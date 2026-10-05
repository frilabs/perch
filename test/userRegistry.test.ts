// Admin-provisioned users: local encrypted registry in the root store, physically separate per-user stores
// and keys, read-only user tokens stored only as hashes, no id reuse, cap, and fail-closed opening of
// missing/symlinked/corrupt namespaces (never re-initialised). Every secret here is generated dummy data.
import { createHash } from 'node:crypto';
import { readFile, rename, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PerchError } from '../src/errors.js';
import { pathExists } from '../src/secureFs.js';
import { encryptEnvelope, parseKey } from '../src/store/crypto.js';
import { CredentialStore, initStore, storeFilePath } from '../src/store/credentialStore.js';
import { addUser, listUsers, MAX_USERS, openUserStore, removeUser, userStorePaths } from '../src/users/registry.js';
import { dummySecret, makeTempDirs, rejection, type TempDirs } from './support/fixtures.js';

let dirs: TempDirs;
let root: CredentialStore;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const tokenFile = (name: string) => path.join(dirs.root, 'config', 'users', `${name}.token`);
const paths = () => ({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });

async function provision(label = 'Alice') {
  const file = tokenFile(`${label}-${Math.random().toString(16).slice(2)}`);
  const { user } = await addUser(root, { label, tokenFile: file });
  return { user, file, token: (await readFile(file, 'utf8')).trim() };
}

async function code(p: Promise<unknown>) {
  const err = await rejection(p);
  expect(err).toBeInstanceOf(PerchError);
  return (err as PerchError).code;
}

