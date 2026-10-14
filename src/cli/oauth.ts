import { createDeviceGrant, parseCapabilities, removeClientGrant } from '../auth/grants.js';
import { BUILTIN_CIMD, newPreClientId, validRedirectUri } from '../access/clients.js';
import { connectControl } from '../access/control.js';
import { loadGoogleLoginClient } from '../access/google.js';
import { silentNotifier, TelegramNotifier, type Notifier, type NoticeKind } from '../access/notify.js';
import { encodeQr, renderQrTerminal } from '../access/qr.js';
import { pairingBlocker } from '../access/runtime.js';
import { parseBaseUrl } from '../access/server.js';
import { DEVICE_ID_PATTERN, endDevice, expireDevices, isPublicLocked, MAX_LOGIN_ALLOW, newRecoveryCodes, OAuthStore, PRECLIENT_ID_PATTERN } from '../access/state.js';
import { base32Encode } from '../access/base32.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../access/totp.js';
import { AuditLog } from '../audit/audit.js';
import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';
import { MailWorkflowLedger } from '../mail/workflowLedger.js';
import { validateCimdOrigin, createFetchTransport, Upstream } from '../upstream.js';
import { CredentialStore } from '../store/credentialStore.js';
import type { CliIo } from './run.js';

/**
 * Local CLI of the public access (docs/PUBLIC_ACCESS_SPEC.md §10). Everything here runs on the server only;
 * nothing of it is reachable over HTTP.
 */

const usage = (msg: string) => new PerchError(msg, 'usage');
const day = (iso: string | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '-');

async function open(config: PerchConfig) {
  const store = await CredentialStore.open({ dataDir: config.dataDir, keyFile: config.keyFile });
  return { store, oauth: new OAuthStore(store), audit: new AuditLog(new MailWorkflowLedger(store)) };
}

async function notifierFor(config: PerchConfig, io: CliIo): Promise<Notifier> {
  if (!config.notifyTelegramFile) return silentNotifier;
  return TelegramNotifier.fromFile(config.notifyTelegramFile, new Upstream(io.transport ?? createFetchTransport()));
}

async function tryNotify(config: PerchConfig, io: CliIo, kind: NoticeKind): Promise<void> {
  try {
    await (await notifierFor(config, io)).notify(kind);
  } catch {
    io.stderr('perch: the notification could not be delivered.\n');
  }
}

const recordAudit = (audit: AuditLog, type: string, deviceId?: string, code?: string) =>
  audit.record({ type, actor: { kind: 'oauth', ...(deviceId ? { deviceId } : {}) }, outcome: 'ok', ...(code ? { code } : {}) });

function readLine(io: CliIo): (prompt: string) => Promise<string> {
  if (!io.readLine) throw new PerchError('This command needs an interactive terminal', 'no_tty');
  return io.readLine;
}

const yes = (answer: string) => /^(y|yes|j|ja)$/i.test(answer.trim());

// ------------------------------------------------------------------ TOTP

