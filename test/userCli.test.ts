// Local admin CLI for users (`perch user add|list|remove`) and the trusted PERCH_USER namespace selector for
// onboarding, accounts, client grants and stdio. IMAP verification is injected (no server is contacted);
// every secret is generated dummy data.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/run.js';
import { CredentialStore, storeFilePath } from '../src/store/credentialStore.js';
import { openUserStore, userStorePaths } from '../src/users/registry.js';
import { dummySecret, makeTempDirs, type TempDirs } from './support/fixtures.js';

let dirs: TempDirs;
let out: string[];
let err: string[];

function io(env: Record<string, string> = {}): CliIo {
  return {
    env: { PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: dirs.root, ...env },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readSecret: async () => dummySecret('APP-PASSWORD'),
    imapVerify: async () => {},
    transport: async () => {
      throw new Error('MOCK: no upstream expected');
    },
  };
}

async function cli(args: string[], env: Record<string, string> = {}) {
  out = [];
  err = [];
  const code = await runCli(args, io(env));
  return { code, out: out.join(''), err: err.join('') };
}

const rootStore = () => CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
const paths = () => ({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });

async function addUser(label: string) {
  const r = await cli(['user', 'add', '--label', label]);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  const id = /Created user (user-[a-f0-9]{16})/.exec(r.out)![1]!;
  return { id, out: r.out };
}

const imapAdd = (label: string) => ['imap', 'add', '--label', label, '--email', `${label.toLowerCase()}@gmx.at`, '--allow-send'];