beforeEach(async () => {
  dirs = await makeTempDirs();
  await initStore(paths());
  root = await CredentialStore.open(paths());
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('user provisioning', () => {
  it('creates a separate store and key per user, outside the data dir; only the token hash is stored', async () => {
    const now = new Date().toISOString();
    await root.update((d) => {
      d.notion.push({ id: 'notion-0000000a', label: 'Root Notion', token: dummySecret('PAT'), createdAt: now, updatedAt: now });
    });
    const before = (await root.read()).notion;
    const { user, file, token } = await provision('Alice');

    expect(user.id).toMatch(/^user-[a-f0-9]{16}$/);
    expect(user).toMatchObject({ label: 'Alice', status: 'active', readTokenSha256: sha(token) });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const data = await root.read();
    expect(data.users).toEqual([user]);
    expect(JSON.stringify(data)).not.toContain(token);
    // Existing root accounts keep their ownership: nothing was moved or rewritten.
    expect(data.notion).toEqual(before);

    const p = userStorePaths(paths(), user.id);
    expect(p.dataDir).toBe(path.join(dirs.dataDir, 'users', user.id));
    expect(p.keyFile).toBe(path.join(path.dirname(dirs.keyFile), 'user-keys', `${user.id}.key`));
    expect(path.relative(dirs.dataDir, p.keyFile).startsWith('..')).toBe(true);
    expect((await stat(p.keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(p.dataDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(p.keyFile, 'utf8')).not.toBe(await readFile(dirs.keyFile, 'utf8'));

    const userStore = await openUserStore(root, user.id);
    expect(userStore.namespace).toBe(user.id);
    expect(root.namespace).toBe('root');
    const u = await userStore.read();
    expect([...u.google, ...u.notion, ...u.gmail, ...u.microsoft, ...u.imap, ...u.googleProductivity, ...u.clients, ...u.users]).toEqual([]);
  });

  it('removes membership without deleting key or store, never reuses ids, and enforces the cap', async () => {
    const a = await provision('Alice');
    const b = await provision('Bob');
    expect(a.user.id).not.toBe(b.user.id);

    const removed = await removeUser(root, a.user.id);
    expect(removed).toMatchObject({ id: a.user.id, status: 'removed' });
    expect(removed.removedAt).toBeTruthy();
    const p = userStorePaths(paths(), a.user.id);
    expect(await pathExists(p.keyFile)).toBe(true);
    expect(await pathExists(storeFilePath(p.dataDir))).toBe(true);
    expect(await code(openUserStore(root, a.user.id))).toBe('user_inactive');
    expect(await code(removeUser(root, a.user.id))).toBe('user_inactive');
    expect(await code(removeUser(root, 'user-0123456789abcdef'))).toBe('unknown_user');
    expect((await listUsers(root)).map((u) => [u.id, u.status])).toEqual([
      [a.user.id, 'removed'],
      [b.user.id, 'active'],
    ]);
    const c = await provision('Alice');
    expect([a.user.id, b.user.id]).not.toContain(c.user.id);

    // The cap counts every registry entry (removed users keep their id forever).
    expect(MAX_USERS).toBe(100);
    await root.update((d) => {
      for (let i = d.users.length; i < MAX_USERS; i++) {
        d.users.push({ id: `user-${i.toString(16).padStart(16, '0')}`, label: `Filler ${i}`, status: 'removed', readTokenSha256: sha(`x${i}`), createdAt: '2026-10-05T00:00:00.000Z', removedAt: '2026-10-05T00:00:00.000Z' });
      }
    });
    expect(await code(addUser(root, { label: 'One too many', tokenFile: tokenFile('cap') }))).toBe('user_limit');
    expect(await pathExists(tokenFile('cap'))).toBe(false);
  });

  it('refuses to overwrite an existing token file and leaves the registry unchanged', async () => {
    await mkdir(path.dirname(tokenFile('exists')), { recursive: true, mode: 0o700 });
    await writeFile(tokenFile('exists'), 'keep me\n', { mode: 0o600 });
    expect(await code(addUser(root, { label: 'Alice', tokenFile: tokenFile('exists') }))).toBe('file_exists');
    expect(await readFile(tokenFile('exists'), 'utf8')).toBe('keep me\n');
    expect((await root.read()).users).toEqual([]);
  });

  it('refuses user administration inside a user namespace and user stores that carry a registry', async () => {
    const a = await provision('Alice');
    const userStore = await openUserStore(root, a.user.id);
    expect(await code(addUser(userStore, { label: 'Nested', tokenFile: tokenFile('nested') }))).toBe('not_root_namespace');
    expect(await code(removeUser(userStore, a.user.id))).toBe('not_root_namespace');
    expect(await code(listUsers(userStore))).toBe('not_root_namespace');
    expect(await code(openUserStore(userStore, a.user.id))).toBe('not_root_namespace');
    await userStore.update((d) => {
      d.users.push({ ...a.user });
    });
    expect(await code(openUserStore(root, a.user.id))).toBe('store_schema');
  });

  it('rejects malformed user ids (traversal, wrong shape) before touching the filesystem', async () => {
    for (const bad of ['../x', 'user-../../etc', 'user-ABCDEF0123456789', 'user-0123', 'user-0123456789abcdef/..', '', 'root']) {
      expect(() => userStorePaths(paths(), bad)).toThrow(/user id/i);
      expect(await code(openUserStore(root, bad))).toBe('bad_user');
    }
  });
});

describe('opening a user namespace fails closed and never re-initialises', () => {
  async function corruptCase(mutate: (p: { dataDir: string; keyFile: string }) => Promise<void>) {
    const a = await provision('Alice');
    const p = userStorePaths(paths(), a.user.id);
    await mutate(p);
    return { a, p };
  }

  it('missing key', async () => {
    const { a, p } = await corruptCase((p) => rm(p.keyFile));
    expect(await code(openUserStore(root, a.user.id))).toBe('key_missing');
    expect(await pathExists(p.keyFile)).toBe(false);
  });

  it('missing store', async () => {
    const { a, p } = await corruptCase((p) => rm(storeFilePath(p.dataDir)));
    expect(await code(openUserStore(root, a.user.id))).toBe('not_initialised');
    expect(await pathExists(storeFilePath(p.dataDir))).toBe(false);
  });

  it('missing namespace directory', async () => {
    const { a, p } = await corruptCase((p) => rm(p.dataDir, { recursive: true }));
    expect(['not_initialised', 'insecure_path']).toContain(await code(openUserStore(root, a.user.id)));
    expect(await pathExists(p.dataDir)).toBe(false);
  });

  it('corrupt store', async () => {
    let original = '';
    const { a, p } = await corruptCase(async (p) => {
      original = await readFile(storeFilePath(p.dataDir), 'utf8');
      const env = JSON.parse(original);
      env.ct = Buffer.from('tampered').toString('base64');
      await writeFile(storeFilePath(p.dataDir), JSON.stringify(env), { mode: 0o600 });
    });
    await rejection(openUserStore(root, a.user.id));
    expect(await readFile(storeFilePath(p.dataDir), 'utf8')).not.toBe(original);
    expect(JSON.parse(await readFile(storeFilePath(p.dataDir), 'utf8')).ct).toBe(Buffer.from('tampered').toString('base64'));
  });

  it('another user key (wrong key)', async () => {
    const b = await provision('Bob');
    const { a } = await corruptCase(async (p) => {
      await rm(p.keyFile);
      await writeFile(p.keyFile, await readFile(userStorePaths(paths(), b.user.id).keyFile), { mode: 0o600 });
    });
    await rejection(openUserStore(root, a.user.id));
  });

  it('symlinked key file', async () => {
    const { a } = await corruptCase(async (p) => {
      await rename(p.keyFile, `${p.keyFile}.real`);
      await symlink(`${p.keyFile}.real`, p.keyFile);
    });
    expect(await code(openUserStore(root, a.user.id))).toBe('insecure_path');
  });

  it('symlinked namespace directory', async () => {
    const { a } = await corruptCase(async (p) => {
      await rename(p.dataDir, `${p.dataDir}.real`);
      await symlink(`${p.dataDir}.real`, p.dataDir);
    });
    expect(await code(openUserStore(root, a.user.id))).toBe('insecure_path');
  });

  it('symlinked users parent directory', async () => {
    const { a } = await corruptCase(async () => {
      const users = path.join(dirs.dataDir, 'users');
      await rename(users, `${users}.real`);
      await symlink(`${users}.real`, users);
    });
    expect(await code(openUserStore(root, a.user.id))).toBe('insecure_path');
  });

  it('symlinked user-keys directory', async () => {
    const { a } = await corruptCase(async (p) => {
      const keys = path.dirname(p.keyFile);
      await rename(keys, `${keys}.real`);
      await symlink(`${keys}.real`, keys);
    });
    expect(await code(openUserStore(root, a.user.id))).toBe('insecure_path');
  });

  it('a registry entry for a namespace that was never created', async () => {
    await root.update((d) => {
      d.users.push({ id: 'user-00000000000000ff', label: 'Ghost', status: 'active', readTokenSha256: sha('ghost'), createdAt: '2026-10-05T00:00:00.000Z' });
    });
    await rejection(openUserStore(root, 'user-00000000000000ff'));
    expect(await pathExists(path.join(dirs.dataDir, 'users', 'user-00000000000000ff'))).toBe(false);
    expect(await pathExists(userStorePaths(paths(), 'user-00000000000000ff').keyFile)).toBe(false);
  });
});

describe('root store compatibility', () => {
  it('opens a store written before the registry existed without rewriting it', async () => {
    const key = parseKey(await readFile(dirs.keyFile));
    const legacy = { version: 1, google: [], notion: [], gmail: [], microsoft: [], imap: [], clients: [], googleProductivity: [] };
    await writeFile(storeFilePath(dirs.dataDir), encryptEnvelope(key, Buffer.from(JSON.stringify(legacy))), { mode: 0o600 });
    const before = await readFile(storeFilePath(dirs.dataDir), 'utf8');
    const s = await CredentialStore.open(paths());
    expect((await s.read()).users).toEqual([]);
    expect(await readFile(storeFilePath(dirs.dataDir), 'utf8')).toBe(before);
  });

  it('refuses an unknown store version instead of overwriting it', async () => {
    const key = parseKey(await readFile(dirs.keyFile));
    await writeFile(storeFilePath(dirs.dataDir), encryptEnvelope(key, Buffer.from(JSON.stringify({ version: 2, users: [] }))), { mode: 0o600 });
    const before = await readFile(storeFilePath(dirs.dataDir), 'utf8');
    expect(await code(CredentialStore.open(paths()))).toBe('store_schema');
    expect(await code(addUser(root, { label: 'Alice', tokenFile: tokenFile('v2') }))).toBe('store_schema');
    expect(await readFile(storeFilePath(dirs.dataDir), 'utf8')).toBe(before);
  });
});
