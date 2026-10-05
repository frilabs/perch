import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PerchError } from '../errors.js';
import {
  ensurePrivateDir,
  pathExists,
  readPrivateFile,
  writePrivateFileAtomic,
  writePrivateFileExclusive,
} from '../secureFs.js';
import { decryptEnvelope, encryptEnvelope, generateKeyFileContents, parseKey } from './crypto.js';
import { withFileLock } from './lock.js';

const GoogleAccountSchema = z.object({
  id: z.string().regex(/^google-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  email: z.string().min(3),
  displayName: z.string().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const NotionWorkspaceSchema = z.object({
  id: z.string().regex(/^notion-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  token: z.string().min(1),
  tokenOwner: z
    .object({ id: z.string(), name: z.string().optional(), type: z.string().optional() })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const StoreDataSchema = z.object({
  version: z.literal(1),
  google: z.array(GoogleAccountSchema),
  notion: z.array(NotionWorkspaceSchema),
});

export type GoogleAccount = z.infer<typeof GoogleAccountSchema>;
export type NotionWorkspace = z.infer<typeof NotionWorkspaceSchema>;
export type StoreData = z.infer<typeof StoreDataSchema>;

export interface StorePaths {
  dataDir: string;
  keyFile: string;
}

export const storeFilePath = (dataDir: string) => path.join(dataDir, 'store.enc');
const lockFilePath = (dataDir: string) => path.join(dataDir, 'store.lock');

const emptyData = (): StoreData => ({ version: 1, google: [], notion: [] });

async function realpathOrResolve(p: string): Promise<string> {
  // Resolve the deepest existing ancestor so symlinked parents cannot hide containment.
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(await realpath(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

async function assertKeyOutsideDataDir(paths: StorePaths): Promise<void> {
  const data = await realpathOrResolve(paths.dataDir);
  const key = await realpathOrResolve(paths.keyFile);
  const rel = path.relative(data, key);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new PerchError('The key file must live outside the data directory (set PERCH_KEY_FILE)', 'insecure_path');
  }
}

function parseData(plain: Buffer): StoreData {
  const parsed = StoreDataSchema.safeParse(JSON.parse(plain.toString('utf8')));
  if (!parsed.success) throw new PerchError('Credential store content does not match the expected schema', 'store_schema');
  return parsed.data;
}

function serialise(key: Buffer, data: StoreData): Buffer {
  const parsed = StoreDataSchema.safeParse(data);
  if (!parsed.success) throw new PerchError('Refusing to write data that does not match the store schema', 'store_schema');
  return Buffer.from(encryptEnvelope(key, Buffer.from(JSON.stringify(parsed.data))));
}

/**
 * Explicit initialisation (`perch init`). Creates whatever is missing, but never generates
 * a new key when an encrypted store already exists (that would orphan the stored credentials).
 */
export async function initStore(paths: StorePaths): Promise<{ createdKey: boolean; createdStore: boolean }> {
  await assertKeyOutsideDataDir(paths);
  await ensurePrivateDir(paths.dataDir);
  await ensurePrivateDir(path.dirname(paths.keyFile));
  const storeFile = storeFilePath(paths.dataDir);
  // The whole check-and-create runs under the store lock; key and store are additionally
  // created with no-overwrite semantics, so concurrent inits always agree on one key.
  return withFileLock(lockFilePath(paths.dataDir), async () => {
    const hasStore = await pathExists(storeFile);
    if (hasStore && !(await pathExists(paths.keyFile))) {
      throw new PerchError(
        `Key file is missing (${paths.keyFile}) but an encrypted store exists. Restore the key from backup; ` +
          'Perch will not generate a new key over existing data.',
        'key_missing',
      );
    }
    const createdKey = hasStore ? false : await writePrivateFileExclusive(paths.keyFile, generateKeyFileContents());
    const key = parseKey(await readPrivateFile(paths.keyFile));
    let createdStore = false;
    if (hasStore) {
      parseData(decryptEnvelope(key, (await readPrivateFile(storeFile)).toString('utf8')));
    } else {
      createdStore = await writePrivateFileExclusive(storeFile, serialise(key, emptyData()));
      if (!createdStore) parseData(decryptEnvelope(key, (await readPrivateFile(storeFile)).toString('utf8')));
    }
    return { createdKey, createdStore };
  });
}

interface CacheStamp {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export class CredentialStore {
  private cache: { stamp: CacheStamp; data: StoreData } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly paths: StorePaths,
    private readonly key: Buffer,
  ) {}

  /** Opens an initialised store. Never creates keys or files. */
  static async open(paths: StorePaths): Promise<CredentialStore> {
    await assertKeyOutsideDataDir(paths);
    const storeFile = storeFilePath(paths.dataDir);
    const hasStore = await pathExists(storeFile);
    const hasKey = await pathExists(paths.keyFile);
    if (hasStore && !hasKey) {
      throw new PerchError(
        `Key file is missing (${paths.keyFile}) but an encrypted store exists. Restore the key from backup.`,
        'key_missing',
      );
    }
    if (!hasStore || !hasKey) throw new PerchError('Perch is not initialised. Run: perch init', 'not_initialised');
    const dirStat = await lstat(paths.dataDir);
    if (dirStat.isSymbolicLink()) throw new PerchError(`Refusing symlinked directory: ${paths.dataDir}`, 'insecure_path');
    const store = new CredentialStore(paths, parseKey(await readPrivateFile(paths.keyFile)));
    await store.read();
    return store;
  }

  /** Returns current data, re-decrypting only when the file on disk changed. */
  async read(): Promise<StoreData> {
    const file = storeFilePath(this.paths.dataDir);
    let st;
    try {
      st = await lstat(file);
    } catch {
      throw new PerchError('Credential store file disappeared. Run: perch init', 'not_initialised');
    }
    const stamp: CacheStamp = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    const c = this.cache;
    if (
      c &&
      c.stamp.ino === stamp.ino &&
      c.stamp.size === stamp.size &&
      c.stamp.mtimeMs === stamp.mtimeMs &&
      c.stamp.ctimeMs === stamp.ctimeMs
    ) {
      return structuredClone(c.data);
    }
    const data = parseData(decryptEnvelope(this.key, (await readPrivateFile(file)).toString('utf8')));
    this.cache = { stamp, data };
    return structuredClone(data);
  }

  /** Read-modify-write under an in-process queue and a cross-process file lock. */
  update<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    const run = async () =>
      withFileLock(lockFilePath(this.paths.dataDir), async () => {
        this.cache = null;
        const data = await this.read();
        const result = await mutate(data);
        await writePrivateFileAtomic(storeFilePath(this.paths.dataDir), serialise(this.key, data));
        this.cache = null;
        return result;
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
