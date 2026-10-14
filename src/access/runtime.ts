import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PerchContext } from '../context.js';
import { PerchError } from '../errors.js';
import type { Upstream } from '../upstream.js';
import { ClientResolver } from './clients.js';
import { startControlServer, type ControlServer } from './control.js';
import { loadGoogleLoginClient, type GoogleLoginClient } from './google.js';
import { silentNotifier, TelegramNotifier, type Notifier } from './notify.js';
import { localPairPage, pageHeaders } from './pages.js';
import { PairingManager, type ConfirmDetails, type PairEvent } from './pairing.js';
import { parseBaseUrl, startPublicServer, type RunningPublicServer } from './server.js';
import { isPublicLocked, OAuthStore, type OAuthState } from './state.js';

/**
 * Wires the public access for `perch serve --http --public`: state, pairing manager, control socket,
 * public listener and the local pairing page (served by the local listener only).
 */
export interface PublicAccessOptions {
  baseUrl: string;
  port: number;
  context: PerchContext;
  upstream: Upstream;
  googleLoginClientFile?: string;
  /** Tests inject the client directly. */
  googleClient?: GoogleLoginClient;
  telegramFile?: string;
  notifier?: Notifier;
  dcrEnabled: boolean;
  trustForwarded: boolean;
  log: (line: string) => void;
}

export interface PublicAccess {
  oauth: OAuthStore;
  pairing: PairingManager;
  publicServer: RunningPublicServer;
  /** Handles /local/pair on the local listener (after the global-token check). */
  localPair: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
  close(): Promise<void>;
}

/** Why a pairing window cannot be opened right now (null = it can). */
export function pairingBlocker(s: OAuthState, now = Date.now()): string | null {
  if (isPublicLocked(s)) return 'Public access is switched off (perch public on to enable it again).';
  if (!s.totp) return 'The Perch code (TOTP) is not set up: run perch oauth totp setup.';
  if (!s.loginAllow.length) return 'No Google account is allowed: run perch oauth login-allow add <email>.';
  if (s.pairLock && Date.parse(s.pairLock.until) > now) return `Pairing is locked after wrong Perch codes until ${s.pairLock.until}.`;
  return null;
}

