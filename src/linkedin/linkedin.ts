import { actorOf } from '../audit/audit.js';
import type { AuditLog } from '../audit/audit.js';
import { assertLinkedinCapability, currentPrincipal, type Principal } from '../auth/grants.js';
import { PerchError } from '../errors.js';
import type { SendWorkflow } from '../mail/workflow.js';
import { messageSendStatus, sendMessageIdempotently, type MessageSendResult, type MessageSendView } from '../messaging/send.js';
import type { RefreshingTokenProvider } from '../oauth/tokenProvider.js';
import type { CredentialStore, LinkedinAccount } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';
import { fetchLinkedinIdentity, linkedinRenewCommand } from './oauth.js';

/**
 * LinkedIn: posting text to the member's own profile (docs/LINKEDIN_X_SPEC.md). Reading means the account's own
 * login state (name, connected until); posting needs a client grant with linkedin_post and goes through the shared
 * idempotent send ledger (src/messaging/send.ts): a 4xx from LinkedIn is "rejected" (not posted), a timeout,
 * network error or 5xx "indeterminate" (never retried). Errors and the audit trail never carry tokens or post text.
 */

/** Longest post text, counted in characters (code points) BEFORE escaping. */
export const MAX_LINKEDIN_TEXT = 3000;
/** Default LinkedIn-Version header (YYYYMM); override with PERCH_LINKEDIN_VERSION. */
export const DEFAULT_LINKEDIN_VERSION = '202608';
export const LINKEDIN_VERSION_PATTERN = /^20[0-9]{2}(?:0[1-9]|1[0-2])(?:\.[0-9]{2})?$/;
/** perch status warns this long before the login expires. */
export const EXPIRY_WARNING_MS = 7 * 24 * 3600 * 1000;

