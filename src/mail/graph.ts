import { PerchError } from '../errors.js';
import type { SourcePage } from '../fanout.js';
import type { MicrosoftAccount } from '../store/credentialStore.js';
import { ORIGINS, UpstreamError, isAllowedRoute, type CallOptions, type Upstream } from '../upstream.js';
import { htmlToText, truncateUtf8 } from './html.js';
import {
  ACCEPTED_NOTE,
  HARD_MAIL_MAX_BYTES,
  INDETERMINATE_NOTE,
  MAX_MAIL_PAGE_SIZE,
  type DraftResult,
  type MailAttachmentContent,
  type MailAttachmentMeta,
  type MailMessage,
  type MailProvider,
  type MailSummary,
  type OutgoingMime,
  type ReadOptions,
  type ReplyContext,
  type SearchOptions,
  type SendResult,
} from './types.js';

/**
 * Microsoft Graph (Outlook.com / Microsoft 365) delegated mail adapter. Every call goes through
 * the fixed-origin, allowlisted Upstream; pagination follows @odata.nextLink only after the link
 * was proven to point at one of the two Graph message-list routes.
 */

export interface GraphTokens {
  getAccessToken(accountId: string): Promise<string>;
  invalidate?(accountId: string): void;
}

const READ_SELECT =
  'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,hasAttachments,internetMessageId,internetMessageHeaders,body';
const REPLY_SELECT = 'internetMessageId,subject,conversationId,internetMessageHeaders';
const ATTACHMENT_LIST_SELECT = 'id,name,contentType,size,isInline';
/** A single message JSON (text body + headers) may legitimately exceed the 5 MiB JSON default. */
const READ_RESPONSE_MAX_BYTES = 2 * HARD_MAIL_MAX_BYTES;
const LIST_SELECT = 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,internetMessageId';
const WELL_KNOWN_FOLDERS = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'];
/** Graph ids are (URL-unsafe) base64; anything else is not a folder id. */
const FOLDER_ID_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;
const MAX_QUERY_LENGTH = 1000;
/**
 * Graph documents MIME payloads as "currently limited to 4 MB" (HTTP 413 above it; see
 * https://learn.microsoft.com/en-us/graph/api/user-post-messages). Perch bounds the base64 request
 * body, the larger of the two sizes, at the smaller reading of "4 MB", and refuses locally.
 */
export const GRAPH_MAX_MIME_REQUEST_BYTES = 4_000_000;
const MAX_CURSOR_LINK_LENGTH = 8192;
/** The only two routes a cursor may continue: the message list, optionally inside one folder. */
const LIST_PATH_RE = /^\/v1\.0\/me\/(?:mailFolders\/[A-Za-z0-9_%=-]{1,1024}\/)?messages$/;
const CURSOR_QUERY_KEYS = new Set(['$search', '$top', '$skiptoken', '$skip', '$select', '$orderby', '$filter', '$count']);

/** Opaque cursor around an @odata.nextLink. Exported so tests can build hostile cursors. */
export function encodeGraphCursor(nextLink: string): string {
  return Buffer.from(JSON.stringify({ v: 1, link: nextLink }), 'utf8').toString('base64url');
}

/**
 * Turns a nextLink into an allowlisted (path, query) pair or returns undefined. Never yields a URL:
 * the request is rebuilt on the fixed Graph origin, so a forged cursor cannot redirect Perch (and
 * the bearer token) anywhere else, nor reach any route other than the two list routes.
 */
function parseNextLink(link: unknown): { path: string; query: Record<string, string> } | undefined {
  if (typeof link !== 'string' || link.length > MAX_CURSOR_LINK_LENGTH || link.includes('#')) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.origin !== ORIGINS.graph || url.username || url.password) return undefined;
  if (!LIST_PATH_RE.test(url.pathname) || !isAllowedRoute('graph', 'GET', url.pathname)) return undefined;
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (!CURSOR_QUERY_KEYS.has(k) || k in query) return undefined;
    query[k] = v;
  }
  return { path: url.pathname, query };
}

function decodeGraphCursor(cursor: string): { path: string; query: Record<string, string> } {
  const bad = () => new PerchError('Invalid or tampered cursor', 'bad_cursor');
  if (!/^[A-Za-z0-9_-]{1,16384}$/.test(cursor)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const link = parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === 1 ? (parsed as { link?: unknown }).link : undefined;
  const target = parseNextLink(link);
  if (!target) throw bad();
  return target;
}

interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  internetMessageId?: string;
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  internetMessageHeaders?: Array<{ name?: string; value?: string }> | null;
  body?: { contentType?: string; content?: string } | null;
}

