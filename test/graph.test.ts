// Microsoft Graph mail adapter against the MOCK Graph (test/support/mockGraph.ts). No live Microsoft calls.
import { describe, expect, it } from 'vitest';
import { GRAPH_MAX_MIME_REQUEST_BYTES, GraphMailProvider, encodeGraphCursor } from '../src/mail/graph.js';
import { ACCEPTED_NOTE, INDETERMINATE_NOTE } from '../src/mail/types.js';
import { PerchError } from '../src/errors.js';
import type { MicrosoftAccount } from '../src/store/credentialStore.js';
import { Upstream } from '../src/upstream.js';
import { rejection } from './support/fixtures.js';
import { MockGraph, type MockGraphMessage, type MockMsAccount } from './support/mockGraph.js';

const now = new Date().toISOString();
function account(scopes: string[] = ['User.Read', 'Mail.Read']): MicrosoftAccount {
  return {
    id: 'microsoft-0000000a', label: 'Outlook', email: 'dummy.one@example.test', tenant: 'consumers',
    clientId: '00000000-0000-4000-8000-00000000d0d0', refreshToken: 'DUMMY-RT', scopes, createdAt: now, updatedAt: now,
  };
}

function msg(i: number, extra: Partial<MockGraphMessage> = {}): MockGraphMessage {
  return {
    id: `AAMk${i}+/=`, folder: 'inbox', conversationId: `conv${i}`, subject: `Subject ${i}`, from: `sender${i}@example.test`,
    to: ['dummy.one@example.test'], receivedDateTime: `2026-01-0${(i % 9) + 1}T00:00:00Z`, body: `Body ${i}`,
    internetMessageId: `<m${i}@example.test>`, ...extra,
  };
}

function setup(messages: MockGraphMessage[] = [msg(1), msg(2), msg(3)], opts: { pageSize?: number } = {}) {
  const ms = new MockGraph(opts);
  const user: MockMsAccount = ms.addAccount('dummy.one@example.test', undefined, messages);
  const token = ms.issueAccessToken(user);
  const invalidated: string[] = [];
  const provider = new GraphMailProvider(new Upstream(ms.transport), {
    getAccessToken: async () => token,
    invalidate: (id) => invalidated.push(id),
  });
  return { ms, user, token, provider, invalidated };
}

describe('GraphMailProvider capabilities', () => {
  it('derives draft/send from the granted scopes', () => {
    const { provider } = setup();
    expect(provider.kind).toBe('microsoft');
    expect(provider.providerCapabilities(account())).toEqual({ draft: false, send: false, modify: false });
    expect(provider.providerCapabilities(account(['Mail.Read', 'Mail.ReadWrite']))).toEqual({ draft: true, send: false, modify: true });
    expect(provider.providerCapabilities(account(['Mail.Read', 'Mail.Send']))).toEqual({ draft: false, send: true, modify: false });
  });
});

describe('GraphMailProvider.search [MOCK Graph]', () => {
  it('lists newest first without a query, with bearer auth and $select', async () => {
    const { ms, token, provider } = setup();
    const page = await provider.search(account(), { pageSize: 2 }, undefined);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      messageId: 'AAMk1+/=', threadId: 'conv1', subject: 'Subject 1', from: 'Name sender1@example.test <sender1@example.test>',
      to: ['dummy.one@example.test'], date: '2026-01-02T00:00:00Z', snippet: 'Body 1', hasAttachments: false,
    });
    const call = ms.calls[0]!;
    expect(call.headers.authorization).toBe(`Bearer ${token}`);
    expect(call.url.pathname).toBe('/v1.0/me/messages');
    expect(call.url.searchParams.get('$top')).toBe('2');
    expect(call.url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(call.url.searchParams.get('$select')).toBe(
      'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,hasAttachments,internetMessageId',
    );
    expect(call.url.searchParams.has('$search')).toBe(false);
    expect(page.next).toEqual(expect.any(String));
  });

  it('quotes and escapes $search and omits $orderby', async () => {
    const { ms, provider } = setup([msg(1, { subject: 'say "hi" \\ there' }), msg(2)]);
    const page = await provider.search(account(), { pageSize: 10, query: 'say "hi" \\' }, undefined);
    const q = ms.calls[0]!.url.searchParams;
    expect(q.get('$search')).toBe('"say \\"hi\\" \\\\"');
    expect(q.has('$orderby')).toBe(false);
    expect(page.items.map((m) => m.messageId)).toEqual(['AAMk1+/=']);
    expect(page.next ?? null).toBeNull();
  });

  it('uses mailFolders for well-known folders and validated ids, and rejects others without calls', async () => {
    const { ms, provider } = setup([msg(1, { folder: 'sentitems' }), msg(2)]);
    const sent = await provider.search(account(), { pageSize: 10, folder: 'sentitems' }, undefined);
    expect(ms.calls[0]!.url.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages');
    expect(sent.items.map((m) => m.messageId)).toEqual(['AAMk1+/=']);
    await provider.search(account(), { pageSize: 10, folder: 'AAMkAGI2/abc+=' }, undefined);
    expect(ms.calls[1]!.url.pathname).toBe('/v1.0/me/mailFolders/AAMkAGI2%2Fabc%2B%3D/messages');
    ms.calls.length = 0;
    for (const folder of ['../users/x', 'inbox?x=1', 'a\u0000b', 'x'.repeat(513), 'Posteingang ä']) {
      expect(await rejection(provider.search(account(), { pageSize: 10, folder }, undefined))).toMatchObject({ code: 'bad_folder' });
    }
    expect(ms.calls).toHaveLength(0);
  });
});

