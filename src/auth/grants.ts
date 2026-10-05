import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { ensurePrivateDir, writePrivateFileExclusive } from '../secureFs.js';
import {
  CAPABILITIES,
  MAIL_CAPABILITIES,
  PRODUCTIVITY_CAPABILITIES,
  type Capability,
  type ClientGrant,
  type CredentialStore,
  type ProductivityCapability,
  type StoreData,
} from '../store/credentialStore.js';

/**
 * Who is calling the MCP server. The global HTTP bearer token (and plain stdio) map to the
 * single operator in READ-ONLY mode. Draft/send and calendar writes are only ever available through
 * an explicit local client grant, and only for the accounts listed in that grant. Mail capabilities
 * apply to mail accounts only; calendar/contacts capabilities to Google productivity accounts only.
 *
 * A principal always acts inside ONE namespace (the store it was resolved from): grants narrow what a
 * client may do there. Separation between users is the namespace model (src/users/): every user has
 * its own store, key and context, and tokens resolve to exactly one namespace.
 */
export interface Principal {
  kind: 'operator_readonly' | 'client';
  clientId?: string;
  clientLabel?: string;
  /** SHA-256 of the client token (never the token); used to re-resolve the grant on every tool call. */
  tokenSha256?: string;
  capabilities: ReadonlySet<Capability>;
  /** Mail accounts this principal may use; 'all' only for the read-only operator principal. */
  mailAccounts: ReadonlySet<string> | 'all';
  /** Google productivity (Calendar/Contacts) accounts; 'all' only for the read-only operator. */
  productivityAccounts: ReadonlySet<string> | 'all';
}

export const READONLY_PRINCIPAL: Principal = Object.freeze({
  kind: 'operator_readonly',
  capabilities: new Set<Capability>(['read', 'calendar_read', 'contacts_read']),
  mailAccounts: 'all',
  productivityAccounts: 'all',
}) as Principal;

const PRODUCTIVITY_PREFIX = 'gprod-';
export const isProductivityAccountId = (id: string) => id.startsWith(PRODUCTIVITY_PREFIX);
const isMailCap = (c: Capability) => (MAIL_CAPABILITIES as readonly string[]).includes(c);
const isProductivityCap = (c: Capability) => (PRODUCTIVITY_CAPABILITIES as readonly string[]).includes(c);

export const tokenSha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function mailAccountIds(data: StoreData): string[] {
  return [...data.gmail, ...data.microsoft, ...data.imap].map((a) => a.id);
}

export function productivityAccountIds(data: StoreData): string[] {
  return data.googleProductivity.map((a) => a.id);
}

export function principalFromGrant(grant: ClientGrant): Principal {
  return {
    kind: 'client',
    clientId: grant.id,
    clientLabel: grant.label,
    tokenSha256: grant.tokenSha256,
    capabilities: new Set(grant.capabilities),
    mailAccounts: new Set(grant.accountIds.filter((id) => !isProductivityAccountId(id))),
    productivityAccounts: new Set(grant.accountIds.filter(isProductivityAccountId)),
  };
}

export function hasWriteCapability(p: Principal): boolean {
  return p.capabilities.has('draft') || p.capabilities.has('send');
}

export function hasMailCapability(p: Principal): boolean {
  return [...p.capabilities].some(isMailCap);
}

export function hasProductivityCapability(p: Principal): boolean {
  return [...p.capabilities].some(isProductivityCap);
}

/** Throws unless the principal holds `cap` for the Google productivity account `accountId`. */
export function assertProductivityCapability(p: Principal, accountId: string, cap: ProductivityCapability): void {
  if (p.kind === 'operator_readonly' && cap === 'calendar_write') {
    throw new PerchError(
      'This connection is read-only (global token or default stdio). Calendar writes need a client grant: perch client add --allow calendar_write',
      'capability_denied',
    );
  }
  const accountOk = p.productivityAccounts === 'all' || p.productivityAccounts.has(accountId);
  if (!p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for account ${accountId}`, 'capability_denied');
  }
}

/** Throws unless the principal holds `cap` for `accountId`. Provider scopes are checked separately. */
export function assertMailCapability(p: Principal, accountId: string, cap: Capability): void {
  if (p.kind === 'operator_readonly' && cap !== 'read') {
    throw new PerchError(
      `This connection is read-only (global token or default stdio). ${cap} needs a client grant: perch client add`,
      'capability_denied',
    );
  }
  const accountOk = p.mailAccounts === 'all' || p.mailAccounts.has(accountId);
  if (!isMailCap(cap) || !p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for account ${accountId}`, 'capability_denied');
  }
}

export function parseCapabilities(list: string[]): Capability[] {
  const caps = [...new Set(list.map((c) => c.trim()).filter(Boolean))];
  for (const c of caps) {
    if (!(CAPABILITIES as readonly string[]).includes(c)) throw new PerchError(`Unknown capability: ${c} (use ${CAPABILITIES.join(', ')})`, 'bad_argument');
  }
  return caps as Capability[];
}

