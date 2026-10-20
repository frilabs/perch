import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog } from '../audit/audit.js';
import { createClientGrant, parseCapabilities, principalForClientToken, READONLY_PRINCIPAL, removeClientGrant } from '../auth/grants.js';
import { loadHttpToken, resolveConfig, type PerchConfig } from '../config.js';
import { createPerchContext } from '../context.js';
import { PerchError, safeMessage } from '../errors.js';
import { registerGoogleAccount, removeGoogleAccount } from '../google/accounts.js';
import { DEFAULT_AUTH_TIMEOUT_MS, DRIVE_READONLY_SCOPE, DRIVE_SCOPE, MAX_AUTH_TIMEOUT_MS, parseClientFile, runLoopbackAuthorization } from '../google/oauth.js';
import {
  parseServices,
  productivityScopesFor,
  registerProductivityAccount,
  removeProductivityAccount,
  runProductivityAuthorization,
} from '../google/productivity.js';
import { createGmailTokenProvider, gmailScopesFor, registerGmailAccount, removeGmailAccount } from '../mail/gmailAccounts.js';
import { addImapAccount, removeImapAccount, verifyImapAccount } from '../mail/imapAccounts.js';
import { IMAP_PRESETS } from '../mail/imapPresets.js';
import { imapSentCopyEnabled } from '../mail/imap.js';
import { PRUNE_REFUSED, resolveSend } from '../mail/workflow.js';
import {
  ACCOUNT_ID_PATTERN,
  initMailWorkflowLedger,
  ledgerFilePath,
  MAX_AUDIT_EVENTS,
  MailWorkflowLedger,
  OPERATION_ID_PATTERN,
  SEND_STATES,
  type Actor,
} from '../mail/workflowLedger.js';
import { generateHttpToken, startHttpServer, validateHttpToken } from '../mcp/http.js';
import { createMcpServer } from '../mcp/server.js';
import { registerMicrosoftAccount, removeMicrosoftAccount } from '../microsoft/accounts.js';
import { runMicrosoftAuthorization, validateTenant } from '../microsoft/oauth.js';
import { addNotionWorkspace, removeNotionWorkspace } from '../notion/notion.js';
import { SLACK_APP_MANIFEST } from '../slack/manifest.js';
import { addSlackWorkspace, removeSlackWorkspace } from '../slack/slack.js';
import { ensurePrivateDir, pathExists, readPrivateFile, writePrivateFileAtomic, writePrivateFileExclusive } from '../secureFs.js';
import { CredentialStore, initStore, type ImapAccount, type StoreData } from '../store/credentialStore.js';
import { createFetchTransport, Upstream, type UpstreamTransport } from '../upstream.js';
import { collectStatus, failedChecks, formatStatusText } from '../status/status.js';
import { startPublicAccess } from '../access/runtime.js';
import { cmdOauth, cmdPublic } from './oauth.js';
import { cmdLuma, lumaMcpFor } from './luma.js';
import type { FetchLike } from '../luma/client.js';
import { PERCH_VERSION } from '../version.js';
import { chooseAccess, claudeAddCommand, runSetup, WRITE_FLAGS } from './onboarding.js';
import { defaultInstallDeps, installGowa, rotateGowaPassword, type InstallDeps } from '../whatsapp/install.js';
import { DEFAULT_PAIR_TIMEOUT_MS, pairWhatsappAccount, probeWhatsappInstance, removeWhatsappAccount, setWhatsappInstance, whatsappDeviceStatus } from '../whatsapp/whatsapp.js';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Masked secret input (TTY only in production). */
  readSecret: (prompt: string) => Promise<string>;
  /** Visible one-line input (confirmations, one-time codes); TTY only in production. */
  readLine?: (prompt: string) => Promise<string>;
  /** Tests inject a fetch serving a MOCK Luma MCP server; production uses fetch behind guardedLumaFetch. */
  lumaFetch?: FetchLike;
  /** Tests inject a MOCK upstream transport; production always uses fetch to fixed origins. */
  transport?: UpstreamTransport;
  /** Tests inject a MOCK IMAP/SMTP login check; production logs in to the real servers over TLS. */
  imapVerify?: (account: ImapAccount) => Promise<void>;
  /** Tests inject a no-op sleep (WhatsApp pairing polls the bridge). */
  sleep?: (ms: number) => Promise<void>;
  /** Tests inject MOCK platform, download, systemctl and pins for `perch whatsapp install`; production uses the real ones. */
  whatsappInstall?: Partial<InstallDeps>;
}