async function totpSetup(config: PerchConfig, io: CliIo): Promise<void> {
  const { oauth, audit } = await open(config);
  const ask = readLine(io);
  const before = await oauth.read();
  if (before.totp) {
    const active = before.devices.filter((d) => d.status === 'active').length;
    const answer = await ask(`A Perch code already exists. Replacing it signs out all ${active} device(s). Continue? [y/N] `);
    if (!yes(answer)) throw new PerchError('Aborted; nothing was changed', 'aborted');
  }
  const secret = newTotpSecret();
  const account = config.publicBaseUrl ? parseBaseUrl(config.publicBaseUrl).hostname : 'perch';
  const uri = otpauthUri(secret, account);
  io.stdout('Scan this QR code with your authenticator app (Google Authenticator, Aegis, 1Password, ...):\n\n');
  io.stdout(renderQrTerminal(encodeQr(uri)));
  io.stdout(`\nOr enter this key by hand: ${base32Encode(secret, { pad: false }).replace(/(.{4})/g, '$1 ').trim()}\n(TOTP, SHA-1, 6 digits, 30 seconds)\n\n`);
  let step: number | null = null;
  for (let i = 0; i < 3 && step === null; i++) {
    step = verifyTotp(secret, (await ask('Enter the 6-digit code your app now shows: ')).replace(/\s/g, ''), Date.now(), undefined);
    if (step === null) io.stderr('That code does not match. Check the time on your phone and try again.\n');
  }
  if (step === null) throw new PerchError('The code could not be confirmed; nothing was changed', 'totp_not_confirmed');
  const { codes, records } = newRecoveryCodes();
  let signedOut = 0;
  await oauth.transact((d) => {
    if (d.totp) {
      for (const dev of d.devices) {
        if (dev.status === 'active') {
          endDevice(dev, 'totp_changed');
          signedOut++;
        }
      }
    }
    d.totp = { secret: secret.toString('base64'), lastStep: step!, createdAt: new Date().toISOString(), recovery: records };
    d.totpFailures = [];
  });
  await recordAudit(audit, 'oauth_totp_set', undefined, before.totp ? 'replaced' : 'created');
  if (before.totp) await tryNotify(config, io, 'totp_changed');
  io.stdout(
    `\nPerch code set up.${signedOut ? ` ${signedOut} device(s) were signed out.` : ''}\n\n` +
      'Recovery codes (each works once instead of the 6-digit code; store them offline, they are not shown again):\n' +
      `${codes.map((c) => `  ${c.slice(0, 5)}-${c.slice(5)}`).join('\n')}\n`,
  );
}

async function totpRecoveryCodes(config: PerchConfig, io: CliIo): Promise<void> {
  const { oauth, audit } = await open(config);
  const { codes, records } = newRecoveryCodes();
  await oauth.transact((d) => {
    if (!d.totp) throw new PerchError('No Perch code is set up yet: run perch oauth totp setup', 'totp_missing');
    d.totp.recovery = records;
  });
  await recordAudit(audit, 'oauth_recovery_codes', undefined, 'regenerated');
  io.stdout(`New recovery codes (the old ones no longer work; not shown again):\n${codes.map((c) => `  ${c.slice(0, 5)}-${c.slice(5)}`).join('\n')}\n`);
}

// ------------------------------------------------------------------ pairing

async function pair(config: PerchConfig, io: CliIo): Promise<number> {
  const ask = readLine(io);
  const ctl = await connectControl(config.dataDir);
  return new Promise<number>((resolve) => {
    let paired: string | undefined;
    let done = false;
    let firstUseTimer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (firstUseTimer) clearTimeout(firstUseTimer);
      ctl.socket.end();
      resolve(code);
    };
    ctl.socket.on('close', () => finish(paired ? 0 : 1));
    ctl.onMessage((m) => {
      switch (m.type) {
        case 'opened':
          io.stdout(
            `Pairing window open until ${String(m.expiresAt).slice(11, 19)} UTC (10 minutes, one device).\n\n` +
              `  Pairing code:  ${String(m.code)}\n\n` +
              'Start the connection on the device now (e.g. add the Perch URL as a custom connector in claude.ai).\n' +
              'Enter the pairing code there, sign in with Google and enter your Perch code. Then confirm here.\n' +
              'Ctrl-C closes the window.\n\n',
          );
          break;
        case 'progress':
          io.stdout(
            {
              started: '… a sign-in started',
              code_ok: '… pairing code accepted',
              google_ok: '… Google account accepted',
              totp_ok: '… Perch code accepted',
            }[String(m.step)] ?? '',
          );
          io.stdout('\n');
          break;
        case 'alarm':
          io.stderr(
            `ALARM: ${{ second_pairing_attempt: 'a second sign-in attempt in this window (possible phishing). Both were discarded.', pairing_code_wrong: 'a wrong pairing code was entered.', pairing_locked: 'too many wrong Perch codes; pairing is locked for a while.' }[String(m.kind)] ?? String(m.kind)}\n`,
          );
          break;
        case 'confirm': {
          const d = m.details as Record<string, unknown>;
          io.stdout(
            '\nA device wants to pair:\n' +
              `  Client:          ${String(d.clientName)} (${String(d.clientDisplay)})\n` +
              `  Registered as:   ${String(d.registration)}\n` +
              `  Returns to:      ${String(d.redirectHost)}\n` +
              `  Google account:  ${String(d.googleEmail)}\n` +
              `  Browser:         ${String(d.userAgent)}\n` +
              `  IP:              ${String(d.ip)}\n` +
              `  Since opening:   ${String(d.secondsSinceOpen)} s${d.usedRecoveryCode ? '  (a recovery code was used)' : ''}\n\n` +
              'Only confirm if this is the device you are connecting right now.\n',
          );
          ask('Pair this device? [y/N] ').then(
            (a) => ctl.send({ op: 'answer', approved: yes(a) }),
            () => ctl.send({ op: 'answer', approved: false }),
          );
          break;
        }
        case 'paired':
          paired = String(m.deviceId);
          io.stdout(`\nPaired device ${paired}. Waiting up to 5 minutes for its first request (Ctrl-C to stop) ...\n`);
          firstUseTimer = setTimeout(() => {
            io.stdout(`No request from ${paired} yet. If your client does not work, revoke it: perch oauth revoke ${paired}\n`);
            finish(0);
          }, 5 * 60 * 1000);
          break;
        case 'first_use':
          io.stdout(`First request from ${String(m.deviceId)} received. Done.\nIf your own client still does not work, something else used this pairing: perch oauth revoke ${String(m.deviceId)}\n`);
          finish(0);
          break;
        case 'closed':
          if (m.reason === 'consumed') break;
          if (!paired) {
            io.stderr(`Pairing window closed (${String(m.reason)}). Nothing was paired.\n`);
            finish(1);
          }
          break;
        case 'error':
          io.stderr(`perch: ${String(m.message)}\n`);
          finish(1);
          break;
      }
    });
    ctl.send({ op: 'open' });
  });
}

