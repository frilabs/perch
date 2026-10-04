import { PerchError } from './errors.js';

/**
 * All outbound HTTP goes through here. Origins are fixed constants and every (method, path)
 * must match a read-only allowlist before any network I/O. There is no way to point Perch at
 * an arbitrary URL; tests swap the transport function, never the origins.
 */

export type Service = 'drive' | 'oauth' | 'notion';

export const ORIGINS: Readonly<Record<Service, string>> = Object.freeze({
  drive: 'https://www.googleapis.com',
  oauth: 'https://oauth2.googleapis.com',
  notion: 'https://api.notion.com',
});

const SERVICE_NAMES: Record<Service, string> = {
  drive: 'Google Drive API',
  oauth: 'Google OAuth',
  notion: 'Notion API',
};

const NOTION_ID = '[0-9a-fA-F-]{32,36}';
const DRIVE_ID = '[A-Za-z0-9_-]{1,200}';

const ROUTES: Record<Service, Array<[string, RegExp]>> = {
  drive: [
    ['GET', /^\/drive\/v3\/about$/],
    ['GET', /^\/drive\/v3\/files$/],
    ['GET', new RegExp(`^/drive/v3/files/${DRIVE_ID}$`)],
    ['GET', new RegExp(`^/drive/v3/files/${DRIVE_ID}/export$`)],
  ],
  oauth: [
    ['POST', /^\/token$/],
    ['POST', /^\/revoke$/],
  ],
  notion: [
    ['GET', /^\/v1\/users\/me$/],
    ['POST', /^\/v1\/search$/],
    ['GET', new RegExp(`^/v1/pages/${NOTION_ID}$`)],
    ['GET', new RegExp(`^/v1/blocks/${NOTION_ID}/children$`)],
    ['GET', new RegExp(`^/v1/databases/${NOTION_ID}$`)],
    ['GET', new RegExp(`^/v1/data_sources/${NOTION_ID}$`)],
    ['POST', new RegExp(`^/v1/data_sources/${NOTION_ID}/query$`)],
  ],
};

export const DEFAULT_JSON_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface UpstreamRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers: Record<string, string>;
  body?: string;
  maxBytes: number;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type UpstreamTransport = (req: UpstreamRequest) => Promise<UpstreamResponse>;

export class UpstreamError extends PerchError {
  constructor(
    message: string,
    readonly status: number,
    readonly upstreamCode: string | undefined,
    /** Sanitised Retry-After in seconds (delta-seconds form only), if the upstream sent one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message, 'upstream_error');
  }
}

function parseRetryAfter(value: string | undefined): number | undefined {
  return value !== undefined && /^\d{1,7}$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

/** Production transport: global fetch, no redirects, hard timeout, streamed size cap. */
export function createFetchTransport(opts: { timeoutMs?: number } = {}): UpstreamTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (req) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const mapErr = (err: unknown): never => {
      if (err instanceof PerchError) throw err;
      if (signal.aborted) throw new PerchError('Upstream request timed out', 'upstream_timeout');
      throw new PerchError('Upstream service unreachable', 'upstream_unreachable');
    };
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      return mapErr(err);
    }
    const tooLarge = () =>
      new PerchError(`Upstream response exceeds the ${req.maxBytes} byte limit`, 'response_too_large');
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > req.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > req.maxBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge();
          }
          chunks.push(Buffer.from(value));
        }
      }
    } catch (err) {
      return mapErr(err);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: Buffer.concat(chunks) };
  };
}

export interface CallOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  maxBytes?: number;
}

const SAFE_CODE = /^[A-Za-z_]{1,64}$/;

function extractCode(service: Service, body: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  let code: unknown;
  if (service === 'notion') code = o.code;
  else if (typeof o.error === 'string') code = o.error;
  else if (o.error && typeof o.error === 'object') {
    const e = o.error as { errors?: Array<{ reason?: unknown }>; status?: unknown };
    code = e.errors?.[0]?.reason ?? e.status;
  }
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

function statusHint(status: number): string {
  if (status === 401) return 'unauthorized: credential invalid, expired or revoked';
  if (status === 403) return 'forbidden or rate limited';
  if (status === 404) return 'not found or not accessible with this account';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'upstream service error';
  return 'request rejected';
}

export class Upstream {
  constructor(private readonly transport: UpstreamTransport) {}

  /** Performs an allowlisted call and returns the raw 2xx response; non-2xx become sanitised errors. */
  async raw(service: Service, opts: CallOptions): Promise<UpstreamResponse> {
    const allowed = ROUTES[service].some(([m, re]) => m === opts.method && re.test(opts.path));
    if (!allowed) {
      throw new PerchError(`Blocked non-allowlisted ${SERVICE_NAMES[service]} call`, 'route_not_allowed');
    }
    const url = new URL(opts.path, ORIGINS[service]);
    if (url.origin !== ORIGINS[service] || url.pathname !== opts.path) {
      throw new PerchError(`Blocked non-allowlisted ${SERVICE_NAMES[service]} call`, 'route_not_allowed');
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    }
    let res: UpstreamResponse;
    try {
      res = await this.transport({
        method: opts.method,
        url,
        headers,
        body,
        maxBytes: opts.maxBytes ?? DEFAULT_JSON_MAX_BYTES,
      });
    } catch (err) {
      if (err instanceof PerchError) throw err;
      throw new PerchError(`${SERVICE_NAMES[service]} unreachable`, 'upstream_unreachable');
    }
    if (res.status < 200 || res.status >= 300) {
      const code = extractCode(service, res.body);
      throw new UpstreamError(
        `${SERVICE_NAMES[service]} request failed (HTTP ${res.status}${code ? `, ${code}` : ''}): ${statusHint(res.status)}`,
        res.status,
        code,
        parseRetryAfter(res.headers['retry-after']),
      );
    }
    return res;
  }

  async json<T = unknown>(service: Service, opts: CallOptions): Promise<T> {
    const res = await this.raw(service, opts);
    try {
      return JSON.parse(res.body.toString('utf8')) as T;
    } catch {
      throw new PerchError(`${SERVICE_NAMES[service]} returned a malformed response`, 'upstream_bad_response');
    }
  }
}