/** Characters LinkedIn's "little text" format reserves; each is escaped with a backslash. */
const LITTLE_TEXT_RESERVED = /[\\|{}@[\]()<>#*_~]/g;

/** Escapes text for the commentary field (little text format), so it is posted literally. */
export function escapeLittleText(text: string): string {
  return text.replace(LITTLE_TEXT_RESERVED, (c) => `\\${c}`);
}

const SAFE_ARG = /^[A-Za-z0-9_.@+:,/=-]+$/;
/** POSIX shell quoting for the user-assigned label inside a suggested command. */
const quote = (s: string) => (SAFE_ARG.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const renewCommandFor = (a: Pick<LinkedinAccount, 'label'>) => linkedinRenewCommand(quote(a.label));

export interface LinkedinExpiry {
  /** End of the login: the access token's expiry, or the refresh token's when LinkedIn issued one (unknown: absent). */
  until?: string;
  state: 'ok' | 'soon' | 'expired';
  refreshable: boolean;
}

export function linkedinExpiry(a: LinkedinAccount, now: number = Date.now()): LinkedinExpiry {
  const refreshable = a.refreshToken !== undefined;
  const until = refreshable ? a.refreshTokenExpiresAt : a.accessTokenExpiresAt;
  if (!until) return { state: 'ok', refreshable };
  const end = Date.parse(until);
  const state = !Number.isFinite(end) || end <= now ? 'expired' : end - now <= EXPIRY_WARNING_MS ? 'soon' : 'ok';
  return { until, state, refreshable };
}

export function loginExpired(a: LinkedinAccount, until: string | undefined): PerchError {
  return new PerchError(
    `The LinkedIn login of ${a.id} expired${until ? ` on ${until.slice(0, 10)}` : ''}. Renew it (same account, same id): ${renewCommandFor(a)}`,
    'login_expired',
  );
}

/** Post URN from the x-restli-id header ↔ the opaque id kept in the send ledger ([A-Za-z0-9_-]). */
const POST_URN = /^urn:li:(share|ugcPost):([0-9]{1,30})$/;
const POST_KEY = /^(share|ugcPost)-([0-9]{1,30})$/;
export const postKeyOf = (urn: string | undefined) => {
  const m = urn ? POST_URN.exec(urn.trim()) : null;
  return m ? `${m[1]}-${m[2]}` : undefined;
};
export const postUrnOf = (key: string | undefined) => {
  const m = key ? POST_KEY.exec(key) : null;
  return m ? `urn:li:${m[1]}:${m[2]}` : undefined;
};
export const postUrlOf = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;

const bindingParts = (a: LinkedinAccount) => ['linkedin', a.id, a.personUrn];

export interface LinkedinPostRequest {
  accountId: string;
  text: string;
  requestId: string;
}

export interface LinkedinServiceOptions {
  /** LinkedIn-Version header (YYYYMM). */
  version?: string;
  now?: () => number;
  /** Session guard of the calling MCP session (revocation), checked again right before posting. */
  guard?: () => Promise<void>;
}

export class LinkedinService {
  private readonly version: string;
  private readonly now: () => number;
  private readonly guard?: () => Promise<void>;

  constructor(
    private readonly store: CredentialStore,
    private readonly upstream: Upstream,
    private readonly workflow: SendWorkflow,
    private readonly audit: AuditLog,
    readonly tokens: RefreshingTokenProvider<LinkedinAccount>,
    opts: LinkedinServiceOptions = {},
  ) {
    this.version = opts.version ?? DEFAULT_LINKEDIN_VERSION;
    if (!LINKEDIN_VERSION_PATTERN.test(this.version)) throw new PerchError('PERCH_LINKEDIN_VERSION must be a LinkedIn API version like 202608', 'bad_config');
    this.now = opts.now ?? Date.now;
    this.guard = opts.guard;
  }

  private async account(id: unknown): Promise<LinkedinAccount> {
    if (typeof id !== 'string') throw new PerchError('accountId is required', 'bad_argument');
    const a = (await this.store.read()).linkedin.find((x) => x.id === id);
    if (!a) throw new PerchError(`Unknown LinkedIn account: ${id}`, 'unknown_account');
    return a;
  }

  /** A usable access token; an expired login (without refresh token) is a clear error naming the renew command. */
  async accessToken(a: LinkedinAccount): Promise<string> {
    const exp = linkedinExpiry(a, this.now());
    if (exp.state === 'expired') throw loginExpired(a, exp.until);
    return a.refreshToken ? this.tokens.getAccessToken(a.id) : a.accessToken;
  }

  private prov(a: LinkedinAccount) {
    return { accountId: a.id, accountLabel: a.label };
  }

  private loginView(a: LinkedinAccount) {
    const exp = linkedinExpiry(a, this.now());
    return {
      ...(a.name ? { name: a.name } : {}),
      personUrn: a.personUrn,
      ...(exp.until ? { connectedUntil: exp.until } : {}),
      loginState: exp.state,
      refreshable: exp.refreshable,
      ...(exp.state !== 'ok' ? { renew: renewCommandFor(a) } : {}),
    };
  }

  async listAccounts(p: Principal) {
    const data = await this.store.read();
    return data.linkedin
      .filter((a) => p.linkedinAccounts === 'all' || p.linkedinAccounts.has(a.id))
      .map((a) => ({
        accountId: a.id,
        label: a.label,
        ...this.loginView(a),
        granted: [...p.capabilities].filter((c) => c.startsWith('linkedin_')).sort(),
        connectedAt: a.createdAt,
      }));
  }

  /** linkedin_status: name and how long the login lasts (local, no LinkedIn call). */
  async status(p: Principal, input: { accountId: string }) {
    const a = await this.account(input?.accountId);
    assertLinkedinCapability(p, a.id, 'linkedin_read');
    return { ...this.prov(a), ...this.loginView(a) };
  }

  /** perch status live check: the stored login still identifies the same member. */
  async check(id: string): Promise<void> {
    const a = await this.account(id);
    let identity;
    try {
      identity = await fetchLinkedinIdentity(this.upstream, await this.accessToken(a));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        if (a.refreshToken) this.tokens.invalidate(a.id);
        throw new PerchError(`LinkedIn refused the stored login (HTTP 401). Renew it: ${renewCommandFor(a)}`, 'login_expired');
      }
      throw err;
    }
    if (identity.personUrn !== a.personUrn) throw new PerchError('The stored LinkedIn login belongs to a different member now', 'account_changed');
  }

  private async stillAllowed(stale: Principal, accountId: string): Promise<void> {
    await this.guard?.();
    assertLinkedinCapability(await currentPrincipal(this.store, stale), accountId, 'linkedin_post');
  }

  /** linkedin_post: one text post on the member's own profile, idempotent per requestId. */
  async post(p: Principal, req: LinkedinPostRequest): Promise<MessageSendView & { accountId?: string; accountLabel?: string; postId?: string; url?: string }> {
    let account: LinkedinAccount | undefined;
    const view = await sendMessageIdempotently({
      workflow: this.workflow,
      audit: this.audit,
      actor: actorOf(p),
      provider: 'linkedin',
      accountId: req?.accountId,
      prepare: async () => {
        await this.guard?.();
        if (typeof req?.accountId !== 'string') throw new PerchError('accountId is required', 'bad_argument');
        assertLinkedinCapability(p, req.accountId, 'linkedin_post');
        account = await this.account(req.accountId);
        if (typeof req.text !== 'string' || !req.text.trim()) throw new PerchError('text must not be empty', 'bad_argument');
        const chars = [...req.text].length;
        if (chars > MAX_LINKEDIN_TEXT) {
          throw new PerchError(`text has ${chars} characters; LinkedIn allows at most ${MAX_LINKEDIN_TEXT}. Nothing was posted.`, 'bad_argument');
        }
        const exp = linkedinExpiry(account, this.now());
        if (exp.state === 'expired') throw loginExpired(account, exp.until);
        const canonical = JSON.stringify(['perch-linkedin-post-v1', account.id, req.text]);
        return { accountId: account.id, requestId: req.requestId, canonical, binding: bindingParts(account) };
      },
      attempt: (binding) => this.attempt(p, req, binding),
    });
    const { providerMessageId, ...rest } = view;
    const urn = postUrnOf(providerMessageId);
    return { ...(account ? this.prov(account) : {}), ...rest, ...(urn ? { postId: urn, url: postUrlOf(urn) } : {}) };
  }

  private async attempt(p: Principal, req: LinkedinPostRequest, binding: string): Promise<MessageSendResult> {
    const notPosted = (detail: string, reason: MessageSendResult['reason']): MessageSendResult => ({ status: 'rejected', detail: `Not posted: ${detail}`, reason });
    try {
      await this.stillAllowed(p, req.accountId);
    } catch (err) {
      return notPosted(err instanceof PerchError ? err.message : 'the request is no longer authorised', 'not_submitted_authorization');
    }
    const current = await this.account(req.accountId).catch(() => undefined);
    if (!current || (await this.workflow.binding(bindingParts(current))) !== binding) {
      return notPosted('the LinkedIn account changed since this requestId was first used', 'not_submitted_account_changed');
    }
    let token: string;
    try {
      token = await this.accessToken(current);
    } catch (err) {
      return notPosted(err instanceof PerchError ? err.message : 'no usable LinkedIn login', 'not_submitted_provider_precheck');
    }
    let res;
    try {
      res = await this.upstream.raw('linkedin', {
        method: 'POST',
        path: '/rest/posts',
        capability: 'linkedin_post',
        headers: { authorization: `Bearer ${token}`, 'linkedin-version': this.version, 'x-restli-protocol-version': '2.0.0' },
        json: {
          author: current.personUrn,
          commentary: escapeLittleText(req.text),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        },
      });
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
        if (err.status === 401) {
          if (current.refreshToken) this.tokens.invalidate(current.id);
          return notPosted(`LinkedIn refused the login (HTTP 401). Renew it: ${renewCommandFor(current)}`, 'provider_rejected');
        }
        return notPosted(`LinkedIn refused the request (HTTP ${err.status}${err.upstreamCode ? `, ${err.upstreamCode}` : ''})`, 'provider_rejected');
      }
      if (err instanceof PerchError && (err.code === 'route_not_allowed' || err.code === 'bad_argument')) return notPosted(err.message, 'not_submitted_provider_precheck');
      return {
        status: 'indeterminate',
        detail: 'The request to LinkedIn failed after it may have been received (timeout, network or server error); the outcome is unknown. Check your profile.',
        reason: 'provider_unknown',
      };
    }
    const key = postKeyOf(res.headers['x-restli-id']);
    return {
      status: 'accepted',
      detail: key ? 'Posted to LinkedIn.' : 'Posted to LinkedIn (LinkedIn returned no recognisable post id).',
      ...(key ? { providerMessageId: key } : {}),
      reason: 'provider_accepted',
    };
  }

  /** linkedin_post_status: the stored outcome of one of this client's posts, without posting. */
  async postStatus(p: Principal, input: { accountId: string; requestId: string }) {
    if (typeof input?.accountId !== 'string') throw new PerchError('accountId is required', 'bad_argument');
    assertLinkedinCapability(p, input.accountId, 'linkedin_post');
    const a = await this.account(input.accountId);
    const { providerMessageId, ...rest } = await messageSendStatus(this.workflow, actorOf(p), a.id, input.requestId, bindingParts(a));
    const urn = postUrnOf(providerMessageId);
    return { ...this.prov(a), ...rest, ...(urn ? { postId: urn, url: postUrlOf(urn) } : {}) };
  }
}

/** perch linkedin remove: the account and every client grant that covered only it. Local only (LinkedIn has no revocation for member tokens here). */
export async function removeLinkedinAccount(store: CredentialStore, id: string): Promise<{ removedGrants: string[] }> {
  const removedGrants: string[] = [];
  await store.update((data) => {
    if (!data.linkedin.some((a) => a.id === id)) throw new PerchError(`Unknown LinkedIn account: ${id}`, 'unknown_account');
    data.linkedin = data.linkedin.filter((a) => a.id !== id);
    data.clients = data.clients
      .map((c) => ({ ...c, accountIds: c.accountIds.filter((x) => x !== id) }))
      .filter((c) => {
        const keep = c.full === true || c.accountIds.length > 0;
        if (!keep) removedGrants.push(c.id);
        return keep;
      });
  });
  return { removedGrants };
}