export async function startPublicAccess(opts: PublicAccessOptions): Promise<PublicAccess> {
  const base = parseBaseUrl(opts.baseUrl);
  const oauth = new OAuthStore(opts.context.store);
  await oauth.read(); // fail closed early on a damaged state
  const google = opts.googleClient ?? (opts.googleLoginClientFile ? await loadGoogleLoginClient(opts.googleLoginClientFile, `${base.origin}/oauth/google/callback`) : null);
  if (!google) throw new PerchError('Public access needs PERCH_GOOGLE_LOGIN_CLIENT_FILE (Google OAuth client of type "Web application")', 'bad_config');
  const notifier = opts.notifier ?? (opts.telegramFile ? await TelegramNotifier.fromFile(opts.telegramFile, opts.upstream) : silentNotifier);
  const pairing = new PairingManager();
  const notify = (kind: Parameters<Notifier['notify']>[0], detail?: string) =>
    notifier.notify(kind, detail).catch(() => opts.log(`perch: notification ${kind} could not be delivered`));
  const audit = (type: string, outcome: 'ok' | 'denied', code?: string) =>
    opts.context.audit.record({ type, actor: { kind: 'oauth' }, outcome, ...(code ? { code } : {}) }).catch(() => opts.log('perch: could not write a public access audit event'));

  const canOpen = async () => {
    const blocker = pairingBlocker(await oauth.read());
    if (blocker) throw new PerchError(blocker, 'pairing_blocked');
  };
  const onEvent = (ev: PairEvent) => {
    if (ev.type === 'opened') {
      void notify('window_opened');
      void audit('oauth_pair_window', 'ok', 'opened');
    } else if (ev.type === 'closed') {
      void audit('oauth_pair_window', ev.reason === 'consumed' ? 'ok' : 'denied', `closed_${ev.reason}`);
    }
  };

  const control: ControlServer = await startControlServer(opts.context.store.storePaths.dataDir, pairing, { canOpen, onEvent });
  let publicServer: RunningPublicServer;
  try {
    publicServer = await startPublicServer({
      baseUrl: base.origin,
      port: opts.port,
      context: opts.context,
      oauth,
      pairing,
      clients: new ClientResolver(opts.upstream),
      upstream: opts.upstream,
      google,
      notifier,
      dcrEnabled: opts.dcrEnabled,
      trustForwarded: opts.trustForwarded,
      log: opts.log,
    });
  } catch (err) {
    await control.close();
    throw err;
  }

  // ------------------------------------------------------------ local pairing page
  const page = {
    windowId: undefined as string | undefined,
    code: undefined as string | undefined,
    expiresAt: undefined as string | undefined,
    details: undefined as ConfirmDetails | undefined,
    paired: undefined as string | undefined,
    events: [] as string[],
  };
  const csrfTokens = new Map<string, number>();
  const newCsrf = () => {
    const t = randomBytes(24).toString('base64url');
    const now = Date.now();
    for (const [k, at] of csrfTokens) if (now - at > 10 * 60 * 1000) csrfTokens.delete(k);
    while (csrfTokens.size >= 20) csrfTokens.delete(csrfTokens.keys().next().value!);
    csrfTokens.set(t, now);
    return t;
  };
  const csrfOk = (t: string) => {
    for (const k of csrfTokens.keys()) {
      const a = Buffer.from(k);
      const b = Buffer.from(t);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        csrfTokens.delete(k);
        return true;
      }
    }
    return false;
  };
  const pageListener = (ev: PairEvent) => {
    onEvent(ev);
    const line = (s: string) => {
      page.events = [...page.events, `${new Date().toISOString().slice(11, 19)} ${s}`].slice(-8);
    };
    if (ev.type === 'opened') {
      page.code = ev.code;
      page.expiresAt = ev.expiresAt;
      page.details = undefined;
      page.paired = undefined;
      line('window opened');
    } else if (ev.type === 'progress') line(`progress: ${ev.step}`);
    else if (ev.type === 'confirm') {
      page.details = ev.details;
      line('waiting for your confirmation');
    } else if (ev.type === 'paired') {
      page.paired = ev.deviceId;
      page.details = undefined;
      line(`paired ${ev.deviceId}`);
    } else if (ev.type === 'first_use') line(`first request from ${ev.deviceId}`);
    else if (ev.type === 'alarm') line(`ALARM: ${ev.kind}`);
    else if (ev.type === 'closed') {
      page.windowId = undefined;
      page.code = undefined;
      page.details = undefined;
      line(`window closed (${ev.reason})`);
    }
  };

  const localPair = async (req: IncomingMessage, res: ServerResponse) => {
    let message: string | undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > 4096) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c as Buffer);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (!csrfOk(form.get('csrf') ?? '')) {
        res.writeHead(403, pageHeaders()).end('Forbidden');
        return;
      }
      try {
        const action = form.get('action');
        if (action === 'open') {
          await canOpen();
          page.windowId = pairing.open(pageListener).windowId;
        } else if (action === 'close') pairing.close('aborted', page.windowId);
        else if (action === 'approve') pairing.answer(true, page.windowId);
        else if (action === 'reject') pairing.answer(false, page.windowId);
      } catch (err) {
        message = err instanceof PerchError ? err.message : 'Action failed';
      }
      res.writeHead(303, { location: '/local/pair', 'cache-control': 'no-store' }).end();
      if (message) page.events = [...page.events, `error: ${message}`].slice(-8);
      return;
    }
    const s = await oauth.read();
    const blocked = pairingBlocker(s);
    const state = page.details ? 'confirm' : page.windowId ? 'open' : page.paired ? 'paired' : blocked && !pairing.isOpen ? 'locked' : 'idle';
    res.writeHead(200, pageHeaders());
    res.end(
      localPairPage({
        base: base.origin,
        csrf: newCsrf(),
        state: pairing.isOpen && !page.windowId ? 'locked' : state,
        ...(page.code ? { code: page.code } : {}),
        ...(page.expiresAt ? { expiresAt: page.expiresAt } : {}),
        ...(page.details ? { details: page.details } : {}),
        ...(page.paired ? { message: `Paired ${page.paired}.` } : {}),
        lastEvents: page.events,
      }),
    );
  };

  return {
    oauth,
    pairing,
    publicServer,
    localPair,
    close: async () => {
      pairing.close('aborted');
      await publicServer.close();
      await control.close();
    },
  };
}
