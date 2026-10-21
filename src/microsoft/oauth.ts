import { PerchError } from '../errors.js';
import { runPkceLoopback, type PasteRedirect } from '../oauth/loopback.js';
import type { TokenGrantResponse } from '../oauth/tokenProvider.js';
import type { MicrosoftAccount } from '../store/credentialStore.js';
import type { Upstream } from '../upstream.js';
import { explainMicrosoftAuthError } from './authErrors.js';

/**
 * Microsoft identity platform, auth code flow with PKCE for a public client (no client secret):
 * https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 * The Entra app registration needs the "Mobile and desktop applications" redirect URI
 * `http://localhost`; Entra ignores the port for localhost, so a random loopback port works.
 */

export const MS_DEFAULT_SCOPES = Object.freeze(['offline_access', 'User.Read', 'Mail.Read'] as const);
const GRAPH_RESOURCE_PREFIX = 'https://graph.microsoft.com/';
/** Canonical spelling of the scopes Perch checks; tokens may report them in any case. */
const KNOWN_SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send'];
const ALWAYS_REQUIRED = ['User.Read', 'Mail.Read'];

/** Same grammar as the msauth token route in upstream.ts: keeps the tenant a single path segment. */
const TENANT_RE =
  /^(?:common|organizations|consumers|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})+)$/;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function validateTenant(tenant: string): string {
  if (!TENANT_RE.test(tenant)) {
    throw new PerchError('Microsoft tenant must be common, organizations, consumers, a tenant GUID or a domain name', 'bad_tenant');
  }
  return tenant;
}

function validateClientId(clientId: string): string {
  // Entra "Application (client) ID" is always a GUID; anything else is a copy/paste mistake.
  if (!GUID_RE.test(clientId)) throw new PerchError('Microsoft client id must be the Application (client) ID GUID', 'bad_client_id');
  return clientId;
}

/** Mail.ReadWrite covers drafts and organizing (flags, move, deleted items); it is requested once for either opt-in. */
export function microsoftScopesFor(opts: { send?: boolean; drafts?: boolean; modify?: boolean }): string[] {
  return [...MS_DEFAULT_SCOPES, ...(opts.drafts || opts.modify ? ['Mail.ReadWrite'] : []), ...(opts.send ? ['Mail.Send'] : [])];
}

/** "https://graph.microsoft.com/mail.read" -> "Mail.Read"; unknown scopes keep their spelling. */
export function normaliseScope(scope: string): string {
  const short = scope.toLowerCase().startsWith(GRAPH_RESOURCE_PREFIX) ? scope.slice(GRAPH_RESOURCE_PREFIX.length) : scope;
  return KNOWN_SCOPES.find((k) => k.toLowerCase() === short.toLowerCase()) ?? short;
}

export interface MicrosoftAuthorizationResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  /** Normalised short names, e.g. "Mail.Read". */
  scopes: string[];
}

/** Validates an authorization_code token response: refresh token + every required scope granted. */
export function assertMicrosoftGrant(tok: TokenGrantResponse, requested: string[]): MicrosoftAuthorizationResult {
  if (!tok.access_token) throw new PerchError('Microsoft did not return an access token', 'oauth_incomplete');
  if (!tok.refresh_token) {
    throw new PerchError(
      'Microsoft did not return a refresh token; the offline_access permission was not granted. Retry and accept every requested permission.',
      'oauth_no_refresh_token',
    );
  }
  const scopes = [...new Set((tok.scope ?? '').split(/\s+/).filter(Boolean).map(normaliseScope))];
  // offline_access is proven by the refresh token; Microsoft often omits it from `scope`.
  const required = new Set([...ALWAYS_REQUIRED, ...requested.filter((s) => s !== 'offline_access')]);
  for (const scope of required) {
    if (!scopes.includes(scope)) {
      throw new PerchError(
        `The ${scope} permission was not granted. Retry and accept every requested permission; ` +
          'for work or school accounts, admin consent or a tenant policy may block it.',
        'oauth_scope_missing',
      );
    }
  }
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in ?? 0) * 1000,
    scopes,
  };
}

export interface MicrosoftAuthorizationOptions {
  clientId: string;
  tenant: string;
  upstream: Upstream;
  send?: boolean;
  drafts?: boolean;
  modify?: boolean;
  /** 0 = random free port. Use a fixed port when forwarding it over SSH (`ssh -L`). */
  port?: number;
  timeoutMs?: number;
  redirectHost?: 'localhost' | '127.0.0.1';
  loginHint?: string;
  onAuthUrl: (url: string) => void;
  /** Paste-the-redirect-address input racing the callback (login without a tunnel). */
  paste?: PasteRedirect;
  /** The client ID is the built-in frilabs app (wording of error messages and the admin consent text). */
  frilabsApp?: boolean;
}

export async function runMicrosoftAuthorization(opts: MicrosoftAuthorizationOptions): Promise<MicrosoftAuthorizationResult> {
  const tenant = validateTenant(opts.tenant);
  const clientId = validateClientId(opts.clientId);
  const scopes = microsoftScopesFor(opts);
  try {
    return await authorize(opts, tenant, clientId, scopes);
  } catch (err) {
    // Microsoft's AADSTS errors (callback or token endpoint) in plain words, incl. the admin consent link.
    throw explainMicrosoftAuthError(err, { app: { clientId, frilabs: Boolean(opts.frilabsApp) }, tenant });
  }
}

function authorize(opts: MicrosoftAuthorizationOptions, tenant: string, clientId: string, scopes: string[]): Promise<MicrosoftAuthorizationResult> {
  return runPkceLoopback({
    provider: 'Microsoft',
    authEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    authParams: {
      client_id: clientId,
      scope: scopes.join(' '),
      response_mode: 'query',
      prompt: 'select_account',
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    },
    redirectHost: opts.redirectHost ?? 'localhost',
    callbackPath: '/',
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    onAuthUrl: opts.onAuthUrl,
    ...(opts.paste ? { paste: opts.paste } : {}),
    exchange: async (code, verifier, redirectUri) => {
      const tok = await opts.upstream.json<TokenGrantResponse>('msauth', {
        method: 'POST',
        path: `/${tenant}/oauth2/v2.0/token`,
        form: {
          client_id: clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          scope: scopes.join(' '),
        },
      });
      return assertMicrosoftGrant(tok, scopes);
    },
  });
}

/** refresh_token grant. Microsoft usually rotates the refresh token; RefreshingTokenProvider persists it. */
export async function refreshMicrosoftToken(upstream: Upstream, account: MicrosoftAccount): Promise<TokenGrantResponse> {
  const tenant = validateTenant(account.tenant);
  const scope = [...new Set(['offline_access', ...account.scopes])].join(' ');
  return upstream.json<TokenGrantResponse>('msauth', {
    method: 'POST',
    path: `/${tenant}/oauth2/v2.0/token`,
    form: { client_id: account.clientId, grant_type: 'refresh_token', refresh_token: account.refreshToken, scope },
  });
}
