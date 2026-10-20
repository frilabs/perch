import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { PerchError } from '../errors.js';
import { newAccountId, validateLabel } from '../ids.js';
import { ensurePrivateDir, writePrivateFileExclusive } from '../secureFs.js';
import {
  CAPABILITIES,
  MAIL_CAPABILITIES,
  PRODUCTIVITY_CAPABILITIES,
  SLACK_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
  LUMA_CAPABILITIES,
  DRIVE_CAPABILITIES,
  NOTION_CAPABILITIES,
  type Capability,
  type ClientGrant,
  type CredentialStore,
  type ProductivityCapability,
  type SlackCapability,
  type StoreData,
  type WhatsappCapability,
  type LumaCapability,
  type DriveCapability,
  type NotionCapability,
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
  /** Slack workspaces; 'all' only for the read-only operator. */
  slackAccounts: ReadonlySet<string> | 'all';
  /** WhatsApp accounts; 'all' only for the read-only operator. */
  whatsappAccounts: ReadonlySet<string> | 'all';
  /** Luma accounts; 'all' only for the read-only operator. */
  lumaAccounts: ReadonlySet<string> | 'all';
  /** Google Drive accounts (google-…); 'all' only for the read-only operator. */
  driveAccounts: ReadonlySet<string> | 'all';
  /** Notion workspaces (notion-…); 'all' only for the read-only operator. */
  notionAccounts: ReadonlySet<string> | 'all';
}

export const READONLY_PRINCIPAL: Principal = Object.freeze({
  kind: 'operator_readonly',
  capabilities: new Set<Capability>(['read', 'calendar_read', 'contacts_read', 'slack_read', 'whatsapp_read', 'luma_read', 'drive_read', 'notion_read']),
  mailAccounts: 'all',
  productivityAccounts: 'all',
  slackAccounts: 'all',
  whatsappAccounts: 'all',
  lumaAccounts: 'all',
  driveAccounts: 'all',
  notionAccounts: 'all',
}) as Principal;

/** Account families: each capability applies to exactly one family, recognised by the account id prefix. */
export type AccountFamily = 'mail' | 'productivity' | 'slack' | 'whatsapp' | 'luma' | 'drive' | 'notion';
const FAMILY_CAPS: Record<AccountFamily, readonly string[]> = {
  mail: MAIL_CAPABILITIES,
  productivity: PRODUCTIVITY_CAPABILITIES,
  slack: SLACK_CAPABILITIES,
  whatsapp: WHATSAPP_CAPABILITIES,
  luma: LUMA_CAPABILITIES,
  drive: DRIVE_CAPABILITIES,
  notion: NOTION_CAPABILITIES,
};
const FAMILY_HINT: Record<AccountFamily, string> = {
  mail: 'Mail capabilities (read, draft, send) need at least one mail account (gmail-…, microsoft-…, imap-…)',
  productivity: 'Calendar/contacts capabilities need at least one Google productivity account (gprod-…)',
  slack: 'Slack capabilities (slack_read, slack_send) need at least one Slack workspace (slack-…)',
  whatsapp: 'WhatsApp capabilities (whatsapp_read, whatsapp_send) need at least one WhatsApp account (whatsapp-…)',
  luma: 'Luma capabilities (luma_read, luma_events, luma_guests, luma_blast) need at least one Luma account (luma-…)',
  drive: 'Drive capabilities (drive_read, drive_write) need at least one Google Drive account (google-…)',
  notion: 'Notion capabilities (notion_read, notion_write) need at least one Notion workspace (notion-…)',
};

export function familyOf(id: string): AccountFamily {
  if (id.startsWith('gprod-')) return 'productivity';
  if (id.startsWith('slack-')) return 'slack';
  if (id.startsWith('whatsapp-')) return 'whatsapp';
  if (id.startsWith('luma-')) return 'luma';
  if (id.startsWith('google-')) return 'drive';
  if (id.startsWith('notion-')) return 'notion';
  return 'mail';
}
const capFamily = (c: Capability): AccountFamily => (Object.keys(FAMILY_CAPS) as AccountFamily[]).find((f) => FAMILY_CAPS[f].includes(c))!;

export const isProductivityAccountId = (id: string) => familyOf(id) === 'productivity';
const isMailCap = (c: Capability) => capFamily(c) === 'mail';
const isProductivityCap = (c: Capability) => capFamily(c) === 'productivity';

export const tokenSha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function mailAccountIds(data: StoreData): string[] {
  return [...data.gmail, ...data.microsoft, ...data.imap].map((a) => a.id);
}

export function productivityAccountIds(data: StoreData): string[] {
  return data.googleProductivity.map((a) => a.id);
}

function accountIdsOf(data: StoreData, family: AccountFamily): string[] {
  if (family === 'mail') return mailAccountIds(data);
  if (family === 'productivity') return productivityAccountIds(data);
  if (family === 'slack') return data.slack.map((w) => w.id);
  if (family === 'luma') return data.luma.map((a) => a.id);
  if (family === 'drive') return data.google.map((a) => a.id);
  if (family === 'notion') return data.notion.map((w) => w.id);
  return data.whatsapp.map((a) => a.id);
}

