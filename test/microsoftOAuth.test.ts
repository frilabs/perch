// Microsoft identity platform OAuth (auth code + PKCE, public client) and account handling against
// the MOCK identity platform / Graph (test/support/mockGraph.ts). No live Microsoft calls.
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMicrosoftTokenProvider,
  fetchMicrosoftIdentity,
  registerMicrosoftAccount,
  removeMicrosoftAccount,
} from '../src/microsoft/accounts.js';
import {
  MS_DEFAULT_SCOPES,
  microsoftScopesFor,
  refreshMicrosoftToken,
  runMicrosoftAuthorization,
  validateTenant,
} from '../src/microsoft/oauth.js';
import { CredentialStore, initStore } from '../src/store/credentialStore.js';
import { Upstream } from '../src/upstream.js';
import { makeTempDirs, rejection, type TempDirs } from './support/fixtures.js';
import { MockGraph, type MockGraphOptions } from './support/mockGraph.js';

const CLIENT_ID = '00000000-0000-4000-8000-00000000d0d0'; // dummy GUID
const G = 'https://graph.microsoft.com/';

/** GET against the loopback listener (always 127.0.0.1, whatever host the redirect URI names). */
function get(url: string) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

function setup(mock: MockGraphOptions = {}, flow: { send?: boolean; drafts?: boolean; tenant?: string; loginHint?: string } = {}) {
  const ms = new MockGraph(mock);
  const acct = ms.addAccount('dummy.one@example.test');
  let resolveUrl!: (u: string) => void;
  const authUrl = new Promise<string>((r) => (resolveUrl = r));
  const result = runMicrosoftAuthorization({
    clientId: CLIENT_ID,
    tenant: flow.tenant ?? 'consumers',
    upstream: new Upstream(ms.transport),
    port: 0,
    timeoutMs: 5000,
    ...(flow.send ? { send: true } : {}),
    ...(flow.drafts ? { drafts: true } : {}),
    ...(flow.loginHint ? { loginHint: flow.loginHint } : {}),
    onAuthUrl: resolveUrl,
  });
  result.catch(() => {});
  return { ms, acct, authUrl, result };
}

async function complete(s: ReturnType<typeof setup>) {
  const u = new URL(await s.authUrl);
  const code = s.ms.approve(u.toString(), s.acct);
  expect(await get(`${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`)).toBe(200);
  return { u, code };
}

describe('scopes and tenant', () => {
  it('defaults to read-only scopes; drafts/send are explicit opt-ins', () => {
    expect([...MS_DEFAULT_SCOPES]).toEqual(['offline_access', 'User.Read', 'Mail.Read']);
    expect(microsoftScopesFor({})).toEqual(['offline_access', 'User.Read', 'Mail.Read']);
    expect(microsoftScopesFor({ drafts: true })).toEqual(['offline_access', 'User.Read', 'Mail.Read', 'Mail.ReadWrite']);
    expect(microsoftScopesFor({ send: true })).toEqual(['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send']);
  });

  it('accepts only common/organizations/consumers, a GUID or a domain', () => {
    for (const t of ['common', 'organizations', 'consumers', CLIENT_ID, 'contoso.onmicrosoft.com']) expect(validateTenant(t)).toBe(t);
    for (const t of ['', 'evil.example/../x', 'a b', 'contoso', 'x?y=1', '..', 'common#']) {
      expect(() => validateTenant(t)).toThrow(/tenant/i);
    }
  });
});