const USAGE = `perch ${PERCH_VERSION} - Google Drive + Notion + mail + Calendar/Contacts + Slack + WhatsApp MCP server (read-only unless a client grant allows more)

Usage:
  perch setup                                  guided onboarding: connect every service step by step, then one full-access client
  perch init                                   create key, encrypted store and HTTP token (if missing)
  perch serve --stdio                          MCP over stdio (read-only; PERCH_CLIENT_TOKEN_FILE selects a client grant)
  perch serve --http [--host IP] [--port N] [--public]   MCP over stateless Streamable HTTP (bearer auth);
                                               --public also starts the public OAuth listener (PERCH_PUBLIC_BASE_URL)
  perch public setup | status | on | off       public access: guided setup, state, kill switch (off signs out every device)
  perch oauth pair                             open a pairing window (10 min, one device) and confirm the sign-in here
  perch oauth totp setup | status | recovery-codes      the Perch code (TOTP) for every pairing
  perch oauth login-allow add|remove EMAIL | list       Google accounts that may sign in
  perch oauth devices | revoke ID | revoke --all        paired devices
  perch oauth grant ID --allow CAPS --account ID ... | ungrant ID --read-all   write capabilities of a device (like perch client add)
  perch oauth client add --name N --redirect URI | add --cimd URL | list | remove ID   extra OAuth clients
  perch luma add --label NAME [--port N] [--timeout SECONDS]   connect a Luma account (official Luma MCP, OAuth)
  perch luma list | remove ID [--revoke] | tools ID [--accept]   tools: approved vs live tool schemas
  perch oauth local-page enable | disable       local pairing page /local/pair with its own password
  perch accounts                               list all connected accounts
  perch status [--no-check] [--json]           overview with a live check per account
                                               (exit code 1 if a check failed); the same page: GET /status on serve --http
  perch google add --label NAME [--allow-write] [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch google list | remove ID [--revoke]
  perch notion add --label NAME                PAT is read via a masked terminal prompt
  perch notion list | remove ID
  perch gmail add --label NAME [--allow-drafts] [--allow-send] [--allow-modify] [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch gmail list | remove ID [--revoke]
  perch microsoft add --label NAME [--allow-drafts] [--allow-send] [--allow-modify] [--port N] [--timeout SECONDS]
                      [--redirect-host localhost|127.0.0.1] [--login-hint EMAIL]
  perch microsoft list | remove ID
  perch imap add --label NAME --email ADDRESS [--username USER] [--preset gmx|gmx-com]
                 [--imap-host H --imap-port N --smtp-host H --smtp-port N --smtp-security tls|starttls]
                 [--allow-drafts] [--allow-send] [--allow-modify] [--drafts-mailbox NAME] [--no-sent-copy]
                 password via masked prompt; --no-sent-copy: never file sent mail in the Sent folder
  perch imap presets | list | remove ID
  perch google-productivity add --label NAME --services calendar,contacts [--allow-calendar-write]
                      [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch google-productivity list | remove ID [--revoke]
  perch slack manifest                         print the Slack app manifest (create one internal app per workspace)
  perch slack add --label NAME                 user token (xoxp-…) is read via a masked terminal prompt
  perch slack list | remove ID
  perch whatsapp install [--yes] [--dir PATH] [--port N]   download the pinned GOWA bridge (SHA-256 checked), run it as a
                                               systemd user service on 127.0.0.1 and store it in Perch (Linux; asks first);
                                               a re-run replaces a gowa.service written by an older Perch
  perch whatsapp rotate-password [--dir PATH]  new random GOWA password in .env, restart GOWA, store it in Perch;
                                               paired devices stay linked; the password is never shown
  perch whatsapp instance set --url http://127.0.0.1:3000   GOWA basic-auth user/password via masked prompts
  perch whatsapp instance show
  perch whatsapp add --label NAME --phone +43…  [--timeout SECONDS]   pair a new linked device by pairing code
  perch whatsapp list | status | remove ID [--keep-device]
  perch client add --label NAME --full [--token-file PATH]   read + write on every account (also later ones)
  perch client add --label NAME --allow CAPS --account ID [--account ID ...] [--token-file PATH]
                      CAPS: read,draft,send,modify (mail accounts); calendar_read,calendar_write,calendar_invite,contacts_read (gprod accounts);
                            slack_read,slack_send (slack accounts); whatsapp_read,whatsapp_send (whatsapp accounts);
                            luma_read,luma_events,luma_guests,luma_blast (luma accounts)
  perch client list | remove ID
  perch token rotate                           replace the HTTP bearer token file
  perch audit list [--limit N] [--client ID] [--account ID]   body-free audit trail
  perch mail-workflow list [--state pending|accepted|rejected|indeterminate]   idempotent send records
  perch mail-workflow resolve OPERATION_ID --outcome sent|not-sent   record a human-verified outcome (never sends)
  perch mail-workflow init                     create a missing ledger for a store created before it existed

Configuration is read from environment variables (see .env.example). Secrets are never
accepted as command-line arguments. Perch serves exactly one operator per installation.`;

const SECRET_FLAG = /^--?(token|pat|secret|client-secret|refresh-token|access-token|password|key|api-key)(=|$)/i;

class UsageError extends PerchError {
  constructor(message: string) {
    super(message, 'usage');
  }
}

function openRootStore(config: PerchConfig) {
  return CredentialStore.open({ dataDir: config.dataDir, keyFile: config.keyFile });
}

const openStore = openRootStore;

/**
 * User isolation was removed (one operator per installation). Stores that still list provisioned users
 * open as before; those users' tokens are no longer accepted, and their stores and keys stay untouched.
 */
async function warnAboutProvisionedUsers(store: CredentialStore, io: CliIo): Promise<void> {
  const active = (await store.read()).users.filter((u) => u.status === 'active');
  if (active.length) {
    io.stderr(
      `perch: warning: this store still lists ${active.length} provisioned user(s) (${active.map((u) => u.id).join(', ')}). ` +
        'User namespaces are no longer supported; their tokens are rejected. Their stores and keys were not touched (see docs/SETUP.md).\n',
    );
  }
}

type AccountSection = 'all' | 'google' | 'notion' | 'gmail' | 'microsoft' | 'imap' | 'productivity' | 'slack' | 'whatsapp';

function formatSlack(data: StoreData): string[] {
  const lines = ['Slack workspaces (labels are user-assigned):'];
  if (!data.slack.length) lines.push('  (none)');
  for (const w of data.slack) {
    lines.push(`  ${w.id}  "${w.label}"  ${w.teamName ?? w.teamId}  user ${w.userName ?? w.userId}  ${w.scopes.includes('chat:write') ? 'read+post' : 'read'}  connected ${w.createdAt}`);
  }
  return lines;
}

function formatWhatsapp(data: StoreData): string[] {
  const lines = [`WhatsApp accounts${data.whatsappInstance ? ` (bridge ${data.whatsappInstance.origin})` : ' (no bridge configured)'}:`];
  if (!data.whatsapp.length) lines.push('  (none)');
  for (const a of data.whatsapp) lines.push(`  ${a.id}  "${a.label}"  ${a.jid ?? 'unknown jid'}  device ${a.deviceId}  connected ${a.createdAt}`);
  return lines;
}

function formatProductivity(data: StoreData): string[] {
  const lines = ['Google Calendar/Contacts accounts:'];
  if (!data.googleProductivity.length) lines.push('  (none)');
  for (const a of data.googleProductivity) {
    lines.push(`  ${a.id}  "${a.label}"  ${a.email}  ${a.services.join(',')}${a.allowCalendarWrite ? ' (calendar write)' : ' (read-only)'}  connected ${a.createdAt}`);
  }
  return lines;
}

function formatMail(data: StoreData, which: AccountSection): string[] {
  const rows = [
    ...(which === 'all' || which === 'gmail' ? data.gmail.map((a) => ({ a, kind: 'gmail', extra: a.scopes.map((x) => x.split('/').pop()).join(',') })) : []),
    ...(which === 'all' || which === 'microsoft'
      ? data.microsoft.map((a) => ({ a, kind: 'microsoft', extra: `tenant ${a.tenant}; ${a.scopes.join(',')}` }))
      : []),
    ...(which === 'all' || which === 'imap'
      ? data.imap.map((a) => ({
          a,
          kind: 'imap',
          extra:
            `${a.imap.host}/${a.smtp.host}; drafts ${a.allowDrafts ? 'on' : 'off'}, send ${a.allowSend ? 'on' : 'off'}, ` +
            `organize ${a.allowModify ? 'on' : 'off'}, sent copy ${imapSentCopyEnabled(a) ? 'on' : 'off'}`,
        }))
      : []),
  ];
  const lines = ['Mail accounts:'];
  if (!rows.length) lines.push('  (none)');
  for (const { a, extra } of rows) lines.push(`  ${a.id}  "${a.label}"  ${a.email}  ${extra}  connected ${a.createdAt}`);
  return lines;
}

