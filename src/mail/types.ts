import type { SourcePage } from '../fanout.js';

/** Provider-neutral shapes shared by the Gmail, Microsoft Graph and IMAP/SMTP adapters. */

export type MailProviderKind = 'gmail' | 'microsoft' | 'imap';

/** Default and hard caps for message text and attachment content returned to MCP clients. */
export const DEFAULT_MAIL_MAX_BYTES = 48 * 1024;
export const HARD_MAIL_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAIL_PAGE_SIZE = 20;
export const MAX_MAIL_PAGE_SIZE = 50;

export interface MailSummary {
  /** Perch message id, opaque and provider-specific (IMAP ids are bound to UIDVALIDITY). */
  messageId: string;
  threadId?: string;
  folder?: string;
  from?: string;
  to?: string[];
  subject?: string;
  /** ISO 8601 */
  date?: string;
  snippet?: string;
  hasAttachments?: boolean;
}

export interface MailAttachmentMeta {
  attachmentId: string;
  filename?: string;
  contentType: string;
  /** Provider-reported size in bytes (IMAP reports the encoded size). */
  size?: number;
  inline?: boolean;
}

export interface MailMessage extends MailSummary {
  cc?: string[];
  replyTo?: string[];
  /** RFC 5322 threading headers of this message. */
  internetMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Plain-text body (from text/plain, or derived from HTML when no text part exists). */
  text?: string;
  /** "text/plain", or "text/html" when the text was derived from HTML. */
  textSource?: 'text/plain' | 'text/html';
  /** True when `text` was cut at maxBytes. */
  truncated: boolean;
  attachments: MailAttachmentMeta[];
}

export interface MailAttachmentContent {
  attachmentId: string;
  filename?: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

/** What a reply needs from the message being answered. */
export interface ReplyContext {
  internetMessageId?: string;
  references: string[];
  subject?: string;
  /** Provider thread id (Gmail threadId), passed back when drafting/sending. */
  threadId?: string;
}

export interface SearchOptions {
  query?: string;
  /** IMAP mailbox path or Graph well-known folder name; Gmail ignores it (use the query, e.g. in:inbox). */
  folder?: string;
  pageSize: number;
}

export interface ReadOptions {
  maxBytes: number;
}

export interface OutgoingMime {
  /** Full RFC 5322 message (Bcc header included for API providers, excluded for SMTP). */
  raw: Buffer;
  /** SMTP envelope: account address and every To/Cc/Bcc recipient (bare addresses). */
  envelope: { from: string; to: string[] };
  threadId?: string;
}

export interface DraftResult {
  draftId: string;
  messageId?: string;
  threadId?: string;
}

/**
 * accepted: the provider accepted the message for delivery (NOT proof of delivery).
 * rejected: the provider refused it before accepting; it was not sent.
 * indeterminate: the outcome is unknown (network loss/timeout/5xx after the request left);
 *   Perch never retries automatically. Check the Sent folder before sending again.
 */
export interface SendResult {
  status: 'accepted' | 'rejected' | 'indeterminate';
  providerMessageId?: string;
  detail: string;
}

/**
 * One adapter per provider. `A` is the stored account type. Adapters never decide
 * authorization: the MailService checks the client grant and provider capability first.
 */
export interface MailProvider<A> {
  readonly kind: MailProviderKind;
  /** What this stored account is able to do at the provider (OAuth scopes / IMAP opt-ins). */
  providerCapabilities(account: A): { draft: boolean; send: boolean };
  search(account: A, opts: SearchOptions, cursor: string | undefined): Promise<SourcePage<MailSummary>>;
  read(account: A, messageId: string, opts: ReadOptions): Promise<MailMessage>;
  getAttachment(account: A, messageId: string, attachmentId: string, opts: ReadOptions): Promise<MailAttachmentContent>;
  replyContext(account: A, messageId: string): Promise<ReplyContext>;
  createDraft(account: A, mail: OutgoingMime): Promise<DraftResult>;
  send(account: A, mail: OutgoingMime): Promise<SendResult>;
}

export const ACCEPTED_NOTE =
  'Accepted by the provider for delivery. This is not proof of delivery to the recipient.';
export const INDETERMINATE_NOTE =
  'The outcome is unknown (connection lost or provider error after the request was sent). Perch did not retry. ' +
  'Check the Sent folder before sending again to avoid a duplicate.';