/**
 * Creates a client grant. The random token is written once to a new 0600 file (never printed,
 * never overwritten); the store keeps only its SHA-256.
 */
export async function createClientGrant(
  store: CredentialStore,
  input: { label: string; capabilities: Capability[]; accountIds: string[]; tokenFile: string },
): Promise<{ client: ClientGrant; token: string }> {
  const label = validateLabel(input.label);
  const capabilities = parseCapabilities(input.capabilities);
  if (!capabilities.length) throw new PerchError(`A client grant needs at least one capability (${CAPABILITIES.join(', ')})`, 'bad_argument');
  const accountIds = [...new Set(input.accountIds)];
  if (!accountIds.length) throw new PerchError('A client grant needs at least one account id', 'bad_argument');
  validateGrantShape(await store.read(), capabilities, accountIds);

  const token = randomBytes(32).toString('base64url');
  await ensurePrivateDir(path.dirname(input.tokenFile));
  if (!(await writePrivateFileExclusive(input.tokenFile, Buffer.from(`${token}\n`)))) {
    throw new PerchError(`Token file ${input.tokenFile} already exists; choose another path`, 'file_exists');
  }
  const client = await store.update((data) => {
    const now = new Date().toISOString();
    validateGrantShape(data, capabilities, accountIds);
    const grant: ClientGrant = {
      id: newAccountId('client', data.clients.map((c) => c.id)),
      label,
      tokenSha256: tokenSha256(token),
      capabilities,
      accountIds,
      createdAt: now,
    };
    data.clients.push(grant);
    return grant;
  });
  return { client, token };
}

/**
 * Every account must exist and be of a kind some granted capability applies to, and every capability
 * family needs at least one matching account. A calendar grant therefore never carries mail access
 * by accident, and a mail grant never Calendar/Contacts access.
 */
function validateGrantShape(data: StoreData, capabilities: Capability[], accountIds: string[]): void {
  const mail = new Set(mailAccountIds(data));
  const productivity = new Set(productivityAccountIds(data));
  for (const id of accountIds) {
    if (isProductivityAccountId(id)) {
      if (!productivity.has(id)) throw new PerchError(`Unknown Google productivity account: ${id}`, 'unknown_account');
    } else if (!mail.has(id)) throw new PerchError(`Unknown mail account: ${id}`, 'unknown_account');
  }
  const mailCaps = capabilities.some(isMailCap);
  const prodCaps = capabilities.some(isProductivityCap);
  if (mailCaps && !accountIds.some((id) => !isProductivityAccountId(id))) {
    throw new PerchError('Mail capabilities (read, draft, send) need at least one mail account (gmail-…, microsoft-…, imap-…)', 'bad_argument');
  }
  if (prodCaps && !accountIds.some(isProductivityAccountId)) {
    throw new PerchError('Calendar/contacts capabilities need at least one Google productivity account (gprod-…)', 'bad_argument');
  }
  for (const id of accountIds) {
    if (isProductivityAccountId(id) ? !prodCaps : !mailCaps) {
      throw new PerchError(`Account ${id} has no granted capability that applies to it; remove it or add a matching capability`, 'bad_argument');
    }
  }
}

export async function removeClientGrant(store: CredentialStore, id: string): Promise<void> {
  await store.update((data) => {
    if (!data.clients.some((c) => c.id === id)) throw new PerchError(`Unknown client: ${id}`, 'unknown_client');
    data.clients = data.clients.filter((c) => c.id !== id);
  });
}

/**
 * Looks a presented token up by its SHA-256. The token carries >= 256 bits of entropy, so a
 * hash lookup leaks nothing useful through timing. Returns null for unknown tokens.
 */
export async function principalForClientToken(store: CredentialStore, token: string): Promise<Principal | null> {
  if (!token) return null;
  const digest = tokenSha256(token);
  const grant = (await store.read()).clients.find((c) => c.tokenSha256 === digest);
  return grant ? principalFromGrant(grant) : null;
}

/**
 * Re-resolves a principal from the store right before a tool runs, so `perch client remove` and
 * narrowed grants apply to long-lived connections (stdio) immediately. The read-only operator is
 * returned unchanged. A client whose grant (same id and token hash) is gone fails closed.
 */
export async function currentPrincipal(store: CredentialStore, p: Principal): Promise<Principal> {
  if (p.kind === 'operator_readonly') return p;
  const grant = p.tokenSha256 ? (await store.read()).clients.find((c) => c.id === p.clientId && c.tokenSha256 === p.tokenSha256) : undefined;
  if (!grant) throw new PerchError('This client grant was revoked or replaced; no request was made (perch client list)', 'grant_revoked');
  return principalFromGrant(grant);
}
