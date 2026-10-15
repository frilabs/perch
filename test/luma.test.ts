// Luma via the official Luma MCP (docs/LUMA_SPEC.md §8) against a MOCK Luma MCP server and a MOCK OAuth
// server: onboarding (CIMD and DCR), the fixed tool list with pinned schemas, grants, idempotent writes,
// the blast head count, refresh failures and origin guards. Nothing reaches Luma; tokens are dummies.
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClientGrant, principalForClientToken, READONLY_PRINCIPAL, type Principal } from '../src/auth/grants.js';
import { runCli, type CliIo } from '../src/cli/run.js';
import { createPerchContext, type PerchContext } from '../src/context.js';
import { guardedLumaFetch, LumaMcp } from '../src/luma/client.js';
import { discoverLumaAuth } from '../src/luma/oauth.js';
import { schemaHash } from '../src/luma/policy.js';
import { createMcpServer } from '../src/mcp/server.js';
import { CredentialStore, initStore } from '../src/store/credentialStore.js';
import { Upstream } from '../src/upstream.js';
import { makeTempDirs, rejection, type TempDirs } from './support/fixtures.js';
import { AUTH_ORIGIN, mockLumaAuth, startMockLuma, type MockLuma, type MockLumaAuth } from './support/mockLuma.js';

let dirs: TempDirs;
let store: CredentialStore;
let luma: MockLuma;
let auth: MockLumaAuth;
let env: Record<string, string>;

