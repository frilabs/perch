import { PerchError, safeMessage } from '../errors.js';
import type { PerchContext } from '../context.js';
import { fetchDriveIdentity } from '../google/accounts.js';
import { fetchVerifiedIdentity } from '../google/productivity.js';
import { fetchGmailIdentity } from '../mail/gmailAccounts.js';
import { verifyImapAccount } from '../mail/imapAccounts.js';
import { MAX_SEND_RECORDS, MailWorkflowLedger } from '../mail/workflowLedger.js';
import { fetchMicrosoftIdentity } from '../microsoft/accounts.js';
import { NOTION_VERSION } from '../notion/notion.js';
import { ROOT_NAMESPACE, type ImapAccount, type StoreData } from '../store/credentialStore.js';
import { PERCH_VERSION } from '../version.js';

/**
 * Read-only overview of one namespace: connected accounts (labels, ids, identities, granted provider
 * permissions; never tokens, passwords or scopes' secrets), client grants, the WhatsApp bridge, the send
 * ledger fill level and, optionally, a live check per account. Live checks only call identity endpoints
 * that every grant already allows (Drive about, Gmail profile, Graph /me, Google userinfo, Notion
 * users/me, Slack auth.test, an IMAP/SMTP login, the GOWA device status) through the namespace's own
 * token providers, so refresh-token rotation never races with the running server.
 */

export type AccountFamily = 'drive' | 'notion' | 'mail' | 'calendar' | 'slack' | 'whatsapp';

export const FAMILY_TITLES: Record<AccountFamily, string> = {
  drive: 'Google Drive',
  notion: 'Notion',
  mail: 'Mail',
  calendar: 'Google Calendar/Contacts',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};

export interface CheckResult {
  state: 'ok' | 'error' | 'skipped';
  /** Sanitised message (PerchError text only). */
  message?: string;
  ms?: number;
}

export interface AccountStatus {
  family: AccountFamily;
  id: string;
  label: string;
  provider: string;
  /** Email, workspace/team or WhatsApp number as stored at onboarding. */
  identity?: string;
  /** Provider permissions in plain words, e.g. "read, send". */
  permissions: string;
  connectedAt: string;
  check?: CheckResult;
}

export interface StatusReport {
  generatedAt: string;
  version: string;
  namespace: string;
  checked: boolean;
  accounts: AccountStatus[];
  clients: Array<{ id: string; label: string; capabilities: string[]; accountIds: string[]; createdAt: string }>;
  whatsappBridge?: { origin: string; configuredAt: string };
  ledger: { sends: number; maxSends: number; pending: number; auditEvents: number; auditDropped: number; lastActivityAt?: string } | { error: string };
  /** Root namespace only: provisioned users (membership, never tokens). */
  users?: Array<{ id: string; label: string; status: string; createdAt: string }>;
}

export const CHECK_TIMEOUT_MS = 20_000;
const CHECK_CONCURRENCY = 6;

const short = (scope: string) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');

function accountsOf(d: StoreData): AccountStatus[] {
  const rows: AccountStatus[] = [];
  for (const a of d.google) rows.push({ family: 'drive', id: a.id, label: a.label, provider: 'google', identity: a.email, permissions: 'read', connectedAt: a.createdAt });
  for (const w of d.notion) {
    rows.push({ family: 'notion', id: w.id, label: w.label, provider: 'notion', ...(w.tokenOwner?.name ? { identity: w.tokenOwner.name } : {}), permissions: 'read', connectedAt: w.createdAt });
  }
  for (const a of d.gmail) {
    const p = ['read', ...(a.scopes.some((s) => s.endsWith('gmail.compose')) ? ['draft'] : []), ...(a.scopes.some((s) => s.endsWith('gmail.send') || s.endsWith('gmail.compose')) ? ['send'] : [])];
    rows.push({ family: 'mail', id: a.id, label: a.label, provider: 'gmail', identity: a.email, permissions: p.join(', '), connectedAt: a.createdAt });
  }
  for (const a of d.microsoft) {
    const p = ['read', ...(a.scopes.includes('Mail.ReadWrite') ? ['draft'] : []), ...(a.scopes.includes('Mail.Send') ? ['send'] : [])];
    rows.push({ family: 'mail', id: a.id, label: a.label, provider: 'microsoft', identity: a.email, permissions: p.join(', '), connectedAt: a.createdAt });
  }
  for (const a of d.imap) {
    const p = ['read', ...(a.allowDrafts ? ['draft'] : []), ...(a.allowSend ? ['send'] : [])];
    rows.push({ family: 'mail', id: a.id, label: a.label, provider: a.preset ? `imap (${a.preset})` : 'imap', identity: a.email, permissions: p.join(', '), connectedAt: a.createdAt });
  }
  for (const a of d.googleProductivity) {
    const p = [...a.services.map((s) => `${s} read`), ...(a.allowCalendarWrite ? ['calendar write'] : [])];
    rows.push({ family: 'calendar', id: a.id, label: a.label, provider: 'google', identity: a.email, permissions: p.join(', '), connectedAt: a.createdAt });
  }
  for (const w of d.slack) {
    const p = ['read', ...(w.scopes.includes('search:read') ? ['search'] : []), ...(w.scopes.includes('chat:write') ? ['post'] : [])];
    rows.push({ family: 'slack', id: w.id, label: w.label, provider: 'slack', identity: [w.teamName ?? w.teamId, w.userName].filter(Boolean).join(' / '), permissions: p.join(', '), connectedAt: w.createdAt });
  }
  for (const a of d.whatsapp) {
    const number = a.jid?.split('@')[0]?.split(':')[0];
    rows.push({ family: 'whatsapp', id: a.id, label: a.label, provider: 'gowa', ...(number ? { identity: `+${number}` } : {}), permissions: 'read, send', connectedAt: a.createdAt });
  }
  return rows;
}

