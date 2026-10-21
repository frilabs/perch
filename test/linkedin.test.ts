// LinkedIn connector (docs/LINKEDIN_X_SPEC.md): login, status/expiry, linkedin_post through the real MCP SDK
// client (in-memory transport), ledger outcomes, grants and body-free audit. MOCK only: the LinkedIn OAuth endpoint,
// userinfo and the Posts API are mocks (test/support/mockLinkedin.ts); nothing here is a live LinkedIn test.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClientGrant, principalForClientToken, READONLY_PRINCIPAL, type Principal } from '../src/auth/grants.js';
import { runCli, type CliIo } from '../src/cli/run.js';
import { linkedinClientGuide } from '../src/cli/linkedin.js';
import { createPerchContext } from '../src/context.js';
import { DEFAULT_LINKEDIN_VERSION, escapeLittleText, MAX_LINKEDIN_TEXT, postKeyOf, postUrnOf } from '../src/linkedin/linkedin.js';
import { LINKEDIN_OAUTH_REDIRECT_URI } from '../src/linkedin/oauth.js';
import { MailWorkflowLedger } from '../src/mail/workflowLedger.js';
import { createMcpServer } from '../src/mcp/server.js';
import { CredentialStore, type Capability } from '../src/store/credentialStore.js';
import { isAllowedRoute, Upstream } from '../src/upstream.js';
import { makeTempDirs, type TempDirs } from './support/fixtures.js';
import { MockLinkedin, type MockMember } from './support/mockLinkedin.js';

let dirs: TempDirs;
let out: string;
let err: string;
let prompts: string[];
let li: MockLinkedin;

const clientFile = () => path.join(dirs.root, '.config', 'perch', 'linkedin-client.json');
const openStore = () => CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
const DAY = 24 * 3600 * 1000;

function io(answers: string[], secrets: string[], extra: Partial<CliIo> = {}): CliIo {
  return {
    env: { PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: dirs.root },
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    transport: li.transport,
    readSecret: async (p) => {
      prompts.push(`SECRET:${p}`);
      const s = secrets.shift();
      if (s === undefined) throw new Error(`MOCK: no secret left (prompt: ${p})`);
      return s;
    },
    readLine: async (p) => {
      prompts.push(p);
      const a = answers.shift();
      if (a === undefined) throw new Error(`MOCK: no more answers (prompt: ${p})`);
      return a;
    },
    ...extra,
  };
}

/** Scripted login: the pasted addresses (in order) are built from the authorization URL Perch printed. */
function loginIo(member: MockMember, answers: string[], secrets: string[], pastes?: Array<(u: URL, code: string) => string>): CliIo {
  let authUrl = '';
  const queue = pastes ?? [(u, code) => `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`];
  return io(answers, secrets, {
    stderr: (s) => {
      err += s;
      authUrl = /https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\S+/.exec(s)?.[0] ?? authUrl;
    },
    readPastedUrl: async () => {
      const next = queue.shift();
      if (!next) return new Promise<undefined>(() => {}); // nothing more to paste: wait (the test fails by timeout)
      const u = new URL(authUrl);
      return next(u, li.approve(authUrl, member));
    },
  });
}

async function connect(member: MockMember, label = 'Fritz'): Promise<string> {
  const secrets = (await stat(clientFile()).catch(() => null)) ? [] : [li.client.id, li.client.secret];
  const answers = secrets.length ? [''] : [];
  expect(await runCli(['linkedin', 'add', '--label', label, '--timeout', '10'], loginIo(member, answers, secrets)), err).toBe(0);
  return (await (await openStore()).read()).linkedin.find((a) => a.personUrn === `urn:li:person:${member.sub}`)!.id;
}

async function setExpiry(id: string, inMs: number) {
  await (await openStore()).update((d) => {
    d.linkedin.find((a) => a.id === id)!.accessTokenExpiresAt = new Date(Date.now() + inMs).toISOString();
  });
}