// ------------------------------------------------------------------ devices, grants, clients

async function devices(config: PerchConfig, io: CliIo): Promise<void> {
  const { oauth } = await open(config);
  const s = await oauth.read();
  const lines = ['Devices of the public access:'];
  if (!s.devices.length) lines.push('  (none)');
  for (const d of s.devices) {
    lines.push(
      `  ${d.id}  ${d.status}${d.endedReason ? ` (${d.endedReason})` : ''}  "${d.clientName}" via ${d.registration}  returns to ${d.redirectHost}  ${d.googleEmail}`,
      `      paired ${day(d.pairedAt)}  last seen ${day(d.lastSeenAt)}  expires ${day(d.expiresAt)}${d.grantClientId ? `  grant ${d.grantClientId}` : '  read-only'}`,
    );
  }
  io.stdout(`${lines.join('\n')}\n`);
}

async function revoke(config: PerchConfig, io: CliIo, id: string | undefined, all: boolean): Promise<void> {
  const { store, oauth, audit } = await open(config);
  if (!all && (!id || !DEVICE_ID_PATTERN.test(id))) throw usage('Usage: perch oauth revoke <oc-…> | --all');
  const grants: string[] = [];
  const ended: string[] = [];
  await oauth.transact((d) => {
    for (const dev of d.devices) {
      if (dev.status !== 'active' || (!all && dev.id !== id)) continue;
      endDevice(dev, 'revoked');
      ended.push(dev.id);
      if (dev.grantClientId) grants.push(dev.grantClientId);
      dev.grantClientId = undefined;
    }
    if (!all && !ended.length) throw new PerchError(`No active device ${id}`, 'unknown_device');
  });
  for (const g of grants) await removeClientGrant(store, g).catch(() => {});
  for (const e of ended) await recordAudit(audit, 'oauth_device_revoked', e, 'local_admin');
  io.stdout(`Revoked ${ended.length} device(s)${ended.length ? `: ${ended.join(', ')}` : ''}. Their tokens stop working with the next request.\n`);
}