function formatAccounts(data: StoreData, which: AccountSection): string {
  if (which === 'gmail' || which === 'microsoft' || which === 'imap') return `${formatMail(data, which).join('\n')}\n`;
  if (which === 'productivity') return `${formatProductivity(data).join('\n')}\n`;
  if (which === 'slack') return `${formatSlack(data).join('\n')}\n`;
  if (which === 'whatsapp') return `${formatWhatsapp(data).join('\n')}\n`;
  const lines: string[] = [];
  if (which !== 'notion') {
    lines.push('Google accounts:');
    if (!data.google.length) lines.push('  (none)');
    for (const g of data.google) lines.push(`  ${g.id}  "${g.label}"  ${g.email}  connected ${g.createdAt}`);
  }
  if (which !== 'google') {
    lines.push('Notion workspaces (labels are user-assigned, not verified by Notion):');
    if (!data.notion.length) lines.push('  (none)');
    for (const w of data.notion) {
      const owner = w.tokenOwner?.name ? `  token owner: ${w.tokenOwner.name}` : '';
      lines.push(`  ${w.id}  "${w.label}"${owner}  connected ${w.createdAt}`);
    }
  }
  if (which === 'all') lines.push(...formatMail(data, 'all'), ...formatProductivity(data), ...formatSlack(data), ...formatWhatsapp(data));
  return `${lines.join('\n')}\n`;
}

async function cmdInit(config: PerchConfig, io: CliIo) {
  const r = await initStore({ dataDir: config.dataDir, keyFile: config.keyFile });
  io.stdout(`${r.createdKey ? 'Created' : 'Kept existing'} key file: ${config.keyFile}\n`);
  io.stdout(`${r.createdStore ? 'Created' : 'Kept existing'} encrypted store: ${path.join(config.dataDir, 'store.enc')}\n`);
  const ledger = ledgerFilePath(config.dataDir);
  if (r.createdStore) io.stdout(`Created mail workflow ledger: ${ledger}\n`);
  else if (await pathExists(ledger)) io.stdout(`Kept existing mail workflow ledger: ${ledger}\n`);
  else {
    io.stdout(
      `Mail workflow ledger is missing (${ledger}); mail tools fail closed until it is restored from backup, or, only if this ` +
        'store predates it, created with: perch mail-workflow init\n',
    );
  }
  if (config.httpTokenEnv) {
    validateHttpToken(config.httpTokenEnv);
    io.stdout('HTTP token: provided via PERCH_HTTP_TOKEN (token file not touched)\n');
  } else {
    await ensurePrivateDir(path.dirname(config.tokenFile));
    const created = await writePrivateFileExclusive(config.tokenFile, Buffer.from(`${generateHttpToken()}\n`));
    if (!created) validateHttpToken(await loadHttpToken(config));
    io.stdout(`${created ? 'Created' : 'Kept existing'} HTTP token file: ${config.tokenFile}\n`);
  }
  if (r.createdKey) {
    io.stdout('Back up the key file separately from the data directory; without it the store cannot be decrypted.\n');
  }
}

async function cmdServe(config: PerchConfig, io: CliIo, values: Record<string, unknown>): Promise<number> {
  if (Boolean(values.stdio) === Boolean(values.http)) throw new UsageError('Choose exactly one of --stdio or --http');
  const store = await openRootStore(config);
  await warnAboutProvisionedUsers(store, io);
  const context = createPerchContext(store, io.transport ?? createFetchTransport(), undefined, lumaMcpFor(io));
  if (values.stdio) {
    // Plain stdio is the read-only operator; a client token file selects one of the client grants.
    const token = config.clientTokenFile ? (await readPrivateFile(config.clientTokenFile)).toString('utf8').trim() : undefined;
    const principal = token === undefined ? READONLY_PRINCIPAL : await principalForClientToken(store, token);
    if (!principal) throw new PerchError('PERCH_CLIENT_TOKEN_FILE does not hold a known client token (perch client list)', 'unknown_client');
    await context.luma.refresh();
    const server = createMcpServer(context, principal);
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = () => resolve();
    });
    await server.connect(new StdioServerTransport());
    io.stderr(`perch: serving MCP over stdio (${principal.clientId ? `client ${principal.clientId}` : 'read-only'})\n`);
    await closed;
    return 0;
  }
  const port = values.port !== undefined ? Number(values.port) : config.httpPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a valid port');
  let publicAccess: Awaited<ReturnType<typeof startPublicAccess>> | undefined;
  if (values.public) {
    if (!config.publicBaseUrl) throw new PerchError('--public needs PERCH_PUBLIC_BASE_URL (see perch public setup)', 'bad_config');
    publicAccess = await startPublicAccess({
      baseUrl: config.publicBaseUrl,
      port: config.publicPort,
      context,
      upstream: new Upstream(io.transport ?? createFetchTransport()),
      ...(config.googleLoginClientFile ? { googleLoginClientFile: config.googleLoginClientFile } : {}),
      ...(config.notifyTelegramFile ? { telegramFile: config.notifyTelegramFile } : {}),
      dcrEnabled: config.oauthDcr,
      trustForwarded: config.publicTrustForwarded,
      log: (l) => io.stderr(`${l}\n`),
    });
    io.stderr(`perch: public listener on http://127.0.0.1:${publicAccess.publicServer.port} for ${config.publicBaseUrl}/mcp (only /mcp, /.well-known/oauth-*, /oauth/*)\n`);
  }
  const running = await startHttpServer({
    host: (values.host as string | undefined) ?? config.httpHost,
    port,
    token: await loadHttpToken(config),
    context,
    ...(publicAccess ? { localPair: publicAccess.localPair } : {}),
    ...(publicAccess ? { statusOptions: { pairingOpen: () => publicAccess!.pairing.isOpen } } : {}),
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
    log: (l) => io.stderr(`${l}\n`),
  });
  io.stderr(`perch: listening on ${running.url} (allowed Host headers: ${running.allowedHosts.join(', ')})\n`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await running.close();
  await publicAccess?.close();
  return 0;
}

