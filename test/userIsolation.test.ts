// Cross-user isolation through the real MCP SDK client over local HTTP and over a persistent in-memory
// session (the stdio code path). Root operator, user A and user B have stores with COLLIDING account ids for
// Drive, Notion, Gmail, Graph, IMAP and Calendar/Contacts; each namespace's upstream is its own MOCK world,
// and every provider request is logged with the namespace tag that received it. Nothing reaches a real
// provider; every secret is generated dummy data.
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClientGrant, removeClientGrant } from '../src/auth/grants.js';
import { generateHttpToken, startHttpServer, type RunningHttpServer } from '../src/mcp/http.js';
import { createMcpServer } from '../src/mcp/server.js';
import { CredentialStore, initStore, storeFilePath, type Capability } from '../src/store/credentialStore.js';
import { NamespaceRouter } from '../src/users/namespaces.js';
import { addUser, openUserStore, removeUser, userStorePaths } from '../src/users/registry.js';
import { makeTempDirs, rejection, type TempDirs } from './support/fixtures.js';
import { createWorld, IDS, seedWorld, worldContextFactory, type IoLog, type World } from './support/namespaceFixtures.js';

let dirs: TempDirs;
let rootStore: CredentialStore;
let router: NamespaceRouter;
let server: RunningHttpServer;
let globalToken: string;
let io: IoLog;
let logs: string[];
let worlds: Map<string, World>;
let A: { id: string; token: string; store: CredentialStore; world: World };
let B: { id: string; token: string; store: CredentialStore; world: World };
let ROOT: World;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TIME_MIN = '2026-10-01T00:00:00Z';

async function provision(label: string, tag: string) {
  const file = path.join(dirs.root, 'config', 'users', `${tag}.token`);
  const { user } = await addUser(rootStore, { label, tokenFile: file });
  const store = await openUserStore(rootStore, user.id);
  const world = createWorld(tag, io);
  worlds.set(user.id, world);
  await seedWorld(store, world);
  return { id: user.id, token: (await readFile(file, 'utf8')).trim(), store, world };
}

async function grant(store: CredentialStore, capabilities: Capability[], accountIds: string[]) {
  const tokenFile = path.join(dirs.root, 'config', 'clients', `${Math.random().toString(16).slice(2)}.token`);
  const { client } = await createClientGrant(store, { label: `C ${capabilities.join(' ')}`, capabilities, accountIds, tokenFile });
  return { client, token: (await readFile(tokenFile, 'utf8')).trim() };
}

