import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClientGrant, parseCapabilities, principalForClientToken, READONLY_PRINCIPAL, removeClientGrant } from '../auth/grants.js';
import { loadHttpToken, resolveConfig, type PerchConfig } from '../config.js';
import { createPerchContext } from '../context.js';
import { PerchError, safeMessage } from '../errors.js';
import { registerGoogleAccount, removeGoogleAccount } from '../google/accounts.js';
import { DEFAULT_AUTH_TIMEOUT_MS, MAX_AUTH_TIMEOUT_MS, parseClientFile, runLoopbackAuthorization } from '../google/oauth.js';
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
import { generateHttpToken, startHttpServer, validateHttpToken } from '../mcp/http.js';
import { createMcpServer } from '../mcp/server.js';
import { registerMicrosoftAccount, removeMicrosoftAccount } from '../microsoft/accounts.js';
import { runMicrosoftAuthorization, validateTenant } from '../microsoft/oauth.js';
import { addNotionWorkspace, removeNotionWorkspace } from '../notion/notion.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic, writePrivateFileExclusive } from '../secureFs.js';
import { CredentialStore, initStore, type ImapAccount, type StoreData } from '../store/credentialStore.js';
import { createFetchTransport, Upstream, type UpstreamTransport } from '../upstream.js';
import { PERCH_VERSION } from '../version.js';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Masked secret input (TTY only in production). */
  readSecret: (prompt: string) => Promise<string>;
  /** Tests inject a MOCK upstream transport; production always uses fetch to fixed origins. */
  transport?: UpstreamTransport;
  /** Tests inject a MOCK IMAP/SMTP login check; production logs in to the real servers over TLS. */
  imapVerify?: (account: ImapAccount) => Promise<void>;
}

const USAGE = `perch ${PERCH_VERSION} - Google Drive + Notion + mail + Calendar/Contacts MCP server (read-only unless a client grant allows more)

Usage:
  perch init                                   create key, encrypted store and HTTP token (if missing)
  perch serve --stdio                          MCP over stdio (read-only; PERCH_CLIENT_TOKEN_FILE selects a client grant)
  perch serve --http [--host IP] [--port N]    MCP over stateless Streamable HTTP (bearer auth)
  perch accounts                               list all connected accounts
  perch google add --label NAME [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch google list | remove ID [--revoke]
  perch notion add --label NAME                PAT is read via a masked terminal prompt
  perch notion list | remove ID
  perch gmail add --label NAME [--allow-drafts] [--allow-send] [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch gmail list | remove ID [--revoke]
  perch microsoft add --label NAME [--allow-drafts] [--allow-send] [--port N] [--timeout SECONDS]
                      [--redirect-host localhost|127.0.0.1] [--login-hint EMAIL]
  perch microsoft list | remove ID
  perch imap add --label NAME --email ADDRESS [--username USER] [--preset gmx|gmx-com]
                 [--imap-host H --imap-port N --smtp-host H --smtp-port N --smtp-security tls|starttls]
                 [--allow-drafts] [--allow-send] [--drafts-mailbox NAME]   password via masked prompt
  perch imap presets | list | remove ID
  perch google-productivity add --label NAME --services calendar,contacts [--allow-calendar-write]
                      [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch google-productivity list | remove ID [--revoke]
  perch client add --label NAME --allow CAPS --account ID [--account ID ...] [--token-file PATH]
                      CAPS: read,draft,send (mail accounts); calendar_read,calendar_write,contacts_read (gprod accounts)
  perch client list | remove ID
  perch token rotate                           replace the HTTP bearer token file

Configuration is read from environment variables (see .env.example). Secrets are never
accepted as command-line arguments.`;

const SECRET_FLAG = /^--?(token|pat|secret|client-secret|refresh-token|access-token|password|key|api-key)(=|$)/i;

class UsageError extends PerchError {
  constructor(message: string) {
    super(message, 'usage');
  }
}

async function openStore(config: PerchConfig) {
  return CredentialStore.open({ dataDir: config.dataDir, keyFile: config.keyFile });
}