beforeEach(async () => {
  dirs = await makeTempDirs();
  out = '';
  err = '';
  prompts = [];
  li = new MockLinkedin();
  expect(await runCli(['init'], io([], []))).toBe(0);
  out = '';
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('perch linkedin add [MOCK LinkedIn]', () => {
  it('guides the app setup, logs in via the pasted address, stores the member URN; nothing secret is printed', async () => {
    const m = li.addMember('Fritz Example');
    const cliIo = loginIo(m, [''], [li.client.id, li.client.secret]);
    expect(await runCli(['linkedin', 'add', '--label', 'Fritz', '--timeout', '10'], cliIo), err).toBe(0);
    expect(prompts[0]).toMatch(/Set it up now.*\[Y\/n\]/);
    expect(prompts[1]).toMatch(/^SECRET:Client ID/);
    expect(prompts[2]).toMatch(/^SECRET:Primary Client Secret/);
    expect(out).toContain(LINKEDIN_OAUTH_REDIRECT_URI);
    expect(out).toMatch(/company page/);
    expect(out).toMatch(/Share on LinkedIn/);
    expect(JSON.parse(await readFile(clientFile(), 'utf8'))).toEqual({ client_id: li.client.id, client_secret: li.client.secret });
    expect((await stat(clientFile())).mode & 0o777).toBe(0o600);

    // Authorization request: fixed redirect, scopes, state; no PKCE (standard LinkedIn apps are confidential clients).
    const auth = new URL(/https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\S+/.exec(err)![0]);
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:8770/linkedin/callback');
    expect(auth.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.has('code_challenge')).toBe(false);
    expect(li.tokenRequests).toEqual([
      expect.objectContaining({ grant_type: 'authorization_code', redirect_uri: LINKEDIN_OAUTH_REDIRECT_URI, client_id: li.client.id }),
    ]);

    const [a] = (await (await openStore()).read()).linkedin;
    expect(a).toMatchObject({ label: 'Fritz', sub: m.sub, personUrn: `urn:li:person:${m.sub}`, name: 'Fritz Example', scopes: ['openid', 'profile', 'w_member_social'] });
    expect(a!.refreshToken).toBeUndefined();
    expect(a!.clientSecret).toBeUndefined();
    const until = Date.parse(a!.accessTokenExpiresAt) - Date.now();
    expect(until).toBeGreaterThan(59 * DAY);
    expect(until).toBeLessThanOrEqual(60 * DAY);
    expect(out).toMatch(/Connected LinkedIn account linkedin-[a-f0-9]{8} "Fritz" \(Fritz Example\)\./);
    expect(out).toMatch(/Connected until \d{4}-\d{2}-\d{2}/);
    expect(out).toMatch(/--allow linkedin_read,linkedin_post --account linkedin-/);
    const all = out + err;
    for (const s of [li.client.secret, ...li.issuedSecrets]) expect(all).not.toContain(s);
  });

  it('refuses a pasted address with another login attempt\'s state, then accepts the right one', async () => {
    const m = li.addMember('Fritz Example');
    const cliIo = loginIo(m, [''], [li.client.id, li.client.secret], [
      (u, code) => `${u.searchParams.get('redirect_uri')}?code=${code}&state=not-the-state`,
      (u, code) => `http://localhost:9999/linkedin/callback?code=${code}&state=${u.searchParams.get('state')}`,
      (u, code) => `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`,
    ]);
    expect(await runCli(['linkedin', 'add', '--label', 'Fritz', '--timeout', '10'], cliIo), err).toBe(0);
    expect(err).toMatch(/different or older login attempt \(state does not match\)/);
    expect(err).toMatch(/it must use port 8770/);
    expect(li.tokenRequests).toHaveLength(1); // the refused addresses never reached the token endpoint
    expect((await (await openStore()).read()).linkedin).toHaveLength(1);
  });

  it('the same member again updates the same account (same id, same URN, grants stay valid)', async () => {
    const m = li.addMember('Fritz Example');
    const id = await connect(m, 'Fritz');
    const first = (await (await openStore()).read()).linkedin[0]!;
    await setExpiry(id, 2 * DAY);
    const { client } = await createClientGrant(await openStore(), { label: 'friagent', capabilities: ['linkedin_post'], accountIds: [id], tokenFile: path.join(dirs.root, 'c.token') });
    out = '';
    expect(await runCli(['linkedin', 'add', '--label', 'Fritz LI', '--timeout', '10'], loginIo(m, [], [])), err).toBe(0);
    const data = (await (await openStore()).read());
    expect(data.linkedin).toHaveLength(1);
    const again = data.linkedin[0]!;
    expect(again).toMatchObject({ id, personUrn: first.personUrn, label: 'Fritz LI', createdAt: first.createdAt });
    expect(again.accessToken).not.toBe(first.accessToken);
    expect(Date.parse(again.accessTokenExpiresAt) - Date.now()).toBeGreaterThan(59 * DAY);
    expect(data.clients.find((c) => c.id === client.id)!.accountIds).toEqual([id]);
    expect(out).toMatch(/Updated LinkedIn account .*\nSame member, same id/);
    // A different member is a new account.
    await connect(li.addMember('Other Person'), 'Other');
    expect((await (await openStore()).read()).linkedin).toHaveLength(2);
  });

  it('uses a refresh token like other providers when LinkedIn issues one', async () => {
    li.issuesRefreshTokens = true;
    const m = li.addMember('Partner App');
    const id = await connect(m);
    const a = (await (await openStore()).read()).linkedin[0]!;
    expect(a).toMatchObject({ clientId: li.client.id, clientSecret: li.client.secret });
    expect(a.refreshTokenExpiresAt).toBeDefined();
    expect(out).toMatch(/refresh token/);
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const r = await call(client, 'linkedin_post', { accountId: id, text: 'hello', requestId: rid() });
    expect(r.body).toMatchObject({ status: 'accepted' });
    expect(li.tokenRequests.map((t) => t.grant_type)).toEqual(['authorization_code', 'refresh_token']);
  });

  it('client setup/show, --port refused, no terminal without an app: clear errors, secrets never printed', async () => {
    expect(await runCli(['linkedin', 'client', 'show'], io([], []))).toBe(0);
    expect(out).toMatch(/No usable LinkedIn app/);
    expect(await runCli(['linkedin', 'client', 'setup'], io([], ['short', 'x', li.client.id, li.client.secret])), err).toBe(0);
    expect(out).toMatch(/looks wrong .*\. Try again/);
    expect(out).toMatch(/Next: perch linkedin add --label NAME/);
    out = '';
    expect(await runCli(['linkedin', 'client', 'show'], io([], []))).toBe(0);
    expect(out).toContain('mockli…');
    expect(out).toContain(`LinkedIn-Version: ${DEFAULT_LINKEDIN_VERSION}`);
    expect(out).not.toContain(li.client.id);
    expect(out).not.toContain(li.client.secret);
    expect(await runCli(['linkedin', 'add', '--label', 'X', '--port', '9000'], io([], []))).toBe(1);
    expect(err).toMatch(/--port is not supported: the redirect URL registered in the LinkedIn app is fixed \(port 8770\)/);
    await (await import('node:fs/promises')).rm(clientFile());
    const noTty = io([], []);
    delete noTty.readLine;
    expect(await runCli(['linkedin', 'add', '--label', 'X'], noTty)).toBe(1);
    expect(err).toMatch(/No usable LinkedIn app .* perch linkedin client setup/);
  });

  it('perch linkedin list and remove (grants that covered only this account go too)', async () => {
    const id = await connect(li.addMember('Fritz Example'));
    await createClientGrant(await openStore(), { label: 'only-li', capabilities: ['linkedin_post'], accountIds: [id], tokenFile: path.join(dirs.root, 'a.token') });
    await createClientGrant(await openStore(), { label: 'full', capabilities: [], accountIds: [], full: true, tokenFile: path.join(dirs.root, 'b.token') });
    out = '';
    expect(await runCli(['linkedin', 'list'], io([], []))).toBe(0);
    expect(out).toMatch(new RegExp(`${id}  "Fritz"  Fritz Example  connected until \\d{4}-`));
    expect(await runCli(['linkedin', 'remove', id], io([], []))).toBe(0);
    const d = await (await openStore()).read();
    expect(d.linkedin).toHaveLength(0);
    expect(d.clients.map((c) => c.label)).toEqual(['full']);
    expect(out).toMatch(/Client grants that covered only this account were removed/);
  });
});

describe('perch status: connected until, 7-day warning, expired [MOCK LinkedIn]', () => {
  it('ok: "connected until" and a live userinfo check', async () => {
    const id = await connect(li.addMember('Fritz Example'));
    out = '';
    li.calls.length = 0;
    expect(await runCli(['status'], io([], []))).toBe(0);
    expect(out).toMatch(/── LinkedIn/);
    expect(out).toMatch(new RegExp(`${id} · linkedin · since \\d{4}-\\d{2}-\\d{2} · connected until \\d{4}-\\d{2}-\\d{2}`));
    expect(out).toMatch(/☑ post to own profile/);
    expect(li.calls.map((c) => c.url.pathname)).toEqual(['/v2/userinfo']);
  });

  it('within 7 days: yellow hint with the renew command (TTY), plain line with "until"', async () => {
    const id = await connect(li.addMember('Fritz Example'), 'Fritz Work');
    await setExpiry(id, 3 * DAY);
    out = '';
    expect(await runCli(['status', '--no-check'], io([], [], { stdoutIsTTY: true }))).toBe(0);
    expect(out).toContain('\u001b[33mlogin expires on');
    expect(out).toContain("    perch linkedin add --label 'Fritz Work'");
    out = '';
    expect(await runCli(['status', '--no-check', '--plain'], io([], []))).toBe(0);
    expect(out).toMatch(new RegExp(`· ${id}  "Fritz Work"  Fritz Example  \\[linkedin: post\\]  since \\S+  until \\d{4}-`));
    expect(out).toMatch(/hint: login expires on .*perch linkedin add --label 'Fritz Work'/);
    out = '';
    expect(await runCli(['status', '--no-check', '--json'], io([], []))).toBe(0);
    expect(JSON.parse(out).accounts[0]).toMatchObject({ family: 'linkedin', expiry: 'soon', renew: "perch linkedin add --label 'Fritz Work'" });
  });

  it('expired: ✗ with the renew command, exit code 1, no LinkedIn call (also with --no-check)', async () => {
    const id = await connect(li.addMember('Fritz Example'));
    await setExpiry(id, -DAY);
    li.calls.length = 0;
    out = '';
    expect(await runCli(['status'], io([], []))).toBe(1);
    expect(out).toMatch(/✗ Fritz/);
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/LinkedIn login of linkedin-[a-f0-9]{8} expired on \d{4}-\d{2}-\d{2}/);
    expect(out).toContain('    perch linkedin add --label Fritz');
    expect(li.calls).toHaveLength(0);
    out = '';
    expect(await runCli(['status', '--no-check'], io([], []))).toBe(1);
    expect(out).toMatch(/✗ Fritz/);
    expect(li.calls).toHaveLength(0);
  });
});

// ---- MCP tools ------------------------------------------------------------------------------------------------

let store: CredentialStore;

async function clientFor(principal: Principal, opts: { linkedinVersion?: string } = {}) {
  store = await openStore();
  const mcp = createMcpServer(createPerchContext(store, li.transport, undefined, undefined, opts), principal);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  const client = new Client({ name: 'linkedin-test', version: '0' });
  await client.connect(a);
  return client;
}

async function grant(capabilities: Capability[], accountIds: string[], full = false) {
  const s = await openStore();
  const { client, token } = await createClientGrant(s, {
    label: 'friagent',
    capabilities,
    accountIds,
    ...(full ? { full: true } : {}),
    tokenFile: path.join(dirs.root, 'clients', `${Math.random().toString(16).slice(2)}.token`),
  });
  return { id: client.id, principal: (await principalForClientToken(s, token))! };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: r.isError === true, text, body: JSON.parse(text) as Record<string, unknown> };
  } catch (e) {
    return { isError: true, text: (e as Error).message, body: { error: (e as Error).message } };
  }
}