async function cmdGoogle(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'google'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch google remove ID [--revoke]');
    const r = await removeGoogleAccount(store, upstream, id, { revoke: Boolean(values.revoke) });
    io.stdout(`Removed ${id} locally.${r.revoked ? ' The grant was revoked at Google.' : ''}\n`);
    if (!values.revoke) io.stdout('The Google grant is still valid; revoke it at https://myaccount.google.com/permissions or rerun with --revoke.\n');
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch google add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  const port = values.port !== undefined ? Number(values.port) : 0;
  const timeoutS = values.timeout !== undefined ? Number(values.timeout) : DEFAULT_AUTH_TIMEOUT_MS / 1000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a valid port');
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_AUTH_TIMEOUT_MS / 1000) {
    throw new UsageError(`--timeout must be a whole number of seconds between 1 and ${MAX_AUTH_TIMEOUT_MS / 1000}`);
  }
  const timeoutMs = timeoutS * 1000;
  if (!config.googleClientFile) {
    throw new PerchError('Set PERCH_GOOGLE_CLIENT_FILE to the JSON of your Google "Desktop app" OAuth client', 'bad_config');
  }
  const client = parseClientFile((await readPrivateFile(config.googleClientFile)).toString('utf8'));
  // --allow-write asks Google for full Drive access (create, edit, share, trash); writes still need a client grant with drive_write.
  const allowWrite = Boolean(values['allow-write']);
  const grant = await runLoopbackAuthorization({
    client,
    upstream,
    port,
    timeoutMs,
    scopes: [allowWrite ? DRIVE_SCOPE : DRIVE_READONLY_SCOPE],
    ...(typeof values['login-hint'] === 'string' ? { loginHint: values['login-hint'] } : {}),
    onAuthUrl: (url) => {
      const p = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
      io.stderr(
        `Open this URL in a browser and approve ${allowWrite ? 'full (read and write)' : 'read-only'} Drive access for the account you want to add:\n\n${url}\n\n` +
          `The browser must reach http://127.0.0.1:${p} on this machine. If the browser runs elsewhere, ` +
          `forward the port first: ssh -L ${p}:127.0.0.1:${p} <this-server>\n` +
          `Waiting up to ${Math.round(timeoutMs / 1000)}s...\n`,
      );
    },
  });
  const account = await registerGoogleAccount(store, upstream, { label: values.label, client, grant });
  io.stdout(`Connected Google account ${account.id} (${account.email}) as "${account.label}"${allowWrite ? ' with Drive write access at Google' : ''}.\n`);
  if (allowWrite) io.stdout(`Writes still need a client grant: perch client add --label NAME --allow drive_read,drive_write --account ${account.id}\n`);
}

async function cmdNotion(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'notion'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch notion remove ID');
    await removeNotionWorkspace(store, id);
    io.stdout(
      `Disconnected ${id} locally. The token itself stays valid until you revoke it in Notion ` +
        '(Settings > Connections / personal access tokens).\n',
    );
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch notion add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  const token = await io.readSecret(`Notion personal access token for "${values.label}" (input hidden): `);
  const ws = await addNotionWorkspace(store, new Upstream(io.transport ?? createFetchTransport()), {
    label: values.label,
    token,
  });
  io.stdout(
    `Connected Notion workspace ${ws.id} as "${ws.label}"` +
      `${ws.tokenOwner?.name ? ` (token owner: ${ws.tokenOwner.name})` : ''}.\n`,
  );
}

function oauthTiming(values: Record<string, unknown>) {
  const port = values.port !== undefined ? Number(values.port) : 0;
  const timeoutS = values.timeout !== undefined ? Number(values.timeout) : DEFAULT_AUTH_TIMEOUT_MS / 1000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a valid port');
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_AUTH_TIMEOUT_MS / 1000) {
    throw new UsageError(`--timeout must be a whole number of seconds between 1 and ${MAX_AUTH_TIMEOUT_MS / 1000}`);
  }
  return { port, timeoutMs: timeoutS * 1000 };
}

function printAuthUrl(io: CliIo, what: string, url: string, timeoutMs: number) {
  const p = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
  io.stderr(
    `Open this URL in a browser and approve ${what} for the account you want to add:\n\n${url}\n\n` +
      `The browser must reach port ${p} on this machine (loopback). If the browser runs elsewhere, ` +
      `forward the port first: ssh -L ${p}:127.0.0.1:${p} <this-server>\n` +
      `Waiting up to ${Math.round(timeoutMs / 1000)}s...\n`,
  );
}

function describeOptIns(values: Record<string, unknown>): string {
  const extra = [values['allow-drafts'] ? 'drafts' : '', values['allow-send'] ? 'send' : '', values['allow-modify'] ? 'organize' : ''].filter(Boolean);
  return extra.length ? `read + ${extra.join(' + ')}` : 'read-only';
}

async function cmdGmail(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'gmail'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch gmail remove ID [--revoke]');
    const r = await removeGmailAccount(store, upstream, id, { revoke: Boolean(values.revoke) });
    io.stdout(`Removed ${id} locally.${r.revoked ? ' The grant was revoked at Google.' : ''}\n`);
    if (!values.revoke) io.stdout('The Gmail grant is still valid; revoke it at https://myaccount.google.com/permissions or rerun with --revoke.\n');
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch gmail add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  const { port, timeoutMs } = oauthTiming(values);
  if (!config.googleClientFile) {
    throw new PerchError('Set PERCH_GOOGLE_CLIENT_FILE to the JSON of your Google "Desktop app" OAuth client', 'bad_config');
  }
  const client = parseClientFile((await readPrivateFile(config.googleClientFile)).toString('utf8'));
  const scopes = gmailScopesFor({ send: Boolean(values['allow-send']), drafts: Boolean(values['allow-drafts']), modify: Boolean(values['allow-modify']) });
  const grant = await runLoopbackAuthorization({
    client,
    upstream,
    port,
    timeoutMs,
    scopes,
    ...(typeof values['login-hint'] === 'string' ? { loginHint: values['login-hint'] } : {}),
    onAuthUrl: (url) => printAuthUrl(io, `Gmail access (${describeOptIns(values)})`, url, timeoutMs),
  });
  const account = await registerGmailAccount(store, upstream, { label: values.label, client, grant });
  io.stdout(`Connected Gmail account ${account.id} (${account.email}) as "${account.label}" (${describeOptIns(values)}).\n`);
}