describe('GraphMailProvider nextLink cursors [MOCK Graph]', () => {
  const five = [1, 2, 3, 4, 5].map((i) => msg(i));

  it('follows a valid @odata.nextLink through the fixed origin until exhausted', async () => {
    const { ms, provider } = setup(five);
    const p1 = await provider.search(account(), { pageSize: 2, query: 'Subject' }, undefined);
    const p2 = await provider.search(account(), { pageSize: 2 }, p1.next!);
    const p3 = await provider.search(account(), { pageSize: 2 }, p2.next!);
    expect([...p1.items, ...p2.items, ...p3.items].map((m) => m.messageId)).toEqual(five.map((m) => m.id));
    expect(p3.next ?? null).toBeNull();
    const second = ms.calls[1]!.url;
    expect(second.origin).toBe('https://graph.microsoft.com');
    expect(second.pathname).toBe('/v1.0/me/messages');
    expect(second.searchParams.get('$skiptoken')).toBe('2');
    expect(second.searchParams.get('$search')).toBe('"Subject"');
    expect(ms.calls[1]!.headers.authorization).toMatch(/^Bearer /);
  });

  it('follows a folder nextLink', async () => {
    const { ms, provider } = setup(five);
    const p1 = await provider.search(account(), { pageSize: 3, folder: 'inbox' }, undefined);
    const p2 = await provider.search(account(), { pageSize: 3 }, p1.next!);
    expect(p2.items).toHaveLength(2);
    expect(ms.calls[1]!.url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
  });

  it('rejects cursors that leave the allowed list routes, with zero transport calls', async () => {
    const { ms, provider } = setup(five);
    const bad = [
      'https://evil.example/v1.0/me/messages?$top=2',
      'http://graph.microsoft.com/v1.0/me/messages?$top=2',
      'https://graph.microsoft.com:8443/v1.0/me/messages?$top=2',
      'https://user:pw@graph.microsoft.com/v1.0/me/messages?$top=2',
      'https://graph.microsoft.com/v1.0/users/x/messages?$top=2',
      'https://graph.microsoft.com/v1.0/me/messages/abc/attachments',
      'https://graph.microsoft.com/v1.0/me/messages/abc',
      'https://graph.microsoft.com/v1.0/me/sendMail',
      'https://graph.microsoft.com/beta/me/messages?$top=2',
      'https://graph.microsoft.com/v1.0/me/messages?$top=2&$expand=attachments',
      'https://graph.microsoft.com/v1.0/me/messages?$top=2&$top=3',
      'https://graph.microsoft.com/v1.0/me/messages?$top=2#frag',
      '/v1.0/me/messages?$top=2',
      'not a url',
    ].map(encodeGraphCursor);
    for (const cursor of [...bad, 'garbage!!', '', Buffer.from('{"x":1}').toString('base64url')]) {
      const err = await rejection(provider.search(account(), { pageSize: 2 }, cursor));
      expect(err).toBeInstanceOf(PerchError);
      expect(err).toMatchObject({ code: 'bad_cursor' });
    }
    expect(ms.calls).toHaveLength(0);
  });

  it('stops (flagged incomplete) at an upstream nextLink that would not be a valid cursor', async () => {
    const { ms, provider } = setup(five);
    ms.intercept = () => ({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/me/messages' })),
    });
    expect(await provider.search(account(), { pageSize: 2 }, undefined)).toEqual({ items: [], next: null, incomplete: true });
  });
});

describe('GraphMailProvider.read / replyContext [MOCK Graph]', () => {
  const withAll = () =>
    msg(7, {
      body: 'Grüße ' + 'x'.repeat(20) + ' €€€ end',
      headers: [
        { name: 'In-Reply-To', value: ' <parent@example.test> ' },
        { name: 'references', value: '<root@example.test>\r\n <parent@example.test>' },
        { name: 'X-Other', value: 'ignored' },
      ],
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att/1=', name: 'a.pdf', contentType: 'application/pdf', size: 1234, isInline: false, contentBytes: 'QUJD' },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'att2', name: 'logo.png', contentType: 'image/png', size: 10, isInline: true, contentBytes: 'QQ==' },
      ],
    });

  it('reads plain text with the Prefer header, threading headers and attachment metadata', async () => {
    const { ms, provider } = setup([withAll()]);
    const m = await provider.read(account(), 'AAMk7+/=', { maxBytes: 4096 });
    expect(m).toMatchObject({
      messageId: 'AAMk7+/=', threadId: 'conv7', subject: 'Subject 7', internetMessageId: '<m7@example.test>',
      inReplyTo: '<parent@example.test>', references: ['<root@example.test>', '<parent@example.test>'],
      textSource: 'text/plain', truncated: false, text: withAll().body,
    });
    expect(m.attachments).toEqual([
      { attachmentId: 'att/1=', filename: 'a.pdf', contentType: 'application/pdf', size: 1234, inline: false },
      { attachmentId: 'att2', filename: 'logo.png', contentType: 'image/png', size: 10, inline: true },
    ]);
    const [get, list] = ms.calls;
    expect(get!.url.pathname).toBe('/v1.0/me/messages/AAMk7%2B%2F%3D');
    expect(get!.headers.prefer).toBe('outlook.body-content-type="text"');
    expect(get!.url.searchParams.get('$select')).toBe(
      'id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,hasAttachments,internetMessageId,internetMessageHeaders,body',
    );
    expect(list!.url.pathname).toBe('/v1.0/me/messages/AAMk7%2B%2F%3D/attachments');
    expect(list!.url.searchParams.get('$select')).toBe('id,name,contentType,size,isInline');
    expect(JSON.stringify(m)).not.toContain('QUJD');
  });

  it('truncates the text at maxBytes without splitting a UTF-8 sequence', async () => {
    const { provider } = setup([withAll()]);
    const m = await provider.read(account(), 'AAMk7+/=', { maxBytes: 31 });
    expect(m.truncated).toBe(true);
    expect(Buffer.byteLength(m.text!)).toBeLessThanOrEqual(31);
    expect(m.text).not.toContain('�');
    expect(withAll().body.startsWith(m.text!)).toBe(true);
    expect(m.text!.endsWith(' ')).toBe(true); // the 3-byte "€" that would cross the limit is dropped whole
  });

  it('rejects malformed ids locally and maps 404', async () => {
    const { ms, provider } = setup([withAll()]);
    for (const id of ['', 'a\nb', 'x'.repeat(513), '../users/x']) {
      expect(await rejection(provider.read(account(), id, { maxBytes: 100 }))).toMatchObject({ code: 'bad_id' });
    }
    expect(ms.calls).toHaveLength(0);
    expect((await rejection(provider.read(account(), 'missing', { maxBytes: 100 }))).message).toMatch(/HTTP 404, ErrorItemNotFound/);
  });

  it('returns the reply context from the message headers', async () => {
    const { ms, provider } = setup([withAll()]);
    expect(await provider.replyContext(account(), 'AAMk7+/=')).toEqual({
      internetMessageId: '<m7@example.test>', references: ['<root@example.test>', '<parent@example.test>'], subject: 'Subject 7', threadId: 'conv7',
    });
    expect(ms.calls[0]!.url.searchParams.get('$select')).toBe('internetMessageId,subject,conversationId,internetMessageHeaders');
  });

  it('invalidates the cached token on 401', async () => {
    const { ms, provider, invalidated } = setup([withAll()]);
    ms.accessTokens.clear();
    expect(await rejection(provider.read(account(), 'AAMk7+/=', { maxBytes: 100 }))).toMatchObject({ status: 401 });
    expect(invalidated).toEqual(['microsoft-0000000a']);
  });
});

