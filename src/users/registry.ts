import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tokenSha256 } from '../auth/grants.js';
import { PerchError } from '../errors.js';
import { validateLabel } from '../ids.js';
import { assertPrivateDir, ensurePrivateDir, pathExists, writePrivateFileExclusive } from '../secureFs.js';
import {
  CredentialStore,
  initStore,
  isWithin,
  MAX_USERS,
  ROOT_NAMESPACE,
  USER_ID_PATTERN,
  type StorePaths,
  type UserRecord,
} from '../store/credentialStore.js';

export { MAX_USERS, USER_ID_PATTERN };

/**
 * Admin-provisioned users (local CLI only). Each user owns a physically separate encrypted store under
 * `<dataDir>/users/<id>/` and a separate key at `<dir of PERCH_KEY_FILE>/user-keys/<id>.key`, outside the
 * data dir. Both paths are derived only from a generated id that passed USER_ID_PATTERN, never from caller
 * input. The root store keeps the registry: membership status and the SHA-256 of each user's read-only
 * token. Removal disables membership; it never deletes keys or stores, and ids are never reused.
 *
 * The local admin (whoever can read the root key and the user keys on this host) can read every
 * namespace: this is a privileged boundary by design, not protection from the host administrator.
 */

const USERS_DIR = 'users';
const USER_KEYS_DIR = 'user-keys';

function assertUserId(id: string): string {
  if (typeof id !== 'string' || !USER_ID_PATTERN.test(id)) throw new PerchError('Invalid user id (expected user-<16 hex>)', 'bad_user');
  return id;
}

function assertRoot(store: CredentialStore): void {
  if (store.namespace !== ROOT_NAMESPACE) {
    throw new PerchError('User administration is only available to the local admin in the root namespace (unset PERCH_USER)', 'not_root_namespace');
  }
}

/** Store paths of a provisioned user, derived from the root paths and a validated generated id. */
export function userStorePaths(root: StorePaths, userId: string): StorePaths {
  const id = assertUserId(userId);
  return {
    dataDir: path.join(root.dataDir, USERS_DIR, id),
    keyFile: path.join(path.dirname(root.keyFile), USER_KEYS_DIR, `${id}.key`),
  };
}

function newUserId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (;;) {
    const id = `user-${randomBytes(8).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

/** Throws unless `userId` is a registered, active user. Always reads the current registry. */
export async function assertActiveUser(root: CredentialStore, userId: string): Promise<UserRecord> {
  assertRoot(root);
  assertUserId(userId);
  const user = (await root.read()).users.find((u) => u.id === userId);
  if (!user) throw new PerchError(`Unknown user: ${userId}`, 'unknown_user');
  if (user.status !== 'active') {
    throw new PerchError('This user was removed or disabled by the admin; no request was made', 'user_inactive');
  }
  return user;
}

export async function listUsers(root: CredentialStore): Promise<UserRecord[]> {
  assertRoot(root);
  return (await root.read()).users;
}

/**
 * Provisions a user: generates the id, creates the user's key and empty store (no-overwrite), writes a new
 * high-entropy read-only token once to a new 0600 file, and records only its hash. Everything runs under the
 * root store lock, so concurrent adds never share an id or exceed the cap.
 */
export async function addUser(
  root: CredentialStore,
  input: { label: string; tokenFile: string | ((userId: string) => string) },
): Promise<{ user: UserRecord; tokenFile: string }> {
  assertRoot(root);
  const label = validateLabel(input.label);
  const rootPaths = root.storePaths;
  let tokenFile = '';
  const user = await root.update(async (data) => {
    if (data.users.length >= MAX_USERS) {
      throw new PerchError(`User limit reached (${MAX_USERS} registry entries, removed users included)`, 'user_limit');
    }
    const id = newUserId(data.users.map((u) => u.id));
    const paths = userStorePaths(rootPaths, id);
    if ((await pathExists(paths.dataDir)) || (await pathExists(paths.keyFile))) {
      throw new PerchError(`Refusing to reuse existing namespace files for ${id}`, 'namespace_exists');
    }
    if (await isWithin(rootPaths.dataDir, paths.keyFile)) throw new PerchError('User keys must live outside the data directory', 'insecure_path');
    tokenFile = path.resolve(typeof input.tokenFile === 'function' ? input.tokenFile(id) : input.tokenFile);
    if (await isWithin(rootPaths.dataDir, tokenFile)) throw new PerchError('The user token file must live outside the data directory', 'insecure_path');
    const token = randomBytes(32).toString('base64url');
    await ensurePrivateDir(path.dirname(tokenFile));
    if (!(await writePrivateFileExclusive(tokenFile, Buffer.from(`${token}\n`)))) {
      throw new PerchError(`Token file ${tokenFile} already exists; choose another path`, 'file_exists');
    }
    await ensurePrivateDir(path.join(rootPaths.dataDir, USERS_DIR));
    await ensurePrivateDir(path.dirname(paths.keyFile));
    const created = await initStore(paths);
    if (!created.createdKey || !created.createdStore) throw new PerchError(`Namespace files for ${id} appeared concurrently`, 'namespace_exists');
    const record: UserRecord = { id, label, status: 'active', readTokenSha256: tokenSha256(token), createdAt: new Date().toISOString() };
    data.users.push(record);
    return record;
  });
  return { user, tokenFile };
}

/** Disables membership (all of the user's tokens and client grants stop resolving). Keeps key and store. */
export async function removeUser(root: CredentialStore, userId: string): Promise<UserRecord> {
  assertRoot(root);
  assertUserId(userId);
  return root.update((data) => {
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new PerchError(`Unknown user: ${userId}`, 'unknown_user');
    if (user.status !== 'active') throw new PerchError(`User ${userId} is already removed`, 'user_inactive');
    user.status = 'removed';
    user.removedAt = new Date().toISOString();
    return { ...user };
  });
}

/**
 * Path invariants of a user namespace: private, non-symlinked users/, store and key directories, the store
 * inside users/ and the key outside the data dir. Checked on open and again before every use of a cached
 * namespace. Never creates anything.
 */
export async function assertUserPaths(root: CredentialStore, userId: string): Promise<StorePaths> {
  assertRoot(root);
  const rootPaths = root.storePaths;
  const paths = userStorePaths(rootPaths, userId);
  await assertPrivateDir(path.join(rootPaths.dataDir, USERS_DIR));
  await assertPrivateDir(paths.dataDir);
  await assertPrivateDir(path.dirname(paths.keyFile));
  if (!(await isWithin(path.join(rootPaths.dataDir, USERS_DIR), paths.dataDir)) || (await isWithin(rootPaths.dataDir, paths.keyFile))) {
    throw new PerchError(`Namespace paths of ${userId} escape their directories`, 'insecure_path');
  }
  return paths;
}

/**
 * Opens an active user's store. Never creates anything: a missing, symlinked, foreign or corrupt directory,
 * key or store fails closed (the admin restores from backup or removes the user).
 */
export async function openUserStore(root: CredentialStore, userId: string): Promise<CredentialStore> {
  assertRoot(root);
  assertUserId(userId);
  await assertActiveUser(root, userId);
  const paths = await assertUserPaths(root, userId);
  const store = await CredentialStore.open(paths, { namespace: userId });
  if ((await store.read()).users.length) {
    throw new PerchError(`The store of ${userId} contains a user registry; user stores must not`, 'store_schema');
  }
  return store;
}
