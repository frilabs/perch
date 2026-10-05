import { principalFromGrant, READONLY_PRINCIPAL, tokenSha256, type Principal } from '../auth/grants.js';
import type { PerchContext } from '../context.js';
import { PerchError } from '../errors.js';
import { ROOT_NAMESPACE, type ClientGrant, type CredentialStore } from '../store/credentialStore.js';
import { assertActiveUser, assertUserPaths, openUserStore } from './registry.js';

/**
 * Builds the long-lived services of one namespace (own store, upstream and token caches). For user
 * namespaces `guard` is the namespace guard; services that can be called directly (MailService) run it.
 */
export type ContextFactory = (store: CredentialStore, guard?: () => Promise<void>) => PerchContext;

/** What createMcpServer needs besides context and principal to keep a session inside its namespace. */
export interface SessionScope {
  /** Owning user (undefined for the root operator namespace). */
  userId?: string;
  /** Runs before EVERY tool invocation; throws if membership (or the user's token) was revoked. */
  guard?: () => Promise<void>;
}

export interface ResolvedSession {
  userId: string | null;
  context: PerchContext;
  principal: Principal;
  session: SessionScope;
}

type Match = { userId: string | null; grant?: ClientGrant };

/**
 * Maps credentials to exactly one namespace. The root context is the legacy operator store; each active
 * user gets a physically separate store and a separate PerchContext (own Upstream and access-token caches),
 * created lazily and kept warm. Membership is NOT cached: every resolution and every tool call re-reads
 * the root registry. A token resolves to a namespace only by its hash; there is no caller-selected
 * user header, query or route.
 */
export class NamespaceRouter {
  private readonly users = new Map<string, Promise<PerchContext>>();

  constructor(
    readonly root: PerchContext,
    private readonly factory: ContextFactory,
  ) {
    if (root.store.namespace !== ROOT_NAMESPACE) throw new PerchError('The router needs the root store', 'not_root_namespace');
  }

  /** Context of an ACTIVE user. Opening fails closed (no re-init); a failed open is not cached. */
  async userContext(userId: string): Promise<PerchContext> {
    await assertActiveUser(this.root.store, userId);
    let ctx = this.users.get(userId);
    if (!ctx) {
      ctx = openUserStore(this.root.store, userId).then((store) => this.factory(store, () => this.namespaceGuard(userId, store)));
      this.users.set(userId, ctx);
      ctx.catch(() => this.users.delete(userId));
    }
    const resolved = await ctx;
    // Directories swapped/symlinked, key removed/replaced or store damaged since it was opened: fail closed
    // for this namespace (the cached context keeps failing until the namespace is restored or the user removed).
    await assertUserPaths(this.root.store, userId);
    await resolved.store.assertKeyUnchanged();
    await resolved.store.read();
    return resolved;
  }

  /**
   * Service-level guard of a user namespace: the user is still active, and the namespace (paths, key,
   * store) is intact and still served by the context built around `store`.
   */
  async namespaceGuard(userId: string, store: CredentialStore): Promise<void> {
    const current = await this.userContext(userId);
    if (current.store !== store) throw new PerchError('The namespace of this service was re-opened; reconnect', 'namespace_unavailable');
  }

  /**
   * Runs before every tool call of a user session (HTTP and persistent stdio): membership, the user's
   * read-only token (if that is the credential), and the full namespace check of userContext (paths, key,
   * store integrity). The session must still be bound to the very context that is cached for the user.
   */
  userGuard(userId: string, readTokenSha256?: string, context?: PerchContext): () => Promise<void> {
    return async () => {
      const user = await assertActiveUser(this.root.store, userId);
      if (readTokenSha256 !== undefined && user.readTokenSha256 !== readTokenSha256) {
        throw new PerchError('This user token was replaced or revoked; no request was made', 'grant_revoked');
      }
      const current = await this.userContext(userId);
      if (context !== undefined && current !== context) {
        throw new PerchError('The namespace of this session was re-opened; reconnect', 'namespace_unavailable');
      }
    };
  }