export function principalFromGrant(grant: ClientGrant): Principal {
  if (grant.full) {
    // Resolved on every call: new accounts and new capabilities are covered without a new grant.
    return {
      kind: 'client',
      clientId: grant.id,
      clientLabel: grant.label,
      tokenSha256: grant.tokenSha256,
      capabilities: new Set(CAPABILITIES),
      mailAccounts: 'all',
      productivityAccounts: 'all',
      slackAccounts: 'all',
      whatsappAccounts: 'all',
      lumaAccounts: 'all',
      driveAccounts: 'all',
      notionAccounts: 'all',
    };
  }
  const of = (f: AccountFamily) => new Set(grant.accountIds.filter((id) => familyOf(id) === f));
  return {
    kind: 'client',
    clientId: grant.id,
    clientLabel: grant.label,
    tokenSha256: grant.tokenSha256,
    capabilities: new Set(grant.capabilities),
    mailAccounts: of('mail'),
    productivityAccounts: of('productivity'),
    slackAccounts: of('slack'),
    whatsappAccounts: of('whatsapp'),
    lumaAccounts: of('luma'),
    driveAccounts: of('drive'),
    notionAccounts: of('notion'),
  };
}

/**
 * Throws unless the principal holds `cap` for the Drive account (google-…) or Notion workspace
 * (notion-…) `accountId`. The read-only operator only reads.
 */
export function assertDocsCapability(p: Principal, family: 'drive' | 'notion', accountId: string, cap: DriveCapability | NotionCapability): void {
  const write = cap === 'drive_write' || cap === 'notion_write';
  if (p.kind === 'operator_readonly' && write) {
    throw new PerchError(`This connection is read-only (global token or default stdio). Writing needs a client grant: perch client add --allow ${cap}`, 'capability_denied');
  }
  const accounts = family === 'drive' ? p.driveAccounts : p.notionAccounts;
  const accountOk = accounts === 'all' || accounts.has(accountId);
  if (!p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for account ${accountId}`, 'capability_denied');
  }
}

/** Account ids of `family` this principal may use ('all' for the read-only operator). */
export function allowedAccounts(p: Principal, family: 'drive' | 'notion'): ReadonlySet<string> | 'all' {
  return family === 'drive' ? p.driveAccounts : p.notionAccounts;
}

export function hasFamilyCapability(p: Principal, family: AccountFamily): boolean {
  return [...p.capabilities].some((c) => capFamily(c) === family);
}

/** Throws unless the principal holds `cap` for the Slack workspace `accountId`. The operator only reads. */
export function assertSlackCapability(p: Principal, accountId: string, cap: SlackCapability): void {
  if (p.kind === 'operator_readonly' && cap !== 'slack_read') {
    throw new PerchError('This connection is read-only (global token or default stdio). Sending to Slack needs a client grant: perch client add --allow slack_send', 'capability_denied');
  }
  const accountOk = p.slackAccounts === 'all' || p.slackAccounts.has(accountId);
  if (!p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for workspace ${accountId}`, 'capability_denied');
  }
}