async function grant(config: PerchConfig, io: CliIo, id: string | undefined, values: Record<string, unknown>): Promise<void> {
  if (!id || !DEVICE_ID_PATTERN.test(id)) throw usage('Usage: perch oauth grant <oc-…> --allow CAPS --account ID [--account ID ...]');
  if (typeof values.allow !== 'string') throw usage('--allow is required (same capabilities as perch client add)');
  const accounts = (values.account as string[] | undefined) ?? [];
  if (!accounts.length) throw usage('--account is required');
  const { store, oauth, audit } = await open(config);
  const dev = (await oauth.read()).devices.find((d) => d.id === id && d.status === 'active');
  if (!dev) throw new PerchError(`No active device ${id}`, 'unknown_device');
  const g = await createDeviceGrant(store, { label: `OAuth ${id}`, capabilities: parseCapabilities(values.allow.split(',')), accountIds: accounts });
  let old: string | undefined;
  try {
    await oauth.transact((d) => {
      const x = d.devices.find((v) => v.id === id && v.status === 'active');
      if (!x) throw new PerchError(`No active device ${id}`, 'unknown_device');
      old = x.grantClientId;
      x.grantClientId = g.id;
    });
  } catch (err) {
    await removeClientGrant(store, g.id).catch(() => {});
    throw err;
  }
  if (old) await removeClientGrant(store, old).catch(() => {});
  await recordAudit(audit, 'oauth_device_grant', id, 'granted');
  io.stdout(
    `Device ${id} now acts as client grant ${g.id} (${g.capabilities.join(',')}) for ${g.accountIds.join(', ')}.\n` +
      'Like perch client add, it then sees only what this grant covers; include read capabilities if it should keep reading.\n' +
      `Undo: perch oauth ungrant ${id}\n`,
  );
}

async function ungrant(config: PerchConfig, io: CliIo, id: string | undefined): Promise<void> {
  if (!id || !DEVICE_ID_PATTERN.test(id)) throw usage('Usage: perch oauth ungrant <oc-…>');
  const { store, oauth, audit } = await open(config);
  let old: string | undefined;
  await oauth.transact((d) => {
    const x = d.devices.find((v) => v.id === id);
    if (!x) throw new PerchError(`Unknown device ${id}`, 'unknown_device');
    old = x.grantClientId;
    x.grantClientId = undefined;
  });
  if (old) await removeClientGrant(store, old).catch(() => {});
  await recordAudit(audit, 'oauth_device_grant', id, 'removed');
  io.stdout(`Device ${id} is read-only again.\n`);
}

