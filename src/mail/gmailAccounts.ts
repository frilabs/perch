import type { AuthorizationResult, GoogleClientCredentials } from '../google/oauth.js';
import { refreshAccessToken, revokeToken } from '../google/oauth.js';
import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { RefreshingTokenProvider } from '../oauth/tokenProvider.js';
import type { CredentialStore, GmailAccount } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';

/**
 * Gmail OAuth scopes (https://developers.google.com/workspace/gmail/api/auth/scopes):
 * gmail.readonly (restricted) is always requested; gmail.send (sensitive) and gmail.compose
 * (restricted; drafts + send) only on explicit opt-in, so a read-only grant can never send.
 */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

export function gmailScopesFor(opts: { send?: boolean; drafts?: boolean }): string[] {
  const scopes = [GMAIL_READONLY_SCOPE];
  // compose includes sending, so gmail.send would only widen the consent screen.
  if (opts.drafts) scopes.push(GMAIL_COMPOSE_SCOPE);
  else if (opts.send) scopes.push(GMAIL_SEND_SCOPE);
  return scopes;
}

/** The mailbox address the grant belongs to (gmail.readonly covers users.getProfile). */
export async function fetchGmailIdentity(upstream: Upstream, accessToken: string): Promise<{ email: string }> {
  const profile = await upstream.json<{ emailAddress?: unknown }>('gmail', {
    method: 'GET',
    path: '/gmail/v1/users/me/profile',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (typeof profile.emailAddress !== 'string' || !profile.emailAddress) {
    throw new PerchError('Gmail did not report the mailbox address', 'gmail_identity');
  }
  return { email: profile.emailAddress };
}

/** Stores a freshly authorised grant as a new Gmail account (one grant per mailbox). */
export async function registerGmailAccount(
  store: CredentialStore,
  upstream: Upstream,
  input: { label: string; client: GoogleClientCredentials; grant: AuthorizationResult },
): Promise<GmailAccount> {
  const label = validateLabel(input.label);
  const { email } = await fetchGmailIdentity(upstream, input.grant.accessToken);
  return store.update((data) => {
    const dup = data.gmail.find((g) => g.email.toLowerCase() === email.toLowerCase());
    if (dup) {
      throw new PerchError(
        `Gmail account ${email} is already connected as ${dup.id} ("${dup.label}"). Remove it first to re-authorise.`,
        'duplicate_account',
      );
    }
    const now = new Date().toISOString();
    const account: GmailAccount = {
      id: newAccountId('gmail', data.gmail.map((g) => g.id)),
      label,
      email,
      clientId: input.client.clientId,
      clientSecret: input.client.clientSecret,
      refreshToken: input.grant.refreshToken,
      scopes: input.grant.scopes,
      createdAt: now,
      updatedAt: now,
    };
    data.gmail.push(account);
    return account;
  });
}

/** Removes the account locally. With `revoke`, also revokes the grant at Google first. */
export async function removeGmailAccount(
  store: CredentialStore,
  upstream: Upstream,
  id: string,
  opts: { revoke?: boolean },
): Promise<{ revoked: boolean }> {
  const account = (await store.read()).gmail.find((g) => g.id === id);
  if (!account) throw new PerchError(`Unknown Gmail account: ${id}`, 'unknown_account');
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
    data.gmail = data.gmail.filter((g) => g.id !== id);
  });
  return { revoked };
}

/** In-memory access tokens for Gmail accounts; refresh-token rotation is persisted under the store lock. */
export function createGmailTokenProvider(
  store: CredentialStore,
  upstream: Upstream,
  now: () => number = Date.now,
): RefreshingTokenProvider<GmailAccount> {
  return new RefreshingTokenProvider<GmailAccount>(
    store,
    {
      name: 'Gmail',
      list: (d) => d.gmail,
      refresh: (a) => refreshAccessToken(upstream, a, a.refreshToken),
      // The label is user-supplied, so the command only ever contains the generated id.
      reconnect: (id) => `\`perch gmail remove ${id}\`, then \`perch gmail add --label <label>\``,
    },
    now,
  );
}
