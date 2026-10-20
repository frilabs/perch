// Guided provider setup for Outlook (Entra app registration, client-id file) and Slack (manifest + steps
// before the token prompt): docs/GUIDED_PROVIDER_SETUP_SPEC.md §3, §4, §5.
// MOCK only: the Microsoft identity platform + Graph and the Slack Web API are mocks; nothing reaches a provider.
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/run.js';
import { resolveConfig } from '../src/config.js';
import { parseMicrosoftClientId, readMicrosoftClientIdFile, ENTRA_NEW_APP_URL } from '../src/microsoft/clientSetup.js';
import { CredentialStore } from '../src/store/credentialStore.js';
import { makeTempDirs, type TempDirs } from './support/fixtures.js';
import { MockGraph } from './support/mockGraph.js';
import { MockSlack } from './support/mockSlack.js';

let dirs: TempDirs;
let out: string;
let err: string;
let prompts: string[];

const CLIENT_ID = '0123abcd-4567-89ef-0123-456789abcdef';
const ENV_ID = '00000000-0000-0000-0000-00000000c11e';

const clientFile = () => path.join(dirs.root, '.config', 'perch', 'microsoft-client-id');

interface IoOpts extends Partial<CliIo> {
  /** When the scripted answers run out: 'throw' (default) or 'hang' (a prompt racing another event). */
  exhausted?: 'throw' | 'hang';
}

function io(answers: string[] = [], { exhausted = 'throw', ...extra }: IoOpts = {}): CliIo {
  return {
    env: { PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: dirs.root },
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    readSecret: async () => {
      throw new Error('MOCK: no secret expected');
    },
    readLine: async (p) => {
      prompts.push(p);
      const a = answers.shift();
      if (a !== undefined) return a;
      if (exhausted === 'hang') return new Promise<string>(() => {});
      throw new Error(`MOCK: no more answers (prompt: ${p})`);
    },
    ...extra,
  };
}

const openStore = () => CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });

