import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { RefreshingTokenProvider } from '../oauth/tokenProvider.js';
import type { CredentialStore, MicrosoftAccount } from '../store/credentialStore.js';
import type { Upstream } from '../upstream.js';
import { refreshMicrosoftToken, validateTenant, type MicrosoftAuthorizationResult } from './oauth.js';

interface MeResponse {
  id?: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

/** Personal Microsoft accounts often have no `mail`; their userPrincipalName is the sign-in address. */
export async function fetchMicrosoftIdentity(upstream: Upstream, accessToken: string) {
  const me = await upstream.json<MeResponse>('graph', {
    method: 'GET',
    path: '/v1.0/me',
    query: { $select: 'id,displayName,mail,userPrincipalName' },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const email = me.mail || me.userPrincipalName;
  if (!email) throw new PerchError('Microsoft Graph did not report the account email', 'microsoft_identity');
  return { id: me.id, email, ...(me.displayName ? { displayName: me.displayName } : {}) };
}

/** Stores a freshly authorised grant as a new account (one grant per mailbox address). */
export async function registerMicrosoftAccount(
  store: CredentialStore,
  upstream: Upstream,
  input: { label: string; clientId: string; tenant: string; grant: MicrosoftAuthorizationResult },
): Promise<MicrosoftAccount> {
  const label = validateLabel(input.label);
  const tenant = validateTenant(input.tenant);
  const identity = await fetchMicrosoftIdentity(upstream, input.grant.accessToken);
  return store.update((data) => {
    const dup = data.microsoft.find((m) => m.email.toLowerCase() === identity.email.toLowerCase());
    if (dup) {
      throw new PerchError(
        `Microsoft account ${identity.email} is already connected as ${dup.id} ("${dup.label}"). Remove it first to re-authorise.`,
        'duplicate_account',
      );
    }
    const now = new Date().toISOString();
    const account: MicrosoftAccount = {
      id: newAccountId('microsoft', data.microsoft.map((m) => m.id)),
      label,
      email: identity.email,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
      tenant,
      clientId: input.clientId,
      refreshToken: input.grant.refreshToken,
      scopes: input.grant.scopes,
      createdAt: now,
      updatedAt: now,
    };
    data.microsoft.push(account);
    return account;
  });
}

/**
 * Removes the account locally only. The Microsoft identity platform has no simple revocation
 * endpoint for a public-client refresh token, so the user withdraws consent themselves:
 * personal accounts at https://account.live.com/consent/Manage, work/school accounts at
 * https://myapps.microsoft.com.
 */
export async function removeMicrosoftAccount(store: CredentialStore, id: string): Promise<void> {
  await store.update((data) => {
    if (!data.microsoft.some((m) => m.id === id)) throw new PerchError(`Unknown Microsoft account: ${id}`, 'unknown_account');
    data.microsoft = data.microsoft.filter((m) => m.id !== id);
  });
}

/** Microsoft rotates refresh tokens on most refreshes; the generic provider persists them under the lock. */
export function createMicrosoftTokenProvider(
  store: CredentialStore,
  upstream: Upstream,
  now: () => number = Date.now,
): RefreshingTokenProvider<MicrosoftAccount> {
  return new RefreshingTokenProvider<MicrosoftAccount>(
    store,
    {
      name: 'Microsoft',
      list: (d) => d.microsoft,
      refresh: (a) => refreshMicrosoftToken(upstream, a),
      reconnect: (id) => `\`perch microsoft remove ${id}\`, then \`perch microsoft add --label <label>\``,
    },
    now,
  );
}
