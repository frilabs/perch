import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadHttpToken, resolveConfig, type PerchConfig } from '../config.js';
import { createPerchContext } from '../context.js';
import { PerchError, safeMessage } from '../errors.js';
import { registerGoogleAccount, removeGoogleAccount } from '../google/accounts.js';
import { DEFAULT_AUTH_TIMEOUT_MS, MAX_AUTH_TIMEOUT_MS, parseClientFile, runLoopbackAuthorization } from '../google/oauth.js';
import { generateHttpToken, startHttpServer, validateHttpToken } from '../mcp/http.js';
import { createMcpServer } from '../mcp/server.js';
import { addNotionWorkspace, removeNotionWorkspace } from '../notion/notion.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic, writePrivateFileExclusive } from '../secureFs.js';
import { CredentialStore, initStore, type StoreData } from '../store/credentialStore.js';
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
}

const USAGE = `perch ${PERCH_VERSION} - read-only Google Drive + Notion MCP server

Usage:
  perch init                                   create key, encrypted store and HTTP token (if missing)
  perch serve --stdio                          MCP over stdio
  perch serve --http [--host IP] [--port N]    MCP over stateless Streamable HTTP (bearer auth)
  perch accounts                               list Google accounts and Notion workspaces
  perch google add --label NAME [--port N] [--timeout SECONDS] [--login-hint EMAIL]
  perch google list
  perch google remove ID [--revoke]
  perch notion add --label NAME                PAT is read via a masked terminal prompt
  perch notion list
  perch notion remove ID
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

function formatAccounts(data: StoreData, which: 'all' | 'google' | 'notion'): string {
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
    const server = createMcpServer(ctx);
    const closed = new Promise<void>((resolve) => {
      server.server.onclose = () => resolve();
    });
    await server.connect(new StdioServerTransport());
    io.stderr('perch: serving MCP over stdio\n');
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
