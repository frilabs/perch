import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PerchError } from '../errors.js';
import type { Upstream } from '../upstream.js';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALLBACK_PATH = '/oauth2/callback';
export const DEFAULT_AUTH_TIMEOUT_MS = 300_000;
/** Upper bound (also keeps setTimeout far below its 2^31 ms overflow). */
export const MAX_AUTH_TIMEOUT_MS = 3_600_000;

export interface GoogleClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface AuthorizationResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

/** Parses the JSON downloaded for a Google Cloud "Desktop app" OAuth client. */
export function parseClientFile(contents: string): GoogleClientCredentials {
  try {
    const parsed = JSON.parse(contents) as { installed?: { client_id?: unknown; client_secret?: unknown } };
    const c = parsed.installed;
    if (c && typeof c.client_id === 'string' && typeof c.client_secret === 'string' && c.client_id && c.client_secret) {
      return { clientId: c.client_id, clientSecret: c.client_secret };
    }
  } catch {
    // fall through
  }
  throw new PerchError(
    'Google client file must be the JSON of an OAuth client of type "Desktop app" (top-level "installed" key)',
    'bad_client_file',
  );
}

const b64url = (b: Buffer) => b.toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function grantedScopes(tok: GoogleTokenResponse): string[] {
  return (tok.scope ?? '').split(/\s+/).filter(Boolean);
}

/** Validates an authorization_code token response: offline refresh token + drive.readonly granted. */
export function assertUsableGrant(tok: GoogleTokenResponse): AuthorizationResult {
  if (!tok.access_token) throw new PerchError('Google did not return an access token', 'oauth_incomplete');
  if (!tok.refresh_token) {
    throw new PerchError(
      'Google did not return a refresh token. Remove Perch under https://myaccount.google.com/permissions and retry.',
      'oauth_no_refresh_token',
    );
  }
  const scopes = grantedScopes(tok);
  if (!scopes.includes(DRIVE_READONLY_SCOPE)) {
    throw new PerchError(
      `The ${DRIVE_READONLY_SCOPE} permission was not granted. Retry and tick the Drive checkbox on the consent screen.`,
      'oauth_scope_missing',
    );
  }
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in ?? 0) * 1000,
    scopes,
  };
}

export interface LoopbackOptions {
  client: GoogleClientCredentials;
  upstream: Upstream;
  /** 0 = random free port. Use a fixed port when forwarding it over SSH (`ssh -L`). */
  port?: number;
  timeoutMs?: number;
  loginHint?: string;
  onAuthUrl: (url: string) => void;
}

/**
 * Desktop-app OAuth: loopback redirect on 127.0.0.1, random state, PKCE S256.
 * The state is verified before the code is ever exchanged.
 */
export async function runLoopbackAuthorization(opts: LoopbackOptions): Promise<AuthorizationResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AUTH_TIMEOUT_MS) {
    throw new PerchError(`OAuth timeout must be positive and at most ${MAX_AUTH_TIMEOUT_MS / 1000} seconds`, 'bad_argument');
  }
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  let done = false;

  const server = createServer((req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return reply(404, 'Not found');
    if (done) return reply(410, 'This authorization request is no longer active.');
    const gotState = url.searchParams.get('state');
    if (!gotState || !safeEqual(gotState, state)) return reply(400, 'Invalid or missing state. Ignored.');
    const error = url.searchParams.get('error');
    if (error) {
      done = true;
      reply(400, 'Authorization was not granted. You can close this window.');
      const code = /^[a-z_]{1,64}$/.test(error) ? error : 'unknown_error';
      return settle.reject(new PerchError(`Google authorization failed: ${code}`, 'oauth_denied'));
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
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;
  const timer = setTimeout(() => {
    done = true;
    settle.reject(new PerchError('Timed out waiting for the Google authorization', 'oauth_timeout'));
  }, timeoutMs);

  try {
    const auth = new URL(AUTH_ENDPOINT);
    auth.search = new URLSearchParams({
      client_id: opts.client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_READONLY_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    }).toString();
    opts.onAuthUrl(auth.toString());

    const code = await codePromise;
    const tok = await opts.upstream.json<GoogleTokenResponse>('oauth', {
      method: 'POST',
      path: '/token',
      form: {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: opts.client.clientId,
        client_secret: opts.client.clientSecret,
      },
    });
    return assertUsableGrant(tok);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

export async function refreshAccessToken(
  upstream: Upstream,
  client: GoogleClientCredentials,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  return upstream.json<GoogleTokenResponse>('oauth', {
    method: 'POST',
    path: '/token',
    form: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
}

/** Revokes the grant at Google (refresh token revocation revokes the whole grant). */
export async function revokeToken(upstream: Upstream, token: string): Promise<void> {
  await upstream.raw('oauth', { method: 'POST', path: '/revoke', form: { token } });
}