/** Throws unless the principal holds `cap` for the Luma account `accountId`. The operator only reads. */
export function assertLumaCapability(p: Principal, accountId: string, cap: LumaCapability): void {
  if (p.kind === 'operator_readonly' && cap !== 'luma_read') {
    throw new PerchError(`This connection is read-only. "${cap}" on Luma needs a client grant: perch client add --allow ${cap}`, 'capability_denied');
  }
  const accountOk = p.lumaAccounts === 'all' || p.lumaAccounts.has(accountId);
  if (!p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for Luma account ${accountId}`, 'capability_denied');
  }
}

/** Throws unless the principal holds `cap` for the WhatsApp account `accountId`. The operator only reads. */
export function assertWhatsappCapability(p: Principal, accountId: string, cap: WhatsappCapability): void {
  if (p.kind === 'operator_readonly' && cap !== 'whatsapp_read') {
    throw new PerchError('This connection is read-only (global token or default stdio). Sending on WhatsApp needs a client grant: perch client add --allow whatsapp_send', 'capability_denied');
  }
  const accountOk = p.whatsappAccounts === 'all' || p.whatsappAccounts.has(accountId);
  if (!p.capabilities.has(cap) || !accountOk) {
    throw new PerchError(`Capability "${cap}" is not granted to this client for account ${accountId}`, 'capability_denied');
  }
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
  if (p.kind === 'operator_readonly' && (cap === 'calendar_write' || cap === 'calendar_invite')) {
    throw new PerchError(
      `This connection is read-only (global token or default stdio). Calendar writes need a client grant: perch client add --allow ${cap}`,
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
  input: { label: string; capabilities: Capability[]; accountIds: string[]; tokenFile: string; full?: boolean },
): Promise<{ client: ClientGrant; token: string }> {
  const label = validateLabel(input.label);
  const full = input.full === true;
  const capabilities = full ? [...CAPABILITIES] : parseCapabilities(input.capabilities);
  if (!capabilities.length) throw new PerchError(`A client grant needs at least one capability (${CAPABILITIES.join(', ')})`, 'bad_argument');
  const accountIds = full ? [] : [...new Set(input.accountIds)];
  if (!full && !accountIds.length) throw new PerchError('A client grant needs at least one account id', 'bad_argument');
  if (!full) validateGrantShape(await store.read(), capabilities, accountIds);

  const token = randomBytes(32).toString('base64url');
  await ensurePrivateDir(path.dirname(input.tokenFile));
  if (!(await writePrivateFileExclusive(input.tokenFile, Buffer.from(`${token}\n`)))) {
    throw new PerchError(`Token file ${input.tokenFile} already exists; choose another path`, 'file_exists');
  }
  const client = await store.update((data) => {
    const now = new Date().toISOString();
    if (!full) validateGrantShape(data, capabilities, accountIds);
    const grant: ClientGrant = {
      id: newAccountId('client', data.clients.map((c) => c.id)),
      label,
      tokenSha256: tokenSha256(token),
      capabilities,
      accountIds,
      ...(full ? { full: true as const } : {}),
      createdAt: now,
    };
    data.clients.push(grant);
    return grant;
  });
  return { client, token };
}

/**
 * Client grant for an OAuth device of the public access (perch oauth grant). It has no bearer token of its
 * own: its token hash is the SHA-256 of 32 random bytes that are discarded at once, so no presented token
 * can ever match it on the local listener. The device record points at the grant id; principalFromGrant and
 * currentPrincipal (re-resolution before every tool call, revocation) then work exactly as for perch client add.
 */
export async function createDeviceGrant(
  store: CredentialStore,
  input: { label: string; capabilities: Capability[]; accountIds: string[]; full?: boolean },
): Promise<ClientGrant> {
  const label = validateLabel(input.label);
  const full = input.full === true;
  const capabilities = full ? [...CAPABILITIES] : parseCapabilities(input.capabilities);
  if (!capabilities.length) throw new PerchError(`A grant needs at least one capability (${CAPABILITIES.join(', ')})`, 'bad_argument');
  const accountIds = full ? [] : [...new Set(input.accountIds)];
  if (!full && !accountIds.length) throw new PerchError('A grant needs at least one account id', 'bad_argument');
  return store.update((data) => {
    if (!full) validateGrantShape(data, capabilities, accountIds);
    const grant: ClientGrant = {
      id: newAccountId('client', data.clients.map((c) => c.id)),
      label,
      tokenSha256: tokenSha256(randomBytes(32).toString('base64url')),
      capabilities,
      accountIds,
      ...(full ? { full: true as const } : {}),
      createdAt: new Date().toISOString(),
    };
    data.clients.push(grant);
    return grant;
  });
}

/** Principal of an existing grant id (OAuth device grants); null if the grant is gone. */
export async function principalForGrantId(store: CredentialStore, id: string): Promise<Principal | null> {
  const grant = (await store.read()).clients.find((c) => c.id === id);
  return grant ? principalFromGrant(grant) : null;
}

/**
 * Every account must exist and be of a kind some granted capability applies to, and every capability
 * family needs at least one matching account. A calendar grant therefore never carries mail access
 * by accident, and a mail grant never Calendar/Contacts access.
 */
const UNKNOWN_ACCOUNT: Record<AccountFamily, string> = {
  mail: 'Unknown mail account',
  productivity: 'Unknown Google productivity account',
  slack: 'Unknown Slack workspace',
  whatsapp: 'Unknown WhatsApp account',
  luma: 'Unknown Luma account',
  drive: 'Unknown Google Drive account',
  notion: 'Unknown Notion workspace',
};

function validateGrantShape(data: StoreData, capabilities: Capability[], accountIds: string[]): void {
  for (const id of accountIds) {
    if (id.startsWith('ggroup-')) {
      // A Google account group is not an account: grants stay per member (google-…, gmail-…, gprod-…).
      const group = data.googleGroups.find((g) => g.id === id);
      if (!group) throw new PerchError(`Unknown Google account group: ${id}`, 'unknown_account');
      const members = [...data.google, ...data.gmail, ...data.googleProductivity].filter((a) => a.groupId === id).map((a) => a.id);
      throw new PerchError(
        `${id} is a Google account group; grant its member ids: ${members.join(', ') || '(none)'} (e.g. --account ${members[0] ?? 'ID'})`,
        'bad_argument',
      );
    }
    const family = familyOf(id);
    if (!accountIdsOf(data, family).includes(id)) throw new PerchError(`${UNKNOWN_ACCOUNT[family]}: ${id}`, 'unknown_account');
  }
  const families = new Set(capabilities.map(capFamily));
  for (const f of families) {
    if (!accountIds.some((id) => familyOf(id) === f)) throw new PerchError(FAMILY_HINT[f], 'bad_argument');
  }
  for (const id of accountIds) {
    if (!families.has(familyOf(id))) {
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