export interface StatusOptions {
  /** Run a live check per account (default true). */
  live?: boolean;
  /** Tests inject a MOCK IMAP/SMTP login check; production logs in to the real servers over TLS. */
  imapVerify?: (account: ImapAccount) => Promise<void>;
  timeoutMs?: number;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PerchError(`No answer within ${Math.round(ms / 1000)} s`, 'check_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One read-only identity call for the account. Throws a PerchError on failure. */
async function checkAccount(ctx: PerchContext, d: StoreData, a: AccountStatus, opts: StatusOptions): Promise<void> {
  const up = ctx.upstream;
  switch (a.family) {
    case 'drive':
      await fetchDriveIdentity(up, await ctx.tokens.drive.getAccessToken(a.id));
      return;
    case 'notion': {
      const ws = d.notion.find((w) => w.id === a.id)!;
      await up.json('notion', { method: 'GET', path: '/v1/users/me', headers: { authorization: `Bearer ${ws.token}`, 'notion-version': NOTION_VERSION } });
      return;
    }
    case 'mail':
      if (a.provider === 'gmail') await fetchGmailIdentity(up, await ctx.tokens.gmail.getAccessToken(a.id));
      else if (a.provider === 'microsoft') await fetchMicrosoftIdentity(up, await ctx.tokens.microsoft.getAccessToken(a.id));
      else await (opts.imapVerify ?? verifyImapAccount)(d.imap.find((x) => x.id === a.id)!);
      return;
    case 'calendar':
      await fetchVerifiedIdentity(up, await ctx.tokens.productivity.getAccessToken(a.id));
      return;
    case 'slack': {
      const ws = d.slack.find((w) => w.id === a.id)!;
      const r = await up.json<{ ok?: boolean; error?: unknown }>('slack', { method: 'GET', path: '/api/auth.test', headers: { authorization: `Bearer ${ws.token}` } });
      if (r.ok !== true) {
        const code = typeof r.error === 'string' && /^[a-z_]{1,64}$/.test(r.error) ? r.error : 'unknown_error';
        throw new PerchError(`Slack refused the token (${code}); reconnect with perch slack add`, 'upstream_error');
      }
      return;
    }
    case 'whatsapp': {
      const acct = d.whatsapp.find((w) => w.id === a.id)!;
      const inst = d.whatsappInstance;
      if (!inst) throw new PerchError('No WhatsApp bridge configured', 'not_configured');
      const r = await up.json<{ code?: unknown; results?: { is_logged_in?: unknown; is_connected?: unknown } }>('gowa', {
        method: 'GET',
        path: `/devices/${acct.deviceId}/status`,
        origin: inst.origin,
        capability: 'admin',
        headers: { authorization: `Basic ${Buffer.from(`${inst.username}:${inst.password}`, 'utf8').toString('base64')}` },
      });
      if (r.code !== 'SUCCESS') throw new PerchError('The WhatsApp bridge reported a failure', 'upstream_error');
      if (r.results?.is_logged_in !== true) throw new PerchError('Not logged in to WhatsApp: pair again with perch whatsapp add', 'not_logged_in');
      if (r.results?.is_connected !== true) throw new PerchError('Logged in, but the bridge is not connected to WhatsApp right now', 'not_connected');
      return;
    }
  }
}

async function ledgerStatus(ctx: PerchContext): Promise<StatusReport['ledger']> {
  try {
    const l = await new MailWorkflowLedger(ctx.store).read();
    return {
      sends: l.sends.length,
      maxSends: MAX_SEND_RECORDS,
      pending: l.sends.filter((s) => s.state === 'pending').length,
      auditEvents: l.audit.length,
      auditDropped: l.auditDropped,
      ...(l.audit.length ? { lastActivityAt: l.audit[l.audit.length - 1]!.at } : {}),
    };
  } catch (err) {
    return { error: safeMessage(err) };
  }
}

export async function collectStatus(ctx: PerchContext, opts: StatusOptions = {}): Promise<StatusReport> {
  const d = await ctx.store.read();
  const accounts = accountsOf(d);
  const live = opts.live ?? true;
  if (live) {
    const queue = [...accounts];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const started = Date.now();
        try {
          await withTimeout(checkAccount(ctx, d, a, opts), opts.timeoutMs ?? CHECK_TIMEOUT_MS);
          a.check = { state: 'ok', ms: Date.now() - started };
        } catch (err) {
          a.check = { state: 'error', message: safeMessage(err), ms: Date.now() - started };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, accounts.length) }, worker));
  }
  return {
    generatedAt: new Date().toISOString(),
    version: PERCH_VERSION,
    namespace: ctx.store.namespace,
    checked: live,
    accounts,
    clients: d.clients.map((c) => ({ id: c.id, label: c.label, capabilities: [...c.capabilities], accountIds: [...c.accountIds], createdAt: c.createdAt })),
    ...(d.whatsappInstance ? { whatsappBridge: { origin: d.whatsappInstance.origin, configuredAt: d.whatsappInstance.createdAt } } : {}),
    ledger: await ledgerStatus(ctx),
    ...(ctx.store.namespace === ROOT_NAMESPACE ? { users: d.users.map((u) => ({ id: u.id, label: u.label, status: u.status, createdAt: u.createdAt })) } : {}),
  };
}