async function cmdMicrosoft(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'microsoft'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch microsoft remove ID');
    await removeMicrosoftAccount(store, id);
    io.stdout(
      `Removed ${id} locally. Revoke the app's consent at https://account.live.com/consent/Manage (personal) or ` +
        'https://myapplications.microsoft.com (work/school).\n',
    );
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch microsoft add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  if (!config.microsoftClientId) {
    throw new PerchError('Set PERCH_MICROSOFT_CLIENT_ID to the Application (client) ID of your Entra app registration', 'bad_config');
  }
  const tenant = validateTenant(config.microsoftTenant);
  const redirectHost = values['redirect-host'] ?? 'localhost';
  if (redirectHost !== 'localhost' && redirectHost !== '127.0.0.1') throw new UsageError('--redirect-host must be localhost or 127.0.0.1');
  const { port, timeoutMs } = oauthTiming(values);
  const grant = await runMicrosoftAuthorization({
    clientId: config.microsoftClientId,
    tenant,
    upstream,
    send: Boolean(values['allow-send']),
    drafts: Boolean(values['allow-drafts']),
    modify: Boolean(values['allow-modify']),
    port,
    timeoutMs,
    redirectHost,
    ...(typeof values['login-hint'] === 'string' ? { loginHint: values['login-hint'] } : {}),
    onAuthUrl: (url) => printAuthUrl(io, `Outlook mail access (${describeOptIns(values)})`, url, timeoutMs),
  });
  const account = await registerMicrosoftAccount(store, upstream, {
    label: values.label,
    clientId: config.microsoftClientId,
    tenant,
    grant,
  });
  io.stdout(`Connected Microsoft account ${account.id} (${account.email}) as "${account.label}" (${describeOptIns(values)}).\n`);
}

async function cmdProductivity(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'productivity'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch google-productivity remove ID [--revoke]');
    const r = await removeProductivityAccount(store, upstream, id, { revoke: Boolean(values.revoke) });
    io.stdout(`Removed ${id} locally.${r.revoked ? ' The grant was revoked at Google.' : ''}\n`);
    if (!values.revoke) io.stdout('The Google grant is still valid; revoke it at https://myaccount.google.com/permissions or rerun with --revoke.\n');
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch google-productivity add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  if (typeof values.services !== 'string') throw new UsageError('--services is required: calendar, contacts or calendar,contacts');
  const services = parseServices(values.services.split(','));
  const allowCalendarWrite = Boolean(values['allow-calendar-write']);
  productivityScopesFor({ services, allowCalendarWrite });
  const { port, timeoutMs } = oauthTiming(values);
  if (!config.googleClientFile) {
    throw new PerchError('Set PERCH_GOOGLE_CLIENT_FILE to the JSON of your Google "Desktop app" OAuth client', 'bad_config');
  }
  const client = parseClientFile((await readPrivateFile(config.googleClientFile)).toString('utf8'));
  const what = services.map((s) => (s === 'calendar' && allowCalendarWrite ? 'calendar (read + write own events)' : `${s} (read-only)`)).join(', ');
  const grant = await runProductivityAuthorization({
    client,
    upstream,
    services,
    allowCalendarWrite,
    port,
    timeoutMs,
    ...(typeof values['login-hint'] === 'string' ? { loginHint: values['login-hint'] } : {}),
    onAuthUrl: (url) => printAuthUrl(io, `Google ${what} access`, url, timeoutMs),
  });
  const account = await registerProductivityAccount(store, upstream, { label: values.label, client, grant, services, allowCalendarWrite });
  io.stdout(`Connected Google account ${account.id} (${account.email}) as "${account.label}" for ${what}.\n`);
  if (allowCalendarWrite) io.stdout(`Calendar writes additionally need a client grant: perch client add --allow calendar_read,calendar_write[,calendar_invite] --account ${account.id} (calendar_invite: guests, invitations, responses)\n`);
}