describe('runMicrosoftAuthorization [MOCK identity platform]', () => {
  it('builds a fixed-endpoint PKCE S256 auth URL with the default scopes and a localhost redirect', async () => {
    const { authUrl } = setup({}, { loginHint: 'dummy.one@example.test' });
    const u = new URL(await authUrl);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('scope')).toBe('offline_access User.Read Mail.Read');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('response_mode')).toBe('query');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('login_hint')).toBe('dummy.one@example.test');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/$/);
  });

  it('requests opt-in scopes', async () => {
    const { authUrl } = setup({}, { send: true, drafts: true });
    expect(new URL(await authUrl).searchParams.get('scope')).toBe('offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send');
  });

  it('rejects a bad tenant or client id before opening the listener', async () => {
    const upstream = new Upstream(new MockGraph().transport);
    const base = { clientId: CLIENT_ID, upstream, onAuthUrl: () => {} };
    expect((await rejection(runMicrosoftAuthorization({ ...base, tenant: 'evil.example/x' }))).message).toMatch(/tenant/i);
    expect((await rejection(runMicrosoftAuthorization({ ...base, tenant: 'common', clientId: 'not-a-guid' }))).message).toMatch(/client id/i);
  });

  it('exchanges the code with the PKCE verifier at the fixed token endpoint, without a client secret', async () => {
    const s = setup({ grantedScope: `${G}User.Read ${G}Mail.Read openid profile` });
    const { u, code } = await complete(s);
    const res = await s.result;
    expect(res.refreshToken).toBe(s.acct.refreshToken);
    expect(res.accessToken).toMatch(/^DUMMY-TEST-MS-ACCESS/);
    expect(res.expiresAt).toBeGreaterThan(Date.now());
    expect(res.scopes).toEqual(expect.arrayContaining(['User.Read', 'Mail.Read']));
    expect(res.scopes.some((x) => x.startsWith('https://'))).toBe(false);
    const call = s.ms.calls.find((c) => c.url.origin === 'https://login.microsoftonline.com')!;
    expect(call.url.toString()).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    const form = new URLSearchParams(call.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(code);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('redirect_uri')).toBe(u.searchParams.get('redirect_uri'));
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('scope')).toBe('offline_access User.Read Mail.Read');
    expect(form.has('client_secret')).toBe(false);
  });

  it('fails without a refresh token, explaining offline_access', async () => {
    const s = setup({ omitRefreshToken: true });
    await complete(s);
    const err = await rejection(s.result);
    expect(err).toMatchObject({ code: 'oauth_no_refresh_token' });
    expect(err.message).toMatch(/offline_access/);
  });

  it('fails when a required or opted-in scope was not granted (case-insensitive, prefix stripped)', async () => {
    const missingRead = setup({ grantedScope: `${G}User.Read` });
    await complete(missingRead);
    const e1 = await rejection(missingRead.result);
    expect(e1).toMatchObject({ code: 'oauth_scope_missing' });
    expect(e1.message).toMatch(/Mail\.Read/);
    expect(e1.message).toMatch(/admin consent|policy/i);

    const missingSend = setup({ grantedScope: `${G}user.read ${G}mail.read` }, { send: true });
    await complete(missingSend);
    expect((await rejection(missingSend.result)).message).toMatch(/Mail\.Send/);

    const ok = setup({ grantedScope: `${G}user.read MAIL.READ ${G}Mail.Send` }, { send: true });
    await complete(ok);
    expect((await ok.result).scopes).toEqual(expect.arrayContaining(['User.Read', 'Mail.Read', 'Mail.Send']));
  });
});