const rid = () => `li-test-${Math.random().toString(16).slice(2, 14)}`;
const posts = () => li.calls.filter((c) => c.url.pathname === '/rest/posts');

describe('linkedin tools [MOCK LinkedIn]', () => {
  let member: MockMember;
  let id: string;
  beforeEach(async () => {
    member = li.addMember('Fritz Example');
    id = await connect(member);
    li.calls.length = 0;
  });

  it('read-only operator: linkedin_status only; posting is never listed', async () => {
    const client = await clientFor(READONLY_PRINCIPAL);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('linkedin_status');
    expect(names).not.toContain('linkedin_post');
    expect(names).not.toContain('linkedin_post_status');
    const st = await call(client, 'linkedin_status', { accountId: id });
    expect(st.body).toMatchObject({ accountId: id, accountLabel: 'Fritz', name: 'Fritz Example', personUrn: `urn:li:person:${member.sub}`, loginState: 'ok', refreshable: false });
    expect(st.body.connectedUntil).toMatch(/^\d{4}-/);
    const list = await call(client, 'perch_list_accounts', {});
    expect((list.body.linkedin as unknown[])[0]).toMatchObject({ accountId: id, label: 'Fritz' });
    expect(li.calls).toHaveLength(0);
  });

  it('grants: linkedin_read alone gets no post tool; linkedin_post is checked per account; capabilities need a linkedin account', async () => {
    const reader = await grant(['linkedin_read'], [id]);
    const names = (await (await clientFor(reader.principal)).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['linkedin_status', 'perch_list_accounts']));
    expect(names).not.toContain('linkedin_post');
    // A second account the grant does not cover.
    const other = await connect(li.addMember('Other Person'), 'Other');
    const poster = await grant(['linkedin_post'], [id]);
    const client = await clientFor(poster.principal);
    const denied = await call(client, 'linkedin_post', { accountId: other, text: 'x', requestId: rid() });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/not granted .* LinkedIn account/);
    const list = await call(client, 'perch_list_accounts', {});
    expect((list.body.linkedin as Array<{ accountId: string }>).map((a) => a.accountId)).toEqual([id]);
    await expect(createClientGrant(await openStore(), { label: 'x', capabilities: ['linkedin_post'], accountIds: ['slack-00000000'], tokenFile: path.join(dirs.root, 'x.token') })).rejects.toThrow();
    const s = await openStore();
    const imap = await expect(createClientGrant(s, { label: 'y', capabilities: ['linkedin_read'], accountIds: [], tokenFile: path.join(dirs.root, 'y.token') })).rejects.toThrow(/account id/);
    void imap;
    // perch client add with linkedin capabilities.
    out = '';
    expect(await runCli(['client', 'add', '--label', 'friagent', '--allow', 'linkedin_read,linkedin_post', '--account', id], io([], []))).toBe(0);
    expect(out).toMatch(/\(linkedin_read,linkedin_post\) for linkedin-/);
    const full = await grant([], [], true);
    expect((await (await clientFor(full.principal)).listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['linkedin_post', 'linkedin_post_status']));
    expect(posts()).toHaveLength(0);
  });

  it('posts with the documented request shape; postId and url from x-restli-id', async () => {
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const r = await call(client, 'linkedin_post', { accountId: id, text: 'Hello LinkedIn', requestId: rid() });
    expect(r.body).toMatchObject({ status: 'accepted', replayed: false, accountId: id, accountLabel: 'Fritz' });
    expect(r.body.postId).toMatch(/^urn:li:share:\d+$/);
    expect(r.body.url).toBe(`https://www.linkedin.com/feed/update/${r.body.postId as string}/`);
    const [req] = posts();
    expect(req!.method).toBe('POST');
    expect(req!.url.toString()).toBe('https://api.linkedin.com/rest/posts');
    expect(req!.headers).toMatchObject({
      authorization: `Bearer ${(await (await openStore()).read()).linkedin[0]!.accessToken}`,
      'linkedin-version': DEFAULT_LINKEDIN_VERSION,
      'x-restli-protocol-version': '2.0.0',
      'content-type': 'application/json',
    });
    expect(JSON.parse(req!.body!)).toEqual({
      author: `urn:li:person:${member.sub}`,
      commentary: 'Hello LinkedIn',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
    // ugcPost URNs too; PERCH_LINKEDIN_VERSION wins.
    li.urnKind = 'ugcPost';
    const c2 = await clientFor(principal, { linkedinVersion: '202512' });
    const r2 = await call(c2, 'linkedin_post', { accountId: id, text: 'second', requestId: rid() });
    expect(r2.body.postId).toMatch(/^urn:li:ugcPost:\d+$/);
    expect(posts()[1]!.headers['linkedin-version']).toBe('202512');
    // No id in the answer: still accepted (2xx), without postId.
    li.postFaults.push({ mode: 'no-id' });
    const r3 = await call(client, 'linkedin_post', { accountId: id, text: 'third', requestId: rid() });
    expect(r3.body).toMatchObject({ status: 'accepted' });
    expect(r3.body.postId).toBeUndefined();
  });

  it('escapes every reserved little-text character, and only those', async () => {
    const reserved = '\\|{}@[]()<>#*_~';
    expect(escapeLittleText(reserved)).toBe('\\\\\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\*\\_\\~');
    for (const c of reserved) expect(escapeLittleText(`a${c}b`)).toBe(`a\\${c}b`);
    const plain = 'Hello, world! ÄÖÜ ß ✓ 😀 "quotes" \'single\' $ % & + = ? / : ; ^ `\nnew line';
    expect(escapeLittleText(plain)).toBe(plain);
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const text = 'Release #1 of @perch (beta) [see] <here> *bold* _it_ ~x~ {a|b} C:\\path';
    await call(client, 'linkedin_post', { accountId: id, text, requestId: rid() });
    expect(JSON.parse(posts()[0]!.body!).commentary).toBe(
      'Release \\#1 of \\@perch \\(beta\\) \\[see\\] \\<here\\> \\*bold\\* \\_it\\_ \\~x\\~ \\{a\\|b\\} C:\\\\path',
    );
  });

  it('allows 3000 characters (counted before escaping, emoji as one), refuses 3001 before any request', async () => {
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const max = `${'#'.repeat(MAX_LINKEDIN_TEXT - 1)}😀`;
    const ok = await call(client, 'linkedin_post', { accountId: id, text: max, requestId: rid() });
    expect(ok.body).toMatchObject({ status: 'accepted' });
    expect(JSON.parse(posts()[0]!.body!).commentary).toHaveLength(2 * (MAX_LINKEDIN_TEXT - 1) + 2);
    const tooLong = await call(client, 'linkedin_post', { accountId: id, text: 'x'.repeat(MAX_LINKEDIN_TEXT + 1), requestId: rid() });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toMatch(/3001 characters; LinkedIn allows at most 3000\. Nothing was posted/);
    const empty = await call(client, 'linkedin_post', { accountId: id, text: '   ', requestId: rid() });
    expect(empty.isError).toBe(true);
    expect(posts()).toHaveLength(1);
    expect((await new MailWorkflowLedger(await openStore()).read()).sends).toHaveLength(1);
  });

  it('never posts twice: replay with the same text, conflict with another, linkedin_post_status', async () => {
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const requestId = rid();
    const first = await call(client, 'linkedin_post', { accountId: id, text: 'once', requestId });
    const again = await call(client, 'linkedin_post', { accountId: id, text: 'once', requestId });
    expect(again.body).toMatchObject({ status: 'accepted', replayed: true, postId: first.body.postId, url: first.body.url, operationId: first.body.operationId });
    const conflict = await call(client, 'linkedin_post', { accountId: id, text: 'twice', requestId });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/already used/);
    expect(posts()).toHaveLength(1);
    expect(member.posts).toHaveLength(1);
    const st = await call(client, 'linkedin_post_status', { accountId: id, requestId });
    expect(st.body).toMatchObject({ status: 'accepted', requestState: 'accepted', postId: first.body.postId, operationId: first.body.operationId });
    const unknown = await call(client, 'linkedin_post_status', { accountId: id, requestId: rid() });
    expect(unknown.isError).toBe(true);
    // Re-adding the same member keeps the binding: the status still resolves.
    await connect(member);
    const st2 = await call(await clientFor(principal), 'linkedin_post_status', { accountId: id, requestId });
    expect(st2.body).toMatchObject({ status: 'accepted', postId: first.body.postId });
  });

  it('4xx = rejected (not posted, no retry); 401 names the renew command', async () => {
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    for (const status of [400, 403, 422, 429]) {
      li.postFaults.push({ mode: 'status', status, body: { status, code: 'MOCK_REFUSED', message: `secret detail ${status}` } });
      const before = posts().length;
      const r = await call(client, 'linkedin_post', { accountId: id, text: `rejected ${status}`, requestId: rid() });
      expect(r.body).toMatchObject({ status: 'rejected', requestState: 'rejected' });
      expect(r.body.detail).toBe(`Not posted: LinkedIn refused the request (HTTP ${status}, MOCK_REFUSED)`);
      expect(posts().length - before).toBe(1);
    }
    li.postFaults.push({ mode: 'status', status: 401, body: { status: 401, code: 'INVALID_ACCESS_TOKEN' } });
    const r401 = await call(client, 'linkedin_post', { accountId: id, text: 'expired token', requestId: rid() });
    expect(r401.body).toMatchObject({ status: 'rejected' });
    expect(r401.body.detail).toMatch(/HTTP 401\)\. Renew it: perch linkedin add --label Fritz/);
  });

  it('timeout, network error and 5xx = indeterminate, attempted once, never retried (also not on repeat)', async () => {
    const { principal } = await grant(['linkedin_post'], [id]);
    const client = await clientFor(principal);
    const faults = [{ mode: 'timeout' as const }, { mode: 'unreachable' as const }, { mode: 'status' as const, status: 500 }, { mode: 'status' as const, status: 503 }];
    for (const f of faults) {
      li.postFaults.push(f);
      const requestId = rid();
      const before = posts().length;
      const r = await call(client, 'linkedin_post', { accountId: id, text: 'maybe', requestId });
      expect(r.body).toMatchObject({ status: 'indeterminate', requestState: 'indeterminate', replayed: false });
      expect(posts().length - before).toBe(1);
      const again = await call(client, 'linkedin_post', { accountId: id, text: 'maybe', requestId });
      expect(again.body).toMatchObject({ status: 'indeterminate', replayed: true });
      expect(posts().length - before).toBe(1);
    }
    expect(member.posts).toHaveLength(0);
  });

  it('an expired login is a clear error with the renew command, before any request', async () => {
    await setExpiry(id, -1000);
    const { principal } = await grant(['linkedin_read', 'linkedin_post'], [id]);
    const client = await clientFor(principal);
    const r = await call(client, 'linkedin_post', { accountId: id, text: 'late', requestId: rid() });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/LinkedIn login of linkedin-[a-f0-9]{8} expired on \d{4}-\d{2}-\d{2}\. Renew it \(same account, same id\): perch linkedin add --label Fritz/);
    expect(posts()).toHaveLength(0);
    const st = await call(client, 'linkedin_status', { accountId: id });
    expect(st.body).toMatchObject({ loginState: 'expired', renew: 'perch linkedin add --label Fritz' });
  });

  it('audit, errors and outputs never carry tokens or post text', async () => {
    const { principal, id: clientId } = await grant(['linkedin_read', 'linkedin_post'], [id]);
    const client = await clientFor(principal);
    const text = 'Very private draft text 0815';
    const outputs: string[] = [];
    outputs.push((await call(client, 'linkedin_post', { accountId: id, text, requestId: rid() })).text);
    li.postFaults.push({ mode: 'status', status: 422, body: { message: text } });
    outputs.push((await call(client, 'linkedin_post', { accountId: id, text: `${text} 2`, requestId: rid() })).text);
    li.postFaults.push({ mode: 'timeout' });
    outputs.push((await call(client, 'linkedin_post', { accountId: id, text: `${text} 3`, requestId: rid() })).text);
    outputs.push((await call(client, 'linkedin_post', { accountId: id, text: 'x'.repeat(3001), requestId: rid() })).text);
    outputs.push((await call(client, 'linkedin_status', { accountId: id })).text);
    const ledger = await new MailWorkflowLedger(await openStore()).read();
    const events = ledger.audit.filter((e) => e.actor.kind === 'client' && e.actor.clientId === clientId);
    expect(events.map((e) => [e.type, e.outcome])).toEqual(
      expect.arrayContaining([
        ['linkedin_post', 'accepted'],
        ['linkedin_post', 'rejected'],
        ['linkedin_post', 'indeterminate'],
        ['linkedin_post', 'invalid'],
        ['linkedin_status', 'ok'],
      ]),
    );
    expect(events.every((e) => e.provider === undefined || e.provider === 'linkedin')).toBe(true);
    const account = (await (await openStore()).read()).linkedin[0]!;
    const dump = JSON.stringify(ledger) + outputs.join('\n');
    for (const secret of [text, account.accessToken, li.client.secret]) expect(dump).not.toContain(secret);
    out = '';
    expect(await runCli(['audit', 'list'], io([], []))).toBe(0);
    expect(out).toContain('linkedin_post');
    expect(out).not.toContain(text);
    expect(out).not.toContain(account.accessToken);
  });
});