type AccountSection = 'all' | 'google' | 'notion' | 'gmail' | 'microsoft' | 'imap' | 'productivity';

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
          extra: `${a.imap.host}/${a.smtp.host}; drafts ${a.allowDrafts ? 'on' : 'off'}, send ${a.allowSend ? 'on' : 'off'}`,
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
  if (which === 'all') lines.push(...formatMail(data, 'all'), ...formatProductivity(data));
  return `${lines.join('\n')}\n`;
}

async function cmdInit(config: PerchConfig, io: CliIo) {
  const r = await initStore({ dataDir: config.dataDir, keyFile: config.keyFile });
  io.stdout(`${r.createdKey ? 'Created' : 'Kept existing'} key file: ${config.keyFile}\n`);
  io.stdout(`${r.createdStore ? 'Created' : 'Kept existing'} encrypted store: ${path.join(config.dataDir, 'store.enc')}\n`);
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
  const store = await openStore(config);
  const ctx = createPerchContext(store, io.transport ?? createFetchTransport());
  if (values.stdio) {
    // Plain stdio is the read-only operator; a client token file selects that client's grant.
    let principal = READONLY_PRINCIPAL;
    if (config.clientTokenFile) {
      const token = (await readPrivateFile(config.clientTokenFile)).toString('utf8').trim();
      const p = await principalForClientToken(store, token);
      if (!p) throw new PerchError('PERCH_CLIENT_TOKEN_FILE does not hold a known client token (perch client list)', 'unknown_client');
      principal = p;
    }
    const server = createMcpServer(ctx, principal);
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
  const running = await startHttpServer({
    host: (values.host as string | undefined) ?? config.httpHost,
    port,
    token: await loadHttpToken(config),
    context: ctx,
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
  const grant = await runLoopbackAuthorization({
    client,
    upstream,
    port,
    timeoutMs,
    ...(typeof values['login-hint'] === 'string' ? { loginHint: values['login-hint'] } : {}),
    onAuthUrl: (url) => {
      const p = new URL(new URL(url).searchParams.get('redirect_uri')!).port;
      io.stderr(
        `Open this URL in a browser and approve read-only Drive access for the account you want to add:\n\n${url}\n\n` +
          `The browser must reach http://127.0.0.1:${p} on this machine. If the browser runs elsewhere, ` +
          `forward the port first: ssh -L ${p}:127.0.0.1:${p} <this-server>\n` +
          `Waiting up to ${Math.round(timeoutMs / 1000)}s...\n`,
      );
    },
  });
  const account = await registerGoogleAccount(store, upstream, { label: values.label, client, grant });
  io.stdout(`Connected Google account ${account.id} (${account.email}) as "${account.label}".\n`);
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
  const extra = [values['allow-drafts'] ? 'drafts' : '', values['allow-send'] ? 'send' : ''].filter(Boolean);
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
  const scopes = gmailScopesFor({ send: Boolean(values['allow-send']), drafts: Boolean(values['allow-drafts']) });
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
  if (allowCalendarWrite) io.stdout(`Calendar writes additionally need a client grant: perch client add --allow calendar_read,calendar_write --account ${account.id}\n`);
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
      `(drafts ${account.allowDrafts ? 'on' : 'off'}, send ${account.allowSend ? 'on' : 'off'}).\n`,
  );
}

async function cmdClient(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>) {
  const store = await openStore(config);
  if (sub === 'list') {
    const { clients } = await store.read();
    const lines = ['Client grants:'];
    if (!clients.length) lines.push('  (none)');
    for (const c of clients) lines.push(`  ${c.id}  "${c.label}"  ${c.capabilities.join(',')}  accounts ${c.accountIds.join(',')}  created ${c.createdAt}`);
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
  if (typeof values.allow !== 'string') {
    throw new UsageError('--allow is required (comma separated: read,draft,send for mail; calendar_read,calendar_write,contacts_read for gprod accounts)');
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
    switch (cmd) {
      case 'init':
        await cmdInit(config, io);
        return 0;
      case 'serve':
        return await cmdServe(config, io, values);
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
      case 'client':
        await cmdClient(config, io, sub, rest, values);
        return 0;
      case 'token':
        await cmdToken(config, io, sub);
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
