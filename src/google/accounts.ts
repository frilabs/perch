import { createHash } from 'node:crypto';
import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import type { CredentialStore, GoogleAccount } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';
import {
  refreshAccessToken,
  revokeToken,
  type AuthorizationResult,
  type GoogleClientCredentials,
} from './oauth.js';

interface AboutResponse {
  user?: { emailAddress?: string; displayName?: string };
}

export async function fetchDriveIdentity(upstream: Upstream, accessToken: string) {
  const about = await upstream.json<AboutResponse>('drive', {
    method: 'GET',
    path: '/drive/v3/about',
    query: { fields: 'user(emailAddress,displayName)' },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const email = about.user?.emailAddress;
  if (!email) throw new PerchError('Google Drive did not report the account email', 'google_identity');
  return { email, displayName: about.user?.displayName };
}

/** Stores a freshly authorised grant as a new account (one grant per Google account). */
export async function registerGoogleAccount(
  store: CredentialStore,
  upstream: Upstream,
  input: { label: string; client: GoogleClientCredentials; grant: AuthorizationResult },
): Promise<GoogleAccount> {
  const label = validateLabel(input.label);
  const identity = await fetchDriveIdentity(upstream, input.grant.accessToken);
  return store.update((data) => {
    const dup = data.google.find((g) => g.email.toLowerCase() === identity.email.toLowerCase());
    if (dup) {
      throw new PerchError(
        `Google account ${identity.email} is already connected as ${dup.id} ("${dup.label}"). Remove it first to re-authorise.`,
        'duplicate_account',
      );
    }
    const now = new Date().toISOString();
    const account: GoogleAccount = {
      id: newAccountId('google', data.google.map((g) => g.id)),
      label,
      email: identity.email,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      clientId: input.client.clientId,
      clientSecret: input.client.clientSecret,
      refreshToken: input.grant.refreshToken,
      scopes: input.grant.scopes,
      createdAt: now,
      updatedAt: now,
    };
    data.google.push(account);
    return account;
  });
}

/** Removes the account locally. With `revoke`, also revokes the grant at Google first. */
export async function removeGoogleAccount(
  store: CredentialStore,
  upstream: Upstream,
  id: string,
  opts: { revoke?: boolean },
): Promise<{ revoked: boolean }> {
  const account = (await store.read()).google.find((g) => g.id === id);
  if (!account) throw new PerchError(`Unknown Google account: ${id}`, 'unknown_account');
  let revoked = false;
  if (opts.revoke) {
    try {
      await revokeToken(upstream, account.refreshToken);
      revoked = true;
    } catch (err) {
      // A token that is already invalid cannot be revoked; removal still proceeds.
      if (!(err instanceof UpstreamError && err.status === 400)) throw err;
    }
  }
  await store.update((data) => {
    data.google = data.google.filter((g) => g.id !== id);
  });
  return { revoked };
}

const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Access tokens live only in memory. Refreshes are single-flight per account. A refresh
 * token returned by Google replaces the stored one; when Google omits it the old one is kept.
 */
export class GoogleTokenProvider {
  private cache = new Map<string, { token: string; expiresAt: number; rtHash: string }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: CredentialStore,
    private readonly upstream: Upstream,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(accountId: string): Promise<string> {
    const account = (await this.store.read()).google.find((g) => g.id === accountId);
    if (!account) throw new PerchError(`Unknown Google account: ${accountId}`, 'unknown_account');
    const rtHash = fingerprint(account.refreshToken);
    const cached = this.cache.get(accountId);
    if (cached && cached.rtHash === rtHash && cached.expiresAt - 60_000 > this.now()) return cached.token;

    const key = `${accountId}:${rtHash}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.refresh(account, rtHash).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async refresh(account: GoogleAccount, rtHash: string): Promise<string> {
    let tok;
    try {
      tok = await refreshAccessToken(this.upstream, account, account.refreshToken);
    } catch (err) {
      if (err instanceof UpstreamError && err.upstreamCode === 'invalid_grant') {
        this.cache.delete(account.id);
        // The label is user-supplied, so it is never embedded in the suggested shell command.
        throw new PerchError(
          `Google grant for ${account.id} was revoked or expired. Re-authorise: run ` +
            `\`perch google remove ${account.id}\`, then \`perch google add --label <label>\`.`,
          'google_grant_invalid',
        );
      }
      throw err;
    }
    if (!tok.access_token) throw new PerchError('Google token refresh returned no access token', 'oauth_incomplete');
    const changedMeanwhile = () =>
      new PerchError(
        `Google account ${account.id} was removed or re-authorised while its token was being refreshed; retry the request`,
        'account_changed',
      );
    let currentHash = rtHash;
    const newRefresh = tok.refresh_token;
    if (newRefresh && newRefresh !== account.refreshToken) {
      let saved: boolean;
      try {
        saved = await this.store.update((data) => {
          const g = data.google.find((x) => x.id === account.id);
          // Only replace the token we refreshed with; never resurrect a removed/re-added account.
          if (!g || fingerprint(g.refreshToken) !== rtHash) return false;
          g.refreshToken = newRefresh;
          g.updatedAt = new Date().toISOString();
          return true;
        });
      } catch {
        this.cache.delete(account.id);
        throw new PerchError(
          `Google issued a new refresh token for ${account.id} but it could not be saved (credential store not writable/locked). ` +
            `If later calls fail, reconnect: run \`perch google remove ${account.id}\`, then \`perch google add --label <label>\`.`,
          'rotation_not_persisted',
        );
      }
      if (!saved) throw changedMeanwhile();
      currentHash = fingerprint(newRefresh);
    } else {
      // Fail closed if the account was removed or replaced while the refresh was in flight.
      const now = (await this.store.read()).google.find((g) => g.id === account.id);
      if (!now || fingerprint(now.refreshToken) !== rtHash) throw changedMeanwhile();
    }
    this.cache.set(account.id, {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 0) * 1000,
      rtHash: currentHash,
    });
    return tok.access_token;
  }
}