describe('GraphMailProvider.getAttachment [MOCK Graph]', () => {
  const content = Buffer.from('dummy attachment bytes '.repeat(10));
  const withAttachments = () =>
    msg(8, {
      attachments: [
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'file/1=', name: 'a.txt', contentType: 'text/plain', size: content.length, isInline: false, contentBytes: content.toString('base64') },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'item1', name: 'Fwd', contentType: 'message/rfc822', size: 50, isInline: false },
        { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'ref1', name: 'cloud', contentType: 'application/octet-stream', size: 5, isInline: false },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'big', name: 'big.bin', contentType: 'application/octet-stream', size: 5000, isInline: false, contentBytes: Buffer.alloc(5000).toString('base64') },
        { '@odata.type': '#microsoft.graph.fileAttachment', id: 'liar', name: 'liar.bin', contentType: 'application/octet-stream', size: 10, isInline: false, contentBytes: Buffer.alloc(3000).toString('base64') },
      ],
    });

  it('returns file attachment bytes as base64 with a bounded response size', async () => {
    const { ms, provider } = setup([withAttachments()]);
    const a = await provider.getAttachment(account(), 'AAMk8+/=', 'file/1=', { maxBytes: 1000 });
    expect(a).toEqual({ attachmentId: 'file/1=', filename: 'a.txt', contentType: 'text/plain', size: content.length, contentBase64: content.toString('base64') });
    const call = ms.calls[0]!;
    expect(call.url.pathname).toBe('/v1.0/me/messages/AAMk8%2B%2F%3D/attachments/file%2F1%3D');
    expect(call.maxBytes).toBe(Math.ceil((1000 * 4) / 3) + 64 * 1024);
  });

  it('refuses item and reference attachments', async () => {
    const { provider } = setup([withAttachments()]);
    for (const id of ['item1', 'ref1']) {
      expect(await rejection(provider.getAttachment(account(), 'AAMk8+/=', id, { maxBytes: 1000 }))).toMatchObject({ code: 'unsupported_attachment' });
    }
  });

  it('rejects attachments over maxBytes (reported size, decoded size, or response cap)', async () => {
    const { ms, provider } = setup([withAttachments()]);
    expect(await rejection(provider.getAttachment(account(), 'AAMk8+/=', 'big', { maxBytes: 1000 }))).toMatchObject({ code: 'attachment_too_large' });
    expect(await rejection(provider.getAttachment(account(), 'AAMk8+/=', 'liar', { maxBytes: 1000 }))).toMatchObject({ code: 'attachment_too_large' });
    ms.intercept = () => {
      throw new PerchError('Upstream response exceeds the limit', 'response_too_large');
    };
    expect(await rejection(provider.getAttachment(account(), 'AAMk8+/=', 'file/1=', { maxBytes: 1000 }))).toMatchObject({ code: 'attachment_too_large' });
  });
});