beforeEach(async () => {
  dirs = await makeTempDirs();
  await initStore({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
  store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
  luma = await startMockLuma();
  auth = mockLumaAuth(luma);
  env = { PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: dirs.root };
});
afterEach(async () => {
  await luma.close();
  await dirs.cleanup();
});

function io(): CliIo & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    env,
    stdout: (s) => (out += s),
    stderr: (s) => {
      err += s;
      // Act as the browser: follow the authorization URL straight to the loopback callback.
      const m = /(https:\/\/auth\.luma\.com\/oauth\/authorize\?\S+)/.exec(s);
      if (m) {
        const u = new URL(m[1]!);
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        expect(u.searchParams.get('resource')).toBe('https://mcp.luma.com/mcp');
        void fetch(`${u.searchParams.get('redirect_uri')}?code=luma-code-123&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
      }
    },
    readSecret: async () => '',
    transport: auth.transport,
    lumaFetch: luma.fetch,
    out: () => out,
    err: () => err,
  };
}

async function addAccount(label = 'frilabs') {
  const x = io();
  const code = await runCli(['luma', 'add', '--label', label, '--timeout', '10'], x);
  expect(code, x.err()).toBe(0);
  return { out: x.out(), id: /Connected Luma account (luma-[a-f0-9]{8})/.exec(x.out())![1]! };
}

function context(): PerchContext {
  return createPerchContext(store, auth.transport, undefined, new LumaMcp(guardedLumaFetch(luma.fetch)));
}

async function mcpClient(ctx: PerchContext, principal: Principal) {
  await ctx.luma.refresh();
  const server = createMcpServer(ctx, principal);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(a);
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError === true, json: JSON.parse(r.content[0]!.text) as Record<string, unknown> };
};

async function grant(caps: string[], accounts: string[]) {
  const tokenFile = `${dirs.root}/config/clients/${caps.join('_')}.token`;
  await createClientGrant(store, { label: 'Luma client', capabilities: caps as never, accountIds: accounts, tokenFile });
  return (await principalForClientToken(store, (await readFile(tokenFile, 'utf8')).trim()))!;
}

describe('onboarding', () => {
  it('connects via CIMD, pins the allowlisted tool schemas and never offers delete/host tools', async () => {
    const { out, id } = await addAccount();
    expect(out).toContain('via cimd');
    expect(out).toMatch(/Not offered by Luma: .*list_calendars/);
    const acc = (await store.read()).luma[0]!;
    expect(acc).toMatchObject({ id, email: 'operator@example.test', userId: 'usr-mock0001', clientId: 'https://fritzkuermayr.github.io/perch/luma-client.json', registration: 'cimd' });
    const names = acc.tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_blast', 'create_event', 'get_event', 'get_self', 'invite_guests', 'list_events', 'list_guests', 'update_event', 'update_guest_status']);
    expect(JSON.stringify(await store.read())).not.toContain('delete_event');
    expect(acc.tools.find((t) => t.name === 'get_event')!.hash).toBe(schemaHash(luma.tools.find((t) => t.name === 'get_event')!.inputSchema));
  });

  it('falls back to Dynamic Client Registration for exactly the loopback redirect', async () => {
    auth.cimd = false;
    const { out } = await addAccount();
    expect(out).toContain('via dcr');
    expect(auth.registered[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await store.read()).luma[0]!.clientId).toMatch(/^dcr-client-/);
  });

  it('refuses an authorization server outside luma.com / lu.ma before any request to it', async () => {
    auth.issuer = 'https://evil.example';
    const err = await rejection(discoverLumaAuth(new Upstream(auth.transport)));
    expect(err.message).toMatch(/outside luma\.com/);
    expect(auth.calls.some((c) => c.includes('evil.example'))).toBe(false);
  });

  it('refuses a duplicate account', async () => {
    await addAccount();
    const x = io();
    expect(await runCli(['luma', 'add', '--label', 'again', '--timeout', '10'], x)).toBe(1);
    expect(x.err()).toMatch(/already connected/);
  });
});

describe('tools and rights', () => {
  let id: string;
  let ctx: PerchContext;
  beforeEach(async () => {
    id = (await addAccount()).id;
    ctx = context();
  });

  it('1: the read-only operator sees read tools only; delete/host tools never exist', async () => {
    const c = await mcpClient(ctx, READONLY_PRINCIPAL);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['luma_get_event', 'luma_list_events', 'luma_list_guests', 'luma_get_self']));
    expect(names.filter((n) => n.startsWith('luma_'))).not.toEqual(expect.arrayContaining(['luma_create_event']));
    expect(names.some((n) => /delete|host/.test(n))).toBe(false);
    const r = await call(c, 'luma_get_event', { event_id: 'evt-42' });
    expect(r.json).toMatchObject({ accountId: id, accountLabel: 'frilabs', result: { event: { api_id: 'evt-42' } } });
  });

  it('6: only fields Perch knows are passed to Luma (no Perch fields, no extras)', async () => {
    await ctx.luma.read(READONLY_PRINCIPAL, 'get_event', { event_id: 'evt-1', accountId: id, sneaky: 'x', requestId: 'r-12345678' });
    expect(luma.calls.at(-1)).toEqual(['get_event', { event_id: 'evt-1' }]);
  });

  it('1b: a changed schema blocks the tool until reviewed; a new field keeps it blocked', async () => {
    luma.tools = luma.tools.map((t) => (t.name === 'get_event' ? { ...t, inputSchema: { ...t.inputSchema, required: [] } } : t));
    const fresh = context();
    const err = await rejection(fresh.luma.read(READONLY_PRINCIPAL, 'get_event', { event_id: 'evt-1', accountId: id }));
    expect(err.message).toMatch(/changed or removed the tool get_event/);
    expect(luma.calls.some(([n]) => n === 'get_event')).toBe(false);
    const states = io();
    await runCli(['luma', 'tools', id], states);
    expect(states.out()).toMatch(/get_event\s+read\s+changed/);
    await runCli(['luma', 'tools', id, '--accept'], io());
    const again = context();
    await again.luma.read(READONLY_PRINCIPAL, 'get_event', { event_id: 'evt-1', accountId: id });
    // A new top-level field is never approved.
    luma.tools = luma.tools.map((t) => (t.name === 'get_event' ? { ...t, inputSchema: { ...t.inputSchema, properties: { event_id: { type: 'string' }, delete_after: { type: 'boolean' } } } } : t));
    const acc = io();
    await runCli(['luma', 'tools', id, '--accept'], acc);
    expect(acc.out()).toMatch(/still blocked: get_event \(unknown fields: delete_after/);
    const third = context();
    expect((await rejection(third.luma.read(READONLY_PRINCIPAL, 'get_event', { event_id: 'evt-1', accountId: id }))).message).toMatch(/not approved/);
  });

  it('2: writes need the matching grant, checked before any request to Luma', async () => {
    const events = await grant(['luma_read', 'luma_events'], [id]);
    const c = await mcpClient(ctx, events);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('luma_create_event');
    expect(names).not.toContain('luma_invite_guests');
    expect(names).not.toContain('luma_create_blast');
    const before = luma.calls.length;
    const denied = await rejection(ctx.luma.write(events, 'invite_guests', { accountId: id, requestId: 'req-inv-0001', event_id: 'evt-1', guests: [{ email: 'a@example.test' }] }));
    expect(denied.message).toMatch(/luma_guests/);
    // update_event with email_guests needs luma_guests as well.
    const mail = await rejection(ctx.luma.write(events, 'update_event', { accountId: id, requestId: 'req-upd-0001', event_id: 'evt-1', email_guests: true }));
    expect(mail.message).toMatch(/luma_guests/);
    expect(luma.calls.length).toBe(before);
    // The read-only operator can never write.
    expect((await rejection(ctx.luma.write(READONLY_PRINCIPAL, 'create_event', { accountId: id, requestId: 'req-op-00001', name: 'x', start_at: '2026-11-01T18:00:00Z', timezone: 'Europe/Vienna' }))).message).toMatch(/read-only/);
  });

  it('3: the same requestId executes once; different arguments under it fail before I/O', async () => {
    const events = await grant(['luma_events'], [id]);
    const c = await mcpClient(ctx, events);
    const args = { accountId: id, requestId: 'req-create-01', name: 'Perch Meetup', start_at: '2026-11-01T18:00:00Z', timezone: 'Europe/Vienna' };
    const first = await call(c, 'luma_create_event', args);
    expect(first.json).toMatchObject({ status: 'accepted', replayed: false, accountId: id, result: { event: { api_id: 'evt-new' } } });
    const again = await call(c, 'luma_create_event', args);
    expect(again.json).toMatchObject({ status: 'accepted', replayed: true });
    expect(luma.calls.filter(([n]) => n === 'create_event')).toHaveLength(1);
    const conflict = await call(c, 'luma_create_event', { ...args, name: 'Other' });
    expect(conflict.isError).toBe(true);
    expect(conflict.json.error).toMatch(/requestId/i);
    expect(luma.calls.filter(([n]) => n === 'create_event')).toHaveLength(1);
    const status = await call(c, 'luma_write_status', { accountId: id, requestId: 'req-create-01' });
    expect(status.json).toMatchObject({ status: 'accepted' });
  });

  it('an interrupted write is indeterminate and never retried', async () => {
    const events = await grant(['luma_events'], [id]);
    luma.dropNextCall = true;
    const args = { accountId: id, requestId: 'req-drop-0001', name: 'X', start_at: '2026-11-01T18:00:00Z', timezone: 'Europe/Vienna' };
    expect(await ctx.luma.write(events, 'create_event', args)).toMatchObject({ status: 'indeterminate' });
    expect(await ctx.luma.write(events, 'create_event', args)).toMatchObject({ status: 'indeterminate', replayed: true });
    expect(luma.calls.filter(([n]) => n === 'create_event')).toHaveLength(1);
  });

  it('guest rules: no refunds through Perch, at most 50 invitations per call', async () => {
    const guests = await grant(['luma_guests'], [id]);
    const before = luma.calls.length;
    expect((await rejection(ctx.luma.write(guests, 'update_guest_status', { accountId: id, requestId: 'req-ref-00001', event_id: 'evt-1', guest_id: 'gst-1', status: 'declined', should_refund: true }))).message).toMatch(/never refunds/);
    const many = Array.from({ length: 51 }, (_, i) => ({ email: `g${i}@example.test` }));
    expect((await rejection(ctx.luma.write(guests, 'invite_guests', { accountId: id, requestId: 'req-inv-00051', event_id: 'evt-1', guests: many }))).message).toMatch(/At most 50/);
    expect(luma.calls.length).toBe(before);
    expect(await ctx.luma.write(guests, 'invite_guests', { accountId: id, requestId: 'req-inv-00002', event_id: 'evt-1', guests: many.slice(0, 2) })).toMatchObject({ status: 'accepted' });
  });

  it('4: a blast is sent only when confirmRecipientCount matches the counted guests', async () => {
    luma.guests.set('evt-1', [
      { api_id: 'gst-1', email: 'a@example.test', approval_status: 'approved' },
      { api_id: 'gst-2', email: 'b@example.test', approval_status: 'approved' },
      { api_id: 'gst-3', email: 'c@example.test', approval_status: 'approved' },
      { api_id: 'gst-4', email: 'd@example.test', approval_status: 'waitlist' },
    ]);
    const blast = await grant(['luma_blast'], [id]);
    const wrong = await ctx.luma.write(blast, 'create_blast', { accountId: id, requestId: 'req-blast-001', event_id: 'evt-1', content_md: 'Hi', confirmRecipientCount: 4 });
    expect(wrong).toMatchObject({ status: 'rejected' });
    expect(wrong.detail).toMatch(/would reach 3 guest/);
    expect(luma.calls.some(([n]) => n === 'create_blast')).toBe(false);
    const both = await ctx.luma.write(blast, 'create_blast', {
      accountId: id,
      requestId: 'req-blast-002',
      event_id: 'evt-1',
      content_md: 'Hi',
      recipient_groups: [{ status: 'approved' }, { status: 'waitlist' }],
      confirmRecipientCount: 4,
    });
    expect(both).toMatchObject({ status: 'accepted' });
    expect(luma.calls.filter(([n]) => n === 'create_blast')).toHaveLength(1);
    expect((await rejection(ctx.luma.write(blast, 'create_blast', { accountId: id, requestId: 'req-blast-003', event_id: 'evt-1', content_md: 'Hi' }))).message).toMatch(/confirmRecipientCount/);
    expect(
      (await rejection(ctx.luma.write(blast, 'create_blast', { accountId: id, requestId: 'req-blast-004', event_id: 'evt-1', content_md: 'Hi', recipient_groups: [{ status: 'approved', ticket_type_id: 'tt-1' }], confirmRecipientCount: 1 }))).message,
    ).toMatch(/ticket type/);
  });

  it('reads across two accounts with provenance', async () => {
    // A second account: the MOCK reports the same user, so give it another identity first.
    await store.update((d) => void (d.luma[0]!.userId = 'usr-other'));
    const second = (await addAccount('second')).id;
    const r = (await ctx.luma.read(READONLY_PRINCIPAL, 'list_events', {})) as { results: Array<{ accountId: string }> };
    expect(r.results.map((x) => x.accountId).sort()).toEqual([id, second].sort());
  });

  it('5: a revoked refresh token fails closed with a reconnect hint', async () => {
    auth.failRefresh = true;
    const fresh = context();
    const err = await rejection(fresh.luma.read(READONLY_PRINCIPAL, 'get_event', { event_id: 'evt-1', accountId: id }));
    expect(err.message).toMatch(/perch luma remove/);
  });

  it('status shows Luma accounts with a live check', async () => {
    const x = io();
    await runCli(['status'], x);
    expect(x.out()).toMatch(/Luma\n {2}✓ luma-[a-f0-9]{8} {2}"frilabs" {2}operator@example\.test/);
  });
});

describe('origin guards', () => {
  it('7: the Luma fetch only reaches https://mcp.luma.com/mcp and never opens the SSE stream', async () => {
    const seen: string[] = [];
    const f = guardedLumaFetch(async (u) => {
      seen.push(String(u));
      return new Response('{}');
    });
    expect((await rejection(f('https://evil.example/mcp', { method: 'POST' }))).message).toMatch(/Blocked/);
    expect((await rejection(f('https://mcp.luma.com/other', { method: 'POST' }))).message).toMatch(/Blocked/);
    expect((await f('https://mcp.luma.com/mcp', { method: 'GET' })).status).toBe(405);
    expect(seen).toEqual([]);
    expect(AUTH_ORIGIN).toBe('https://auth.luma.com');
  });
});
