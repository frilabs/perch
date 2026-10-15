import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PerchError } from '../errors.js';

export const DEFAULT_AUTH_TIMEOUT_MS = 300_000;
/** Upper bound (also keeps setTimeout far below its 2^31 ms overflow). */
export const MAX_AUTH_TIMEOUT_MS = 3_600_000;

export interface PkceLoopbackOptions<T> {
  /** Name used in messages, e.g. "Google" or "Microsoft". */
  provider: string;
  /** Fixed authorization endpoint (never user supplied). */
  authEndpoint: string;
  /** Extra authorization parameters (client_id, scope, prompt, ...). */
  authParams: Record<string, string>;
  /** Host name in the redirect URI. The listener always binds 127.0.0.1 only. */
  redirectHost: '127.0.0.1' | 'localhost';
  callbackPath: string;
  /** 0 = random free port. Use a fixed port when forwarding it over SSH (`ssh -L`). */
  port?: number;
  timeoutMs?: number;
  onAuthUrl: (url: string) => void;
  /**
   * Runs once the callback port is known, before the authorization URL is built; its parameters are added
   * (e.g. a client id registered for exactly this redirect URI).
   */
  prepare?: (redirectUri: string) => Promise<Record<string, string>>;
  /** Exchanges the code (with the PKCE verifier) at the fixed token endpoint. */
  exchange: (code: string, verifier: string, redirectUri: string) => Promise<T>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Native-app OAuth: loopback redirect, random state, PKCE S256. The state is verified (constant
 * time) before the code is ever exchanged; wrong paths get 404 and wrong states 400 while the
 * flow keeps waiting until the timeout.
 */
export async function runPkceLoopback<T>(opts: PkceLoopbackOptions<T>): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AUTH_TIMEOUT_MS) {
    throw new PerchError(`OAuth timeout must be positive and at most ${MAX_AUTH_TIMEOUT_MS / 1000} seconds`, 'bad_argument');
  }
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  codePromise.catch(() => {}); // a timeout during prepare() must not become an unhandled rejection
  let done = false;

  const server = createServer((req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== opts.callbackPath) return reply(404, 'Not found');
    if (done) return reply(410, 'This authorization request is no longer active.');
    const gotState = url.searchParams.get('state');
    if (!gotState || !safeEqual(gotState, state)) return reply(400, 'Invalid or missing state. Ignored.');
    const error = url.searchParams.get('error');
    if (error) {
      done = true;
      reply(400, 'Authorization was not granted. You can close this window.');
      const code = /^[a-z_]{1,64}$/.test(error) ? error : 'unknown_error';
      return settle.reject(new PerchError(`${opts.provider} authorization failed: ${code}`, 'oauth_denied'));
    }
    const code = url.searchParams.get('code');
    if (!code) return reply(400, 'Missing code.');
    done = true;
    reply(200, 'Perch received the authorization. You can close this window and return to the terminal.');
    settle.resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new PerchError('Could not open the OAuth callback port', 'oauth_port')));
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://${opts.redirectHost}:${(server.address() as AddressInfo).port}${opts.callbackPath}`;
  const timer = setTimeout(() => {
    done = true;
    settle.reject(new PerchError(`Timed out waiting for the ${opts.provider} authorization`, 'oauth_timeout'));
  }, timeoutMs);

  try {
    const auth = new URL(opts.authEndpoint);
    const extra = opts.prepare ? await opts.prepare(redirectUri) : {};
    auth.search = new URLSearchParams({
      ...opts.authParams,
      ...extra,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    opts.onAuthUrl(auth.toString());
    const code = await codePromise;
    return await opts.exchange(code, verifier, redirectUri);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