describe('Microsoft accounts [MOCK Graph]', () => {
  let dirs: TempDirs;
  let store: CredentialStore;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    await initStore({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
  });
  afterEach(async () => {
    await dirs.cleanup();
  });

  const grantFor = (ms: MockGraph, a: ReturnType<MockGraph['addAccount']>) => ({
    refreshToken: a.refreshToken,
    accessToken: ms.issueAccessToken(a),
    expiresAt: Date.now() + 3_600_000,
    scopes: ['User.Read', 'Mail.Read'],
  });

  it('identifies via /v1.0/me: mail, falling back to userPrincipalName', async () => {
    const ms = new MockGraph();
    const withMail = ms.addAccount('dummy.mail@example.test', 'upn@example.test');
    const noMail = ms.addAccount(null, 'live.upn@example.test');
    const upstream = new Upstream(ms.transport);
    expect(await fetchMicrosoftIdentity(upstream, ms.issueAccessToken(withMail))).toMatchObject({ email: 'dummy.mail@example.test' });
    expect(await fetchMicrosoftIdentity(upstream, ms.issueAccessToken(noMail))).toMatchObject({ email: 'live.upn@example.test' });
    const me = ms.calls[0]!;
    expect(me.url.pathname).toBe('/v1.0/me');
    expect(me.url.searchParams.get('$select')).toBe('id,displayName,mail,userPrincipalName');
  });

  it('registers an account and rejects a duplicate email', async () => {
    const ms = new MockGraph();
    const a = ms.addAccount('Dummy.One@example.test');
    const upstream = new Upstream(ms.transport);
    const acct = await registerMicrosoftAccount(store, upstream, { label: 'Outlook', clientId: CLIENT_ID, tenant: 'consumers', grant: grantFor(ms, a) });
    expect(acct).toMatchObject({ label: 'Outlook', email: 'Dummy.One@example.test', tenant: 'consumers', clientId: CLIENT_ID, refreshToken: a.refreshToken });
    expect(acct.id).toMatch(/^microsoft-[a-f0-9]{8}$/);
    expect((await store.read()).microsoft).toHaveLength(1);
    a.mail = 'dummy.one@EXAMPLE.test';
    const err = await rejection(registerMicrosoftAccount(store, upstream, { label: 'Again', clientId: CLIENT_ID, tenant: 'consumers', grant: grantFor(ms, a) }));
    expect(err).toMatchObject({ code: 'duplicate_account' });
    expect(err.message).not.toContain(a.refreshToken);

    await removeMicrosoftAccount(store, acct.id);
    expect((await store.read()).microsoft).toHaveLength(0);
    expect(await rejection(removeMicrosoftAccount(store, acct.id))).toMatchObject({ code: 'unknown_account' });
  });

  it('refreshes against the fixed token endpoint, persists rotation, and is single-flight', async () => {
    const ms = new MockGraph();
    const a = ms.addAccount('dummy.one@example.test');
    const upstream = new Upstream(ms.transport);
    const acct = await registerMicrosoftAccount(store, upstream, { label: 'Outlook', clientId: CLIENT_ID, tenant: 'common', grant: grantFor(ms, a) });
    const original = acct.refreshToken;
    ms.calls.length = 0;
    const tokens = createMicrosoftTokenProvider(store, upstream);
    const [t1, t2, t3] = await Promise.all([tokens.getAccessToken(acct.id), tokens.getAccessToken(acct.id), tokens.getAccessToken(acct.id)]);
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
    expect(ms.calls).toHaveLength(1);
    const call = ms.calls[0]!;
    expect(call.url.toString()).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const form = new URLSearchParams(call.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(original);
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['offline_access', 'User.Read', 'Mail.Read']));
    expect(form.has('client_secret')).toBe(false);
    const stored = (await store.read()).microsoft[0]!.refreshToken;
    expect(stored).not.toBe(original);
    expect(stored).toBe(a.refreshToken);
  });

  it('maps invalid_grant to a reconnect hint without labels or tokens', async () => {
    const ms = new MockGraph();
    const a = ms.addAccount('dummy.one@example.test');
    const upstream = new Upstream(ms.transport);
    const acct = await registerMicrosoftAccount(store, upstream, { label: 'evil; rm -rf ~', clientId: CLIENT_ID, tenant: 'common', grant: grantFor(ms, a) });
    a.refreshToken = 'revoked-at-provider';
    const err = await rejection(createMicrosoftTokenProvider(store, upstream).getAccessToken(acct.id));
    expect(err).toMatchObject({ code: 'grant_invalid' });
    expect(err.message).toContain(`perch microsoft remove ${acct.id}`);
    expect(err.message).toContain('perch microsoft add --label <label>');
    expect(err.message).not.toContain('rm -rf');
    expect(err.message).not.toContain(acct.refreshToken);
  });

  it('refreshMicrosoftToken posts the refresh grant for the stored tenant', async () => {
    const ms = new MockGraph({ rotateOnRefresh: false });
    const a = ms.addAccount('dummy.one@example.test');
    const now = new Date().toISOString();
    const tok = await refreshMicrosoftToken(new Upstream(ms.transport), {
      id: 'microsoft-0000000a', label: 'x', email: 'dummy.one@example.test', tenant: 'organizations', clientId: CLIENT_ID,
      refreshToken: a.refreshToken, scopes: ['User.Read', 'Mail.Read', 'Mail.Send'], createdAt: now, updatedAt: now,
    });
    expect(tok.access_token).toMatch(/^DUMMY-TEST-MS-ACCESS/);
    expect(ms.calls[0]!.url.pathname).toBe('/organizations/oauth2/v2.0/token');
    expect(new URLSearchParams(ms.calls[0]!.body).get('scope')).toBe('offline_access User.Read Mail.Read Mail.Send');
  });
});