  /**
   * True if the global operator token's hash also appears as a user read-only token (active or removed),
   * a root client grant or a client grant in any ACTIVE user's store: then the global token is ambiguous
   * and must not be accepted. Proving that needs every active user's store, so an active namespace that
   * cannot be opened fails closed ('namespace_unavailable', HTTP 503) instead of being skipped.
   */
  async collidesWithGlobal(token: string): Promise<boolean> {
    const digest = tokenSha256(token);
    const data = await this.root.store.read();
    if (data.users.some((u) => u.readTokenSha256 === digest) || data.clients.some((c) => c.tokenSha256 === digest)) return true;
    for (const user of data.users) {
      if (user.status !== 'active') continue;
      const ctx = await this.openForResolution(user.id);
      if (ctx && (await ctx.store.read()).clients.some((c) => c.tokenSha256 === digest)) return true;
    }
    return false;
  }

  /** userContext for token resolution: null if the user was removed meanwhile, otherwise fail closed. */
  private async openForResolution(userId: string): Promise<PerchContext | null> {
    try {
      return await this.userContext(userId);
    } catch (err) {
      if (err instanceof PerchError && err.code === 'user_inactive') return null; // removed meanwhile
      throw new PerchError('A user namespace could not be opened; token resolution fails closed', 'namespace_unavailable');
    }
  }

  /**
   * Resolves a non-global bearer token to exactly one owned session BEFORE any provider I/O. Candidates:
   * root client grants, active users' read-only tokens and active users' client grants. No match: null.
   * More than one: fails closed ('ambiguous_token'). An active user's namespace that cannot be opened
   * fails the resolution ('namespace_unavailable') rather than guessing; removed users are skipped.
   */
  async resolveToken(token: string): Promise<ResolvedSession | null> {
    if (!token) return null;
    const digest = tokenSha256(token);
    const rootData = await this.root.store.read();
    const matches: Match[] = rootData.clients.filter((c) => c.tokenSha256 === digest).map((grant) => ({ userId: null, grant }));
    const contexts = new Map<string, PerchContext>();
    for (const user of rootData.users) {
      if (user.status !== 'active') continue;
      // Only a namespace that opened (user still active) can contribute a match, so a user removed between
      // the registry read and here never yields a session without a context.
      const ctx = await this.openForResolution(user.id);
      if (!ctx) continue;
      contexts.set(user.id, ctx);
      if (user.readTokenSha256 === digest) matches.push({ userId: user.id });
      for (const grant of (await ctx.store.read()).clients) if (grant.tokenSha256 === digest) matches.push({ userId: user.id, grant });
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new PerchError('This token matches more than one grant; refusing to choose a namespace', 'ambiguous_token');
    const m = matches[0]!;
    if (m.userId === null) {
      return { userId: null, context: this.root, principal: principalFromGrant(m.grant!), session: {} };
    }
    const context = contexts.get(m.userId);
    if (!context) return null;
    return {
      userId: m.userId,
      context,
      principal: m.grant ? principalFromGrant(m.grant) : READONLY_PRINCIPAL,
      session: { userId: m.userId, guard: this.userGuard(m.userId, m.grant ? undefined : digest, context) },
    };
  }

  /**
   * Local stdio/CLI selection: the trusted PERCH_USER selector (or root when absent), optionally narrowed
   * by a client token file. The token must resolve to exactly the selected namespace; there is no fallback.
   */
  async localSession(userId: string | undefined, clientToken?: string): Promise<ResolvedSession> {
    if (clientToken !== undefined) {
      const r = await this.resolveToken(clientToken);
      if (!r || r.userId !== (userId ?? null)) {
        throw new PerchError('PERCH_CLIENT_TOKEN_FILE does not hold a known token of the selected namespace (perch client list)', 'unknown_client');
      }
      return r;
    }
    if (userId === undefined) return { userId: null, context: this.root, principal: READONLY_PRINCIPAL, session: {} };
    const context = await this.userContext(userId);
    return { userId, context, principal: READONLY_PRINCIPAL, session: { userId, guard: this.userGuard(userId, undefined, context) } };
  }
}