async function loginAllow(config: PerchConfig, io: CliIo, sub: string | undefined, arg: string | undefined): Promise<void> {
  const { oauth, audit } = await open(config);
  if (sub === 'list') {
    const s = await oauth.read();
    io.stdout(`Allowed Google accounts:\n${s.loginAllow.length ? s.loginAllow.map((e) => `  ${e.email}${e.sub ? '  (pinned)' : '  (pinned at first sign-in)'}`).join('\n') : '  (none)'}\n`);
    return;
  }
  const email = arg?.trim().toLowerCase();
  if ((sub !== 'add' && sub !== 'remove') || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw usage('Usage: perch oauth login-allow add|remove <email> | list');
  await oauth.transact((d) => {
    if (sub === 'add') {
      if (d.loginAllow.some((e) => e.email === email)) throw new PerchError(`${email} is already allowed`, 'exists');
      if (d.loginAllow.length >= MAX_LOGIN_ALLOW) throw new PerchError(`At most ${MAX_LOGIN_ALLOW} Google accounts`, 'too_many');
      d.loginAllow.push({ email, addedAt: new Date().toISOString() });
    } else {
      if (!d.loginAllow.some((e) => e.email === email)) throw new PerchError(`${email} is not on the list`, 'unknown');
      d.loginAllow = d.loginAllow.filter((e) => e.email !== email);
    }
  });
  await recordAudit(audit, 'oauth_login_allow', undefined, sub === 'add' ? 'added' : 'removed');
  io.stdout(sub === 'add' ? `Allowed ${email}. Its Google account id is pinned at the first sign-in.\n` : `Removed ${email}. Devices already paired with it keep working until revoked.\n`);
}

async function clients(config: PerchConfig, io: CliIo, sub: string | undefined, arg: string | undefined, values: Record<string, unknown>): Promise<void> {
  const { oauth } = await open(config);
  if (sub === 'list') {
    const s = await oauth.read();
    const lines = ['Built in: Claude client metadata documents under https://claude.ai/oauth/… and https://claude.com/oauth/…'];
    for (const u of s.cimdUrls) lines.push(`  metadata document  ${u}`);
    for (const c of s.preClients) lines.push(`  ${c.id}  "${c.name}"  ${c.redirectUris.join(' ')}`);
    io.stdout(`${lines.join('\n')}\n`);
    return;
  }
  if (sub === 'add' && typeof values.cimd === 'string') {
    const url = values.cimd.trim();
    validateCimdOrigin(url);
    const u = new URL(url);
    if (u.search || u.hash || u.pathname === '/' || BUILTIN_CIMD.test(url)) throw usage('--cimd must be an https URL with a path, without query or fragment (Claude documents are built in)');
    await oauth.transact((d) => {
      if (!d.cimdUrls.includes(url)) d.cimdUrls.push(url);
    });
    io.stdout(`Allowed the client metadata document ${url}.\n`);
    return;
  }
  if (sub === 'add') {
    const name = typeof values.name === 'string' ? values.name.trim() : '';
    const redirects = (values.redirect as string[] | undefined) ?? [];
    if (!name || !redirects.length || redirects.length > 5 || !redirects.every(validRedirectUri)) {
      throw usage('Usage: perch oauth client add --name NAME --redirect URI [--redirect URI ...]  (https, or http loopback)  |  add --cimd URL');
    }
    const id = newPreClientId();
    await oauth.transact((d) => {
      d.preClients.push({ id, name: name.slice(0, 100), redirectUris: redirects, createdAt: new Date().toISOString() });
    });
    io.stdout(`Pre-registered client ${id} ("${name}"). Use ${id} as its OAuth client id (public client with PKCE, no secret).\n`);
    return;
  }
  if (sub === 'remove' && arg) {
    await oauth.transact((d) => {
      if (PRECLIENT_ID_PATTERN.test(arg)) {
        if (!d.preClients.some((c) => c.id === arg)) throw new PerchError(`Unknown client ${arg}`, 'unknown');
        d.preClients = d.preClients.filter((c) => c.id !== arg);
      } else {
        if (!d.cimdUrls.includes(arg)) throw new PerchError(`Unknown client ${arg}`, 'unknown');
        d.cimdUrls = d.cimdUrls.filter((u) => u !== arg);
      }
    });
    io.stdout(`Removed ${arg}. Devices already paired with it keep working until revoked.\n`);
    return;
  }
  throw usage('Usage: perch oauth client add --name NAME --redirect URI | add --cimd URL | list | remove ID|URL');
}

export async function cmdOauth(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>): Promise<number> {
  switch (sub) {
    case 'pair':
      return pair(config, io);
    case 'totp':
      if (rest[0] === 'setup') await totpSetup(config, io);
      else if (rest[0] === 'recovery-codes') await totpRecoveryCodes(config, io);
      else if (rest[0] === 'status') {
        const s = await (await open(config)).oauth.read();
        io.stdout(s.totp ? `Perch code set up ${day(s.totp.createdAt)}; ${s.totp.recovery.filter((r) => !r.usedAt).length} unused recovery code(s).\n` : 'No Perch code set up (perch oauth totp setup).\n');
      } else throw usage('Usage: perch oauth totp setup|status|recovery-codes');
      return 0;
    case 'login-allow':
      await loginAllow(config, io, rest[0], rest[1]);
      return 0;
    case 'client':
      await clients(config, io, rest[0], rest[1], values);
      return 0;
    case 'devices':
      await devices(config, io);
      return 0;
    case 'revoke':
      await revoke(config, io, rest[0], values.all === true);
      return 0;
    case 'grant':
      await grant(config, io, rest[0], values);
      return 0;
    case 'ungrant':
      await ungrant(config, io, rest[0]);
      return 0;
    default:
      throw usage('Usage: perch oauth pair | totp … | login-allow … | client … | devices | revoke … | grant … | ungrant …');
  }
}

// ------------------------------------------------------------------ perch public

const funnelHint = (config: PerchConfig) =>
  `  sudo tailscale funnel --bg --https=443 http://127.0.0.1:${config.publicPort}      # public: only the public listener\n` +
  `  sudo tailscale serve --bg --https=8443 http://127.0.0.1:${config.httpPort}       # optional, private: the local listener\n`;

export async function cmdPublic(config: PerchConfig, io: CliIo, sub: string | undefined): Promise<number> {
  const { oauth, audit } = await open(config);
  if (sub === 'off') {
    let ended = 0;
    await oauth.transact((d) => {
      d.publicLocked = { since: new Date().toISOString() };
      for (const dev of d.devices) {
        if (dev.status === 'active') {
          endDevice(dev, 'kill_switch');
          ended++;
        }
      }
    });
    await recordAudit(audit, 'oauth_kill_switch', undefined, 'off');
    await tryNotify(config, io, 'kill_switch');
    io.stdout(
      `Public access is OFF: the public listener answers 503 (also after restarts), any open pairing window closes, ${ended} device(s) were signed out.\n` +
        'Also stop the public proxy, for Tailscale Funnel for example:\n  sudo tailscale funnel --https=443 off\n',
    );
    return 0;
  }
  if (sub === 'on') {
    await oauth.transact((d) => {
      d.publicLocked = undefined;
    });
    await recordAudit(audit, 'oauth_kill_switch', undefined, 'on');
    io.stdout('Public access is ON again (if perch serve --http --public runs). All devices have to be paired again: perch oauth pair\n');
    return 0;
  }
  if (sub === 'status' || sub === undefined) {
    const s = await oauth.read();
    expireDevices(s);
    const blocker = pairingBlocker(s);
    io.stdout(
      `Public access: ${isPublicLocked(s) ? 'OFF (kill switch)' : config.publicBaseUrl ? `configured for ${config.publicBaseUrl}` : 'not configured (PERCH_PUBLIC_BASE_URL)'}\n` +
        `Perch code: ${s.totp ? 'set up' : 'missing'} · allowed Google accounts: ${s.loginAllow.length} · active devices: ${s.devices.filter((d) => d.status === 'active').length}\n` +
        `Pairing: ${blocker ?? 'possible (perch oauth pair)'}\n`,
    );
    return 0;
  }
  if (sub === 'setup') {
    const ask = readLine(io);
    if (!config.publicBaseUrl) throw new PerchError('Set PERCH_PUBLIC_BASE_URL first (e.g. https://homeserver.tailnet-xyz.ts.net)', 'bad_config');
    const base = parseBaseUrl(config.publicBaseUrl);
    io.stdout(`Public address: ${base.origin} (MCP endpoint ${base.origin}/mcp)\n`);
    if (!config.googleLoginClientFile) {
      throw new PerchError(
        `Set PERCH_GOOGLE_LOGIN_CLIENT_FILE to the JSON of a Google OAuth client of type "Web application" with the redirect URI ${base.origin}/oauth/google/callback (scopes openid email)`,
        'bad_config',
      );
    }
    await loadGoogleLoginClient(config.googleLoginClientFile, `${base.origin}/oauth/google/callback`);
    io.stdout('Google sign-in client: OK\n');
    let s = await oauth.read();
    if (!s.loginAllow.length) {
      const email = await ask('Your Google account (email) that may sign in: ');
      await loginAllow(config, io, 'add', email);
    } else io.stdout(`Allowed Google accounts: ${s.loginAllow.map((e) => e.email).join(', ')}\n`);
    s = await oauth.read();
    if (!s.totp) await totpSetup(config, io);
    else io.stdout('Perch code: already set up (perch oauth totp setup replaces it)\n');
    io.stdout(config.notifyTelegramFile ? 'Telegram notifications: configured\n' : 'Telegram notifications: off (optional: PERCH_NOTIFY_TELEGRAM_FILE)\n');
    io.stdout(`\nNext steps (Perch does not change Tailscale itself):\n${funnelHint(config)}  perch serve --http --public\n  perch oauth pair                 # then add ${base.origin}/mcp as a custom connector in claude.ai\n`);
    return 0;
  }
  throw usage('Usage: perch public setup|status|on|off');
}
