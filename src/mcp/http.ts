import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hasWriteCapability, principalForClientToken, READONLY_PRINCIPAL, type Principal } from '../auth/grants.js';
import type { PerchContext } from '../context.js';
import { PerchError } from '../errors.js';
import { createMcpServer } from './server.js';

export const MIN_TOKEN_LENGTH = 43; // 32 random bytes as base64url
const MAX_BODY_BYTES = 1024 * 1024;
/** Draft/send clients may upload inline base64 attachments (10 MiB decoded is ~13.4 MiB base64). */
const MAX_WRITE_BODY_BYTES = 16 * 1024 * 1024;
const MCP_PATH = '/mcp';

export function generateHttpToken(): string {
  return randomBytes(32).toString('base64url');
}

export function validateHttpToken(token: string | undefined): string {
  const t = token?.trim();
  if (!t) throw new PerchError('No HTTP bearer token configured. Run `perch init` or set PERCH_HTTP_TOKEN_FILE.', 'no_token');
  if (t.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9._~+/=-]+$/.test(t)) {
    throw new PerchError(`HTTP bearer token must be at least ${MIN_TOKEN_LENGTH} URL-safe characters (>= 32 random bytes)`, 'weak_token');
  }
  return t;
}

/** Loopback, or an explicit Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48). Never wildcard. */
export function validateBindHost(host: string): void {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    if (a === 127) return;
    if (a === 100 && b >= 64 && b <= 127) return;
  } else if (v === 6) {
    if (h === '::1') return;
    if (h.startsWith('fd7a:115c:a1e0:')) return;
  }
  throw new PerchError(
    `Refusing to bind to ${JSON.stringify(host)}: use loopback (default 127.0.0.1) or an explicit Tailscale IP`,
    'bad_bind_host',
  );
}

const isLoopback = (h: string) => h === 'localhost' || h === '::1' || h.startsWith('127.');
const hostPort = (h: string, port: number) => (isIP(h) === 6 ? `[${h}]:${port}` : `${h}:${port}`);

/**
 * The global token is the single operator in READ-ONLY mode. Any other well-formed token is
 * looked up as a local client grant (hash lookup; tokens carry 256 bits of entropy).
 */
async function authenticate(header: string | undefined, expectedDigest: Buffer, ctx: PerchContext): Promise<Principal | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const got = createHash('sha256').update(m?.[1] ?? '').digest();
  // Always compare (constant time on fixed-size digests), then require a well-formed header.
  if (timingSafeEqual(got, expectedDigest) && m !== null) return READONLY_PRINCIPAL;
  if (!m || m[1]!.length < MIN_TOKEN_LENGTH) return null;
  return principalForClientToken(ctx.store, m[1]!);
}

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string;
  context: PerchContext;
  /** Extra exact Host header values, e.g. the Tailscale Serve MagicDNS name. */
  allowedHosts?: string[];
  /** Exact Origin values; a request carrying any other Origin is rejected. */
  allowedOrigins?: string[];
  log?: (line: string) => void;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  allowedHosts: string[];
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = Number(req.headers['content-length'] ?? 0) > limit;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) tooLarge = true;
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => resolve(tooLarge ? 'too_large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Stateless Streamable HTTP: one MCP server + transport per POST, JSON responses. */
export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  validateBindHost(opts.host);
  const tokenDigest = createHash('sha256').update(validateHttpToken(opts.token)).digest();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  let allowedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts.has(host)) {
        log(`perch: rejected request with Host ${JSON.stringify(host.slice(0, 100))} (add it to PERCH_ALLOWED_HOSTS if legitimate)`);
        return sendJson(res, 403, rpcError(-32000, 'Forbidden host'));
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        log('perch: rejected request with a disallowed Origin');
        return sendJson(res, 403, rpcError(-32000, 'Forbidden origin'));
      }
      const principal = await authenticate(req.headers.authorization, tokenDigest, opts.context);
      if (!principal) {
        return sendJson(res, 401, rpcError(-32001, 'Unauthorized'), { 'www-authenticate': 'Bearer realm="perch"' });
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== MCP_PATH) return sendJson(res, 404, rpcError(-32000, 'Not found'));
      if (req.method !== 'POST') {
        return sendJson(res, 405, rpcError(-32000, 'Method not allowed (stateless server: POST only)'), { allow: 'POST' });
      }
      const body = await readBody(req, hasWriteCapability(principal) ? MAX_WRITE_BODY_BYTES : MAX_BODY_BYTES);
      if (body === 'too_large') return sendJson(res, 413, rpcError(-32000, 'Request body too large'));
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, rpcError(-32700, 'Parse error'));
      }

      const mcp = createMcpServer(opts.context, principal);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [...allowedHosts],
        ...(allowedOrigins.size ? { allowedOrigins: [...allowedOrigins] } : {}),
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      log('perch: internal error while handling an HTTP request');
      sendJson(res, 500, rpcError(-32603, 'Internal error'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hosts = [hostPort(opts.host.toLowerCase(), port)];
  if (isLoopback(opts.host.toLowerCase())) hosts.push(`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`);
  for (const h of opts.allowedHosts ?? []) if (h.trim()) hosts.push(h.trim().toLowerCase());
  allowedHosts = new Set(hosts);

  return {
    url: `http://${hostPort(opts.host, port)}${MCP_PATH}`,
    port,
    allowedHosts: [...allowedHosts],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
