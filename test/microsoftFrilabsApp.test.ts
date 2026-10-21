// Built-in frilabs Microsoft app, AADSTS error mapping and the admin consent link
// (docs/MICROSOFT_FRILABS_APP_SPEC.md, section "Perch").
// MOCK only: the Microsoft identity platform + Graph are mocks (test/support/mockGraph.ts); nothing reaches Microsoft.
// The frilabs client ID below is a dummy injected through the test seam; production ships FRILABS_MICROSOFT_CLIENT_ID.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/run.js';
import { resolveConfig } from '../src/config.js';
import {
  adminConsentScopes,
  adminConsentTenant,
  adminConsentUrl,
  classifyMicrosoftAuthError,
  explainMicrosoftAuthError,
} from '../src/microsoft/authErrors.js';
import { FRILABS_MICROSOFT_CLIENT_ID } from '../src/microsoft/defaultApp.js';
import { OAuthDeniedError } from '../src/oauth/loopback.js';
import { CredentialStore } from '../src/store/credentialStore.js';
import { UpstreamError } from '../src/upstream.js';
import { makeTempDirs, type TempDirs } from './support/fixtures.js';
import { MockGraph, msCallbackError, type MockGraphOptions } from './support/mockGraph.js';

const FRILABS_ID = '00000000-0000-4000-8000-0000000f7a85'; // dummy, injected via the seam
const OWN_ID = '0123abcd-4567-89ef-0123-456789abcdef';
const ENV_ID = '00000000-0000-0000-0000-00000000c11e';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dirs: TempDirs;
let out: string;
let err: string;

const clientFile = () => path.join(dirs.root, '.config', 'perch', 'microsoft-client-id');
const baseEnv = () => ({ PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: dirs.root });

function io(extra: Partial<CliIo> = {}): CliIo {
  return {
    env: baseEnv(),
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    readSecret: async () => {
      throw new Error('MOCK: no secret expected');
    },
    readLine: async (p) => {
      throw new Error(`MOCK: unexpected prompt: ${p}`);
    },
    ...extra,
  };
}

async function writeOwnClientFile(id = OWN_ID) {
  await mkdir(path.dirname(clientFile()), { recursive: true, mode: 0o700 });
  await writeFile(clientFile(), `${id}\n`, { mode: 0o600 });
}

/**
 * Runs `perch microsoft add` against the MOCK identity platform. `answer` decides what the MOCK browser does
 * with the login URL: approve (code) or a Microsoft error redirect.
 */
async function add(opts: { answer: (authUrl: string, graph: MockGraph) => string; mock?: MockGraphOptions; extra?: Partial<CliIo>; args?: string[] }) {
  const graph = new MockGraph(opts.mock ?? {});
  let authUrl = '';
  const code = await runCli(['microsoft', 'add', '--label', 'Work', '--read-only', '--timeout', '10', ...(opts.args ?? [])], {
    ...io({ transport: graph.transport, microsoftDefaultClientId: FRILABS_ID, ...opts.extra }),
    stderr: (s) => {
      err += s;
      const m = /https:\/\/login\.microsoftonline\.com\S+\/authorize\S+/.exec(s);
      if (m && !authUrl) {
        authUrl = m[0];
        void fetch(opts.answer(authUrl, graph)).catch(() => {});
      }
    },
  });
  return { code, authUrl, graph };
}

const approveWith = (mail: string) => (authUrl: string, graph: MockGraph) => {
  const acct = graph.addAccount(mail);
  const code = graph.approve(authUrl, acct);
  const u = new URL(authUrl);
  const r = new URL(u.searchParams.get('redirect_uri')!);
  return `http://127.0.0.1:${r.port}/?code=${code}&state=${u.searchParams.get('state')}`;
};