async function http(token: string) {
  const c = new Client({ name: 'iso-http', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

/** Persistent session over the stdio code path: resolved once, then kept open across tool calls. */
async function persistent(token: string) {
  const s = (await router.resolveToken(token))!;
  const mcp = createMcpServer(s.context, s.principal, s.session);
  const [x, y] = InMemoryTransport.createLinkedPair();
  await mcp.connect(y);
  const c = new Client({ name: 'iso-persistent', version: '0' });
  await c.connect(x);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
  } catch (err) {
    return { isError: true, text: (err as Error).message, json: undefined };
  }
}

function rawStatus(token: string) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, host: `127.0.0.1:${server.port}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }));
  });
}

/** Runs `fn` and returns the provider requests it caused (by namespace tag). */
async function ioOf(fn: () => Promise<unknown>) {
  const start = io.length;
  await fn();
  return io.slice(start);
}

const otherTags = (tag: string) => ['ROOT', 'A', 'B'].filter((t) => t !== tag);

beforeEach(async () => {
  dirs = await makeTempDirs();
  io = [];
  logs = [];
  worlds = new Map();
  await initStore({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
  rootStore = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
  ROOT = createWorld('ROOT', io);
  worlds.set('root', ROOT);
  await seedWorld(rootStore, ROOT);
  A = await provision('Alice', 'A');
  B = await provision('Bob', 'B');
  const factory = worldContextFactory(worlds, io);
  router = new NamespaceRouter(factory(rootStore), factory);
  globalToken = generateHttpToken();
  server = await startHttpServer({ host: '127.0.0.1', port: 0, token: globalToken, context: router.root, namespaces: router, log: (l) => logs.push(l) });
});
afterEach(async () => {
  await server?.close();
  await dirs.cleanup();
});

describe('namespace selection by bearer token [MOCK upstreams]', () => {
  it('lists only the caller namespace accounts although every namespace uses the same account ids', async () => {
    for (const [token, tag, userId] of [
      [globalToken, 'ROOT', undefined],
      [A.token, 'A', A.id],
      [B.token, 'B', B.id],
    ] as const) {
      const c = await http(token);
      const r = await call(c, 'perch_list_accounts');
      expect(r.isError, r.text).toBe(false);
      expect(r.json.google).toEqual([expect.objectContaining({ accountId: IDS.google, label: `Drive of ${tag}` })]);
      expect(r.json.notion).toEqual([expect.objectContaining({ workspaceId: IDS.notion, label: `Notion of ${tag}` })]);
      expect(r.json.mail.map((m: { accountId: string; accountLabel: string }) => `${m.accountId} ${m.accountLabel}`).sort()).toEqual(
        [`${IDS.gmail} Gmail of ${tag}`, `${IDS.imap} GMX of ${tag}`, `${IDS.microsoft} Outlook of ${tag}`].sort(),
      );
      expect(r.json.googleProductivity).toEqual([expect.objectContaining({ accountId: IDS.gprod, label: `Calendar of ${tag}` })]);
      expect(r.json.connection).toMatchObject({ kind: 'operator_readonly', ...(userId ? { user: userId } : {}) });
      if (!userId) expect(r.json.connection.user).toBeUndefined();
      for (const other of otherTags(tag)) expect(r.text).not.toContain(` of ${other}`);
      for (const id of [A.id, B.id].filter((x) => x !== userId)) expect(r.text).not.toContain(id);
      expect(r.text).not.toMatch(/Alice|Bob/);
      await c.close();
    }
    expect(io).toEqual([]);
  });

  it('reads, downloads, attachments and fan-out searches use only the caller namespace credentials', async () => {
    for (const [token, tag] of [
      [A.token, 'A'],
      [B.token, 'B'],
      [globalToken, 'ROOT'],
    ] as const) {
      const c = await http(token);
      const texts: string[] = [];
      const used = await ioOf(async () => {
        const ok = async (name: string, args: Record<string, unknown>) => {
          const r = await call(c, name, args);
          expect(r.isError, `${tag} ${name}: ${r.text}`).toBe(false);
          texts.push(r.text);
          return r.json;
        };
        const ds = await ok('drive_search', { query: 'report' });
        expect(ds.results.map((f: { name: string }) => f.name).sort()).toEqual([`report ${tag} one`, `report ${tag} two`]);
        expect((await ok('drive_read_file', { accountId: IDS.google, fileId: 'file0001' })).text).toBe(`drive secret of ${tag}`);
        const dl = await ok('drive_download_file', { accountId: IDS.google, fileId: 'file0002' });
        expect(Buffer.from(dl.data, 'base64').toString()).toBe(`pdf of ${tag}`);
        const ns = await ok('notion_search', {});
        expect(ns.results.map((p: { title: string }) => p.title)).toEqual([`Plan ${tag}`]);
        const page = await ok('notion_get_page_content', { workspaceId: IDS.notion, pageId: ns.results[0].id });
        expect(JSON.stringify(page)).toContain(`block 1 of ${tag}`);
        const ms = await ok('mail_search', {});
        expect(ms.results.map((m: { subject: string }) => m.subject).sort()).toEqual([`gmail ${tag}`, `graph ${tag}`, `imap ${tag}`]);
        for (const m of ms.results as Array<{ accountId: string; messageId: string }>) {
          const msg = await ok('mail_read_message', { accountId: m.accountId, messageId: m.messageId });
          expect(msg.text).toContain(`body of ${tag}`);
          const att = (msg.attachments as Array<{ attachmentId: string }>)[0];
          if (att) {
            const content = await ok('mail_get_attachment', { accountId: m.accountId, messageId: m.messageId, attachmentId: att.attachmentId });
            expect(Buffer.from(content.contentBase64, 'base64').toString()).toBe(`${m.accountId.split('-')[0]} attachment of ${tag}`);
          }
        }
        const ev = await ok('calendar_list_events', { timeMin: TIME_MIN });
        expect(ev.results.map((e: { summary: string }) => e.summary)).toEqual([1, 2, 3].map((n) => `event ${n} of ${tag}`));
        const one = await ok('calendar_get_event', { accountId: IDS.gprod, calendarId: 'primary', eventId: ev.results[0].eventId });
        expect(one.summary).toBe(`event 1 of ${tag}`);
        const ct = await ok('contacts_list', {});
        expect(ct.results.map((p: { names: Array<{ displayName: string }> }) => p.names[0]!.displayName)).toEqual([1, 2, 3].map((n) => `contact ${n} of ${tag}`));
        expect((await ok('contacts_get', { accountId: IDS.gprod, resourceName: 'people/c2' })).names[0].displayName).toBe(`contact 2 of ${tag}`);
      });
      expect(used.length).toBeGreaterThan(10);
      expect(used.filter((u) => !u.startsWith(`${tag} `))).toEqual([]);
      for (const other of otherTags(tag)) expect(texts.join('\n')).not.toContain(`of ${other}`);
      await c.close();
    }
  });

  it('never shares access-token caches between namespaces with colliding account ids', async () => {
    const a = await http(A.token);
    const b = await http(B.token);
    for (let i = 0; i < 2; i++) {
      expect((await call(a, 'drive_read_file', { accountId: IDS.google, fileId: 'file0001' })).json.text).toBe('drive secret of A');
      expect((await call(b, 'drive_read_file', { accountId: IDS.google, fileId: 'file0001' })).json.text).toBe('drive secret of B');
    }
    // Each namespace refreshed its own grant once and then used its own cached token.
    expect(A.world.drive.tokenCalls).toBe(1);
    expect(B.world.drive.tokenCalls).toBe(1);
    for (const w of [A.world, B.world]) {
      const presented = w.drive.calls.filter((r) => r.url.pathname.startsWith('/drive/')).map((r) => r.headers.authorization!.replace('Bearer ', ''));
      expect(presented.length).toBe(4); // metadata + media per read
      expect(presented.every((t) => w.drive.accessTokens.has(t))).toBe(true);
    }
    expect(ROOT.drive.calls).toEqual([]);
    await a.close();
    await b.close();
  });
});

describe('cross-namespace references fail before provider I/O [MOCK upstreams]', () => {
  it('rejects cursors from another namespace (same ids) and forged cursors, without provider I/O', async () => {
    const a = await http(A.token);
    const b = await http(B.token);
    const root = await http(globalToken);
    const pageA = (await call(a, 'notion_search', {})).json.results[0].id as string;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['drive_search', { query: 'report', pageSize: 1 }],
      ['drive_list_files', { pageSize: 1 }],
      ['notion_get_block_children', { workspaceId: IDS.notion, blockId: pageA, pageSize: 1 }],
      ['notion_get_page_content', { workspaceId: IDS.notion, pageId: pageA, pageSize: 1 }],
      ['calendar_list_events', { timeMin: TIME_MIN, pageSize: 1 }],
      ['calendar_list_events', { accountId: IDS.gprod, timeMin: TIME_MIN, pageSize: 1 }],
      ['contacts_list', { pageSize: 1 }],
      ['contacts_list', { accountId: IDS.gprod, pageSize: 1 }],
    ];
    for (const [tool, args] of cases) {
      const first = await call(a, tool, args);
      expect(first.isError, `${tool}: ${first.text}`).toBe(false);
      const cursor = first.json.nextCursor as string;
      expect(typeof cursor, tool).toBe('string');
      // The owner can continue.
      const cont = await call(a, tool, { ...args, cursor });
      expect(cont.isError, `${tool} continue: ${cont.text}`).toBe(false);

      for (const [who, c] of [
        ['B', b],
        ['ROOT', root],
      ] as const) {
        const used = await ioOf(async () => {
          const r = await call(c, tool, { ...args, cursor });
          expect(r.isError, `${who} ${tool} with A's cursor`).toBe(true);
          expect(r.text).toMatch(/cursor/i);
          expect(r.text).not.toMatch(/of A|Alice/);
        });
        expect(used, `${who} ${tool}`).toEqual([]);
      }
      const forged = cursor.slice(0, -2) + (cursor.endsWith('AA') ? 'BB' : 'AA');
      const used = await ioOf(async () => {
        const r = await call(a, tool, { ...args, cursor: forged });
        expect(r.isError, `forged ${tool}`).toBe(true);
        expect(r.text).toMatch(/cursor/i);
      });
      expect(used, `forged ${tool}`).toEqual([]);
    }
    for (const c of [a, b, root]) await c.close();
  });

  it('treats an account id that exists only in another namespace as unknown, before I/O and without its metadata', async () => {
    const now = new Date().toISOString();
    await A.store.update((d) => {
      d.google.push({ ...d.google[0]!, id: 'google-000000bb', label: 'Only-A drive', email: 'only.a@example.test', createdAt: now });
      d.notion.push({ ...d.notion[0]!, id: 'notion-000000bb', label: 'Only-A notion' });
      d.imap.push({ ...d.imap[0]!, id: 'imap-000000bb', label: 'Only-A imap', email: 'only.a.imap@example.test' });
      d.googleProductivity.push({ ...d.googleProductivity[0]!, id: 'gprod-000000bb', label: 'Only-A calendar', email: 'only.a.cal@example.test' });
    });
    const pageA = A.world.notionPageId;
    for (const token of [B.token, globalToken]) {
      const c = await http(token);
      const used = await ioOf(async () => {
        for (const [tool, args] of [
          ['drive_get_file', { accountId: 'google-000000bb', fileId: 'file0001' }],
          ['drive_read_file', { accountId: 'google-000000bb', fileId: 'file0001' }],
          ['drive_download_file', { accountId: 'google-000000bb', fileId: 'file0002' }],
          ['drive_search', { query: 'report', accountId: 'google-000000bb' }],
          ['notion_get_page', { workspaceId: 'notion-000000bb', pageId: pageA }],
          ['notion_search', { workspaceId: 'notion-000000bb' }],
          ['mail_search', { accountId: 'imap-000000bb' }],
          ['mail_read_message', { accountId: 'imap-000000bb', messageId: 'imap:SU5CT1g:1:7' }],
          ['mail_get_attachment', { accountId: 'imap-000000bb', messageId: 'imap:SU5CT1g:1:7', attachmentId: '2' }],
          ['calendar_list_events', { accountId: 'gprod-000000bb', timeMin: TIME_MIN }],
          ['calendar_get_event', { accountId: 'gprod-000000bb', calendarId: 'primary', eventId: 'evta00001' }],
          ['contacts_get', { accountId: 'gprod-000000bb', resourceName: 'people/c1' }],
        ] as const) {
          const r = await call(c, tool, args);
          expect(r.isError, `${tool}: ${r.text}`).toBe(true);
          expect(r.text).toMatch(/unknown|not granted/i);
          expect(r.text).not.toMatch(/Only-A|only\.a|of A|Alice/);
        }
        const listed = await call(c, 'perch_list_accounts');
        expect(listed.text).not.toMatch(/000000bb|Only-A/);
      });
      expect(used).toEqual([]);
      await c.close();
    }
  });
});