export const failedChecks = (r: StatusReport) => r.accounts.filter((a) => a.check?.state === 'error').length;

const day = (iso: string) => iso.slice(0, 10);

/** Plain-text rendering for `perch status`. */
export function formatStatusText(r: StatusReport): string {
  const lines = [`Perch ${r.version} · namespace ${r.namespace} · ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC${r.checked ? '' : ' · live checks skipped'}`, ''];
  for (const family of Object.keys(FAMILY_TITLES) as AccountFamily[]) {
    const rows = r.accounts.filter((a) => a.family === family);
    lines.push(`${FAMILY_TITLES[family]}${rows.length ? '' : ': none'}`);
    for (const a of rows) {
      const mark = !a.check ? '·' : a.check.state === 'ok' ? '✓' : '✗';
      const result = !a.check ? '' : a.check.state === 'ok' ? `  ok (${a.check.ms} ms)` : `  ERROR: ${a.check.message}`;
      lines.push(`  ${mark} ${a.id}  "${a.label}"  ${a.identity ?? ''}  [${a.provider}: ${a.permissions}]  since ${day(a.connectedAt)}${result}`);
    }
  }
  lines.push('', `Client grants${r.clients.length ? '' : ': none'}`);
  for (const c of r.clients) lines.push(`  ${c.id}  "${c.label}"  ${c.capabilities.join(',')}  → ${c.accountIds.join(', ')}`);
  if (r.whatsappBridge) lines.push('', `WhatsApp bridge: ${r.whatsappBridge.origin}`);
  lines.push('');
  if ('error' in r.ledger) lines.push(`Send ledger: ERROR ${r.ledger.error}`);
  else {
    lines.push(
      `Send ledger: ${r.ledger.sends} / ${r.ledger.maxSends} records used${r.ledger.pending ? `, ${r.ledger.pending} pending (unknown outcome)` : ''}`,
      `Audit: ${r.ledger.auditEvents} events${r.ledger.auditDropped ? ` (+${r.ledger.auditDropped} rotated out)` : ''}${r.ledger.lastActivityAt ? `, last activity ${r.ledger.lastActivityAt.replace('T', ' ').slice(0, 16)} UTC` : ''}`,
    );
  }
  if (r.users) {
    lines.push('', `Users${r.users.length ? '' : ': none'}`);
    for (const u of r.users) lines.push(`  ${u.id}  "${u.label}"  ${u.status}  since ${day(u.createdAt)}`);
  }
  const failed = failedChecks(r);
  if (r.checked) lines.push('', failed ? `${failed} check(s) failed.` : 'All checks passed.');
  return `${lines.join('\n')}\n`;
}