interface GraphAttachmentMeta {
  '@odata.type'?: string;
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

/** Ids reach Graph only percent-encoded; after encoding they must fit the upstream path grammar. */
function idSegment(id: string, what = 'message'): string {
  if (typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new PerchError(`Invalid Microsoft ${what} id`, 'bad_id');
  }
  const enc = encodeURIComponent(id);
  if (!/^[A-Za-z0-9_%=-]+$/.test(enc)) throw new PerchError(`Invalid Microsoft ${what} id`, 'bad_id');
  return enc;
}

function header(m: GraphMessage, name: string): string | undefined {
  const h = m.internetMessageHeaders?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  const v = h?.value?.trim();
  return v || undefined;
}

function referencesOf(m: GraphMessage): string[] {
  return (header(m, 'References') ?? '').split(/\s+/).filter(Boolean);
}

function checkMaxBytes(maxBytes: number): number {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAIL_MAX_BYTES) {
    throw new PerchError(`maxBytes must be an integer between 1 and ${HARD_MAIL_MAX_BYTES}`, 'bad_argument');
  }
  return maxBytes;
}

function formatRecipient(r: GraphRecipient | null | undefined): string | undefined {
  const addr = r?.emailAddress?.address ?? undefined;
  const name = r?.emailAddress?.name ?? undefined;
  if (!addr) return name || undefined;
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function recipients(list: GraphRecipient[] | undefined): string[] | undefined {
  return list?.map(formatRecipient).filter((x): x is string => !!x);
}

function toSummary(m: GraphMessage): MailSummary {
  if (typeof m.id !== 'string' || !m.id) throw new PerchError('Microsoft Graph returned a message without an id', 'upstream_bad_response');
  const from = formatRecipient(m.from);
  const to = recipients(m.toRecipients);
  return {
    messageId: m.id,
    ...(m.conversationId ? { threadId: m.conversationId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(m.subject != null ? { subject: m.subject } : {}),
    ...(m.receivedDateTime ? { date: m.receivedDateTime } : {}),
    ...(m.bodyPreview != null ? { snippet: m.bodyPreview } : {}),
    ...(m.hasAttachments !== undefined ? { hasAttachments: m.hasAttachments } : {}),
  };
}

function folderSegment(folder: string): string {
  const lower = folder.toLowerCase();
  if (WELL_KNOWN_FOLDERS.includes(lower)) return lower;
  if (FOLDER_ID_RE.test(folder)) return encodeURIComponent(folder);
  throw new PerchError(`Unsupported Microsoft folder. Use one of ${WELL_KNOWN_FOLDERS.join(', ')} or a folder id`, 'bad_folder');
}

function searchLiteral(query: string): string {
  if (query.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new PerchError(`Search query must be at most ${MAX_QUERY_LENGTH} printable characters`, 'bad_argument');
  }
  // KQL phrase: the whole query is one quoted string so it cannot inject OData syntax.
  return `"${query.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export class GraphMailProvider implements MailProvider<MicrosoftAccount> {
  readonly kind = 'microsoft' as const;

  constructor(
    private readonly upstream: Upstream,
    private readonly tokens: GraphTokens,
  ) {}

  providerCapabilities(account: MicrosoftAccount): { draft: boolean; send: boolean } {
    return { draft: account.scopes.includes('Mail.ReadWrite'), send: account.scopes.includes('Mail.Send') };
  }

  /** Authorised Graph call; a 401 drops the cached access token so the next call refreshes. */
  private async call<T>(account: MicrosoftAccount, opts: CallOptions): Promise<T> {
    const token = await this.tokens.getAccessToken(account.id);
    try {
      return await this.upstream.json<T>('graph', { ...opts, headers: { ...opts.headers, authorization: `Bearer ${token}` } });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) this.tokens.invalidate?.(account.id);
      throw err;
    }
  }

  async search(account: MicrosoftAccount, opts: SearchOptions, cursor: string | undefined): Promise<SourcePage<MailSummary>> {
    let path: string;
    let query: Record<string, string>;
    if (cursor !== undefined) {
      ({ path, query } = decodeGraphCursor(cursor));
    } else {
      const top = Math.max(1, Math.min(MAX_MAIL_PAGE_SIZE, Math.floor(opts.pageSize) || 1));
      path = opts.folder !== undefined ? `/v1.0/me/mailFolders/${folderSegment(opts.folder)}/messages` : '/v1.0/me/messages';
      query = { $top: String(top), $select: LIST_SELECT };
      // Graph rejects $search combined with $orderby; search results come back by relevance/date.
      if (opts.query) query.$search = searchLiteral(opts.query);
      else query.$orderby = 'receivedDateTime desc';
    }
    const res = await this.call<{ value?: GraphMessage[]; '@odata.nextLink'?: string }>(account, { method: 'GET', path, query });
    const items = (res.value ?? []).map(toSummary);
    const nextLink = res['@odata.nextLink'];
    if (nextLink === undefined || nextLink === null) return { items, next: null };
    // A nextLink we would refuse as a cursor ends pagination here, flagged incomplete instead of silently.
    if (!parseNextLink(nextLink)) return { items, next: null, incomplete: true };
    return { items, next: encodeGraphCursor(nextLink) };
  }

  async read(account: MicrosoftAccount, messageId: string, opts: ReadOptions): Promise<MailMessage> {
    const maxBytes = checkMaxBytes(opts.maxBytes);
    const id = idSegment(messageId);
    const m = await this.call<GraphMessage>(account, {
      method: 'GET',
      path: `/v1.0/me/messages/${id}`,
      query: { $select: READ_SELECT },
      headers: { prefer: 'outlook.body-content-type="text"' },
      maxBytes: READ_RESPONSE_MAX_BYTES,
    });
    // Inline-only messages report hasAttachments=false, so the listing is always fetched.
    const list = await this.call<{ value?: GraphAttachmentMeta[] }>(account, {
      method: 'GET',
      path: `/v1.0/me/messages/${id}/attachments`,
      query: { $select: ATTACHMENT_LIST_SELECT },
    });
    const isHtml = m.body?.contentType?.toLowerCase() === 'html';
    const raw = m.body?.content ?? '';
    const body = isHtml ? htmlToText(raw, maxBytes) : truncateUtf8(raw, maxBytes);
    const cc = recipients(m.ccRecipients);
    const replyTo = recipients(m.replyTo);
    const inReplyTo = header(m, 'In-Reply-To');
    const references = referencesOf(m);
    const attachments: MailAttachmentMeta[] = (list.value ?? [])
      .filter((a) => typeof a.id === 'string' && a.id)
      .map((a) => ({
        attachmentId: a.id!,
        ...(a.name ? { filename: a.name } : {}),
        contentType: a.contentType || 'application/octet-stream',
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
        ...(a.isInline !== undefined ? { inline: a.isInline } : {}),
      }));
    return {
      ...toSummary(m),
      ...(cc?.length ? { cc } : {}),
      ...(replyTo?.length ? { replyTo } : {}),
      ...(m.internetMessageId ? { internetMessageId: m.internetMessageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length ? { references } : {}),
      text: body.text,
      textSource: isHtml ? 'text/html' : 'text/plain',
      truncated: body.truncated,
      attachments,
    };
  }

  async getAttachment(account: MicrosoftAccount, messageId: string, attachmentId: string, opts: ReadOptions): Promise<MailAttachmentContent> {
    const maxBytes = checkMaxBytes(opts.maxBytes);
    const tooLarge = () =>
      new PerchError(`Attachment exceeds the ${maxBytes} byte limit (raise maxBytes, up to ${HARD_MAIL_MAX_BYTES})`, 'attachment_too_large');
    let a: GraphAttachmentMeta;
    try {
      a = await this.call<GraphAttachmentMeta>(account, {
        method: 'GET',
        path: `/v1.0/me/messages/${idSegment(messageId)}/attachments/${idSegment(attachmentId, 'attachment')}`,
        // contentBytes is base64 (4/3) plus JSON metadata; the transport aborts anything larger.
        maxBytes: Math.ceil((maxBytes * 4) / 3) + 64 * 1024,
      });
    } catch (err) {
      if (err instanceof PerchError && err.code === 'response_too_large') throw tooLarge();
      throw err;
    }
    // Item attachments (attached Outlook items) and reference attachments (cloud links) carry no file bytes.
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      throw new PerchError('Only file attachments can be downloaded (this is an attached Outlook item or a cloud link)', 'unsupported_attachment');
    }
    if (typeof a.size === 'number' && a.size > maxBytes) throw tooLarge();
    const b64 = a.contentBytes ?? '';
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw new PerchError('Microsoft Graph returned malformed attachment content', 'upstream_bad_response');
    }
    const size = Buffer.from(b64, 'base64').length;
    if (size > maxBytes) throw tooLarge();
    return {
      attachmentId,
      ...(a.name ? { filename: a.name } : {}),
      contentType: a.contentType || 'application/octet-stream',
      size,
      contentBase64: b64,
    };
  }

  async replyContext(account: MicrosoftAccount, messageId: string): Promise<ReplyContext> {
    const m = await this.call<GraphMessage>(account, {
      method: 'GET',
      path: `/v1.0/me/messages/${idSegment(messageId)}`,
      query: { $select: REPLY_SELECT },
    });
    return {
      ...(m.internetMessageId ? { internetMessageId: m.internetMessageId } : {}),
      references: referencesOf(m),
      ...(m.subject != null ? { subject: m.subject } : {}),
      ...(m.conversationId ? { threadId: m.conversationId } : {}),
    };
  }

  private requireScope(account: MicrosoftAccount, cap: 'draft' | 'send'): void {
    if (this.providerCapabilities(account)[cap]) return;
    const scope = cap === 'draft' ? 'Mail.ReadWrite' : 'Mail.Send';
    const flag = cap === 'draft' ? '--allow-drafts' : '--allow-send';
    throw new PerchError(
      `Microsoft account ${account.id} was not authorised with ${scope}. Reconnect it with ${flag}: ` +
        `\`perch microsoft remove ${account.id}\`, then \`perch microsoft add ${flag} --label <label>\`.`,
      'provider_scope_missing',
    );
  }

  /** Base64 MIME request body, refused before any token fetch or call when over the Graph limit. */
  private mimeBody(mail: OutgoingMime, what: 'draft' | 'send'): string {
    const encoded = 4 * Math.ceil(mail.raw.length / 3);
    if (encoded > GRAPH_MAX_MIME_REQUEST_BYTES) {
      throw new PerchError(
        `${what === 'send' ? 'Not sent' : 'No draft created'}: the message is ${mail.raw.length} bytes of MIME (${encoded} bytes base64), ` +
          `over the Microsoft Graph limit of ${GRAPH_MAX_MIME_REQUEST_BYTES} bytes per request. Reduce or remove attachments.`,
        'message_too_large',
      );
    }
    return mail.raw.toString('base64');
  }

  /** Graph "create message in MIME format": base64 MIME as text/plain lands in Drafts. */
  async createDraft(account: MicrosoftAccount, mail: OutgoingMime): Promise<DraftResult> {
    this.requireScope(account, 'draft');
    const data = this.mimeBody(mail, 'draft');
    const m = await this.call<GraphMessage>(account, {
      method: 'POST',
      path: '/v1.0/me/messages',
      text: { contentType: 'text/plain', data },
      capability: 'draft',
    });
    if (typeof m.id !== 'string' || !m.id) throw new PerchError('Microsoft Graph did not return the draft id', 'upstream_bad_response');
    return {
      draftId: m.id,
      ...(m.internetMessageId ? { messageId: m.internetMessageId } : {}),
      ...(m.conversationId ? { threadId: m.conversationId } : {}),
    };
  }

  /**
   * sendMail with base64 MIME. 202 only means "accepted for processing". Exactly one attempt: once
   * the request was handed to the transport, any non-4xx failure may still have sent the message,
   * so it is reported as indeterminate and never retried.
   */
  async send(account: MicrosoftAccount, mail: OutgoingMime): Promise<SendResult> {
    this.requireScope(account, 'send');
    const data = this.mimeBody(mail, 'send'); // refused locally: nothing was sent
    const token = await this.tokens.getAccessToken(account.id); // failures here throw: nothing was sent
    try {
      await this.upstream.raw('graph', {
        method: 'POST',
        path: '/v1.0/me/sendMail',
        headers: { authorization: `Bearer ${token}` },
        text: { contentType: 'text/plain', data },
        capability: 'send',
      });
      return { status: 'accepted', detail: ACCEPTED_NOTE };
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
        if (err.status === 401) this.tokens.invalidate?.(account.id);
        // err.message is the sanitised status/code summary built by Upstream (no body, no token).
        return { status: 'rejected', detail: `Not sent. ${err.message}` };
      }
      // Blocked before any network I/O: a programming error, not an outcome.
      if (err instanceof PerchError && err.code === 'route_not_allowed') throw err;
      return { status: 'indeterminate', detail: INDETERMINATE_NOTE };
    }
  }
}