describe('client grants are owned by their namespace [MOCK upstreams]', () => {
  it('mail draft/send and calendar create/update act only on the owning namespace accounts', async () => {
    const mailA = await grant(A.store, ['read', 'draft', 'send'], [IDS.imap, IDS.gmail]);
    const calA = await grant(A.store, ['calendar_read', 'calendar_write', 'contacts_read'], [IDS.gprod]);
    const mailB = await grant(B.store, ['read', 'send'], [IDS.imap]);

    const m = await http(mailA.token);
    const tools = (await m.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['mail_create_draft', 'mail_get_attachment', 'mail_read_message', 'mail_search', 'mail_send', 'perch_list_accounts']);
    const listed = await call(m, 'perch_list_accounts');
    expect(Object.keys(listed.json).sort()).toEqual(['connection', 'mail']);
    expect(listed.json.connection).toMatchObject({ kind: 'client', user: A.id });
    expect(listed.text).not.toMatch(/of B|of ROOT|gprod-|Drive of|Notion of/);
    const used = await ioOf(async () => {
      const draft = await call(m, 'mail_create_draft', { accountId: IDS.imap, to: ['x@example.test'], subject: 'Draft A', text: 'Hello from A' });
      expect(draft.isError, draft.text).toBe(false);
      const sent = await call(m, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 'Send A', text: 'Hello from A' });
      expect(sent.json).toMatchObject({ status: 'accepted', accountId: IDS.imap });
      const gsent = await call(m, 'mail_send', { accountId: IDS.gmail, to: ['x@example.test'], subject: 'Gmail send A', text: 'Hello from A' });
      expect(gsent.json, gsent.text).toMatchObject({ status: 'accepted', accountId: IDS.gmail });
    });
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((u) => !u.startsWith('A '))).toEqual([]);
    expect(A.world.smtpSent.join()).toContain('Send A');
    expect(A.world.imapSessions.flatMap((x) => x.appended).map((x) => x.raw.toString())).toEqual([expect.stringContaining('Draft A')]);
    expect(A.world.gmail.accounts[0]!.sent.length).toBe(1);
    expect(B.world.smtpSent).toEqual([]);
    expect(ROOT.smtpSent).toEqual([]);
    expect(B.world.gmail.accounts[0]!.sent).toEqual([]);
    // Mail-only grant: no Calendar/Drive/Notion tools, even for the same namespace.
    for (const t of ['calendar_create_event', 'calendar_list_events', 'drive_search', 'notion_search']) {
      const r = await ioOf(async () => expect((await call(m, t, { query: 'x' })).isError).toBe(true));
      expect(r).toEqual([]);
    }

    const cal = await http(calA.token);
    const calUsed = await ioOf(async () => {
      const created = await call(cal, 'calendar_create_event', {
        accountId: IDS.gprod,
        requestId: 'req-isolation-0001',
        summary: 'Created by A',
        start: { date: '2026-10-09' },
        end: { date: '2026-10-10' },
      });
      expect(created.json, created.text).toMatchObject({ status: 'created', accountId: IDS.gprod });
      const got = await call(cal, 'calendar_get_event', { accountId: IDS.gprod, calendarId: 'primary', eventId: created.json.event.eventId });
      const updated = await call(cal, 'calendar_update_event', { accountId: IDS.gprod, calendarId: 'primary', eventId: created.json.event.eventId, etag: got.json.etag, summary: 'Updated by A' });
      expect(updated.json, updated.text).toMatchObject({ status: 'updated' });
    });
    expect(calUsed.filter((u) => !u.startsWith('A '))).toEqual([]);
    expect(JSON.stringify(A.world.prod.accounts[0]!.calendars)).toContain('Updated by A');
    expect(JSON.stringify(B.world.prod.accounts[0]!.calendars)).not.toContain('by A');
    expect(JSON.stringify(ROOT.prod.accounts[0]!.calendars)).not.toContain('by A');
    for (const t of ['mail_search', 'drive_search']) expect((await call(cal, t, { query: 'x' })).isError).toBe(true);

    // B's client with the same account id sends from B's account only.
    const mb = await http(mailB.token);
    const bUsed = await ioOf(async () => {
      expect((await call(mb, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 'Send B', text: 'Hello from B' })).json).toMatchObject({ status: 'accepted' });
    });
    expect(bUsed.filter((u) => !u.startsWith('B '))).toEqual([]);
    expect(B.world.smtpSent.join()).toContain('Send B');
    expect(A.world.smtpSent.join()).not.toContain('Send B');
    for (const c of [m, cal, mb]) await c.close();
  });

  it('a root client grant cannot reach user accounts, and user grants cannot name root-only accounts', async () => {
    const rootMail = await grant(rootStore, ['read', 'send'], [IDS.imap]);
    const c = await http(rootMail.token);
    const used = await ioOf(async () => {
      expect((await call(c, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 'Send ROOT', text: 'x' })).json).toMatchObject({ status: 'accepted' });
    });
    expect(used.filter((u) => !u.startsWith('ROOT '))).toEqual([]);
    expect(A.world.smtpSent).toEqual([]);
    expect(B.world.smtpSent).toEqual([]);
    await c.close();
    // A grant can only be created for accounts of its own namespace.
    await rootStore.update((d) => {
      d.imap.push({ ...d.imap[0]!, id: 'imap-000000cc' });
    });
    const err = await rejection(grant(A.store, ['read'], ['imap-000000cc']));
    expect(err.message).toMatch(/unknown mail account/i);
  });
});