function optPort(values: Record<string, unknown>, name: string): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--${name} must be a valid port`);
  return n;
}

async function cmdImap(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  if (sub === 'presets') {
    const lines: string[] = [];
    for (const [name, p] of Object.entries(IMAP_PRESETS)) {
      lines.push(
        `${name}: ${p.name} (${p.domains.join(', ')})`,
        `  IMAP ${p.imap.host}:${p.imap.port} (TLS); SMTP ${p.smtp.host}:${p.smtp.port} (TLS) or :${p.smtpStarttlsPort} (STARTTLS)`,
        `  ${p.notes}`,
      );
    }
    return io.stdout(`${lines.join('\n')}\n`);
  }
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'imap'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch imap remove ID');
    await removeImapAccount(store, id);
    io.stdout(`Removed ${id} locally (the stored password was deleted). Revoke an app password at your provider if you created one.\n`);
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch imap add|list|remove|presets');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  if (typeof values.email !== 'string') throw new UsageError('--email is required');
  const security = values['smtp-security'];
  if (security !== undefined && security !== 'tls' && security !== 'starttls') throw new UsageError('--smtp-security must be tls or starttls');
  const password = await io.readSecret(`IMAP/SMTP password (app password) for ${values.email} (input hidden): `);
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const imapPort = optPort(values, 'imap-port');
  const smtpPort = optPort(values, 'smtp-port');
  const account = await addImapAccount(
    store,
    {
      label: values.label,
      email: values.email,
      password,
      allowDrafts: Boolean(values['allow-drafts']),
      allowSend: Boolean(values['allow-send']),
      allowModify: Boolean(values['allow-modify']),
      ...(values['no-sent-copy'] ? { sentCopy: false } : {}),
      ...(str('username') ? { username: str('username')! } : {}),
      ...(str('preset') ? { preset: str('preset')! } : {}),
      ...(str('imap-host') ? { imapHost: str('imap-host')! } : {}),
      ...(imapPort ? { imapPort } : {}),
      ...(str('smtp-host') ? { smtpHost: str('smtp-host')! } : {}),
      ...(smtpPort ? { smtpPort } : {}),
      ...(security ? { smtpSecurity: security as 'tls' | 'starttls' } : {}),
      ...(str('drafts-mailbox') ? { draftsMailbox: str('drafts-mailbox')! } : {}),
    },
    io.imapVerify ?? ((a) => verifyImapAccount(a)),
  );
  io.stdout(
    `Connected IMAP account ${account.id} (${account.email}) as "${account.label}" via ${account.imap.host}/${account.smtp.host} ` +
      `(drafts ${account.allowDrafts ? 'on' : 'off'}, send ${account.allowSend ? 'on' : 'off'}, organize ${account.allowModify ? 'on' : 'off'}, ` +
      `sent copy ${imapSentCopyEnabled(account) ? 'on' : 'off'}).\n`,
  );
}

async function cmdSlack(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  if (sub === 'manifest') return io.stdout(`${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`);
  const store = await openStore(config);
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'slack'));
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch slack remove ID');
    await removeSlackWorkspace(store, id);
    io.stdout(`Disconnected ${id} locally. The token stays valid until you uninstall the app (or revoke the token) in that Slack workspace.\n`);
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch slack manifest|add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  const token = await io.readSecret(`Slack user token (xoxp-…) for "${values.label}" (input hidden): `);
  const ws = await addSlackWorkspace(store, new Upstream(io.transport ?? createFetchTransport()), { label: values.label, token });
  const missing = ['search:read', 'chat:write', 'reactions:read', 'reactions:write', 'files:read', 'files:write', 'im:write', 'mpim:write'].filter((s) => !ws.scopes.includes(s));
  io.stdout(
    `Connected Slack workspace ${ws.id} "${ws.label}" (${ws.teamName ?? ws.teamId}, user ${ws.userName ?? ws.userId}).\n` +
      (missing.length
        ? `Note: the token lacks ${missing.join(', ')}; the tools that need them will not work until you reinstall the app with the current manifest (perch slack manifest) and run perch slack add again.\n`
        : '') +
      `Posting needs a client grant: perch client add --label NAME --allow slack_read,slack_send --account ${ws.id}\n`,
  );
}

async function cmdWhatsapp(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const store = await openStore(config);
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const gowaDeps = (): InstallDeps => {
    const home = io.env.HOME;
    if (!home || !path.isAbsolute(home)) throw new PerchError('HOME is not set to an absolute path', 'usage');
    return {
      ...defaultInstallDeps({
        home,
        sleep: io.sleep,
        out: io.stdout,
        ask: io.readLine,
        configuredOrigin: async () => (await store.read()).whatsappInstance?.origin,
        probe: async (url, username, password) => void (await probeWhatsappInstance(upstream, { url, username, password })),
        store: async (url, username, password) => void (await setWhatsappInstance(store, upstream, { url, username, password })),
      }),
      ...io.whatsappInstall,
    };
  };
  if (sub === 'install') {
    if (rest.length) throw new UsageError('Usage: perch whatsapp install [--yes] [--dir PATH] [--port N]');
    const dir = typeof values.dir === 'string' ? values.dir : undefined;
    const r = await installGowa({ yes: values.yes === true, dir, port: optPort(values, 'port') }, gowaDeps());
    if (r.status === 'unit_updated') return;
    return io.stdout('Next: perch whatsapp add --label NAME --phone +43…  (pairs your phone by code)\n');
  }
  if (sub === 'rotate-password') {
    if (rest.length) throw new UsageError('Usage: perch whatsapp rotate-password [--dir PATH]');
    const dir = typeof values.dir === 'string' ? values.dir : undefined;
    await rotateGowaPassword({ dir }, gowaDeps());
    return;
  }
  if (sub === 'instance') {
    const action = rest[0];
    if (action === 'show') {
      const inst = (await store.read()).whatsappInstance;
      return io.stdout(inst ? `WhatsApp bridge: ${inst.origin} (basic auth user set; password stored encrypted), configured ${inst.createdAt}\n` : 'No WhatsApp bridge configured.\n');
    }
    if (action !== 'set') throw new UsageError('Usage: perch whatsapp instance set --url URL | show');
    if (typeof values.url !== 'string') throw new UsageError('--url is required, e.g. http://127.0.0.1:3000');
    const username = await io.readSecret('GOWA basic-auth username (input hidden): ');
    const password = await io.readSecret('GOWA basic-auth password (input hidden): ');
    const r = await setWhatsappInstance(store, upstream, { url: values.url, username, password });
    return io.stdout(`WhatsApp bridge ${r.origin} verified (${r.devices} device slot(s)) and stored.\n`);
  }
  if (sub === 'list') return io.stdout(formatAccounts(await store.read(), 'whatsapp'));
  if (sub === 'status') {
    const rows = await whatsappDeviceStatus(store, upstream);
    if (!rows.length) return io.stdout('No WhatsApp accounts.\n');
    return io.stdout(
      `${rows
        .map((r) => `  ${r.account.id}  "${r.account.label}"  ${r.error ? `error: ${r.error}` : `${r.loggedIn ? 'logged in' : 'NOT logged in (pair again)'}, ${r.connected ? 'connected' : 'disconnected'}`}`)
        .join('\n')}\n`,
    );
  }
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch whatsapp remove ID [--keep-device]');
    const deleted = await removeWhatsappAccount(store, upstream, id, { keepDevice: values['keep-device'] === true });
    io.stdout(
      `Removed ${id} locally. ` +
        (values['keep-device'] === true
          ? 'Its device slot was kept in the bridge (still linked).\n'
          : deleted
            ? 'Its device slot was deleted in the bridge: unlinked from the phone, stored chats cleared.\n'
            : 'The bridge could not delete its device slot: unlink "Perch" under WhatsApp > Linked devices on the phone.\n'),
    );
    return;
  }
  if (sub !== 'add') throw new UsageError('Usage: perch whatsapp install|rotate-password|instance|add|list|status|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  if (typeof values.phone !== 'string') throw new UsageError('--phone is required (international format, e.g. +4366012345678)');
  const timeout = values.timeout === undefined ? DEFAULT_PAIR_TIMEOUT_MS / 1000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) throw new UsageError('--timeout must be 30-900 seconds');
  const account = await pairWhatsappAccount(store, upstream, {
    label: values.label,
    phone: values.phone,
    timeoutMs: timeout * 1000,
    sleep: io.sleep,
    onCode: (code) =>
      io.stdout(
        `Pairing code: ${code}\nOn the phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", ` +
          `then enter the code. Waiting up to ${timeout} s...\n`,
      ),
  });
  io.stdout(
    `Connected WhatsApp account ${account.id} "${account.label}"${account.jid ? ` (${account.jid})` : ''}.\n` +
      'Reading is available to the global token; sending needs a client grant: ' +
      `perch client add --label NAME --allow whatsapp_read,whatsapp_send --account ${account.id}\n`,
  );
}

async function cmdStatus(config: PerchConfig, io: CliIo, values: Record<string, unknown>): Promise<number> {
  const store = await openStore(config);
  const ctx = createPerchContext(store, io.transport ?? createFetchTransport(), undefined, lumaMcpFor(io));
  const report = await collectStatus(ctx, { live: values['no-check'] !== true, ...(io.imapVerify ? { imapVerify: io.imapVerify } : {}) });
  io.stdout(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatStatusText(report));
  return failedChecks(report) ? 1 : 0;
}

