import { assertMailCapability, type Principal } from '../auth/grants.js';
import { PerchError } from '../errors.js';
import { fanOut, type FanOutResult } from '../fanout.js';
import type { Capability, CredentialStore, GmailAccount, ImapAccount, MicrosoftAccount, StoreData } from '../store/credentialStore.js';
import { composeForProvider, isMessageId, validateOutgoing, type ComposeInput } from './compose.js';
import {
  DEFAULT_MAIL_MAX_BYTES,
  DEFAULT_MAIL_PAGE_SIZE,
  HARD_MAIL_MAX_BYTES,
  MAX_MAIL_PAGE_SIZE,
  type MailProvider,
  type MailProviderKind,
  type MailSummary,
  type SendResult,
} from './types.js';

export interface MailProviders {
  gmail: MailProvider<GmailAccount>;
  microsoft: MailProvider<MicrosoftAccount>;
  imap: MailProvider<ImapAccount>;
}

type Entry =
  | { kind: 'gmail'; account: GmailAccount }
  | { kind: 'microsoft'; account: MicrosoftAccount }
  | { kind: 'imap'; account: ImapAccount };

export interface MailProvenance {
  accountId: string;
  accountLabel: string;
  provider: MailProviderKind;
}

export interface OutgoingRequest extends Omit<ComposeInput, 'subject'> {
  accountId: string;
  /** Optional when replying (defaults to "Re: <original subject>"). */
  subject?: string;
  /** Perch message id (same account) being answered; sets In-Reply-To/References/thread. */
  replyToMessageId?: string;
}

const RECONNECT: Record<MailProviderKind, (id: string, opt: string) => string> = {
  gmail: (id, opt) => `perch gmail remove ${id}, then perch gmail add --label <label> ${opt}`,
  microsoft: (id, opt) => `perch microsoft remove ${id}, then perch microsoft add --label <label> ${opt}`,
  imap: (id, opt) => `perch imap remove ${id}, then perch imap add ... ${opt}`,
};

function entries(data: StoreData): Entry[] {
  return [
    ...data.gmail.map((account) => ({ kind: 'gmail' as const, account })),
    ...data.microsoft.map((account) => ({ kind: 'microsoft' as const, account })),
    ...data.imap.map((account) => ({ kind: 'imap' as const, account })),
  ];
}

function bounded(name: string, value: number | undefined, def: number, max: number): number {
  const n = value ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new PerchError(`${name} must be between 1 and ${max}`, 'bad_argument');
  return n;
}

const provenance = (e: Entry): MailProvenance => ({ accountId: e.account.id, accountLabel: e.account.label, provider: e.kind });

/**
 * Provider-neutral mail operations. Authorization happens here, before any provider call:
 * 1. the principal must hold the capability for that account (client grant; replying also needs
 * "read"), 2. the account must exist, 3. the stored provider grant must allow it (OAuth scopes /
 * IMAP opt-in).
 * The sender is always the explicitly chosen account; adapters never pick a From address.
 */
export class MailService {
  constructor(
    private readonly store: CredentialStore,
    private readonly providers: MailProviders,
  ) {}

  private provider(e: Entry): MailProvider<unknown> {
    return this.providers[e.kind] as MailProvider<unknown>;
  }

  private async entry(accountId: string): Promise<Entry> {
    const e = entries(await this.store.read()).find((x) => x.account.id === accountId);
    if (!e) throw new PerchError(`Unknown mail account: ${accountId}`, 'unknown_account');
    return e;
  }

  /**
   * The capability check comes first, so a client cannot tell an ungranted account id from a
   * nonexistent one. The read-only operator may read every account and still gets unknown_account.
   */
  private async authorised(principal: Principal, accountId: string, cap: Capability): Promise<Entry> {
    assertMailCapability(principal, accountId, cap);
    return this.entry(accountId);
  }

  /** A client sees only the accounts named in its grant; the read-only operator sees all. */
  async listAccounts(principal: Principal) {
    const visible = (id: string) => principal.mailAccounts === 'all' || principal.mailAccounts.has(id);
    return entries(await this.store.read()).filter((e) => visible(e.account.id)).map((e) => {
      return {
        ...provenance(e),
        email: e.account.email,
        providerCapabilities: { read: true, ...this.provider(e).providerCapabilities(e.account) },
        granted: [...principal.capabilities].filter((c) => c === 'read' || c === 'draft' || c === 'send').sort(),
      };
    });
  }

  async search(
    principal: Principal,
    opts: { query?: string; accountId?: string; folder?: string; pageSize?: number; cursor?: string },
  ): Promise<FanOutResult<MailSummary & { provider: MailProviderKind; accountId: string; accountLabel: string }>> {
    const pageSize = bounded('pageSize', opts.pageSize, DEFAULT_MAIL_PAGE_SIZE, MAX_MAIL_PAGE_SIZE);
    let targets: Entry[];
    if (opts.accountId) {
      targets = [await this.authorised(principal, opts.accountId, 'read')];
    } else {
      targets = entries(await this.store.read()).filter(
        (e) => principal.capabilities.has('read') && (principal.mailAccounts === 'all' || principal.mailAccounts.has(e.account.id)),
      );
    }
    const byId = new Map(targets.map((e) => [e.account.id, e]));
    return fanOut({
      kind: 'mail',
      queryKey: { q: opts.query ?? '', f: opts.folder ?? '', s: pageSize, a: opts.accountId ?? '*' },
      sources: targets.map((e) => ({ id: e.account.id, label: e.account.label })),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      fetchPage: async (source, cursor) => {
        const e = byId.get(source.id)!;
        const page = await this.provider(e).search(
          e.account,
          { ...(opts.query ? { query: opts.query } : {}), ...(opts.folder ? { folder: opts.folder } : {}), pageSize },
          cursor,
        );
        return { ...page, items: page.items.map((i) => ({ ...i, provider: e.kind })) };
      },
    });
  }