describe('membership and grant revocation [MOCK upstreams]', () => {
  it('a removed user fails on every HTTP request and on the next tool call of a persistent session, before provider I/O', async () => {
    const mailA = await grant(A.store, ['read', 'draft', 'send'], [IDS.imap]);
    const calA = await grant(A.store, ['calendar_read', 'calendar_write'], [IDS.gprod]);
    const ro = await persistent(A.token);
    const mail = await persistent(mailA.token);
    const cal = await persistent(calA.token);
    expect((await call(ro, 'perch_list_accounts')).isError).toBe(false);
    expect((await call(mail, 'mail_search', {})).isError).toBe(false);
    expect(await rawStatus(A.token)).toBe(200);

    await removeUser(rootStore, A.id);

    const used = await ioOf(async () => {
      for (const [c, tool, args] of [
        [ro, 'perch_list_accounts', {}],
        [ro, 'drive_search', { query: 'report' }],
        [ro, 'drive_read_file', { accountId: IDS.google, fileId: 'file0001' }],
        [ro, 'notion_search', {}],
        [ro, 'mail_search', {}],
        [ro, 'calendar_list_events', { timeMin: TIME_MIN }],
        [ro, 'contacts_list', {}],
        [mail, 'perch_list_accounts', {}],
        [mail, 'mail_read_message', { accountId: IDS.imap, messageId: 'imap:SU5CT1g:1:7' }],
        [mail, 'mail_create_draft', { accountId: IDS.imap, to: ['x@example.test'], subject: 's', text: 't' }],
        [mail, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 's', text: 't' }],
        [cal, 'calendar_create_event', { accountId: IDS.gprod, requestId: 'req-after-removal', summary: 's', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } }],
        [cal, 'calendar_update_event', { accountId: IDS.gprod, calendarId: 'primary', eventId: 'evta00001', etag: '"1"', summary: 'x' }],
      ] as const) {
        const r = await call(c, tool, args);
        expect(r.isError, `${tool} after removal`).toBe(true);
        expect(r.text).toMatch(/removed|disabled|not active/i);
      }
    });
    expect(used).toEqual([]);
    expect(A.world.smtpSent).toEqual([]);
    for (const t of [A.token, mailA.token, calA.token]) expect(await rawStatus(t)).toBe(401);
    // Other namespaces are unaffected.
    expect(await rawStatus(B.token)).toBe(200);
    expect(await rawStatus(globalToken)).toBe(200);
    for (const c of [ro, mail, cal]) await c.close();
  });

  it('client revocation and narrowing still apply inside a user namespace (persistent session)', async () => {
    const g = await grant(A.store, ['read', 'send'], [IDS.imap, IDS.gmail]);
    const c = await persistent(g.token);
    expect((await call(c, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 's', text: 't' })).isError).toBe(false);
    // Narrow: same token hash, send removed.
    await A.store.update((d) => {
      d.clients[0]!.capabilities = ['read'];
    });
    const narrowed = await ioOf(async () => {
      const r = await call(c, 'mail_send', { accountId: IDS.imap, to: ['x@example.test'], subject: 's2', text: 't' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not granted/i);
    });
    expect(narrowed).toEqual([]);
    await removeClientGrant(A.store, g.client.id);
    const revoked = await ioOf(async () => {
      const r = await call(c, 'mail_search', {});
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/revoked/i);
    });
    expect(revoked).toEqual([]);
    expect(await rawStatus(g.token)).toBe(401);
    await c.close();
  });
});