async function cmdClient(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const store = await openStore(config);
  if (sub === 'list') {
    const { clients } = await store.read();
    const lines = ['Client grants:'];
    if (!clients.length) lines.push('  (none)');
    for (const c of clients) {
      lines.push(
        c.full
          ? `  ${c.id}  "${c.label}"  FULL access (all capabilities, all accounts incl. later ones)  created ${c.createdAt}`
          : `  ${c.id}  "${c.label}"  ${c.capabilities.join(',')}  accounts ${c.accountIds.join(',')}  created ${c.createdAt}`,
      );
    }
    return io.stdout(`${lines.join('\n')}\n`);
  }
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw new UsageError('Usage: perch client remove ID');
    await removeClientGrant(store, id);
    return io.stdout(`Removed client ${id}; its token stops working immediately. Delete its token file.\n`);
  }
  if (sub !== 'add') throw new UsageError('Usage: perch client add|list|remove');
  if (typeof values.label !== 'string') throw new UsageError('--label is required');
  const tokenFileFor = () =>
    path.resolve(
      typeof values['token-file'] === 'string'
        ? values['token-file']
        : path.join(path.dirname(config.tokenFile), 'clients', `${randomBytes(4).toString('hex')}.token`),
    );
  if (values.full === true) {
    if (values.allow !== undefined || values.account !== undefined) throw new UsageError('--full replaces --allow and --account; use one or the other');
    const tokenFile = tokenFileFor();
    const { client } = await createClientGrant(store, { label: values.label, capabilities: [], accountIds: [], tokenFile, full: true });
    io.stdout(
      `Created client ${client.id} "${client.label}" with FULL access: read and write on every connected account, including accounts connected later.\n` +
        `Its bearer token was written to ${tokenFile} (0600) and is not shown here. Revoke with: perch client remove ${client.id}\n` +
        claudeAddCommand(config, tokenFile),
    );
    return;
  }
  if (typeof values.allow !== 'string') {
    throw new UsageError(
      '--allow is required (comma separated: read,draft,send for mail; calendar_read,calendar_write,calendar_invite,contacts_read for gprod accounts; ' +
        'slack_read,slack_send for slack accounts; whatsapp_read,whatsapp_send for whatsapp accounts)',
    );
  }
  const accounts = (values.account as string[] | undefined) ?? [];
  if (!accounts.length) throw new UsageError('--account is required (repeat for several accounts)');
  const capabilities = parseCapabilities(values.allow.split(','));
  const tokenFile = path.resolve(
    typeof values['token-file'] === 'string'
      ? values['token-file']
      : path.join(path.dirname(config.tokenFile), 'clients', `${randomBytes(4).toString('hex')}.token`),
  );
  const { client } = await createClientGrant(store, { label: values.label, capabilities, accountIds: accounts, tokenFile });
  io.stdout(
    `Created client ${client.id} "${client.label}" (${client.capabilities.join(',')}) for ${client.accountIds.join(', ')}.\n` +
      `Its bearer token was written to ${tokenFile} (0600) and is not shown here.\n` +
      'HTTP: send it as "Authorization: Bearer <token>". stdio: set PERCH_CLIENT_TOKEN_FILE to that file.\n',
  );
}

const describeActor = (a: Actor) =>
  a.kind === 'client' ? `client ${a.clientId}` : a.kind === 'local_admin' ? 'local admin' : a.kind === 'oauth' ? `public access${a.deviceId ? ` ${a.deviceId}` : ''}` : 'operator (read-only)';

function optOne(values: Record<string, unknown>, name: string, pattern: RegExp, what: string): string | undefined {
  const v = values[name];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  if (list.length > 1 || (list.length === 1 && (typeof list[0] !== 'string' || !pattern.test(list[0])))) throw new UsageError(`--${name} must be one ${what}`);
  return list[0] as string | undefined;
}