describe('GraphMailProvider.createDraft / send [MOCK Graph]', () => {
  const raw = Buffer.from('From: dummy.one@example.test\r\nTo: x@example.test\r\nBcc: hidden@example.test\r\nSubject: Hi ä\r\n\r\nBody\r\n');
  const mail = { raw, envelope: { from: 'dummy.one@example.test', to: ['x@example.test', 'hidden@example.test'] } };
  const DRAFTS = ['User.Read', 'Mail.Read', 'Mail.ReadWrite'];
  const SEND = ['User.Read', 'Mail.Read', 'Mail.Send'];
  const status = (code: number, body: unknown = { error: { code: 'ErrorX', message: 'mock' } }) => () => ({
    status: code,
    headers: {},
    body: Buffer.from(JSON.stringify(body)),
  });

  it('creates a draft from base64 MIME (text/plain) on the draft-tagged route', async () => {
    const { ms, provider } = setup();
    const d = await provider.createDraft(account(DRAFTS), mail);
    expect(d).toEqual({ draftId: 'draft1', messageId: '<draft1@mock.example>', threadId: 'conv-draft1' });
    expect(ms.calls).toHaveLength(1);
    const call = ms.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(call.headers['content-type']).toBe('text/plain');
    expect(call.body).toBe(raw.toString('base64'));
    expect(ms.drafts[0]).toBe(raw.toString('utf8'));
  });

  it('refuses drafts and sends locally when the grant lacks the scope (no token fetch, no call)', async () => {
    const ms = new MockGraph();
    let tokenFetches = 0;
    const provider = new GraphMailProvider(new Upstream(ms.transport), { getAccessToken: async () => (tokenFetches++, 'x') });
    expect(await rejection(provider.createDraft(account(SEND), mail))).toMatchObject({ code: 'provider_scope_missing' });
    expect(await rejection(provider.send(account(DRAFTS), mail))).toMatchObject({ code: 'provider_scope_missing' });
    expect(tokenFetches + ms.calls.length).toBe(0);
  });

  it('refuses a MIME message whose base64 request body would exceed the Graph 4 MB payload limit, before any token fetch or call', async () => {
    // Primary docs (user-post-messages): MIME payloads "are currently limited to 4 MB"; larger ones get 413.
    // Perch bounds the base64 request body at 4,000,000 bytes (the smaller reading of "4 MB").
    expect(GRAPH_MAX_MIME_REQUEST_BYTES).toBe(4_000_000);
    const header = Buffer.from('From: dummy.one@example.test\r\nTo: x@example.test\r\nSubject: big\r\n\r\n');
    const sized = (n: number) => ({ ...mail, raw: Buffer.concat([header, Buffer.alloc(n - header.length, 0x41)]) });
    const ms = new MockGraph();
    let tokenFetches = 0;
    const provider = new GraphMailProvider(new Upstream(ms.transport), { getAccessToken: async () => (tokenFetches++, 'x') });
    const all = ['User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send'];
    for (const op of ['send', 'draft'] as const) {
      const err = await rejection(op === 'send' ? provider.send(account(all), sized(3_000_001)) : provider.createDraft(account(all), sized(3_000_001)));
      expect(err).toMatchObject({ code: 'message_too_large' });
      expect(err.message).toMatch(/not sent|no draft/i);
      expect(err.message).toContain('4000000');
    }
    expect(tokenFetches + ms.calls.length).toBe(0);
    // Exactly at the bound (3,000,000 raw bytes -> 4,000,000 base64 bytes) is still sent.
    const ok = setup();
    expect((await ok.provider.send(account(SEND), sized(3_000_000))).status).toBe('accepted');
    expect(ok.ms.calls[0]!.body!.length).toBe(4_000_000);
  });

  it('send: 202 is "accepted" (not delivered), exactly one call, base64 MIME on the send-tagged route', async () => {
    const { ms, provider } = setup();
    const r = await provider.send(account(SEND), mail);
    expect(r).toEqual({ status: 'accepted', detail: ACCEPTED_NOTE });
    expect(ms.calls).toHaveLength(1);
    expect(ms.calls[0]!.url.toString()).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(ms.calls[0]!.headers['content-type']).toBe('text/plain');
    expect(ms.calls[0]!.body).toBe(raw.toString('base64'));
    expect(ms.sent).toEqual([raw.toString('utf8')]);
  });

  it('send: 4xx (incl. 429) is "rejected", never retried', async () => {
    for (const code of [400, 403, 413, 429]) {
      const { ms, provider, token } = setup();
      ms.intercept = status(code, { error: { code: 'ErrorMessageSubmissionBlocked', message: `secret detail ${token}` } });
      const r = await provider.send(account(SEND), mail);
      expect(r.status).toBe('rejected');
      expect(r.detail).toContain(`HTTP ${code}`);
      expect(r.detail).not.toContain(token);
      expect(r.detail).not.toContain('secret detail');
      expect(ms.calls).toHaveLength(1);
    }
  });

  it('send: 5xx, timeout, unreachable, oversize or unknown transport failure is "indeterminate", never retried', async () => {
    const failures: Array<() => never | ReturnType<ReturnType<typeof status>>> = [
      status(500),
      status(503),
      () => { throw new PerchError('Upstream request timed out', 'upstream_timeout'); },
      () => { throw new PerchError('Upstream service unreachable', 'upstream_unreachable'); },
      () => { throw new PerchError('too large', 'response_too_large'); },
      () => { throw new Error('socket hang up'); },
    ];
    for (const fail of failures) {
      const { ms, provider, token } = setup();
      ms.intercept = fail;
      const r = await provider.send(account(SEND), mail);
      expect(r).toEqual({ status: 'indeterminate', detail: INDETERMINATE_NOTE });
      expect(JSON.stringify(r)).not.toContain(token);
      expect(ms.calls).toHaveLength(1);
    }
  });

  it('send: a token failure before the request throws and makes no call', async () => {
    const ms = new MockGraph();
    const provider = new GraphMailProvider(new Upstream(ms.transport), {
      getAccessToken: async () => {
        throw new PerchError('Microsoft grant for microsoft-0000000a was revoked or expired.', 'grant_invalid');
      },
    });
    expect(await rejection(provider.send(account(SEND), mail))).toMatchObject({ code: 'grant_invalid' });
    expect(ms.calls).toHaveLength(0);
  });

  it('never puts the access token into error messages', async () => {
    const { ms, provider, token } = setup([msg(1)]);
    ms.intercept = status(500, { error: { code: 'InternalServerError', message: token } });
    const errs = [
      await rejection(provider.read(account(), 'AAMk1+/=', { maxBytes: 100 })),
      await rejection(provider.search(account(), { pageSize: 5 }, undefined)),
      await rejection(provider.createDraft(account(DRAFTS), mail)),
    ];
    for (const e of errs) expect(e.message).not.toContain(token);
  });
});