beforeEach(async () => {
  dirs = await makeTempDirs();
  expect((await cli(['init'])).code).toBe(0);
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('perch user', () => {
  it('adds a user with a token written once to a new 0600 file, lists and removes without deleting data', async () => {
    const { id, out: added } = await addUser('Alice');
    const tokenFile = path.join(path.dirname(dirs.tokenFile), 'users', `${id}.token`);
    expect(added).toContain(tokenFile);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    expect(added).not.toContain(token);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

    const list = await cli(['user', 'list']);
    expect(list.out).toMatch(new RegExp(`${id}\\s+"Alice"\\s+active`));
    expect(list.out).not.toContain(token);

    const rm = await cli(['user', 'remove', id]);
    expect(rm.code).toBe(0);
    expect(rm.out).toMatch(/kept/i);
    expect((await cli(['user', 'list'])).out).toMatch(new RegExp(`${id}\\s+"Alice"\\s+removed`));
    const p = userStorePaths(paths(), id);
    expect((await stat(p.keyFile)).isFile()).toBe(true);
    expect((await stat(storeFilePath(p.dataDir))).isFile()).toBe(true);
    // A removed user can no longer be selected; nothing falls back to root.
    const sel = await cli(['accounts'], { PERCH_USER: id });
    expect(sel.code).toBe(1);
    expect(sel.err).toMatch(/removed|disabled/i);
  });

  it('refuses to overwrite an existing --token-file', async () => {
    const tokenFile = path.join(dirs.root, 'config', 'mine.token');
    expect((await cli(['user', 'add', '--label', 'A', '--token-file', tokenFile])).code).toBe(0);
    const before = await readFile(tokenFile, 'utf8');
    const again = await cli(['user', 'add', '--label', 'B', '--token-file', tokenFile]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(await readFile(tokenFile, 'utf8')).toBe(before);
    expect((await (await rootStore()).read()).users).toHaveLength(1);
  });
});

describe('PERCH_USER selects a provisioned namespace for local administration', () => {
  it('onboards accounts and client grants into the selected user store only', async () => {
    const a = await addUser('Alice');
    const b = await addUser('Bob');
    expect((await cli(imapAdd('AliceMail'), { PERCH_USER: a.id })).code).toBe(0);
    expect((await cli(imapAdd('RootMail'))).code).toBe(0);

    const root = await rootStore();
    const ua = await openUserStore(root, a.id);
    const ub = await openUserStore(root, b.id);
    expect((await root.read()).imap.map((x) => x.label)).toEqual(['RootMail']);
    expect((await ua.read()).imap.map((x) => x.label)).toEqual(['AliceMail']);
    expect((await ub.read()).imap).toEqual([]);

    const userAccounts = await cli(['accounts'], { PERCH_USER: a.id });
    expect(userAccounts.out).toContain('AliceMail');
    expect(userAccounts.out).not.toContain('RootMail');
    const rootAccounts = await cli(['accounts']);
    expect(rootAccounts.out).toContain('RootMail');
    expect(rootAccounts.out).not.toContain('AliceMail');

    const aliceImap = (await ua.read()).imap[0]!.id;
    const grant = await cli(['client', 'add', '--label', 'Laptop', '--allow', 'read,send', '--account', aliceImap], { PERCH_USER: a.id });
    expect(grant.err).toBe('');
    expect(grant.code).toBe(0);
    expect((await ua.read()).clients).toHaveLength(1);
    expect((await root.read()).clients).toEqual([]);
    expect((await cli(['client', 'list'], { PERCH_USER: a.id })).out).toContain('Laptop');
    expect((await cli(['client', 'list'])).out).not.toContain('Laptop');
    expect((await cli(['client', 'list'], { PERCH_USER: b.id })).out).not.toContain('Laptop');
    // Bob cannot grant Alice's account id (it does not exist in Bob's namespace).
    const cross = await cli(['client', 'add', '--label', 'X', '--allow', 'read', '--account', aliceImap], { PERCH_USER: b.id });
    expect(cross.code).toBe(1);
    expect(cross.err).toMatch(/unknown mail account/i);
  });

  it('rejects malformed, unknown or empty selectors instead of falling back to root', async () => {
    const before = await readFile(storeFilePath(dirs.dataDir), 'utf8');
    for (const bad of ['', ' ', '../users/x', 'user-ABCDEF0123456789', 'root', 'user-0123456789abcdef']) {
      const r = await cli(imapAdd('Nope'), { PERCH_USER: bad });
      expect(r.code, JSON.stringify(bad)).not.toBe(0);
      expect(r.err).toMatch(/PERCH_USER|unknown user/i);
    }
    expect(await readFile(storeFilePath(dirs.dataDir), 'utf8')).toBe(before);
  });

  it('refuses admin-only and global commands in user mode', async () => {
    const a = await addUser('Alice');
    for (const args of [['user', 'add', '--label', 'Nested'], ['user', 'list'], ['user', 'remove', a.id], ['init'], ['token', 'rotate'], ['serve', '--http', '--port', '0']]) {
      const r = await cli(args, { PERCH_USER: a.id });
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.err).toMatch(/not available with PERCH_USER|root namespace/i);
    }
    expect((await (await rootStore()).read()).users).toHaveLength(1);
  });

  it('stdio refuses a client token file of another namespace before serving', async () => {
    const a = await addUser('Alice');
    const b = await addUser('Bob');
    await cli(imapAdd('AliceMail'), { PERCH_USER: a.id });
    const ua = await openUserStore(await rootStore(), a.id);
    const tokenFile = path.join(dirs.root, 'config', 'alice-client.token');
    expect((await cli(['client', 'add', '--label', 'L', '--allow', 'read', '--account', (await ua.read()).imap[0]!.id, '--token-file', tokenFile], { PERCH_USER: a.id })).code).toBe(0);
    for (const env of [{ PERCH_CLIENT_TOKEN_FILE: tokenFile }, { PERCH_USER: b.id, PERCH_CLIENT_TOKEN_FILE: tokenFile }] as Array<Record<string, string>>) {
      const r = await cli(['serve', '--stdio'], env);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/selected namespace/i);
    }
    // The user's own read-only token is not a client token either: use PERCH_USER for the user's read-only stdio.
    const userToken = path.join(path.dirname(dirs.tokenFile), 'users', `${a.id}.token`);
    const r = await cli(['serve', '--stdio'], { PERCH_CLIENT_TOKEN_FILE: userToken });
    expect(r.code).toBe(1);
  });
});
