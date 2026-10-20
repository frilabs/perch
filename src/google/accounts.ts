import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { RefreshingTokenProvider, type SharedTokenSource } from '../oauth/tokenProvider.js';
import type { CredentialStore, GoogleAccount } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';
import { detachGroupMember, sharedGoogleLogin, sharedRevokeRefused } from './groupStore.js';
import {
  ownClient,
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
        dup.groupId
          ? `Google account ${identity.email} is already connected as ${dup.id} in group ${dup.groupId}. To change its permissions run perch google add for the same account (updates the group).`
          : `Google account ${identity.email} is already connected as ${dup.id} ("${dup.label}"). Remove it first to re-authorise.`,
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

/**
 * Removes the account locally. With `revoke`, also revokes the grant at Google first. A member of a Google account
 * group only leaves its group (the shared login stays for the other services; revoking it is refused).
 */
export async function removeGoogleAccount(
  store: CredentialStore,
  upstream: Upstream,
  id: string,
  opts: { revoke?: boolean },
): Promise<{ revoked: boolean; groupId?: string; groupRemoved?: boolean }> {
  const account = (await store.read()).google.find((g) => g.id === id);
  if (!account) throw new PerchError(`Unknown Google account: ${id}`, 'unknown_account');
  if (account.groupId) {
    if (opts.revoke) throw sharedRevokeRefused(id, account.groupId);
    const r = await store.update((data) => detachGroupMember(data, 'google', id));
    return { revoked: false, groupId: r.groupId, groupRemoved: r.groupRemoved };
  }
  let revoked = false;
  if (opts.revoke && account.refreshToken) {
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

/**
 * Access tokens live only in memory. Refreshes are single-flight per account. A refresh
 * token returned by Google replaces the stored one; when Google omits it the old one is kept.
 */
export class GoogleTokenProvider extends RefreshingTokenProvider<GoogleAccount> {
  /** `group` overrides the shared Google account group provider (default: the one of this store and upstream). */
  constructor(store: CredentialStore, upstream: Upstream, now: () => number = Date.now, group?: SharedTokenSource) {
    super(
      store,
      {
        name: 'Google',
        list: (d) => d.google,
        refresh: (a, rt) => refreshAccessToken(upstream, ownClient(a), rt),
        reconnect: (id) => `\`perch google remove ${id}\`, then \`perch google add --label <label> --services drive\``,
        shared: sharedGoogleLogin(store, upstream, group),
      },
      now,
    );
  }
}
