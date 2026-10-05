import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { createLedgerFile } from '../mail/workflowLedger.js';
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

/** Gmail grant (separate OAuth consent from Drive; default gmail.readonly, opt-in send/compose). */
const GmailAccountSchema = z.object({
  id: z.string().regex(/^gmail-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  email: z.string().min(3),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Microsoft Graph delegated grant (public client, PKCE; no client secret). */
const MicrosoftAccountSchema = z.object({
  id: z.string().regex(/^microsoft-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  email: z.string().min(3),
  displayName: z.string().optional(),
  tenant: z.string().min(1).max(100),
  clientId: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const HostPortSchema = z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) });

/** Generic IMAP (implicit TLS) + SMTP account, e.g. GMX. The password is stored encrypted like every other secret. */
const ImapAccountSchema = z.object({
  id: z.string().regex(/^imap-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  email: z.string().min(3),
  username: z.string().min(1),
  password: z.string().min(1),
  preset: z.string().optional(),
  imap: HostPortSchema,
  smtp: HostPortSchema.extend({ security: z.enum(['tls', 'starttls']) }),
  /** IMAP has no OAuth scopes: drafts/send are explicit opt-ins recorded at onboarding. */
  allowDrafts: z.boolean(),
  allowSend: z.boolean(),
  draftsMailbox: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Google Calendar/Contacts grant (separate OAuth consent from Drive and Gmail). `services` and
 * `allowCalendarWrite` record what was requested at onboarding; `scopes` what Google actually granted.
 * Both must agree before a tool runs (see src/google/productivity.ts).
 */
const GoogleProductivityAccountSchema = z.object({
  id: z.string().regex(/^gprod-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  email: z.string().min(3).max(320),
  /** OpenID Connect subject: stable Google account id, used to detect duplicate grants. */
  sub: z.string().min(1).max(255),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  scopes: z.array(z.string()),
  services: z.array(z.enum(['calendar', 'contacts'])).min(1),
  allowCalendarWrite: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Mail capabilities (email milestone) apply to mail accounts only. */
export const MAIL_CAPABILITIES = ['read', 'draft', 'send'] as const;
/** Calendar/Contacts capabilities apply to Google productivity accounts (gprod-…) only. */
export const PRODUCTIVITY_CAPABILITIES = ['calendar_read', 'calendar_write', 'contacts_read'] as const;
export const CAPABILITIES = [...MAIL_CAPABILITIES, ...PRODUCTIVITY_CAPABILITIES] as const;

/** Local per-client grant. Only the SHA-256 of the (high-entropy) client token is stored. */
const ClientGrantSchema = z.object({
  id: z.string().regex(/^client-[a-f0-9]{8}$/),
  label: z.string().min(1).max(100),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
  accountIds: z.array(z.string()).min(1),
  createdAt: z.string(),
});

/** Upper bound on registry entries (active and removed: ids are never reused, entries never deleted). */
export const MAX_USERS = 100;
export const USER_ID_PATTERN = /^user-[a-f0-9]{16}$/;
/** Namespace of the legacy store at the configured data dir: the local operator. */
export const ROOT_NAMESPACE = 'root';

/**
 * Admin-provisioned user (root store only). The user's credentials live in a physically separate store
 * and key (see src/users/registry.ts); the registry holds membership and the SHA-256 of the user's
 * read-only token, never the token.
 */
const UserSchema = z.object({
  id: z.string().regex(USER_ID_PATTERN),
  label: z.string().min(1).max(100),
  status: z.enum(['active', 'removed']),
  readTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  removedAt: z.string().optional(),
});

const StoreDataSchema = z.object({
  version: z.literal(1),
  google: z.array(GoogleAccountSchema),
  notion: z.array(NotionWorkspaceSchema),
  // Added by the email milestone; stores written earlier have no such keys.
  gmail: z.array(GmailAccountSchema).default([]),
  microsoft: z.array(MicrosoftAccountSchema).default([]),
  imap: z.array(ImapAccountSchema).default([]),
  clients: z.array(ClientGrantSchema).default([]),
  // Added by the Google productivity milestone.
  googleProductivity: z.array(GoogleProductivityAccountSchema).default([]),
  // Added by the user-isolation milestone (root store only; must stay empty in user stores).
  users: z
    .array(UserSchema)
    .max(MAX_USERS)
    .default([])
    .refine((users) => new Set(users.map((u) => u.id)).size === users.length, 'duplicate user id'),
  // Added by the mail workflow milestone: set once this namespace's mail-workflow.enc exists. A missing
  // ledger with this marker was lost (restore from backup); it is never initialised again.
  mailWorkflowLedger: z.strictObject({ createdAt: z.string() }).optional(),
});

export type GoogleAccount = z.infer<typeof GoogleAccountSchema>;
export type NotionWorkspace = z.infer<typeof NotionWorkspaceSchema>;
export type GmailAccount = z.infer<typeof GmailAccountSchema>;
export type MicrosoftAccount = z.infer<typeof MicrosoftAccountSchema>;
export type ImapAccount = z.infer<typeof ImapAccountSchema>;
export type GoogleProductivityAccount = z.infer<typeof GoogleProductivityAccountSchema>;
export type ClientGrant = z.infer<typeof ClientGrantSchema>;
export type UserRecord = z.infer<typeof UserSchema>;
export type Capability = (typeof CAPABILITIES)[number];
export type MailCapability = (typeof MAIL_CAPABILITIES)[number];
export type ProductivityCapability = (typeof PRODUCTIVITY_CAPABILITIES)[number];
export type StoreData = z.infer<typeof StoreDataSchema>;

export interface StorePaths {
  dataDir: string;
  keyFile: string;
}

export const storeFilePath = (dataDir: string) => path.join(dataDir, 'store.enc');
const lockFilePath = (dataDir: string) => path.join(dataDir, 'store.lock');

const emptyData = (): StoreData => ({
  version: 1,
  google: [],
  notion: [],
  gmail: [],
  microsoft: [],
  imap: [],
  clients: [],
  googleProductivity: [],
  users: [],
  // initStore creates the ledger before the store, so a new store is born with it.
  mailWorkflowLedger: { createdAt: new Date().toISOString() },
});

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

/** True if `inner` is `outer` or lies below it (after resolving symlinked ancestors). */
export async function isWithin(outer: string, inner: string): Promise<boolean> {
  const rel = path.relative(await realpathOrResolve(outer), await realpathOrResolve(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function assertKeyOutsideDataDir(paths: StorePaths): Promise<void> {
  if (await isWithin(paths.dataDir, paths.keyFile)) {
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
 * A newly created store also gets its empty mail workflow ledger (`mail-workflow.enc`, bound to
 * `opts.namespace`, default root). An existing store never gets a ledger implicitly: a missing ledger
 * next to an existing store fails closed until restored or explicitly initialised.
 */
export async function initStore(paths: StorePaths, opts: { namespace?: string } = {}): Promise<{ createdKey: boolean; createdStore: boolean }> {
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
      // Ledger first: a store without its ledger would make every audited call fail closed.
      await createLedgerFile(paths.dataDir, key, opts.namespace ?? ROOT_NAMESPACE);
      createdStore = await writePrivateFileExclusive(storeFile, serialise(key, emptyData()));
      if (!createdStore) parseData(decryptEnvelope(key, (await readPrivateFile(storeFile)).toString('utf8')));
    }
    return { createdKey, createdStore };
  });
}

/**
 * Opaque pagination cursors are sealed with a MAC keyed per store (namespace): a cursor issued by one
 * namespace, or for another query kind/account/parent, or edited by the caller, is rejected before any
 * provider request. Format: base64url(payload) "~" base64url(HMAC-SHA256 truncated to 128 bits).
 */
export interface CursorSeal {
  sealCursor(kind: string, payload: string): string;
  openCursor(kind: string, cursor: string): string;
}

const CURSOR_MAC_CHARS = 22;
const badCursor = () => new PerchError('Invalid cursor: it does not belong to this query, account or connection; repeat the same arguments', 'bad_cursor');

interface CacheStamp {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export class CredentialStore implements CursorSeal {
  private cache: { stamp: CacheStamp; data: StoreData } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cursorKey: Buffer;

  private constructor(
    private readonly paths: StorePaths,
    private readonly key: Buffer,
    /** 'root' for the operator store, otherwise the owning user id. Never derived from caller input. */
    readonly namespace: string,
  ) {
    this.cursorKey = createHmac('sha256', key).update(`perch-cursor-v1\u0000${namespace}`).digest();
  }

  get storePaths(): StorePaths {
    return { ...this.paths };
  }

  /**
   * Opens an initialised store. Never creates keys or files. `namespace` is set by the caller that chose
   * the paths (root for the configured store, the user id for a provisioned user's store).
   */
  static async open(paths: StorePaths, opts: { namespace?: string } = {}): Promise<CredentialStore> {
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
    const store = new CredentialStore(paths, parseKey(await readPrivateFile(paths.keyFile)), opts.namespace ?? ROOT_NAMESPACE);
    await store.read();
    return store;
  }

  /** Fails closed if the key file was removed, replaced or made insecure since the store was opened. */
  async assertKeyUnchanged(): Promise<void> {
    let current: Buffer;
    try {
      current = parseKey(await readPrivateFile(this.paths.keyFile));
    } catch (err) {
      if (err instanceof PerchError && err.code === 'not_found') {
        throw new PerchError(`Key file is missing (${this.paths.keyFile}). Restore the key from backup.`, 'key_missing');
      }
      throw err;
    }
    if (current.length !== this.key.length || !timingSafeEqual(current, this.key)) {
      throw new PerchError(`Key file ${this.paths.keyFile} changed since the store was opened; refusing to continue`, 'wrong_key');
    }
  }

  private cursorMac(kind: string, body: string): string {
    return createHmac('sha256', this.cursorKey).update(`${kind}\u0000${body}`).digest('base64url').slice(0, CURSOR_MAC_CHARS);
  }

  sealCursor(kind: string, payload: string): string {
    const body = Buffer.from(payload, 'utf8').toString('base64url');
    return `${body}~${this.cursorMac(kind, body)}`;
  }

  openCursor(kind: string, cursor: string): string {
    const m = /^([A-Za-z0-9_-]{1,32768})~([A-Za-z0-9_-]{22})$/.exec(cursor);
    if (!m) throw badCursor();
    const expected = Buffer.from(this.cursorMac(kind, m[1]!));
    if (!timingSafeEqual(expected, Buffer.from(m[2]!))) throw badCursor();
    return Buffer.from(m[1]!, 'base64url').toString('utf8');
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