describe('token resolution fails closed [MOCK upstreams]', () => {
  it('rejects ambiguous token hashes instead of choosing a namespace', async () => {
    // Two users with the same read-token hash.
    await rootStore.update((d) => {
      d.users.find((u) => u.id === B.id)!.readTokenSha256 = sha(A.token);
    });
    await expect(router.resolveToken(A.token)).rejects.toMatchObject({ code: 'ambiguous_token' });
    expect(await rawStatus(A.token)).toBe(401);
    expect(logs.join('\n')).toMatch(/ambiguous/i);

    // A user client grant and a root client grant with the same hash.
    await rootStore.update((d) => {
      d.users.find((u) => u.id === B.id)!.readTokenSha256 = sha(B.token);
    });
    const userClient = await grant(A.store, ['read'], [IDS.imap]);
    const rootClient = await grant(rootStore, ['read'], [IDS.imap]);
    expect(await rawStatus(userClient.token)).toBe(200);
    await rootStore.update((d) => {
      d.clients.find((c) => c.id === rootClient.client.id)!.tokenSha256 = sha(userClient.token);
    });
    expect(await rawStatus(userClient.token)).toBe(401);

    // The global token must not also be a user token.
    await rootStore.update((d) => {
      d.users.find((u) => u.id === B.id)!.readTokenSha256 = sha(globalToken);
    });
    expect(await rawStatus(globalToken)).toBe(401);
    expect(io).toEqual([]);
  });

  it('a damaged active user namespace blocks all bearer tokens instead of guessing; removing the user restores them', async () => {
    const file = storeFilePath(userStorePaths({ dataDir: dirs.dataDir, keyFile: dirs.keyFile }, B.id).dataDir);
    const env = JSON.parse(await readFile(file, 'utf8'));
    env.ct = Buffer.from('tampered').toString('base64');
    await writeFile(file, JSON.stringify(env), { mode: 0o600 });
    expect(await rawStatus(B.token)).toBe(503);
    expect(await rawStatus(A.token)).toBe(503);
    // The global token too: its uniqueness against B's client grants cannot be proven (documented trade-off).
    expect(await rawStatus(globalToken)).toBe(503);
    expect(JSON.parse(await readFile(file, 'utf8')).ct).toBe(env.ct);
    await removeUser(rootStore, B.id);
    expect(await rawStatus(A.token)).toBe(200);
    expect(await rawStatus(B.token)).toBe(401);
    expect(await rawStatus(globalToken)).toBe(200);
    expect(io).toEqual([]);
  });

  it('unknown tokens and caller-supplied selectors never pick a namespace', async () => {
    expect(await router.resolveToken(generateHttpToken())).toBeNull();
    expect(await rawStatus(generateHttpToken())).toBe(401);
    // A user id is not a credential.
    expect(await rawStatus(`${A.id}${'x'.repeat(40)}`)).toBe(401);
    expect(await router.resolveToken(A.id)).toBeNull();
  });
});

