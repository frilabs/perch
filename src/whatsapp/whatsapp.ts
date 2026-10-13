import { randomBytes } from 'node:crypto';
import { actorOf, type AuditLog } from '../audit/audit.js';
import { assertWhatsappCapability, currentPrincipal, type Principal } from '../auth/grants.js';
import { PerchError, safeMessage } from '../errors.js';
import { fanOut, type FanOutResult } from '../fanout.js';
import { newAccountId, validateLabel } from '../ids.js';
import type { SendWorkflow } from '../mail/workflow.js';
import { messageSendStatus, sendMessageIdempotently, type MessageSendResult, type MessageSendView } from '../messaging/send.js';
import type { CredentialStore, WhatsappAccount, WhatsappInstance } from '../store/credentialStore.js';
import { GOWA_DEVICE_ID, UpstreamError, validateGowaOrigin, WHATSAPP_JID, type CallOptions, type HttpMethod, type Upstream } from '../upstream.js';

/**
 * WhatsApp through a self-hosted GOWA bridge (go-whatsapp-web-multidevice, REST API v9; unofficial
 * linked-device protocol). Perch talks to exactly one GOWA instance per namespace, on loopback or a
 * Tailscale address only, with basic auth, and always names the device slot (X-Device-Id) it paired, so
 * a request can never fall back to GOWA's default device.
 *
 * MCP tools only reach the allowlisted read routes and, with a whatsapp_send grant, POST /send/message.
 * Pairing and unlinking (device slot routes) are local CLI operations (capability "admin").
 */

