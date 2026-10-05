import { createHash } from 'node:crypto';
import { PerchError } from '../errors.js';
import type { CredentialStore, StoreData } from '../store/credentialStore.js';
import { UpstreamError } from '../upstream.js';

export interface TokenGrantResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface RefreshableAccount {
  id: string;
  refreshToken: string;
  updatedAt: string;
}

export interface TokenProviderConfig<A extends RefreshableAccount> {
  /** Human name used in messages, e.g. "Google", "Gmail", "Microsoft". */
  name: string;
  /** The store section holding these accounts (mutable reference inside store.update). */
  list: (data: StoreData) => A[];
  /** Performs the refresh_token grant against the fixed token endpoint. */
  refresh: (account: A) => Promise<TokenGrantResponse>;
  /** Shell commands that reconnect the account. Never includes user-supplied labels. */
  reconnect: (id: string) => string;
}

const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex');

/** Token-endpoint errors that mean the user must reconnect (Microsoft: MFA/consent changes). */
const RECONNECT_CODES = new Set(['invalid_grant', 'interaction_required', 'consent_required']);

/**
 * Access tokens live only in memory (60 s expiry buffer). Refreshes are single-flight per
 * account and refresh token. A refresh token returned by the provider replaces the stored one
 * under the store lock; when it is omitted the old one is kept. Fails closed when the account
 * was removed or re-authorised while the refresh was in flight, and when a rotated refresh token
 * cannot be persisted (the new access token is then neither cached nor returned).
 */
export class RefreshingTokenProvider<A extends RefreshableAccount> {
  private cache = new Map<string, { token: string; expiresAt: number; rtHash: string; scopes?: string[] }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: CredentialStore,
    private readonly cfg: TokenProviderConfig<A>,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(accountId: string): Promise<string> {
    const account = this.cfg.list(await this.store.read()).find((a) => a.id === accountId);
    if (!account) throw new PerchError(`Unknown ${this.cfg.name} account: ${accountId}`, 'unknown_account');
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

  /**
   * Scopes the provider reported with the currently cached access token (refresh responses carry
   * `scope`), or undefined when unknown. Lets callers fail closed when a scope was revoked upstream.
   */
  lastGrantedScopes(accountId: string): string[] | undefined {
    return this.cache.get(accountId)?.scopes;
  }

  /** Drops the cached access token (e.g. after the provider answered 401). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  private async refresh(account: A, rtHash: string): Promise<string> {
    const { name } = this.cfg;
    let tok: TokenGrantResponse;
    try {
      tok = await this.cfg.refresh(account);
    } catch (err) {
      if (err instanceof UpstreamError && err.upstreamCode && RECONNECT_CODES.has(err.upstreamCode)) {
        this.cache.delete(account.id);
        // The label is user-supplied, so it is never embedded in the suggested shell command.
        throw new PerchError(
          `${name} grant for ${account.id} was revoked or expired. Re-authorise: run ${this.cfg.reconnect(account.id)}.`,
          'grant_invalid',
        );
      }
      throw err;
    }
    if (!tok.access_token) throw new PerchError(`${name} token refresh returned no access token`, 'oauth_incomplete');
    const changedMeanwhile = () =>
      new PerchError(
        `${name} account ${account.id} was removed or re-authorised while its token was being refreshed; retry the request`,
        'account_changed',
      );
    let currentHash = rtHash;
    const newRefresh = tok.refresh_token;
    if (newRefresh && newRefresh !== account.refreshToken) {
      let saved: boolean;
      try {
        saved = await this.store.update((data) => {
          const a = this.cfg.list(data).find((x) => x.id === account.id);
          // Only replace the token we refreshed with; never resurrect a removed/re-added account.
          if (!a || fingerprint(a.refreshToken) !== rtHash) return false;
          a.refreshToken = newRefresh;
          a.updatedAt = new Date().toISOString();
          return true;
        });
      } catch {
        this.cache.delete(account.id);
        throw new PerchError(
          `${name} issued a new refresh token for ${account.id} but it could not be saved (credential store not writable/locked). ` +
            `If later calls fail, reconnect: run ${this.cfg.reconnect(account.id)}.`,
          'rotation_not_persisted',
        );
      }
      if (!saved) throw changedMeanwhile();
      currentHash = fingerprint(newRefresh);
    } else {
      // Fail closed if the account was removed or replaced while the refresh was in flight.
      const now = this.cfg.list(await this.store.read()).find((a) => a.id === account.id);
      if (!now || fingerprint(now.refreshToken) !== rtHash) throw changedMeanwhile();
    }
    this.cache.set(account.id, {
      token: tok.access_token,
      expiresAt: this.now() + (tok.expires_in ?? 0) * 1000,
      rtHash: currentHash,
      ...(typeof tok.scope === 'string' ? { scopes: tok.scope.split(/\s+/).filter(Boolean) } : {}),
    });
    return tok.access_token;
  }
}