describe('owner namespace integrity is re-checked before every tool call [MOCK upstreams]', () => {
  const userPaths = (id: string) => userStorePaths({ dataDir: dirs.dataDir, keyFile: dirs.keyFile }, id);

  /** Persistent sessions over the stdio path: user read-only token, user client grant and PERCH_USER selection. */
  async function sessions() {
    const g = await grant(A.store, ['read', 'draft', 'send'], [IDS.imap]);
    const s = await router.localSession(A.id);
    const mcp = createMcpServer(s.context, s.principal, s.session);
    const [x, y] = InMemoryTransport.createLinkedPair();
    await mcp.connect(y);
    const local = new Client({ name: 'iso-local', version: '0' });
    await local.connect(x);
    const list = [
      { c: await persistent(A.token), tool: 'drive_search', args: { query: 'report' } },
      { c: await persistent(g.token), tool: 'mail_search', args: {} },
      { c: local, tool: 'notion_search', args: {} },
    ];
    for (const s of list) expect((await call(s.c, 'perch_list_accounts')).isError).toBe(false);
    return list;
  }

  const damage: Record<string, (id: string) => Promise<void>> = {
    'key missing': async (id) => {
      await rm(userPaths(id).keyFile);
    },
    'key replaced': async (id) => {
      const file = userPaths(id).keyFile;
      await rm(file);
      await writeFile(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    },
    'key symlinked': async (id) => {
      const file = userPaths(id).keyFile;
      const copy = `${file}.copy`;
      await writeFile(copy, await readFile(file), { mode: 0o600 });
      await rm(file);
      await symlink(copy, file);
    },
    'store corrupt': async (id) => {
      const file = storeFilePath(userPaths(id).dataDir);
      const env = JSON.parse(await readFile(file, 'utf8'));
      env.ct = Buffer.from('tampered').toString('base64');
      await writeFile(file, JSON.stringify(env), { mode: 0o600 });
    },
    'namespace dir symlinked': async (id) => {
      const dir = userPaths(id).dataDir;
      await rename(dir, `${dir}.moved`);
      await symlink(`${dir}.moved`, dir);
    },
  };

  for (const [name, fn] of Object.entries(damage)) {
    it(`${name}: persistent read-only, client and PERCH_USER sessions fail before provider I/O; nothing is re-created`, async () => {
      const list = await sessions();
      const before = await readdir(path.dirname(userPaths(A.id).keyFile));
      await fn(A.id);
      const used = await ioOf(async () => {
        for (const { c, tool, args } of list) {
          for (const [t, a] of [['perch_list_accounts', {}], [tool, args]] as const) {
            const r = await call(c, t, a);
            expect(r.isError, `${t} after ${name}`).toBe(true);
            expect(r.text).not.toMatch(/removed|disabled/i);
          }
        }
      });
      expect(used).toEqual([]);
      // The registry still lists A as active: the failure comes from the namespace itself, not membership.
      expect((await rootStore.read()).users.find((u) => u.id === A.id)!.status).toBe('active');
      if (name === 'key missing') expect(await readdir(path.dirname(userPaths(A.id).keyFile))).toEqual(before.filter((f) => f !== `${A.id}.key`));
      // The local root operator session (plain stdio) keeps working read-only.
      const r = await router.localSession(undefined);
      const rootMcp = createMcpServer(r.context, r.principal, r.session);
      const [x, y] = InMemoryTransport.createLinkedPair();
      await rootMcp.connect(y);
      const root = new Client({ name: 'iso-root', version: '0' });
      await root.connect(x);
      expect((await call(root, 'perch_list_accounts')).isError).toBe(false);
      await root.close();
      // HTTP: an active but damaged namespace makes every bearer token fail closed (documented trade-off),
      // because uniqueness of the token hash cannot be proven without it.
      for (const t of [B.token, globalToken]) expect(await rawStatus(t)).toBe(503);
      for (const { c } of list) await c.close();
    });
  }
});

describe('global token collisions and removal races [MOCK upstreams]', () => {
  it('rejects the global token when it equals an active user CLIENT grant token, without root metadata or provider I/O', async () => {
    const g = await grant(A.store, ['read'], [IDS.imap]);
    await server.close();
    server = await startHttpServer({ host: '127.0.0.1', port: 0, token: g.token, context: router.root, namespaces: router, log: (l) => logs.push(l) });
    expect(await router.collidesWithGlobal(g.token)).toBe(true);
    expect(await rawStatus(g.token)).toBe(401);
    expect(logs.join('\n')).toMatch(/ambiguous/i);
    expect(io).toEqual([]);
  });

  it('a user removed between the registry read and opening its namespace resolves to nothing (no undefined context)', async () => {
    const other = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const real = rootStore.read.bind(rootStore);
    let first = true;
    rootStore.read = async () => {
      const data = await real();
      if (first) {
        first = false;
        await removeUser(other, A.id); // lands after resolveToken took its registry snapshot
      }
      return data;
    };
    try {
      expect(await router.resolveToken(A.token)).toBeNull();
    } finally {
      rootStore.read = real;
    }
    expect(io).toEqual([]);
  });
});
