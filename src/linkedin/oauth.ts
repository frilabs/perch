import path from 'node:path';
import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { runPkceLoopback, type PasteRedirect } from '../oauth/loopback.js';
import { RefreshingTokenProvider, type TokenGrantResponse } from '../oauth/tokenProvider.js';
import { ensurePrivateDir, pathExists, readPrivateFile, writePrivateFileAtomic } from '../secureFs.js';
import type { CredentialStore, LinkedinAccount } from '../store/credentialStore.js';
import type { Upstream } from '../upstream.js';

/**
 * LinkedIn login (docs/LINKEDIN_X_SPEC.md): OAuth 2.0 authorization code flow (3-legged) with the operator's own
 * LinkedIn app (products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn"). One app per
 * installation (linkedin-client.json, 0600). Standard LinkedIn apps are confidential clients without PKCE, so the
 * login sends no code challenge; state is checked as for every other provider.
 */

export const LINKEDIN_OAUTH_PORT = 8770;
export const LINKEDIN_OAUTH_CALLBACK_PATH = '/linkedin/callback';
export const LINKEDIN_OAUTH_REDIRECT_URI = `http://localhost:${LINKEDIN_OAUTH_PORT}${LINKEDIN_OAUTH_CALLBACK_PATH}`;
export const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'] as const;
const TOKEN_PATH = '/oauth/v2/accessToken';
/** LinkedIn's documented access token lifetime (60 days) when a response carries no expires_in. */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_S = 60 * 24 * 3600;
const MAX_CLIENT_FILE_BYTES = 4096;

export interface LinkedinClient {
  clientId: string;
  clientSecret: string;
}

/** Default location: $XDG_CONFIG_HOME/perch/linkedin-client.json (~/.config/perch/…). */
export function defaultLinkedinClientFile(configHome: string): string {
  return path.join(configHome, 'perch', 'linkedin-client.json');
}

const SAFE_VALUE = /^[\x21-\x7e]{8,512}$/;

/** Checks pasted client values (printable, no whitespace, sane length). Never echoes them. */
export function parseLinkedinClient(raw: { clientId: string; clientSecret: string }): LinkedinClient {
  const clientId = raw.clientId.trim();
  const clientSecret = raw.clientSecret.trim();
  if (!SAFE_VALUE.test(clientId)) throw new PerchError('The Client ID looks wrong (copy it from the app\'s "Auth" tab)', 'usage');
  if (!SAFE_VALUE.test(clientSecret)) throw new PerchError('The Primary Client Secret looks wrong (copy it from the app\'s "Auth" tab)', 'usage');
  if (clientId === clientSecret) throw new PerchError('Client ID and Client Secret are the same value; copy each one separately', 'usage');
  return { clientId, clientSecret };
}

/** Reads the client file (owner-only, no symlink). Missing → PerchError 'not_found'; malformed → 'bad_client_file'. */
export async function readLinkedinClient(file: string): Promise<LinkedinClient> {
  const buf = await readPrivateFile(file);
  if (buf.length > MAX_CLIENT_FILE_BYTES) throw new PerchError(`The LinkedIn client file ${file} is too large`, 'bad_client_file');
  try {
    const o = JSON.parse(buf.toString('utf8')) as { client_id?: unknown; client_secret?: unknown };
    if (typeof o.client_id !== 'string' || typeof o.client_secret !== 'string') throw new Error('shape');
    return parseLinkedinClient({ clientId: o.client_id, clientSecret: o.client_secret });
  } catch {
    throw new PerchError(`The LinkedIn client file ${file} does not contain client_id and client_secret`, 'bad_client_file');
  }
}

export async function saveLinkedinClient(file: string, client: LinkedinClient): Promise<void> {
  const dir = path.dirname(file);
  if (!(await pathExists(dir))) await ensurePrivateDir(dir);
  const json = `${JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret }, null, 2)}\n`;
  await writePrivateFileAtomic(file, Buffer.from(json, 'utf8'));
}

export const shortLinkedinClientId = (id: string) => `${id.slice(0, 6)}…`;

export interface LinkedinTokenResponse extends TokenGrantResponse {
  refresh_token_expires_in?: number;
  id_token?: string;
}

export interface LinkedinIdentity {
  sub: string;
  personUrn: string;
  name?: string;
}