export const DEFAULT_WA_PAGE_SIZE = 50;
export const MAX_WA_PAGE_SIZE = 100;
export const DEFAULT_SEARCH_CHATS = 30;
export const MAX_SEARCH_CHATS = 100;
const SEARCH_HITS_PER_CHAT = 10;
const SEARCH_CONCURRENCY = 5;
export const MAX_WA_TEXT = 65_536;
export const DEFAULT_PAIR_TIMEOUT_MS = 180_000;
const PAIR_POLL_MS = 3_000;
const WA_MESSAGE_ID = /^[A-Za-z0-9]{8,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Raw = Record<string, unknown>;

export interface AccountProvenance {
  accountId: string;
  accountLabel: string;
}

const basic = (i: WhatsappInstance) => `Basic ${Buffer.from(`${i.username}:${i.password}`, 'utf8').toString('base64')}`;
const jidPath = (jid: string) => jid.replace('@', '%40');

function jidOf(v: unknown, what = 'chatJid'): string {
  if (typeof v !== 'string' || !WHATSAPP_JID.test(v)) {
    throw new PerchError(`${what} must be a WhatsApp chat id from whatsapp_list_chats (…@s.whatsapp.net, …@lid or …@g.us)`, 'bad_argument');
  }
  return v;
}

function bounded(name: string, value: number | undefined, def: number, max: number): number {
  const n = value ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new PerchError(`${name} must be between 1 and ${max}`, 'bad_argument');
  return n;
}

function timeOf(v: string | undefined, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) {
    throw new PerchError(`${what} must be an RFC 3339 timestamp with offset, e.g. 2026-10-05T09:00:00+02:00`, 'bad_argument');
  }
  return new Date(Date.parse(v)).toISOString();
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

function toChat(c: Raw) {
  const jid = String(c.jid ?? '');
  return {
    chatJid: jid,
    kind: jid.endsWith('@g.us') ? 'group' : 'person',
    ...(str(c.name, 300) ? { name: str(c.name, 300) } : {}),
    ...(str(c.last_message_time, 40) ? { lastMessageTime: str(c.last_message_time, 40) } : {}),
    ...(typeof c.archived === 'boolean' ? { archived: c.archived } : {}),
  };
}

function toMessage(m: Raw) {
  let replyTo: string | undefined;
  if (typeof m.context_metadata === 'string') {
    try {
      const ctx = JSON.parse(m.context_metadata) as Raw;
      if (typeof ctx.replied_to_id === 'string' && WA_MESSAGE_ID.test(ctx.replied_to_id)) replyTo = ctx.replied_to_id;
    } catch {
      // ignore malformed metadata
    }
  }
  return {
    messageId: String(m.id ?? ''),
    ...(str(m.timestamp, 40) ? { time: str(m.timestamp, 40) } : {}),
    ...(str(m.sender_jid, 200) ? { sender: str(m.sender_jid, 200) } : {}),
    ...(str(m.sender_display_name, 300) ? { senderName: str(m.sender_display_name, 300) } : {}),
    fromMe: m.is_from_me === true,
    text: typeof m.content === 'string' ? m.content : '',
    ...(str(m.media_type, 40) ? { mediaType: str(m.media_type, 40) } : {}),
    ...(str(m.filename, 300) ? { filename: str(m.filename, 300) } : {}),
    ...(typeof m.file_length === 'number' ? { fileSize: m.file_length } : {}),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  };
}

function results(body: Raw): unknown {
  if (body.code !== 'SUCCESS') throw new PerchError('The WhatsApp bridge reported a failure', 'upstream_error');
  return body.results;
}

async function call(upstream: Upstream, inst: WhatsappInstance, method: HttpMethod, path: string, opts: Partial<CallOptions> & { deviceId?: string } = {}): Promise<Raw> {
  if (opts.deviceId !== undefined && !GOWA_DEVICE_ID.test(opts.deviceId)) throw new PerchError('Invalid device slot', 'bad_argument');
  return upstream.json<Raw>('gowa', {
    ...opts,
    method,
    path,
    origin: inst.origin,
    headers: { authorization: basic(inst), ...(opts.deviceId ? { 'x-device-id': opts.deviceId } : {}) },
  });
}

async function instanceOf(store: CredentialStore): Promise<WhatsappInstance> {
  const inst = (await store.read()).whatsappInstance;
  if (!inst) throw new PerchError('No WhatsApp bridge configured. Run: perch whatsapp instance set --url http://127.0.0.1:3000', 'not_configured');
  return inst;
}

/** Stores the GOWA instance after one authenticated request (GET /devices) succeeded. */
export async function setWhatsappInstance(store: CredentialStore, upstream: Upstream, input: { url: string; username: string; password: string }): Promise<{ origin: string; devices: number }> {
  const origin = validateGowaOrigin(input.url);
  const username = input.username.trim();
  if (!username || username.includes(':') || !input.password) throw new PerchError('GOWA username (without ":") and password are required', 'bad_argument');
  const now = new Date().toISOString();
  const probe: WhatsappInstance = { origin, username, password: input.password, createdAt: now, updatedAt: now };
  const body = await call(upstream, probe, 'GET', '/devices', { capability: 'admin' });
  const list = results(body);
  await store.update((data) => {
    data.whatsappInstance = { ...probe, createdAt: data.whatsappInstance?.createdAt ?? now };
  });
  return { origin, devices: Array.isArray(list) ? list.length : 0 };
}

export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[\s()./-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (!/^[1-9][0-9]{6,19}$/.test(digits)) throw new PerchError('Phone number must be in international format, e.g. +4366012345678', 'bad_argument');
  return digits;
}

/**
 * Pairs a new linked device by pairing code: creates a Perch device slot in GOWA, asks GOWA for the code
 * (shown via onCode; the user enters it in WhatsApp > Linked devices > Link with phone number) and waits
 * until the slot is logged in. On failure or timeout the slot is removed again (best effort).
 */
export async function pairWhatsappAccount(
  store: CredentialStore,
  upstream: Upstream,
  input: { label: string; phone: string; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; onCode: (code: string) => void },
): Promise<WhatsappAccount> {
  const label = validateLabel(input.label);
  const phone = normalisePhone(input.phone);
  const inst = await instanceOf(store);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deviceId = `perch-${randomBytes(8).toString('hex')}`;
  results(await call(upstream, inst, 'POST', '/devices', { capability: 'admin', json: { device_id: deviceId } }));
  const cleanup = () => call(upstream, inst, 'DELETE', `/devices/${deviceId}`, { capability: 'admin' }).catch(() => undefined);
  try {
    const login = results(await call(upstream, inst, 'POST', `/devices/${deviceId}/login/code`, { capability: 'admin', query: { phone } })) as Raw | undefined;
    const code = typeof login?.pair_code === 'string' && /^[A-Z0-9-]{4,16}$/.test(login.pair_code) ? login.pair_code : undefined;
    if (!code) throw new PerchError('The WhatsApp bridge returned no pairing code', 'upstream_bad_response');
    input.onCode(code);
    const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS);
    for (;;) {
      await sleep(PAIR_POLL_MS);
      // A transient poll failure must not unlink a device the user may just have paired: keep polling.
      const status = (await call(upstream, inst, 'GET', `/devices/${deviceId}/status`, { capability: 'admin' })
        .then(results)
        .catch(() => undefined)) as Raw | undefined;
      if (status?.is_logged_in === true) break;
      if (Date.now() >= deadline) throw new PerchError('Pairing timed out: the code was not entered in time. Nothing was stored; run the command again', 'pairing_timeout');
    }
    const info = (results(await call(upstream, inst, 'GET', `/devices/${deviceId}`, { capability: 'admin' })) ?? {}) as Raw;
    return await store.update((data) => {
      const now = new Date().toISOString();
      const account: WhatsappAccount = {
        id: newAccountId('whatsapp', data.whatsapp.map((a) => a.id)),
        label,
        deviceId,
        ...(str(info.jid, 200) ? { jid: str(info.jid, 200) } : {}),
        ...(str(info.display_name, 200) ? { displayName: str(info.display_name, 200) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      data.whatsapp.push(account);
      return account;
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Removes the account locally and (unless keepDevice) deletes its GOWA device slot, which unlinks the
 * device from the phone and clears its stored chats in GOWA. Returns whether the slot was deleted.
 */
export async function removeWhatsappAccount(store: CredentialStore, upstream: Upstream, id: string, opts: { keepDevice?: boolean } = {}): Promise<boolean> {
  const data = await store.read();
  const account = data.whatsapp.find((a) => a.id === id);
  if (!account) throw new PerchError(`Unknown WhatsApp account: ${id}`, 'unknown_account');
  let deleted = false;
  if (!opts.keepDevice && data.whatsappInstance) {
    deleted = await call(upstream, data.whatsappInstance, 'DELETE', `/devices/${account.deviceId}`, { capability: 'admin' }).then(
      () => true,
      () => false,
    );
  }
  await store.update((d) => {
    d.whatsapp = d.whatsapp.filter((a) => a.id !== id);
  });
  return deleted;
}

/** Connection state of each account's device slot (local CLI). */
export async function whatsappDeviceStatus(store: CredentialStore, upstream: Upstream): Promise<Array<{ account: WhatsappAccount; connected?: boolean; loggedIn?: boolean; error?: string }>> {
  const data = await store.read();
  if (!data.whatsapp.length) return [];
  const inst = await instanceOf(store);
  return Promise.all(
    data.whatsapp.map(async (account) => {
      try {
        const s = results(await call(upstream, inst, 'GET', `/devices/${account.deviceId}/status`, { capability: 'admin' })) as Raw | undefined;
        return { account, connected: s?.is_connected === true, loggedIn: s?.is_logged_in === true };
      } catch (err) {
        return { account, error: safeMessage(err) };
      }
    }),
  );
}

const bindingParts = (a: WhatsappAccount, inst: WhatsappInstance) => ['whatsapp', a.id, a.deviceId, a.jid ?? '', inst.origin];

export interface WhatsappSendRequest {
  accountId: string;
  chatJid: string;
  text: string;
  replyToMessageId?: string;
  requestId: string;
}

export class WhatsappService {
  private readonly guard?: () => Promise<void>;

  constructor(
    private readonly store: CredentialStore,
    private readonly upstream: Upstream,
    private readonly workflow: SendWorkflow,
    private readonly audit: AuditLog,
    opts: { guard?: () => Promise<void> } = {},
  ) {
    this.guard = opts.guard;
  }

  private async account(id: unknown): Promise<{ account: WhatsappAccount; inst: WhatsappInstance }> {
    const data = await this.store.read();
    const account = typeof id === 'string' ? data.whatsapp.find((a) => a.id === id) : undefined;
    if (!account) throw new PerchError(`Unknown WhatsApp account: ${String(id)}`, 'unknown_account');
    if (!data.whatsappInstance) throw new PerchError('No WhatsApp bridge configured', 'not_configured');
    return { account, inst: data.whatsappInstance };
  }

  private async readable(p: Principal, id: unknown) {
    if (typeof id !== 'string') throw new PerchError('accountId is required', 'bad_argument');
    assertWhatsappCapability(p, id, 'whatsapp_read');
    return this.account(id);
  }

  private async readableAll(p: Principal, id: string | undefined): Promise<Array<{ account: WhatsappAccount; inst: WhatsappInstance }>> {
    if (id !== undefined) return [await this.readable(p, id)];
    if (!p.capabilities.has('whatsapp_read')) throw new PerchError('Capability "whatsapp_read" is not granted to this client', 'capability_denied');
    const data = await this.store.read();
    const accounts = data.whatsapp.filter((a) => p.whatsappAccounts === 'all' || p.whatsappAccounts.has(a.id));
    if (accounts.length && !data.whatsappInstance) throw new PerchError('No WhatsApp bridge configured', 'not_configured');
    return accounts.map((account) => ({ account, inst: data.whatsappInstance! }));
  }

  private prov(a: WhatsappAccount): AccountProvenance {
    return { accountId: a.id, accountLabel: a.label };
  }

  private async chatsPage(account: WhatsappAccount, inst: WhatsappInstance, q: { query?: string; archived?: boolean; limit: number; offset: number }) {
    const r = results(
      await call(this.upstream, inst, 'GET', '/chats', {
        deviceId: account.deviceId,
        query: { limit: q.limit, offset: q.offset, search: q.query || undefined, archived: q.archived },
      }),
    ) as { data?: Raw[]; pagination?: { total?: number } } | undefined;
    const chats = (r?.data ?? []).filter((c) => typeof c.jid === 'string' && WHATSAPP_JID.test(c.jid)).map(toChat);
    const total = typeof r?.pagination?.total === 'number' ? r.pagination.total : 0;
    return { chats, next: q.offset + q.limit < total && (r?.data?.length ?? 0) > 0 ? q.offset + q.limit : null };
  }

  /** Chats (people and groups) stored by the bridge, optionally filtered by name, across accounts. */
  async listChats(p: Principal, input: { accountId?: string; query?: string; archived?: boolean; pageSize?: number; cursor?: string }): Promise<FanOutResult<Raw>> {
    const pageSize = bounded('pageSize', input.pageSize, DEFAULT_WA_PAGE_SIZE, MAX_WA_PAGE_SIZE);
    const query = input.query?.trim().slice(0, 200);
    const targets = await this.readableAll(p, input.accountId);
    return fanOut<Raw>({
      kind: 'whatsapp-chats',
      queryKey: { a: input.accountId ?? null, q: query ?? null, ar: input.archived ?? null, pageSize },
      sources: targets.map((t) => t.account),
      seal: this.store,
      cursor: input.cursor,
      fetchPage: async (source, start) => {
        const t = targets.find((x) => x.account.id === source.id)!;
        const offset = start ? Number(start) : 0;
        if (!Number.isInteger(offset) || offset < 0) throw new PerchError('Invalid cursor', 'bad_cursor');
        const page = await this.chatsPage(t.account, t.inst, { query, archived: input.archived, limit: pageSize, offset });
        return { items: page.chats, next: page.next === null ? null : String(page.next) };
      },
    });
  }

  private async messagesPage(
    account: WhatsappAccount,
    inst: WhatsappInstance,
    jid: string,
    q: { query?: string; after?: string; before?: string; fromMe?: boolean; mediaOnly?: boolean; limit: number; offset: number },
  ) {
    const r = results(
      await call(this.upstream, inst, 'GET', `/chat/${jidPath(jid)}/messages`, {
        deviceId: account.deviceId,
        query: {
          limit: q.limit,
          offset: q.offset,
          search: q.query || undefined,
          start_time: q.after,
          end_time: q.before,
          is_from_me: q.fromMe,
          media_only: q.mediaOnly,
        },
      }),
    ) as { data?: Raw[]; pagination?: { total?: number }; chat_info?: Raw } | undefined;
    // Rows of another chat (a bridge bug or a confused route) are dropped, never shown under this chat.
    const messages = (r?.data ?? []).filter((m) => m.chat_jid === undefined || m.chat_jid === jid).map(toMessage);
    const total = typeof r?.pagination?.total === 'number' ? r.pagination.total : 0;
    return {
      messages,
      chatName: str(r?.chat_info?.name, 300),
      next: q.offset + q.limit < total && (r?.data?.length ?? 0) > 0 ? q.offset + q.limit : null,
    };
  }

  /** Messages of one chat as stored by the bridge, with optional text search and time window. */
  async getMessages(
    p: Principal,
    input: { accountId: string; chatJid: string; query?: string; after?: string; before?: string; fromMe?: boolean; mediaOnly?: boolean; pageSize?: number; cursor?: string },
  ) {
    const { account, inst } = await this.readable(p, input.accountId);
    const jid = jidOf(input.chatJid);
    const pageSize = bounded('pageSize', input.pageSize, DEFAULT_WA_PAGE_SIZE, MAX_WA_PAGE_SIZE);
    const after = timeOf(input.after, 'after');
    const before = timeOf(input.before, 'before');
    const query = input.query?.trim().slice(0, 200);
    const kind = `whatsapp-messages:${account.id}:${jid}:${JSON.stringify([query ?? null, after ?? null, before ?? null, input.fromMe ?? null, input.mediaOnly ?? null, pageSize])}`;
    const offset = input.cursor ? Number(this.store.openCursor(kind, input.cursor)) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new PerchError('Invalid cursor', 'bad_cursor');
    const page = await this.messagesPage(account, inst, jid, { query, after, before, fromMe: input.fromMe, mediaOnly: input.mediaOnly, limit: pageSize, offset });
    return {
      ...this.prov(account),
      chatJid: jid,
      ...(page.chatName ? { chatName: page.chatName } : {}),
      messages: page.messages,
      nextCursor: page.next === null ? null : this.store.sealCursor(kind, String(page.next)),
      hasMore: page.next !== null,
    };
  }

  /**
   * Text search over the most recently active chats (the bridge has no global message search): lists up to
   * chatLimit chats per account, newest activity first, and searches each of them.
   */
  async search(p: Principal, input: { query: string; accountId?: string; chatLimit?: number }) {
    const query = input.query?.trim().slice(0, 200);
    if (!query) throw new PerchError('query is required', 'bad_argument');
    const chatLimit = bounded('chatLimit', input.chatLimit, DEFAULT_SEARCH_CHATS, MAX_SEARCH_CHATS);
    const targets = await this.readableAll(p, input.accountId);
    const hits: Raw[] = [];
    const errors: Array<{ accountId: string; accountLabel: string; message: string }> = [];
    let chatsSearched = 0;
    for (const { account, inst } of targets) {
      try {
        const chats: Array<ReturnType<typeof toChat>> = [];
        let offset: number | null = 0;
        while (offset !== null && chats.length < MAX_SEARCH_CHATS * 3) {
          const page = await this.chatsPage(account, inst, { limit: MAX_WA_PAGE_SIZE, offset });
          chats.push(...page.chats);
          offset = page.next;
        }
        const recent = chats.sort((a, b) => String(b.lastMessageTime ?? '').localeCompare(String(a.lastMessageTime ?? ''))).slice(0, chatLimit);
        for (let i = 0; i < recent.length; i += SEARCH_CONCURRENCY) {
          await Promise.all(
            recent.slice(i, i + SEARCH_CONCURRENCY).map(async (chat) => {
              try {
                const page = await this.messagesPage(account, inst, chat.chatJid, { query, limit: SEARCH_HITS_PER_CHAT, offset: 0 });
                chatsSearched++;
                for (const m of page.messages) hits.push({ ...m, chatJid: chat.chatJid, ...(chat.name ? { chatName: chat.name } : {}), ...this.prov(account) });
              } catch (err) {
                errors.push({ ...this.prov(account), message: `${chat.chatJid}: ${safeMessage(err)}` });
              }
            }),
          );
        }
      } catch (err) {
        errors.push({ ...this.prov(account), message: safeMessage(err) });
      }
    }
    hits.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
    return {
      results: hits,
      chatsSearched,
      partial: errors.length > 0,
      errors,
      note:
        `Searched the ${chatLimit} most recently active chats per account (up to ${SEARCH_HITS_PER_CHAT} hits each), not all chats. ` +
        'The bridge only holds messages since pairing plus what the phone synced. Use whatsapp_get_messages with query for one chat.',
    };
  }

  private async stillAllowed(stale: Principal, accountId: string): Promise<void> {
    await this.guard?.();
    assertWhatsappCapability(await currentPrincipal(this.store, stale), accountId, 'whatsapp_send');
  }

  /** Sends a text message from the explicitly chosen account (idempotent per requestId). */
  async send(p: Principal, req: WhatsappSendRequest): Promise<MessageSendView & AccountProvenance & { chatJid?: string; messageId?: string }> {
    let account: WhatsappAccount | undefined;
    let jid = '';
    const view = await sendMessageIdempotently({
      workflow: this.workflow,
      audit: this.audit,
      actor: actorOf(p),
      provider: 'whatsapp',
      accountId: req?.accountId,
      prepare: async () => {
        await this.guard?.();
        if (typeof req?.accountId !== 'string') throw new PerchError('accountId is required', 'bad_argument');
        assertWhatsappCapability(p, req.accountId, 'whatsapp_send');
        const found = await this.account(req.accountId);
        account = found.account;
        jid = jidOf(req.chatJid);
        if (typeof req.text !== 'string' || !req.text.trim()) throw new PerchError('text must not be empty', 'bad_argument');
        if (req.text.length > MAX_WA_TEXT) throw new PerchError(`text exceeds ${MAX_WA_TEXT} characters`, 'bad_argument');
        if (req.replyToMessageId !== undefined && (typeof req.replyToMessageId !== 'string' || !WA_MESSAGE_ID.test(req.replyToMessageId))) {
          throw new PerchError('replyToMessageId must be a messageId from whatsapp_get_messages', 'bad_argument');
        }
        const canonical = JSON.stringify(['perch-whatsapp-send-v1', account.id, jid, req.text, req.replyToMessageId ?? null]);
        return { accountId: account.id, requestId: req.requestId, canonical, binding: bindingParts(account, found.inst) };
      },
      attempt: (binding) => this.attempt(p, req, jid, binding),
    });
    const { providerMessageId, ...rest } = view;
    return { ...this.prov(account!), ...rest, chatJid: jid, ...(providerMessageId ? { messageId: providerMessageId } : {}) };
  }

  private async attempt(p: Principal, req: WhatsappSendRequest, jid: string, binding: string): Promise<MessageSendResult> {
    const notSent = (detail: string, reason: MessageSendResult['reason']): MessageSendResult => ({ status: 'rejected', detail: `Not sent: ${detail}`, reason });
    try {
      await this.stillAllowed(p, req.accountId);
    } catch (err) {
      return notSent(err instanceof PerchError ? err.message : 'the request is no longer authorised', 'not_submitted_authorization');
    }
    const current = await this.account(req.accountId).catch(() => undefined);
    if (!current || (await this.workflow.binding(bindingParts(current.account, current.inst))) !== binding) {
      return notSent('the account or bridge changed since this requestId was first used', 'not_submitted_account_changed');
    }
    let body: Raw;
    try {
      body = await call(this.upstream, current.inst, 'POST', '/send/message', {
        capability: 'whatsapp_send',
        deviceId: current.account.deviceId,
        json: { phone: jid, message: req.text, ...(req.replyToMessageId ? { reply_message_id: req.replyToMessageId } : {}) },
      });
    } catch (err) {
      if (err instanceof UpstreamError && err.status < 500) return notSent(`the bridge refused the request (HTTP ${err.status})`, 'provider_rejected');
      if (err instanceof PerchError && (err.code === 'route_not_allowed' || err.code === 'bad_argument')) return notSent(err.message, 'not_submitted_provider_precheck');
      return { status: 'indeterminate', detail: 'The request to the WhatsApp bridge failed after it may have been sent; the outcome is unknown.', reason: 'provider_unknown' };
    }
    const r = (body.results ?? {}) as Raw;
    if (body.code !== 'SUCCESS' || typeof r.schedule_id === 'string') {
      return { status: 'indeterminate', detail: 'The bridge answered without confirming the send; the outcome is unknown.', reason: 'provider_unknown' };
    }
    const id = typeof r.message_id === 'string' && PROVIDER_ID.test(r.message_id) ? r.message_id : undefined;
    return { status: 'accepted', detail: 'Sent to WhatsApp.', ...(id ? { providerMessageId: id } : {}), reason: 'provider_accepted' };
  }

  async sendStatus(p: Principal, input: { accountId: string; requestId: string }) {
    if (typeof input?.accountId !== 'string') throw new PerchError('accountId is required', 'bad_argument');
    assertWhatsappCapability(p, input.accountId, 'whatsapp_send');
    const { account, inst } = await this.account(input.accountId);
    const { providerMessageId, ...rest } = await messageSendStatus(this.workflow, actorOf(p), account.id, input.requestId, bindingParts(account, inst));
    return { ...this.prov(account), ...rest, ...(providerMessageId ? { messageId: providerMessageId } : {}) };
  }

  async listAccounts(p: Principal) {
    const data = await this.store.read();
    return data.whatsapp
      .filter((a) => p.whatsappAccounts === 'all' || p.whatsappAccounts.has(a.id))
      .map((a) => ({
        accountId: a.id,
        label: a.label,
        ...(a.jid ? { jid: a.jid } : {}),
        ...(a.displayName ? { displayName: a.displayName } : {}),
        granted: [...p.capabilities].filter((c) => c.startsWith('whatsapp_')).sort(),
        connectedAt: a.createdAt,
      }));
  }
}