describe('LinkedIn upstream allowlist', () => {
  it('only userinfo, own posts (linkedin_post tag) and the token endpoint (admin)', async () => {
    expect(isAllowedRoute('linkedin', 'GET', '/v2/userinfo')).toBe(true);
    expect(isAllowedRoute('linkedin', 'POST', '/rest/posts')).toBe(false);
    expect(isAllowedRoute('linkedin', 'POST', '/rest/posts', 'linkedin_post')).toBe(true);
    expect(isAllowedRoute('linkedin', 'DELETE', '/rest/posts', 'linkedin_post')).toBe(false);
    expect(isAllowedRoute('linkedin', 'GET', '/rest/posts')).toBe(false);
    expect(isAllowedRoute('linkedin', 'GET', '/v2/me')).toBe(false);
    expect(isAllowedRoute('linkedin', 'POST', '/rest/organizations', 'linkedin_post')).toBe(false);
    expect(isAllowedRoute('linkedinauth', 'POST', '/oauth/v2/accessToken')).toBe(false);
    expect(isAllowedRoute('linkedinauth', 'POST', '/oauth/v2/accessToken', 'admin')).toBe(true);
    expect(isAllowedRoute('linkedinauth', 'POST', '/oauth/v2/accessToken', 'linkedin_post')).toBe(false);
    const up = new Upstream(li.transport);
    await expect(up.raw('linkedin', { method: 'POST', path: '/rest/posts', json: {} })).rejects.toMatchObject({ code: 'route_not_allowed' });
    expect(li.calls).toHaveLength(0);
  });

  it('post ids round-trip through the ledger form; foreign ids are not kept', () => {
    expect(postKeyOf('urn:li:share:123')).toBe('share-123');
    expect(postUrnOf('share-123')).toBe('urn:li:share:123');
    expect(postUrnOf(postKeyOf('urn:li:ugcPost:9'))).toBe('urn:li:ugcPost:9');
    expect(postKeyOf('urn:li:person:abc')).toBeUndefined();
    expect(postKeyOf('https://evil.example/x')).toBeUndefined();
  });

  it('the guide lines fit in 80 columns', () => {
    for (const line of linkedinClientGuide().split('\n')) expect([...line].length).toBeLessThanOrEqual(80);
  });
});