/** Fails if the output repeats Microsoft's description, trace ids, OAuth state/code or a token. */
function expectNoLeak(text: string, authUrl: string) {
  expect(text).not.toMatch(/MOCK error text|MOCK-TRACE|MOCK-CORR|DUMMY-TEST-/);
  if (authUrl) {
    const state = new URL(authUrl).searchParams.get('state')!;
    const challenge = new URL(authUrl).searchParams.get('code_challenge')!;
    // The login URL itself (with state + challenge) is printed once; the error message must not repeat them.
    const afterLogin = text.slice(text.indexOf('Waiting up to'));
    expect(afterLogin).not.toContain(state);
    expect(afterLogin).not.toContain(challenge);
  }
  expect(text).not.toMatch(/client_secret/i);
}

beforeEach(async () => {
  dirs = await makeTempDirs();
  out = '';
  err = '';
  expect(await runCli(['init'], io())).toBe(0);
  out = '';
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('client ID sources: env > file > frilabs default', () => {
  it('the shipped constant is empty or a GUID (never a fake id in production code)', () => {
    expect(FRILABS_MICROSOFT_CLIENT_ID === '' || GUID_RE.test(FRILABS_MICROSOFT_CLIENT_ID)).toBe(true);
  });

  it('uses the frilabs default only when neither the env variable nor the file is set', async () => {
    const seam = { frilabsMicrosoftClientId: FRILABS_ID };
    expect(resolveConfig(baseEnv(), { frilabsMicrosoftClientId: '' }).microsoftClientId).toBeUndefined();
    expect(resolveConfig(baseEnv(), seam)).toMatchObject({ microsoftClientId: FRILABS_ID, microsoftClientIdSource: 'frilabs' });
    await writeOwnClientFile();
    expect(resolveConfig(baseEnv(), seam)).toMatchObject({ microsoftClientId: OWN_ID, microsoftClientIdSource: 'file' });
    expect(resolveConfig({ ...baseEnv(), PERCH_MICROSOFT_CLIENT_ID: ENV_ID }, seam)).toMatchObject({
      microsoftClientId: ENV_ID,
      microsoftClientIdSource: 'env',
    });
  });

  it('an unusable client-id file is reported, never silently replaced by the default', async () => {
    await writeOwnClientFile();
    const { chmod } = await import('node:fs/promises');
    await chmod(clientFile(), 0o644);
    const cfg = resolveConfig(baseEnv(), { frilabsMicrosoftClientId: FRILABS_ID });
    expect(cfg.microsoftClientId).toBeUndefined();
    expect(cfg.microsoftClientIdFileError).toMatch(/insecure/);
  });

  it('an injected default that is not a GUID is rejected', () => {
    expect(() => resolveConfig(baseEnv(), { frilabsMicrosoftClientId: 'not-a-guid' })).toThrow(/GUID/);
  });

  it('client show names the frilabs default; client setup still writes an own app that then wins', async () => {
    expect(await runCli(['microsoft', 'client', 'show'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(0);
    expect(out).toContain('frilabs default');
    expect(out).toContain('Perch (frilabs)');
    expect(out).toContain('perch microsoft client setup');
    out = '';
    await writeOwnClientFile();
    expect(await runCli(['microsoft', 'client', 'show'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(0);
    expect(out).not.toContain('frilabs default');
    expect(out).toContain(clientFile());
  });
});

describe('perch microsoft add with the frilabs default [MOCK Microsoft identity platform + Graph]', () => {
  it('signs in directly without the registration guide and names the app "Perch (frilabs)"', async () => {
    const { code, authUrl, graph } = await add({ answer: approveWith('dummy.outlook@example.test') });
    expect(code).toBe(0);
    expect(new URL(authUrl).searchParams.get('client_id')).toBe(FRILABS_ID);
    expect(out + err).not.toContain('entra.microsoft.com');
    expect(out + err).not.toMatch(/Application \(client\) ID:/);
    expect(err).toContain('"Perch (frilabs)"');
    expect(err).toMatch(/frilabs never receives/);
    const acct = (await (await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile })).read()).microsoft[0]!;
    expect(acct).toMatchObject({ label: 'Work', clientId: FRILABS_ID, email: 'dummy.outlook@example.test' });
    expect(out + err).not.toContain(graph.accounts[0]!.refreshToken);
  });

  it('keeps the read/write question with the default', async () => {
    const prompts: string[] = [];
    const graph = new MockGraph();
    await runCli(['microsoft', 'add', '--label', 'Work', '--timeout', '1'], {
      ...io({ transport: graph.transport, microsoftDefaultClientId: FRILABS_ID }),
      readLine: async (p) => {
        prompts.push(p);
        return 'r';
      },
    });
    expect(prompts[0]).toMatch(/\[r\]ead only, or read \+ \[w\]rite/);
    expect(out).not.toContain('entra.microsoft.com');
  });

  it('with an own app the login text does not claim the frilabs app', async () => {
    await writeOwnClientFile();
    const { code, authUrl } = await add({ answer: approveWith('dummy.own@example.test') });
    expect(code).toBe(0);
    expect(new URL(authUrl).searchParams.get('client_id')).toBe(OWN_ID);
    expect(err).not.toContain('Perch (frilabs)');
  });

  it('without default and without a terminal it still points at the guided setup (behaviour as before)', async () => {
    const code = await runCli(['microsoft', 'add', '--label', 'Work', '--read-only'], { ...io({ microsoftDefaultClientId: '' }), readLine: undefined });
    expect(code).toBe(1);
    expect(err).toMatch(/perch microsoft client setup/);
  });

  it('rejects --tenant on add (the sign-in tenant comes from PERCH_MICROSOFT_TENANT)', async () => {
    expect(await runCli(['microsoft', 'add', '--label', 'Work', '--read-only', '--tenant', 'example.com'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(2);
    expect(err).toMatch(/--tenant is only valid for perch microsoft admin-consent-link/);
  });
});

describe('Microsoft sign-in errors in plain words [MOCK Microsoft identity platform]', () => {
  const callback = (error: string, aadsts?: number, description?: string) => (authUrl: string) => msCallbackError(authUrl, error, aadsts, description);
  const adminLink = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0/adminconsent?client_id=${FRILABS_ID}&scope=`;

  for (const aadsts of [65001, 90094, 90095]) {
    it(`AADSTS${aadsts} in the callback: admin approval needed, prints the admin consent link and text`, async () => {
      const { code, authUrl } = await add({ answer: callback('access_denied', aadsts) });
      expect(code).toBe(1);
      expect(err).toMatch(new RegExp(`requires an admin to approve Perch first \\(AADSTS${aadsts}\\)`));
      expect(err).toContain(adminLink('organizations'));
      expect(err).toContain('Text to forward to your IT administrator');
      expect(err).toMatch(/frilabs, the publisher,\n {2}never receives any mail or account data/);
      expectNoLeak(out + err, authUrl);
    });
  }

  it('consent_required without an AADSTS number is an admin approval, too', async () => {
    const { code, authUrl } = await add({ answer: callback('consent_required') });
    expect(code).toBe(1);
    expect(err).toMatch(/requires an admin to approve Perch first \(consent_required\)/);
    expect(err).toContain(adminLink('organizations'));
    expectNoLeak(out + err, authUrl);
  });

  it('a description asking for admin approval (any error name) is an admin approval', async () => {
    const { code } = await add({ answer: callback('access_denied', undefined, 'Need admin approval. MOCK error text') });
    expect(code).toBe(1);
    expect(err).toContain(adminLink('organizations'));
    expect(err).not.toContain('MOCK error text');
  });

  it('the admin link uses a specific sign-in tenant (PERCH_MICROSOFT_TENANT) instead of organizations', async () => {
    const env = { ...baseEnv(), PERCH_MICROSOFT_TENANT: 'example.com' };
    const { code } = await add({ answer: callback('access_denied', 65001), extra: { env } });
    expect(code).toBe(1);
    expect(err).toContain(adminLink('example.com'));
  });

  it('AADSTS65001 from the token endpoint maps the same way (code never echoed)', async () => {
    const { code, authUrl, graph } = await add({ answer: approveWith('dummy.org@example.test'), mock: { tokenError: { error: 'invalid_grant', aadsts: 65001 } } });
    expect(code).toBe(1);
    expect(graph.tokenCalls).toBe(1);
    expect(err).toMatch(/requires an admin to approve Perch first \(AADSTS65001\)/);
    expect(err).toContain(adminLink('organizations'));
    expectNoLeak(out + err, authUrl);
  });

  const cases: Array<[number, RegExp, RegExp]> = [
    [50020, /rejected this account for the tenant "common" \(AADSTS50020\)/, /set PERCH_MICROSOFT_TENANT to your\norganisation's domain/],
    [700016, /does not know the app with client ID 00000000-… \(AADSTS700016\)/, /built-in Perch \(frilabs\) app is not available[\s\S]*perch microsoft client setup/],
    [50011, /redirect address does not match the app registration \(AADSTS50011\)/, /"Mobile and desktop\napplications" with the redirect URI http:\/\/localhost/],
    [53003, /\(Conditional Access\) blocks this\nsign-in \(AADSTS53003\)/, /Only an administrator of your organisation can allow it/],
  ];
  for (const [aadsts, first, hint] of cases) {
    it(`AADSTS${aadsts} in the callback gets a clear message without the admin link`, async () => {
      const { code, authUrl } = await add({ answer: callback('access_denied', aadsts) });
      expect(code).toBe(1);
      expect(err).toMatch(first);
      expect(err).toMatch(hint);
      expect(err).not.toContain('adminconsent');
      expectNoLeak(out + err, authUrl);
    });
    it(`AADSTS${aadsts} from the token endpoint maps the same way`, async () => {
      const { code, authUrl } = await add({ answer: approveWith('dummy.t@example.test'), mock: { tokenError: { error: 'invalid_request', aadsts } } });
      expect(code).toBe(1);
      expect(err).toMatch(hint);
      expectNoLeak(out + err, authUrl);
    });
  }

  it('AADSTS50020 with a specific sign-in tenant suggests PERCH_MICROSOFT_TENANT=common', async () => {
    const env = { ...baseEnv(), PERCH_MICROSOFT_TENANT: 'example.com' };
    const { code } = await add({ answer: callback('invalid_request', 50020), extra: { env } });
    expect(code).toBe(1);
    expect(err).toMatch(/does not belong to the Microsoft tenant "example.com"\n\(AADSTS50020\)/);
    expect(err).toMatch(/PERCH_MICROSOFT_TENANT=common in .env/);
  });

  it('AADSTS700016 with an own app points at client show/setup', async () => {
    await writeOwnClientFile();
    const { code } = await add({ answer: callback('unauthorized_client', 700016) });
    expect(code).toBe(1);
    expect(err).toMatch(/client ID 0123abcd-… \(AADSTS700016\)/);
    expect(err).toMatch(/perch microsoft client show and replace it with perch microsoft client setup/);
    expect(err.slice(err.indexOf('perch:'))).not.toContain(OWN_ID); // shortened in the message
  });

  it('unknown codes keep the generic message with the error name and AADSTS number only', async () => {
    const { code, authUrl } = await add({ answer: callback('access_denied', 65004) });
    expect(code).toBe(1);
    expect(err).toContain('perch: Microsoft authorization failed: access_denied (AADSTS65004)');
    expectNoLeak(out + err, authUrl);
  });

  it('classification and the error objects only carry sanitised facts', () => {
    expect(classifyMicrosoftAuthError({ aadsts: '90095' })).toBe('admin_consent');
    expect(classifyMicrosoftAuthError({ error: 'consent_required' })).toBe('admin_consent');
    expect(classifyMicrosoftAuthError({ error: 'access_denied', mentionsAdminApproval: true })).toBe('admin_consent');
    expect(classifyMicrosoftAuthError({ aadsts: '50020' })).toBe('wrong_tenant');
    expect(classifyMicrosoftAuthError({ aadsts: '700016' })).toBe('unknown_app');
    expect(classifyMicrosoftAuthError({ aadsts: '50011' })).toBe('redirect_mismatch');
    expect(classifyMicrosoftAuthError({ aadsts: '53003' })).toBe('conditional_access');
    expect(classifyMicrosoftAuthError({ error: 'access_denied', aadsts: '65004' })).toBeUndefined();
    const denied = new OAuthDeniedError('Microsoft', 'access_denied', '50020', false);
    expect(Object.values(denied).join(' ')).not.toMatch(/MOCK/);
    // Server errors are not mapped (no AADSTS guess on a 5xx).
    const server = new UpstreamError('x', 500, 'server_error', undefined, '65001');
    expect(explainMicrosoftAuthError(server, { app: { clientId: FRILABS_ID, frilabs: true }, tenant: 'common' })).toBe(server);
  });
});

describe('perch microsoft admin-consent-link', () => {
  it('builds the v2.0 adminconsent URL with every Graph permission, URL-encoded, tenant organizations by default', () => {
    const url = new URL(adminConsentUrl(FRILABS_ID));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/v2.0/adminconsent');
    expect(url.searchParams.get('client_id')).toBe(FRILABS_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([
      'offline_access',
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ]);
    expect(adminConsentScopes()).toHaveLength(5);
    const raw = adminConsentUrl(FRILABS_ID);
    expect(raw).not.toMatch(/\s/);
    expect(raw).toContain('&redirect_uri=http%3A%2F%2Flocalhost');
    expect(raw).toContain('scope=offline_access%20https%3A%2F%2Fgraph.microsoft.com%2FUser.Read%20');
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'redirect_uri', 'scope']);
  });

  it('accepts a domain, a tenant GUID or an e-mail address for --tenant and rejects everything else', () => {
    expect(adminConsentTenant()).toBe('organizations');
    expect(adminConsentTenant('Example.COM')).toBe('example.com');
    expect(adminConsentTenant('fritz@ProjectAccess.org')).toBe('projectaccess.org');
    expect(adminConsentTenant('72F988BF-86F1-41AF-91AB-2D7CD011DB47')).toBe('72f988bf-86f1-41af-91ab-2d7cd011db47');
    expect(adminConsentTenant('organizations')).toBe('organizations');
    for (const bad of ['common', 'consumers', 'evil.example/../x', 'a b.com', 'localhost', '', '-x.com', 'x.com?y=1', 'x.com#a']) {
      expect(() => adminConsentTenant(bad), bad).toThrow(/--tenant must be a domain/);
    }
  });

  it('prints the link and the text to forward (frilabs default)', async () => {
    expect(await runCli(['microsoft', 'admin-consent-link'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(0);
    expect(out).toContain(`https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${FRILABS_ID}&scope=`);
    expect(out).toMatch(/Please approve the Microsoft app "Perch \(frilabs\)"/);
    expect(out).toMatch(/self-hosted/);
    expect(out).toMatch(/frilabs, the publisher,\n {2}never receives any mail or account data/);
    expect(out).toMatch(/Specific organisation: perch microsoft admin-consent-link --tenant DOMAIN/);
    for (const line of out.split('\n')) if (!line.includes('https://')) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('--tenant puts the organisation into the link; own apps are not called frilabs', async () => {
    await writeOwnClientFile();
    expect(await runCli(['microsoft', 'admin-consent-link', '--tenant', 'fritz@projectaccess.org'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(0);
    expect(out).toContain(`https://login.microsoftonline.com/projectaccess.org/v2.0/adminconsent?client_id=${OWN_ID}&`);
    expect(out).toMatch(/Please approve the Microsoft app "Perch" for our organisation/);
    expect(out).not.toContain('frilabs');
    expect(out).not.toContain('Specific organisation');
  });

  it('fails clearly without a client ID, with an invalid --tenant or extra arguments', async () => {
    expect(await runCli(['microsoft', 'admin-consent-link'], io({ microsoftDefaultClientId: '' }))).toBe(1);
    expect(err).toMatch(/No Microsoft client ID configured/);
    err = '';
    expect(await runCli(['microsoft', 'admin-consent-link', '--tenant', 'common'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(1);
    expect(err).toMatch(/--tenant must be a domain/);
    err = '';
    expect(await runCli(['microsoft', 'admin-consent-link', 'extra'], io({ microsoftDefaultClientId: FRILABS_ID }))).toBe(2);
    expect(out).toBe('');
  });
});