async function cmdAudit(config: PerchConfig, io: CliIo, sub: string | undefined, values: Record<string, unknown>) {
  if (sub !== 'list') throw new UsageError('Usage: perch audit list [--limit N] [--client ID] [--account ID]');
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!/^\d+$/.test(String(values.limit)) || limit < 1 || limit > MAX_AUDIT_EVENTS) throw new UsageError(`--limit must be 1-${MAX_AUDIT_EVENTS}`);
  }
  const clientId = optOne(values, 'client', /^client-[a-f0-9]{8}$/, 'client id (client-…)');
  const accountId = optOne(values, 'account', ACCOUNT_ID_PATTERN, 'account id');
  const store = await openStore(config);
  const { events, dropped, total } = await new AuditLog(new MailWorkflowLedger(store)).list({
    ...(clientId ? { clientId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(limit ? { limit } : {}),
  });
  const lines = [
    `Audit events (namespace ${store.namespace}; oldest first; ${events.length} of ${total} shown` +
      `${dropped ? `; ${dropped} older events were dropped (ring of ${MAX_AUDIT_EVENTS})` : ''}). No content, recipients or credentials are recorded:`,
  ];
  if (!events.length) lines.push('  (none)');
  for (const e of events) {
    const account = e.accountId ? `${e.accountId} (${e.provider})` : '-';
    lines.push(`  ${e.at}  ${e.operationId}  ${e.type}  ${e.outcome}  ${describeActor(e.actor)}  ${account}${e.code ? `  ${e.code}` : ''}`);
  }
  io.stdout(`${lines.join('\n')}\n`);
}

async function cmdMailWorkflow(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  if (sub === 'init') {
    const store = await openStore(config);
    if (!(await initMailWorkflowLedger(store))) {
      throw new PerchError(`Mail workflow ledger ${ledgerFilePath(store.storePaths.dataDir)} already exists; refusing to overwrite it`, 'ledger_exists');
    }
    return io.stdout(`Created mail workflow ledger: ${ledgerFilePath(store.storePaths.dataDir)} (namespace ${store.namespace})\n`);
  }
  if (sub === 'list') {
    const state = values.state;
    if (state !== undefined && !(SEND_STATES as readonly unknown[]).includes(state)) throw new UsageError(`--state must be one of ${SEND_STATES.join(', ')}`);
    const store = await openStore(config);
    const sends = (await new MailWorkflowLedger(store).read()).sends.filter((r) => state === undefined || r.state === state);
    const lines = [
      `Send records (namespace ${store.namespace}). "accepted" = accepted by the provider, not proof of delivery; ` +
        '"pending"/"indeterminate" = outcome unknown, never resent:',
    ];
    if (!sends.length) lines.push('  (none)');
    for (const r of sends) {
      lines.push(
        `  ${r.operationId}  ${r.state}  ${r.accountId} (${r.provider})  ${describeActor(r.actor)}  created ${r.createdAt}` +
          `${r.finalizedAt ? `  finalized ${r.finalizedAt}` : ''}${r.reason ? `  ${r.reason}` : ''}` +
          `${r.resolution ? `  resolved: ${r.resolution.outcome === 'sent' ? 'sent' : 'not sent'} ${r.resolution.at}` : ''}`,
      );
    }
    return io.stdout(`${lines.join('\n')}\n`);
  }
  if (sub === 'resolve') {
    const op = rest[0];
    if (!op || !OPERATION_ID_PATTERN.test(op)) throw new UsageError('Usage: perch mail-workflow resolve OPERATION_ID --outcome sent|not-sent');
    if (values.outcome !== 'sent' && values.outcome !== 'not-sent') throw new UsageError('--outcome must be sent or not-sent (after checking the Sent folder)');
    const outcome = values.outcome === 'sent' ? 'sent' : 'not_sent';
    const store = await openStore(config);
    await resolveSend(new MailWorkflowLedger(store), op, outcome);
    return io.stdout(
      `Recorded for ${op}: verified ${outcome === 'sent' ? 'sent' : 'not sent'}. Nothing was sent; the requestId stays used, so a client ` +
        'must use a new requestId to send again.\n',
    );
  }
  if (sub === 'prune') {
    // Refused before opening anything: forgetting a requestId would allow a duplicate send.
    throw new PerchError(PRUNE_REFUSED, 'prune_unsupported');
  }
  throw new UsageError('Usage: perch mail-workflow list|resolve|init');
}

async function cmdToken(config: PerchConfig, io: CliIo, sub: string | undefined) {
  if (sub !== 'rotate') throw new UsageError('Usage: perch token rotate');
  await ensurePrivateDir(path.dirname(config.tokenFile));
  await writePrivateFileAtomic(config.tokenFile, Buffer.from(`${generateHttpToken()}\n`));
  io.stdout(`Wrote a new HTTP token to ${config.tokenFile}. Restart \`perch serve --http\` and update the client header.\n`);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.some((a) => SECRET_FLAG.test(a))) {
    io.stderr('Secrets are never accepted as command-line arguments. Use the masked prompt, a 0600 file or env vars.\n');
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        stdio: { type: 'boolean' },
        http: { type: 'boolean' },
        host: { type: 'string' },
        port: { type: 'string' },
        label: { type: 'string' },
        timeout: { type: 'string' },
        'login-hint': { type: 'string' },
        revoke: { type: 'boolean' },
        'allow-send': { type: 'boolean' },
        'allow-drafts': { type: 'boolean' },
        'allow-calendar-write': { type: 'boolean' },
        services: { type: 'string' },
        'redirect-host': { type: 'string' },
        email: { type: 'string' },
        username: { type: 'string' },
        preset: { type: 'string' },
        'imap-host': { type: 'string' },
        'imap-port': { type: 'string' },
        'smtp-host': { type: 'string' },
        'smtp-port': { type: 'string' },
        'smtp-security': { type: 'string' },
        'drafts-mailbox': { type: 'string' },
        allow: { type: 'string' },
        account: { type: 'string', multiple: true },
        'token-file': { type: 'string' },
        limit: { type: 'string' },
        client: { type: 'string' },
        state: { type: 'string' },
        outcome: { type: 'string' },
        before: { type: 'string' },
        url: { type: 'string' },
        phone: { type: 'string' },
        'keep-device': { type: 'boolean' },
        'no-check': { type: 'boolean' },
        'read-all': { type: 'boolean' },
        'allow-write': { type: 'boolean' },
        'allow-modify': { type: 'boolean' },
        'no-sent-copy': { type: 'boolean' },
        write: { type: 'boolean' },
        'read-only': { type: 'boolean' },
        full: { type: 'boolean' },
        public: { type: 'boolean' },
        name: { type: 'string' },
        redirect: { type: 'string', multiple: true },
        cimd: { type: 'string' },
        all: { type: 'boolean' },
        accept: { type: 'boolean' },
        json: { type: 'boolean' },
        yes: { type: 'boolean' },
        dir: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch {
    io.stderr(`Invalid arguments.\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, sub, ...rest] = positionals;
  if (values.version) {
    io.stdout(`${PERCH_VERSION}\n`);
    return 0;
  }
  if (values.help || !cmd || cmd === 'help') {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const config = resolveConfig(io.env);
    let wantsWrite = false;
    if (sub === 'add' && WRITE_FLAGS[cmd]) wantsWrite = await chooseAccess(cmd, values as Record<string, unknown>, io.readLine, io.stderr);
    if (wantsWrite) {
      io.stdout('Requesting read and write permissions from the provider. Clients still need a grant to write: perch client add --label NAME --full\n');
    }
    switch (cmd) {
      case 'init':
        await cmdInit(config, io);
        return 0;
      case 'serve':
        return await cmdServe(config, io, values);
      case 'oauth':
        return await cmdOauth(config, io, sub, rest, values);
      case 'luma':
        await cmdLuma(config, io, sub, rest, values);
        return 0;
      case 'public':
        return await cmdPublic(config, io, sub);
      case 'setup':
        return await runSetup(config, io, (argv) => runCli(argv, io), {
          whatsappConfigured: async () => Boolean((await (await openStore(config)).read()).whatsappInstance),
        });
      case 'status':
        return await cmdStatus(config, io, values);
      case 'accounts':
        io.stdout(formatAccounts(await (await openStore(config)).read(), 'all'));
        return 0;
      case 'google':
        await cmdGoogle(config, io, sub, rest, values);
        return 0;
      case 'notion':
        await cmdNotion(config, io, sub, rest, values);
        return 0;
      case 'gmail':
        await cmdGmail(config, io, sub, rest, values);
        return 0;
      case 'microsoft':
        await cmdMicrosoft(config, io, sub, rest, values);
        return 0;
      case 'imap':
        await cmdImap(config, io, sub, rest, values);
        return 0;
      case 'google-productivity':
        await cmdProductivity(config, io, sub, rest, values);
        return 0;
      case 'slack':
        await cmdSlack(config, io, sub, rest, values);
        return 0;
      case 'whatsapp':
        await cmdWhatsapp(config, io, sub, rest, values);
        return 0;
      case 'client':
        await cmdClient(config, io, sub, rest, values);
        return 0;
      case 'token':
        await cmdToken(config, io, sub);
        return 0;
      case 'audit':
        await cmdAudit(config, io, sub, values);
        return 0;
      case 'mail-workflow':
        await cmdMailWorkflow(config, io, sub, rest, values);
        return 0;
      default:
        throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    io.stderr(`perch: ${safeMessage(err)}\n`);
    return 1;
  }
}