/** OpenID userinfo → person URN (urn:li:person:<sub>) and display name. */
export async function fetchLinkedinIdentity(upstream: Upstream, accessToken: string): Promise<LinkedinIdentity> {
  const u = await upstream.json<{ sub?: unknown; name?: unknown; given_name?: unknown; family_name?: unknown }>('linkedin', {
    method: 'GET',
    path: '/v2/userinfo',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (typeof u.sub !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(u.sub)) {
    throw new PerchError('LinkedIn returned no usable member id (userinfo sub)', 'oauth_incomplete');
  }
  const joined = [u.given_name, u.family_name].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
  const name = typeof u.name === 'string' && u.name ? u.name : joined || undefined;
  return { sub: u.sub, personUrn: `urn:li:person:${u.sub}`, ...(name ? { name: name.slice(0, 200) } : {}) };
}

export interface LinkedinAuthorizationOptions {
  client: LinkedinClient;
  upstream: Upstream;
  timeoutMs?: number;
  onAuthUrl: (url: string) => void;
  paste?: PasteRedirect;
}

/** Login in the browser (state checked), then the code exchange with the client secret. */
export async function runLinkedinAuthorization(opts: LinkedinAuthorizationOptions): Promise<LinkedinTokenResponse> {
  return runPkceLoopback({
    provider: 'LinkedIn',
    authEndpoint: LINKEDIN_AUTHORIZE_URL,
    authParams: { client_id: opts.client.clientId, scope: LINKEDIN_SCOPES.join(' ') },
    redirectHost: 'localhost',
    callbackPath: LINKEDIN_OAUTH_CALLBACK_PATH,
    port: LINKEDIN_OAUTH_PORT,
    pkce: false,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    onAuthUrl: opts.onAuthUrl,
    ...(opts.paste ? { paste: opts.paste } : {}),
    exchange: async (code, _verifier, redirectUri) => {
      const tok = await opts.upstream.json<LinkedinTokenResponse>('linkedinauth', {
        method: 'POST',
        path: TOKEN_PATH,
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: opts.client.clientId, client_secret: opts.client.clientSecret },
        capability: 'admin',
      });
      if (!tok.access_token) throw new PerchError('LinkedIn did not return an access token', 'oauth_incomplete');
      return tok;
    },
  });
}

const lifetime = (s: unknown, dflt: number) => (typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : dflt);

/**
 * Stores the login: a new account, or the existing one with the same member (person URN) updated in place (same
 * id, so client grants stay valid). The refresh token and its client are kept only when LinkedIn issued one.
 */
export async function upsertLinkedinAccount(
  store: CredentialStore,
  input: { label: string; client: LinkedinClient; grant: LinkedinTokenResponse; identity: LinkedinIdentity; now?: number },
): Promise<{ account: LinkedinAccount; updated: boolean }> {
  const label = validateLabel(input.label);
  const { grant, client, identity } = input;
  const now = input.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const scopes = typeof grant.scope === 'string' ? grant.scope.split(/[\s,]+/).filter(Boolean).slice(0, 20) : [...LINKEDIN_SCOPES];
  return store.update((data) => {
    const fields = {
      label,
      sub: identity.sub,
      personUrn: identity.personUrn,
      ...(identity.name ? { name: identity.name } : {}),
      accessToken: grant.access_token!,
      accessTokenExpiresAt: new Date(now + lifetime(grant.expires_in, DEFAULT_ACCESS_TOKEN_LIFETIME_S) * 1000).toISOString(),
      ...(grant.refresh_token
        ? {
            refreshToken: grant.refresh_token,
            ...(typeof grant.refresh_token_expires_in === 'number' && grant.refresh_token_expires_in > 0
              ? { refreshTokenExpiresAt: new Date(now + grant.refresh_token_expires_in * 1000).toISOString() }
              : {}),
            clientId: client.clientId,
            clientSecret: client.clientSecret,
          }
        : {}),
      scopes,
      updatedAt: iso,
    };
    const existing = data.linkedin.find((a) => a.personUrn === identity.personUrn);
    if (existing) {
      delete existing.name;
      delete existing.refreshToken;
      delete existing.refreshTokenExpiresAt;
      delete existing.clientId;
      delete existing.clientSecret;
      Object.assign(existing, fields);
      return { account: existing, updated: true };
    }
    const account: LinkedinAccount = { id: newAccountId('linkedin', data.linkedin.map((a) => a.id)), ...fields, createdAt: iso };
    data.linkedin.push(account);
    return { account, updated: false };
  });
}

/** The command that renews a LinkedIn login (same account, same id). The label is shell-quoted by the caller. */
export const linkedinRenewCommand = (quotedLabel: string) => `perch linkedin add --label ${quotedLabel}`;

/** refresh_token grant at the token endpoint (only for accounts LinkedIn gave a refresh token). */
export async function refreshLinkedinToken(upstream: Upstream, account: LinkedinAccount, refreshToken: string): Promise<TokenGrantResponse> {
  if (!account.clientId || !account.clientSecret) {
    throw new PerchError(`LinkedIn account ${account.id} has no stored client. Renew the login: perch linkedin add --label <label>.`, 'grant_invalid');
  }
  const tok = await upstream.json<LinkedinTokenResponse>('linkedinauth', {
    method: 'POST',
    path: TOKEN_PATH,
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: account.clientId, client_secret: account.clientSecret },
    capability: 'admin',
  });
  return { ...tok, expires_in: lifetime(tok.expires_in, DEFAULT_ACCESS_TOKEN_LIFETIME_S) };
}

/** Access tokens of accounts with a refresh token (single-flight refresh, rotation persisted under the lock). */
export function createLinkedinTokenProvider(store: CredentialStore, upstream: Upstream): RefreshingTokenProvider<LinkedinAccount> {
  return new RefreshingTokenProvider<LinkedinAccount>(store, {
    name: 'LinkedIn',
    list: (d) => d.linkedin,
    refresh: (a, rt) => refreshLinkedinToken(upstream, a, rt),
    reconnect: () => '`perch linkedin add --label <label>` (updates the same account)',
  });
}