beforeEach(async () => {
  dirs = await makeTempDirs();
  out = '';
  err = '';
  prompts = [];
  expect(await runCli(['init'], io())).toBe(0);
  out = '';
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('Microsoft client ID: validation, file fallback, precedence', () => {
  it('accepts only GUIDs (braces/case normalised)', () => {
    expect(parseMicrosoftClientId(` {${CLIENT_ID.toUpperCase()}} `)).toBe(CLIENT_ID);
    for (const bad of ['', 'not-a-guid', `${CLIENT_ID}x`, CLIENT_ID.replace(/-/g, ''), 'https://evil.example/0123abcd-4567-89ef-0123-456789abcdef']) {
      expect(() => parseMicrosoftClientId(bad)).toThrow(/GUID/);
    }
  });

  it('reads the file as fallback; PERCH_MICROSOFT_CLIENT_ID takes precedence', async () => {
    const base = { HOME: dirs.root };
    expect(resolveConfig(base).microsoftClientId).toBeUndefined();
    await mkdir(path.dirname(clientFile()), { recursive: true, mode: 0o700 });
    await writeFile(clientFile(), `${CLIENT_ID}\n`, { mode: 0o600 });
    expect(resolveConfig(base)).toMatchObject({ microsoftClientId: CLIENT_ID, microsoftClientIdSource: 'file', microsoftClientIdFile: clientFile() });
    expect(resolveConfig({ ...base, PERCH_MICROSOFT_CLIENT_ID: ENV_ID })).toMatchObject({ microsoftClientId: ENV_ID, microsoftClientIdSource: 'env' });
    // XDG_CONFIG_HOME moves the file.
    expect(resolveConfig({ ...base, XDG_CONFIG_HOME: path.join(dirs.root, 'xdg') }).microsoftClientId).toBeUndefined();
  });

  it('ignores an insecure, symlinked or malformed file with a reason', async () => {
    await mkdir(path.dirname(clientFile()), { recursive: true, mode: 0o700 });
    await writeFile(clientFile(), CLIENT_ID, { mode: 0o600 });
    await chmod(clientFile(), 0o644);
    expect(readMicrosoftClientIdFile(clientFile())).toEqual({ error: expect.stringMatching(/insecure permissions/) });
    expect(resolveConfig({ HOME: dirs.root })).toMatchObject({ microsoftClientIdFileError: expect.stringMatching(/insecure/) });
    await chmod(clientFile(), 0o600);
    await writeFile(clientFile(), 'garbage');
    expect(readMicrosoftClientIdFile(clientFile())).toEqual({ error: expect.stringMatching(/does not contain/) });
    const real = path.join(dirs.root, 'real-id');
    await writeFile(real, CLIENT_ID, { mode: 0o600 });
    const link = path.join(dirs.root, 'link-id');
    await symlink(real, link);
    expect(readMicrosoftClientIdFile(link)).toEqual({ error: expect.stringMatching(/symlink/) });
    expect(readMicrosoftClientIdFile(path.join(dirs.root, 'nope'))).toEqual({ missing: true });

    // microsoft add refuses to start a guide over an unusable file and says why.
    await chmod(clientFile(), 0o644);
    expect(await runCli(['microsoft', 'add', '--label', 'Work', '--read-only'], io())).toBe(1);
    expect(err).toMatch(/client-id file is not usable: insecure permissions/);
  });

  it('microsoft add without a terminal fails clearly and points at perch microsoft client setup', async () => {
    const noTty = io();
    delete noTty.readLine;
    expect(await runCli(['microsoft', 'add', '--label', 'Work', '--read-only'], noTty)).toBe(1);
    expect(err).toMatch(/PERCH_MICROSOFT_CLIENT_ID/);
    expect(err).toMatch(/perch microsoft client setup/);
  });
});

describe('perch microsoft client setup | show', () => {
  it('guides with direct Entra links, validates the GUID, writes the file 0600 atomically', async () => {
    const answers = ['', '', '', 'not-a-guid', CLIENT_ID];
    expect(await runCli(['microsoft', 'client', 'setup'], io(answers))).toBe(0);
    expect(out).toContain(ENTRA_NEW_APP_URL);
    expect(out).toContain('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade');
    expect(out).toMatch(/personal Microsoft accounts/);
    expect(out).toMatch(/Public client\/native \(mobile & desktop\)/);
    expect(out).toMatch(/Mobile and desktop applications/);
    expect(out).toContain('http://localhost');
    expect(out).toMatch(/Do NOT create a client secret/);
    expect(out).toMatch(/User\.Read, Mail\.Read/);
    expect(out).toMatch(/Mail\.ReadWrite, Mail\.Send/);
    expect(out).toMatch(/offline_access/);
    expect(out).toMatch(/not a GUID/);
    expect(await readFile(clientFile(), 'utf8')).toBe(`${CLIENT_ID}\n`);
    expect((await stat(clientFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(clientFile()))).mode & 0o777).toBe(0o700);
    const dirEntries = await import('node:fs/promises').then((f) => f.readdir(path.dirname(clientFile())));
    expect(dirEntries).toEqual(['microsoft-client-id']);

    out = '';
    expect(await runCli(['microsoft', 'client', 'show'], io())).toBe(0);
    expect(out).toContain('0123abcd-…');
    expect(out).not.toContain(CLIENT_ID);
    expect(out).toContain(clientFile());
  });

  it('gives up after three invalid IDs without writing a file', async () => {
    expect(await runCli(['microsoft', 'client', 'setup'], io(['', '', '', 'a', 'b', 'c']))).toBe(1);
    expect(err).toMatch(/GUID/);
    await expect(stat(clientFile())).rejects.toThrow();
  });

  it('asks before replacing an existing file; N keeps it', async () => {
    await mkdir(path.dirname(clientFile()), { recursive: true, mode: 0o700 });
    await writeFile(clientFile(), `${CLIENT_ID}\n`, { mode: 0o600 });
    expect(await runCli(['microsoft', 'client', 'setup'], io(['n']))).toBe(0);
    expect(prompts[0]).toMatch(/Replace it/);
    expect(out).toMatch(/Kept the existing/);
    expect(await readFile(clientFile(), 'utf8')).toBe(`${CLIENT_ID}\n`);
    const other = 'ffffffff-0000-1111-2222-333333333333';
    expect(await runCli(['microsoft', 'client', 'setup'], io(['y', '', '', '', other]))).toBe(0);
    expect(await readFile(clientFile(), 'utf8')).toBe(`${other}\n`);
  });

  it('show reports the env variable as the source when set; setup notes the precedence', async () => {
    const env = { ...io().env, PERCH_MICROSOFT_CLIENT_ID: ENV_ID };
    expect(await runCli(['microsoft', 'client', 'show'], io([], { env }))).toBe(0);
    expect(out).toMatch(/from PERCH_MICROSOFT_CLIENT_ID \(takes precedence/);
    out = '';
    expect(await runCli(['microsoft', 'client', 'setup'], io(['', '', '', CLIENT_ID], { env }))).toBe(0);
    expect(out).toMatch(/PERCH_MICROSOFT_CLIENT_ID is set and takes precedence/);
  });

  it('show without any client ID; setup without a terminal is refused', async () => {
    expect(await runCli(['microsoft', 'client', 'show'], io())).toBe(0);
    expect(out).toMatch(/No client ID configured/);
    const noTty = io();
    delete noTty.readLine;
    expect(await runCli(['microsoft', 'client', 'setup'], noTty)).toBe(1);
    expect(err).toMatch(/interactive terminal/);
  });
});

describe('perch microsoft add with the guide [MOCK Microsoft identity platform + Graph]', () => {
  it('runs the guide when no client ID exists, lists the write permissions for write, then signs in with the new ID', async () => {
    const graph = new MockGraph({
      grantedScope: 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
    });
    const acct = graph.addAccount('dummy.outlook@example.test');
    let clientIdSeen = '';
    let done = false;
    const cliIo = io(['w', '', '', '', CLIENT_ID], {
      exhausted: 'hang',
      transport: graph.transport,
      stderr: (s) => {
        err += s;
        const m = /https:\/\/login\.microsoftonline\.com\S+/.exec(s);
        if (m && !done) {
          done = true;
          const url = new URL(m[0]);
          clientIdSeen = url.searchParams.get('client_id')!;
          const code = graph.approve(url.toString(), acct);
          const redirect = new URL(url.searchParams.get('redirect_uri')!);
          void fetch(`http://127.0.0.1:${redirect.port}${redirect.pathname}?code=${code}&state=${url.searchParams.get('state')}`);
        }
      },
    });
    expect(await runCli(['microsoft', 'add', '--label', 'Outlook', '--timeout', '10'], cliIo)).toBe(0);
    expect(out).toContain(ENTRA_NEW_APP_URL);
    expect(out).toMatch(/User\.Read, Mail\.Read, Mail\.ReadWrite, Mail\.Send/);
    expect(clientIdSeen).toBe(CLIENT_ID);
    expect(await readFile(clientFile(), 'utf8')).toBe(`${CLIENT_ID}\n`);
    expect((await (await openStore()).read()).microsoft[0]).toMatchObject({ label: 'Outlook', clientId: CLIENT_ID });
    expect(out + err).not.toContain(acct.refreshToken);
  });

  it('read-only add lists only User.Read and Mail.Read', async () => {
    // Stop after the guide: the login itself is covered above.
    const cliIo = io(['r', '', '', '', CLIENT_ID]);
    await runCli(['microsoft', 'add', '--label', 'Outlook', '--timeout', '1'], { ...cliIo, transport: async () => ({ status: 500, headers: {}, body: Buffer.from('{}') }) });
    expect(out).toMatch(/Delegated permissions:\n {2}User\.Read, Mail\.Read\n/);
    expect(out).not.toMatch(/Mail\.Send/);
  });

  it('never runs the guide when the env variable is set', async () => {
    const env = { ...io().env, PERCH_MICROSOFT_CLIENT_ID: ENV_ID, PERCH_MICROSOFT_TENANT: 'evil.example/../x' };
    expect(await runCli(['microsoft', 'add', '--label', 'Work', '--read-only'], io([], { env }))).toBe(1);
    expect(err).toMatch(/tenant/i);
    expect(out).not.toContain('entra.microsoft.com');
  });
});

describe('perch slack add guide [MOCK Slack]', () => {
  function slackIo(answers: string[], secrets: string[]) {
    const slack = mock;
    return io(answers, {
      transport: slack.transport,
      readSecret: async (p) => {
        prompts.push(`SECRET:${p}`);
        const s = secrets.shift();
        if (s === undefined) throw new Error('MOCK: no secret');
        return s;
      },
    });
  }
  let mock: MockSlack;
  beforeEach(() => {
    mock = new MockSlack();
  });

  it('shows manifest, link and steps before the hidden token prompt; the token is never printed', async () => {
    const team = mock.addTeam('A');
    expect(await runCli(['slack', 'add', '--label', 'Company'], slackIo([''], [team.token]))).toBe(0);
    expect(out).toContain('https://api.slack.com/apps?new_app=1');
    expect(out).toMatch(/From a manifest/);
    expect(out).toMatch(/Install to Workspace/);
    expect(out).toMatch(/User OAuth Token/);
    expect(out).toContain('"token_rotation_enabled": false');
    expect(prompts[0]).toMatch(/Press Enter/);
    expect(prompts[1]).toMatch(/^SECRET:Slack user token/);
    expect(out.indexOf('new_app=1')).toBeLessThan(out.indexOf('Connected Slack workspace'));
    expect(out + err).not.toContain(team.token);
  });

  it('--skip-guide goes straight to the token prompt', async () => {
    const team = mock.addTeam('A');
    expect(await runCli(['slack', 'add', '--label', 'Company', '--skip-guide'], slackIo([], [team.token]))).toBe(0);
    expect(out).not.toContain('new_app=1');
    expect(prompts).toEqual([expect.stringMatching(/^SECRET:/)]);
  });

  it('asks [y/N] when a workspace is already connected', async () => {
    const a = mock.addTeam('A');
    const b = mock.addTeam('B');
    const c = mock.addTeam('C');
    expect(await runCli(['slack', 'add', '--label', 'A', '--skip-guide'], slackIo([], [a.token]))).toBe(0);
    out = '';
    prompts = [];
    expect(await runCli(['slack', 'add', '--label', 'B'], slackIo([''], [b.token]))).toBe(0);
    expect(prompts[0]).toMatch(/Show the steps .*\[y\/N\]/);
    expect(out).not.toContain('new_app=1');
    prompts = [];
    expect(await runCli(['slack', 'add', '--label', 'C'], slackIo(['y', ''], [c.token]))).toBe(0);
    expect(out).toContain('new_app=1');
    expect(prompts.map((p) => p.slice(0, 7))).toEqual(['Show th', 'Press E', 'SECRET:']);
  });

  it('without a terminal: no guide, the masked prompt fails as before', async () => {
    const noTty = slackIo([], []);
    delete noTty.readLine;
    expect(await runCli(['slack', 'add', '--label', 'X'], noTty)).toBe(1);
    expect(out).not.toContain('new_app=1');
  });
});

describe('perch setup hints', () => {
  it('Outlook and Slack say that Perch guides through the preparation', async () => {
    // google n, microsoft y → the label prompt is next; the scripted answers end there (focus: the hint).
    await runCli(['setup'], io(['n', 'y']));
    expect(out).toMatch(/Entra app registration .*guides you through it/);
    out = '';
    // google, microsoft, imap, notion n; slack y.
    await runCli(['setup'], io(['n', 'n', 'n', 'n', 'y']));
    expect(out).toMatch(/Perch shows the app manifest and the steps/);
  });
});