  async read(principal: Principal, opts: { accountId: string; messageId: string; maxBytes?: number }) {
    const e = await this.authorised(principal, opts.accountId, 'read');
    const maxBytes = bounded('maxBytes', opts.maxBytes, DEFAULT_MAIL_MAX_BYTES, HARD_MAIL_MAX_BYTES);
    return { ...provenance(e), ...(await this.provider(e).read(e.account, opts.messageId, { maxBytes })) };
  }

  async getAttachment(principal: Principal, opts: { accountId: string; messageId: string; attachmentId: string; maxBytes?: number }) {
    const e = await this.authorised(principal, opts.accountId, 'read');
    const maxBytes = bounded('maxBytes', opts.maxBytes, DEFAULT_MAIL_MAX_BYTES, HARD_MAIL_MAX_BYTES);
    return { ...provenance(e), ...(await this.provider(e).getAttachment(e.account, opts.messageId, opts.attachmentId, { maxBytes })) };
  }

  /**
   * Validates input, resolves reply threading and builds the MIME message. `mode` 'api' keeps the
   * Bcc header (API sends and every stored draft need it); 'smtp' drops it (Bcc is envelope-only).
   */
  private async prepare(e: Entry, req: OutgoingRequest, mode: 'api' | 'smtp') {
    let { subject, inReplyTo, references } = req;
    let threadId: string | undefined;
    if (req.replyToMessageId) {
      const ctx = await this.provider(e).replyContext(e.account, req.replyToMessageId);
      threadId = ctx.threadId;
      // Upstream headers are untrusted and often malformed: keep only well-formed ids. Caller-supplied
      // inReplyTo/references are not filtered here; validateOutgoing rejects them if malformed.
      const original = isMessageId(ctx.internetMessageId) ? ctx.internetMessageId : undefined;
      const upstreamRefs = (ctx.references ?? []).filter((r) => isMessageId(r) && r !== original);
      if (original) inReplyTo ??= original;
      const threadRefs = [...upstreamRefs, ...(original ? [original] : [])].slice(-50);
      if (threadRefs.length) references ??= threadRefs;
      if (subject === undefined && ctx.subject !== undefined) subject = /^re:/i.test(ctx.subject) ? ctx.subject : `Re: ${ctx.subject}`;
    }
    if (subject === undefined) throw new PerchError('subject is required (or reply to a message)', 'bad_argument');
    const { accountId: _a, replyToMessageId: _r, ...compose } = req;
    const validated = validateOutgoing(
      { ...compose, subject, ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) },
      e.account.email,
    );
    return composeForProvider(validated, mode, threadId);
  }

  private assertProviderAllows(e: Entry, what: 'draft' | 'send') {
    const caps = this.provider(e).providerCapabilities(e.account);
    if (caps[what]) return;
    const opt = what === 'send' ? '--allow-send' : '--allow-drafts';
    throw new PerchError(
      what === 'send'
        ? `Account ${e.account.id} was not authorised to send at the provider. Reconnect with send permission: ${RECONNECT[e.kind](e.account.id, opt)}`
        : `Account ${e.account.id} was not authorised for drafts at the provider. Reconnect: ${RECONNECT[e.kind](e.account.id, opt)}`,
      'provider_scope_missing',
    );
  }

  /**
   * replyToMessageId reads the original (subject, Message-ID, References, thread), so it also needs
   * "read" on that account. Checked before any provider I/O; otherwise a send-only grant could copy
   * any message's subject into a mail it addresses to itself.
   */
  private assertReplyReadable(principal: Principal, req: OutgoingRequest) {
    if (req.replyToMessageId !== undefined) assertMailCapability(principal, req.accountId, 'read');
  }

  async createDraft(principal: Principal, req: OutgoingRequest) {
    const e = await this.authorised(principal, req.accountId, 'draft');
    this.assertReplyReadable(principal, req);
    this.assertProviderAllows(e, 'draft');
    // Drafts keep Bcc for every provider (IMAP drafts are APPENDed as complete messages).
    const mail = await this.prepare(e, req, 'api');
    return { ...provenance(e), from: e.account.email, ...(await this.provider(e).createDraft(e.account, mail)) };
  }

  async send(principal: Principal, req: OutgoingRequest): Promise<SendResult & MailProvenance & { from: string }> {
    const e = await this.authorised(principal, req.accountId, 'send');
    this.assertReplyReadable(principal, req);
    this.assertProviderAllows(e, 'send');
    const mail = await this.prepare(e, req, e.kind === 'imap' ? 'smtp' : 'api');
    return { ...provenance(e), from: e.account.email, ...(await this.provider(e).send(e.account, mail)) };
  }
}
