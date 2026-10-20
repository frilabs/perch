import { groupMembers, groupServices } from '../google/groupStore.js';
import { DRIVE_SCOPE } from '../google/oauth.js';
import { CALENDAR_EVENTS_OWNED_SCOPE, CALENDAR_READONLY_SCOPE, CONTACTS_READONLY_SCOPE } from '../google/productivity.js';
import { GMAIL_COMPOSE_SCOPE, GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE } from '../mail/gmailAccounts.js';
import { IMAP_PRESETS } from '../mail/imapPresets.js';
import type { GmailAccount, ImapAccount, StoreData } from '../store/credentialStore.js';
import { failedChecks, type AccountStatus, type StatusReport } from './status.js';

/**
 * Terminal rendering of `perch status` (docs/STATUS_UI_GOWA_HARDENING_SPEC.md §1): sections with rules,
 * ☑/☐/✗ checkboxes, per-account capabilities (enabled vs. possible, with the command that enables a missing
 * one), unconnected services, access, activity and an onboarding checklist. Colour only for status (green ok,
 * red failure, yellow hint) and only on a TTY without NO_COLOR. Never prints a secret: everything rendered
 * comes from the StatusReport (already secret-free) and from non-secret store fields (labels, addresses,
 * hosts, opt-ins and OAuth scope names).
 */

/** One capability of a connected account: enabled, or possible with the command that enables it. */
export interface AccountCapability {
  name: string;
  enabled: boolean;
  /** What the capability covers, shown for a missing one. */
  detail?: string;
  /** Shell command (or short instruction) that enables a missing capability. */
  enable?: string;
}

export type CapabilityMap = Record<string, AccountCapability[]>;

export interface TerminalOptions {
  /** stdout is a terminal (colour allowed unless NO_COLOR is set). */
  tty: boolean;
  /** Terminal width; undefined (pipe) renders at 80. Clamped to 60..120. */
  columns?: number;
  env: Record<string, string | undefined>;
}

const SAFE_ARG = /^[A-Za-z0-9_.@+:,/=-]+$/;
/** POSIX shell quoting for user-assigned values (labels) inside a suggested command. */
export const shellQuote = (s: string) => (SAFE_ARG.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ---- capabilities ------------------------------------------------------------------------------------------

function reconnect(remove: string, add: string[]): string {
  return `${remove} && ${add.filter(Boolean).join(' ')}`;
}

function imapAddCommand(a: ImapAccount, opts: { drafts: boolean; send: boolean; modify: boolean }): string {
  const args = ['perch imap add', `--label ${shellQuote(a.label)}`, `--email ${shellQuote(a.email)}`];
  if (a.username !== a.email) args.push(`--username ${shellQuote(a.username)}`);
  const preset = a.preset && a.preset in IMAP_PRESETS ? IMAP_PRESETS[a.preset as keyof typeof IMAP_PRESETS] : undefined;
  if (preset) {
    args.push(`--preset ${a.preset}`);
    if (a.imap.port !== preset.imap.port) args.push(`--imap-port ${a.imap.port}`);
    if (a.smtp.security === 'starttls') args.push('--smtp-security starttls');
    const defaultSmtp = a.smtp.security === 'tls' ? preset.smtp.port : preset.smtpStarttlsPort;
    if (a.smtp.port !== defaultSmtp) args.push(`--smtp-port ${a.smtp.port}`);
  } else {
    args.push(`--imap-host ${a.imap.host}`, `--imap-port ${a.imap.port}`, `--smtp-host ${a.smtp.host}`, `--smtp-port ${a.smtp.port}`, `--smtp-security ${a.smtp.security}`);
  }
  if (opts.drafts) args.push('--allow-drafts');
  if (opts.send) args.push('--allow-send');
  if (opts.modify) args.push('--allow-modify');
  if (a.draftsMailbox) args.push(`--drafts-mailbox ${shellQuote(a.draftsMailbox)}`);
  if (a.sentCopy === false) args.push('--no-sent-copy');
  return reconnect(`perch imap remove ${a.id}`, args);
}

const MAIL_DETAILS = { drafts: 'create and change drafts', send: 'send mail', organize: 'flags, move, archive, trash' } as const;

// ---- Google (one login per account group; docs/GOOGLE_UNIFIED_SPEC.md) ------------------------------------------

type GService = 'drive' | 'gmail' | 'calendar' | 'contacts';
const G_SERVICES: readonly GService[] = ['drive', 'gmail', 'calendar', 'contacts'];
const G_FLAGS = ['--allow-write', '--allow-drafts', '--allow-send', '--allow-modify', '--allow-calendar-write'] as const;
type GFlag = (typeof G_FLAGS)[number];
interface GoogleState {
  services: GService[];
  flags: GFlag[];
}

function gmailFlags(a: GmailAccount | undefined): GFlag[] {
  if (!a) return [];
  return [
    ...(a.scopes.includes(GMAIL_COMPOSE_SCOPE) ? (['--allow-drafts'] as const) : []),
    ...(a.scopes.includes(GMAIL_SEND_SCOPE) || a.scopes.includes(GMAIL_COMPOSE_SCOPE) ? (['--allow-send'] as const) : []),
    ...(a.scopes.includes(GMAIL_MODIFY_SCOPE) ? (['--allow-modify'] as const) : []),
  ];
}

/** Services and write opt-ins a Google account group has now (what a re-add must keep). */
function groupState(d: StoreData, groupId: string): GoogleState {
  const m = groupMembers(d, groupId);
  return {
    services: groupServices(d, groupId),
    flags: [
      ...(m.drive?.scopes.includes(DRIVE_SCOPE) ? (['--allow-write'] as const) : []),
      ...gmailFlags(m.gmail),
      ...(m.productivity?.allowCalendarWrite && m.productivity.scopes.includes(CALENDAR_EVENTS_OWNED_SCOPE) ? (['--allow-calendar-write'] as const) : []),
    ],
  };
}

/**
 * The `perch google add` that adds `want` to `now`. For a group member it updates the group in place (same ids);
 * for an account connected separately it first removes that account (`remove`).
 */
function googleEnable(d: StoreData, a: { label: string; email: string; groupId?: string }, remove: string, now: GoogleState, want: { services?: GService[]; flags?: GFlag[] }): string {
  const group = a.groupId ? d.googleGroups.find((g) => g.id === a.groupId) : undefined;
  const services = G_SERVICES.filter((s) => now.services.includes(s) || want.services?.includes(s));
  const flags = G_FLAGS.filter((f) => now.flags.includes(f) || want.flags?.includes(f));
  const add = ['perch google add', `--label ${shellQuote(group?.label ?? a.label)}`, `--services ${services.join(',')}`, ...flags, `--login-hint ${shellQuote(group?.email ?? a.email)}`].join(' ');
  return group ? add : reconnect(remove, [add]);
}

/**
 * Enabled and possible capabilities per connected account, derived from the opt-ins and granted scopes in
 * the store. Each missing capability carries the command that enables it while keeping the enabled ones.
 */
export function accountCapabilities(d: StoreData): CapabilityMap {
  const out: CapabilityMap = {};
  const loginHint = (email: string) => `--login-hint ${shellQuote(email)}`;
  for (const g of d.googleGroups) {
    const now = groupState(d, g.id);
    const svc = (name: string, s: GService, detail: string) => ({ name, enabled: now.services.includes(s), detail, enable: googleEnable(d, { ...g, groupId: g.id }, '', now, { services: [s] }) });
    out[g.id] = [svc('Drive', 'drive', 'search, read, export files'), svc('Gmail', 'gmail', 'read, search mail'), svc('Calendar', 'calendar', 'read calendars and events'), svc('Contacts', 'contacts', 'read contacts')];
  }
  for (const a of d.google) {
    const write = a.scopes.includes(DRIVE_SCOPE);
    const now = a.groupId ? groupState(d, a.groupId) : { services: ['drive' as const], flags: write ? (['--allow-write'] as GFlag[]) : [] };
    out[a.id] = [
      { name: 'read', enabled: true },
      { name: 'write', enabled: write, detail: 'create, edit, share, trash', enable: googleEnable(d, a, `perch google remove ${a.id}`, now, { flags: ['--allow-write'] }) },
    ];
  }
  for (const w of d.notion) out[w.id] = [{ name: 'read', enabled: true }];
  for (const a of d.gmail) {
    const has = { drafts: a.scopes.includes(GMAIL_COMPOSE_SCOPE), send: a.scopes.includes(GMAIL_SEND_SCOPE) || a.scopes.includes(GMAIL_COMPOSE_SCOPE), organize: a.scopes.includes(GMAIL_MODIFY_SCOPE) };
    const now = a.groupId ? groupState(d, a.groupId) : { services: ['gmail' as const], flags: gmailFlags(a) };
    const FLAG = { drafts: '--allow-drafts', send: '--allow-send', organize: '--allow-modify' } as const;
    const cmd = (extra: keyof typeof has) => googleEnable(d, a, `perch gmail remove ${a.id}`, now, { flags: [FLAG[extra]] });
    out[a.id] = [{ name: 'read', enabled: true }, ...(['drafts', 'send', 'organize'] as const).map((k) => ({ name: k, enabled: has[k], detail: MAIL_DETAILS[k], enable: cmd(k) }))];
  }
  for (const a of d.microsoft) {
    const rw = a.scopes.includes('Mail.ReadWrite');
    const has = { drafts: rw, send: a.scopes.includes('Mail.Send'), organize: rw };
    const cmd = (extra: keyof typeof has) => {
      const want = { ...has, [extra]: true };
      return reconnect(`perch microsoft remove ${a.id}`, [
        'perch microsoft add',
        `--label ${shellQuote(a.label)}`,
        want.drafts ? '--allow-drafts' : '',
        want.send ? '--allow-send' : '',
        want.organize ? '--allow-modify' : '',
        loginHint(a.email),
      ]);
    };
    out[a.id] = [{ name: 'read', enabled: true }, ...(['drafts', 'send', 'organize'] as const).map((k) => ({ name: k, enabled: has[k], detail: MAIL_DETAILS[k], enable: cmd(k) }))];
  }
  for (const a of d.imap) {
    const has = { drafts: a.allowDrafts, send: a.allowSend, organize: a.allowModify === true };
    const cmd = (extra: keyof typeof has) => {
      const want = { ...has, [extra]: true };
      return imapAddCommand(a, { drafts: want.drafts, send: want.send, modify: want.organize });
    };
    out[a.id] = [{ name: 'read', enabled: true }, ...(['drafts', 'send', 'organize'] as const).map((k) => ({ name: k, enabled: has[k], detail: MAIL_DETAILS[k], enable: cmd(k) }))];
  }
  for (const a of d.googleProductivity) {
    const calendar = a.services.includes('calendar') && a.scopes.includes(CALENDAR_READONLY_SCOPE);
    const contacts = a.services.includes('contacts') && a.scopes.includes(CONTACTS_READONLY_SCOPE);
    const write = calendar && a.allowCalendarWrite && a.scopes.includes(CALENDAR_EVENTS_OWNED_SCOPE);
    const state = a.groupId
      ? groupState(d, a.groupId)
      : { services: [...(calendar ? (['calendar'] as const) : []), ...(contacts ? (['contacts'] as const) : [])], flags: write ? (['--allow-calendar-write'] as GFlag[]) : [] };
    const cmd = (want: { calendar: boolean; contacts: boolean; write: boolean }) =>
      googleEnable(d, a, `perch google-productivity remove ${a.id}`, state, {
        services: [...(want.calendar ? (['calendar'] as const) : []), ...(want.contacts ? (['contacts'] as const) : [])],
        flags: want.write ? ['--allow-calendar-write'] : [],
      });
    const now = { calendar, contacts, write };
    out[a.id] = [
      { name: 'calendar', enabled: calendar, detail: 'read calendars and events', enable: cmd({ ...now, calendar: true }) },
      { name: 'contacts', enabled: contacts, detail: 'read contacts', enable: cmd({ ...now, contacts: true }) },
      { name: 'calendar write', enabled: write, detail: 'create, move, delete own events', enable: cmd({ ...now, calendar: true, write: true }) },
      { name: 'invitations', enabled: write, detail: 'guests, invitations, responses (client grant calendar_invite)', enable: cmd({ ...now, calendar: true, write: true }) },
    ];
  }
  for (const w of d.slack) {
    const has = (...scopes: string[]) => scopes.every((s) => w.scopes.includes(s));
    const enable = `reinstall the Slack app with the current manifest (perch slack manifest), then perch slack remove ${w.id} && perch slack add --label ${shellQuote(w.label)}`;
    const caps: Array<[string, boolean, string]> = [
      ['read', has('channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history', 'users:read'), 'channels, DMs, threads'],
      ['search', has('search:read'), 'search messages'],
      ['post', has('chat:write'), 'post and schedule messages'],
      ['reactions', has('reactions:read', 'reactions:write'), 'read and add reactions'],
      ['files', has('files:read', 'files:write'), 'read and upload files'],
      ['open DMs', has('im:write', 'mpim:write'), 'start direct messages'],
    ];
    out[w.id] = caps.map(([name, enabled, detail]) => ({ name, enabled, detail, enable }));
  }
  for (const a of d.whatsapp) out[a.id] = [{ name: 'read', enabled: true }, { name: 'send', enabled: true }];
  for (const a of d.luma) out[a.id] = [{ name: `${a.tools.length} tools approved`, enabled: true }];
  return out;
}

// ---- layout helpers ----------------------------------------------------------------------------------------

// Labels, team names and error texts come from users or providers: never let them carry terminal escapes.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (s: string) => s.replace(CONTROL, ' ');
const width = (s: string) => [...s].length;
/** Cuts a value to `max` characters with an ellipsis. */
export function fit(s: string, max: number): string {
  const chars = [...clean(s)];
  if (chars.length <= max) return chars.join('');
  return max <= 1 ? '…'.slice(0, Math.max(0, max)) : `${chars.slice(0, max - 1).join('')}…`;
}
/** Word wrap for prose (error messages, notes); words longer than the line are cut hard. */
function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of clean(s).split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (width(line) + 1 + width(word) <= max) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    while (width(line) > max) {
      out.push([...line].slice(0, max).join(''));
      line = [...line].slice(max).join('');
    }
  }
  if (line) out.push(line);
  return out;
}

interface Paint {
  ok: (s: string) => string;
  fail: (s: string) => string;
  hint: (s: string) => string;
  bold: (s: string) => string;
}
const sgr = (code: string) => (s: string) => `\u001b[${code}m${s}\u001b[0m`;
const PLAIN: Paint = { ok: (s) => s, fail: (s) => s, hint: (s) => s, bold: (s) => s };
const COLOR: Paint = { ok: sgr('32'), fail: sgr('31'), hint: sgr('33'), bold: sgr('1') };

const ON = '☑';
const OFF = '☐';
const FAIL = '✗';

const SERVICES: Array<{ key: string; title: string; name?: string; match: (a: AccountStatus) => boolean; does: string; add: (r: StatusReport) => string }> = [
  { key: 'drive', title: 'Google Drive', match: (a) => a.family === 'drive', does: 'search, read, export files; opt-in: write', add: () => 'perch google add --label NAME --services drive [--allow-write]' },
  { key: 'notion', title: 'Notion', match: (a) => a.family === 'notion', does: 'search and read pages and databases of a workspace', add: () => 'perch notion add --label NAME' },
  { key: 'gmail', title: 'Mail · Gmail',
    name: 'Gmail', match: (a) => a.provider === 'gmail', does: 'read, search; opt-in: drafts, send, organize', add: () => 'perch google add --label NAME --services gmail [--allow-drafts] [--allow-send] [--allow-modify]' },
  { key: 'microsoft', title: 'Mail · Outlook / Microsoft 365',
    name: 'Outlook / Microsoft 365', match: (a) => a.provider === 'microsoft', does: 'read, search; opt-in: drafts, send, organize', add: () => 'perch microsoft add --label NAME [--allow-drafts] [--allow-send] [--allow-modify]' },
  {
    key: 'imap',
    title: 'Mail · IMAP (GMX …)',
    name: 'IMAP mail (GMX …)',
    match: (a) => a.family === 'mail' && a.provider !== 'gmail' && a.provider !== 'microsoft',
    does: 'IMAP/SMTP, e.g. GMX; opt-in: drafts, send, organize',
    add: () => 'perch imap add --label NAME --email ADDRESS [--preset gmx] [--allow-drafts] [--allow-send] [--allow-modify]',
  },
  { key: 'calendar', title: 'Google Calendar/Contacts', match: (a) => a.family === 'calendar', does: 'calendars + contacts; opt-in: events, invitations', add: () => 'perch google add --label NAME --services calendar,contacts [--allow-calendar-write]' },
  { key: 'slack', title: 'Slack', match: (a) => a.family === 'slack', does: 'read, search and post (internal app, user token)', add: () => 'perch slack manifest, then perch slack add --label NAME' },
  {
    key: 'whatsapp',
    title: 'WhatsApp',
    match: (a) => a.family === 'whatsapp',
    does: 'read and send through the self-hosted GOWA bridge',
    add: (r) => (r.whatsappBridge ? 'perch whatsapp add --label NAME --phone +43…' : 'perch whatsapp install, then perch whatsapp add --label NAME --phone +43…'),
  },
  { key: 'luma', title: 'Luma', match: (a) => a.family === 'luma', does: 'events and guests through the official Luma MCP', add: () => 'perch luma add --label NAME' },
];

const WRITE_FREE = (cap: string) => cap === 'read' || cap.endsWith('_read');
const minute = (iso: string) => `${iso.replace('T', ' ').slice(0, 16)} UTC`;

/** The terminal rendering of `perch status`. Same data as formatStatusText; plain Unicode without a TTY. */
export function formatStatusTerminal(r: StatusReport, capabilities: CapabilityMap, opts: TerminalOptions): string {
  const W = Math.max(60, Math.min(opts.columns ?? 80, 120));
  const noColor = typeof opts.env.NO_COLOR === 'string' && opts.env.NO_COLOR !== '';
  const p = opts.tty && !noColor ? COLOR : PLAIN;
  const out: string[] = [];

  /** Left text and a right-aligned status; the left part is cut to make room. Inputs are plain text. */
  const row = (indent: number, mark: string, paintMark: (s: string) => string, left: string, right = '', paintRight: (s: string) => string = (s) => s) => {
    const pre = ' '.repeat(indent) + (mark ? `${mark} ` : '');
    const room = W - width(pre) - (right ? width(right) + 2 : 0);
    const l = fit(left, room);
    const gap = right ? ' '.repeat(Math.max(2, W - width(pre) - width(l) - width(right))) : '';
    out.push(`${' '.repeat(indent)}${mark ? `${paintMark(mark)} ` : ''}${l}${gap}${right ? paintRight(right) : ''}`.trimEnd());
  };
  const text = (indent: number, s: string, paint: (s: string) => string = (x) => x) => out.push(' '.repeat(indent) + paint(fit(s, W - indent)));
  const prose = (indent: number, s: string, paint: (s: string) => string = (x) => x) => {
    for (const l of wrap(s, W - indent)) out.push(' '.repeat(indent) + paint(l));
  };
  /** Commands are printed whole (cutting would break copy & paste); the terminal wraps them. */
  const command = (indent: number, s: string) => out.push(' '.repeat(indent) + clean(s));
  const section = (title: string) => {
    const t = `── ${clean(title)} `;
    out.push('', p.bold(t) + '─'.repeat(Math.max(3, W - width(t))));
  };

  // ---- header
  const head = `Perch ${r.version} · namespace ${r.namespace}`;
  const when = minute(r.generatedAt);
  out.push(p.bold(fit(head, W - width(when) - 2)) + ' '.repeat(Math.max(2, W - width(fit(head, W - width(when) - 2)) - width(when))) + when);
  out.push('═'.repeat(W));
  if (!r.checked) text(0, 'live checks skipped (--no-check)', p.hint);

  /** One account: status row, id line, ☑ chips, ☐ capabilities with the command that enables them. */
  const renderAccount = (a: AccountStatus, title: string) => {
    const failed = a.check?.state === 'error';
    const status = !a.check ? 'not checked' : a.check.state === 'ok' ? `ok · ${a.check.ms} ms` : a.check.state === 'skipped' ? 'skipped' : 'FAILED';
    row(0, failed ? FAIL : ON, failed ? p.fail : p.ok, title, status, failed ? p.fail : a.check ? p.ok : (s) => s);
    text(2, `${a.id} · ${a.provider} · since ${a.connectedAt.slice(0, 10)}`);
    if (failed && a.check?.message) prose(2, a.check.message, p.fail);
    const caps = capabilities[a.id] ?? [{ name: a.permissions, enabled: true }];
    chipLine(caps);
    const off = caps.filter((c) => !c.enabled);
    offLines(off);
    // Group members keep their ids when the group is updated; separate accounts get new ones when reconnected.
    if (off.length && !a.groupId) {
      const pinned = r.clients.filter((c) => !c.full && c.accountIds.includes(a.id));
      if (pinned.length) prose(4, `note: reconnecting gives a new account id; grant it again to ${pinned.map((c) => c.label).join(', ')}`, p.hint);
    }
    if (a.hint && !off.length) prose(2, `hint: ${a.hint}`, p.hint);
  };
  /** Enabled capabilities as one wrapped line of ☑ chips. */
  const chipLine = (caps: AccountCapability[], indent = 2) => {
    const chips = caps.filter((c) => c.enabled).map((c) => `${ON} ${clean(c.name)}`);
    let line = '';
    const flush = () => {
      if (line) out.push(`${' '.repeat(indent)}${line.split(ON).join(p.ok(ON))}`);
      line = '';
    };
    for (const chip of chips) {
      if (line && width(line) + 3 + width(chip) > W - indent) flush();
      line = line ? `${line}   ${chip}` : chip;
    }
    flush();
  };
  const offLines = (off: AccountCapability[]) => {
    for (const c of off) {
      row(2, OFF, (s) => s, `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
      if (c.enable) command(4, c.enable);
    }
  };
  const SERVICE_TITLE: Record<string, string> = { drive: 'Drive', gmail: 'Gmail', calendar: 'Calendar/Contacts' };

  // ---- Google account groups: one login, the services below it
  for (const g of r.googleGroups) {
    section(`Google · ${g.label}`);
    const members = r.accounts.filter((a) => a.groupId === g.id);
    const failed = members.filter((a) => a.check?.state === 'error').length;
    row(0, failed ? FAIL : ON, failed ? p.fail : p.ok, `${g.label}  ${g.email}`, `one login · ${g.services.length} service${g.services.length === 1 ? '' : 's'}`);
    text(2, `${g.id} · since ${g.connectedAt.slice(0, 10)}`);
    const caps = capabilities[g.id] ?? [];
    chipLine(caps);
    offLines(caps.filter((c) => !c.enabled));
    for (const a of members) {
      const name = a.family === 'drive' ? 'drive' : a.family === 'mail' ? 'gmail' : 'calendar';
      renderAccount(a, `${SERVICE_TITLE[name]}${a.identity ? `  ${a.identity}` : ''}`);
    }
  }

  // ---- connected services (accounts with their own login)
  const missing: typeof SERVICES = [];
  for (const svc of SERVICES) {
    const all = r.accounts.filter(svc.match);
    if (!all.length) {
      missing.push(svc);
      continue;
    }
    const rows = all.filter((a) => !a.groupId);
    if (!rows.length) continue;
    section(svc.title);
    for (const a of rows) renderAccount(a, `${a.label}${a.identity ? `  ${a.identity}` : ''}`);
  }

  if (missing.length) {
    section('Not connected');
    const nameW = Math.min(Math.max(...missing.map((s) => width(s.name ?? s.title))), 26);
    for (const svc of missing) {
      const name = fit(svc.name ?? svc.title, nameW).padEnd(nameW);
      row(0, OFF, (s) => s, `${name}  ${svc.does}`);
      command(4, svc.add(r));
    }
  }

  // ---- access
  section('Access');
  if (!r.clients.length) {
    row(0, OFF, (s) => s, 'no client yet (Claude, Codex, …)');
    command(4, 'perch client add --label NAME --full');
  }
  const labelOf = new Map(r.accounts.map((a) => [a.id, a.label]));
  for (const c of r.clients) {
    row(0, ON, p.ok, `client ${c.label}  ${c.id}`, c.full ? 'full access' : `${c.capabilities.length} capabilities`);
    if (c.full) text(4, 'read + write on every account, also later ones');
    else text(4, `${c.capabilities.join(', ')} → ${c.accountIds.map((id) => labelOf.get(id) ?? id).join(', ')}`);
  }
  const pub = r.publicAccess;
  if ('error' in pub) {
    row(0, FAIL, p.fail, 'public access', 'ERROR', p.fail);
    prose(4, pub.error, p.fail);
  } else if (pub.state === 'on') {
    row(0, ON, p.ok, 'public access (OAuth for claude.ai, ChatGPT …)', 'on', p.ok);
    text(4, `Perch code ${pub.totp ? 'set up' : 'missing'} · ${pub.allowedAccounts} allowed Google account(s) · ${pub.activeDevices} active device(s)${pub.lastPairedAt ? ` · last pairing ${minute(pub.lastPairedAt)}` : ''}${pub.pairingOpen ? ' · pairing window OPEN' : ''}`);
    if (!pub.totp) command(4, 'perch oauth totp setup');
  } else if (pub.state === 'off') {
    row(0, OFF, (s) => s, 'public access (OAuth for claude.ai, ChatGPT …)', 'OFF (kill switch)', p.hint);
    command(4, 'perch public on');
  } else {
    row(0, OFF, (s) => s, 'public access (OAuth for claude.ai, ChatGPT …)', 'not set up');
    command(4, 'perch public setup');
  }
  if (r.whatsappBridge) row(0, ON, p.ok, `WhatsApp bridge  ${r.whatsappBridge.origin}`);

  // ---- activity
  section('Activity');
  const l = r.ledger;
  if ('error' in l) {
    row(0, FAIL, p.fail, 'send ledger', 'ERROR', p.fail);
    prose(4, l.error, p.fail);
  } else {
    const label = `${l.sends} / ${l.maxSends} records`;
    const barW = Math.max(10, Math.min(30, W - 14 - width(label) - 3));
    const ratio = l.maxSends ? Math.min(1, l.sends / l.maxSends) : 0;
    const filled = l.sends > 0 ? Math.max(1, Math.round(ratio * barW)) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
    const paintBar = ratio >= 1 ? p.fail : ratio >= 0.8 ? p.hint : (s: string) => s;
    out.push(`Send ledger   ${paintBar(bar)}  ${label}`);
    if (l.pending) text(14, `${l.pending} pending (unknown outcome): perch mail-workflow list --state pending`, p.hint);
    out.push(fit(`Audit         ${l.auditEvents} events${l.auditDropped ? ` (+${l.auditDropped} rotated out)` : ''}${l.lastActivityAt ? ` · last activity ${minute(l.lastActivityAt)}` : ''}`, W));
  }

  // ---- onboarding checklist
  const writes = r.clients.some((c) => c.full || c.capabilities.some((cap) => !WRITE_FREE(cap)));
  const publicOn = !('error' in pub) && pub.state === 'on';
  const steps: Array<{ done: boolean; text: string; next?: string }> = [
    { done: r.accounts.length > 0, text: 'at least one account connected', next: 'perch setup' },
    { done: r.clients.length > 0, text: 'a client is set up', next: 'perch client add --label NAME --full' },
    { done: writes, text: 'a client may write (draft, send, organize, …)', next: 'perch client add --label NAME --full' },
    { done: publicOn, text: 'public access (optional)', next: 'perch public setup' },
  ];
  section(`Onboarding ${steps.filter((s) => s.done).length}/${steps.length}`);
  for (const s of steps) {
    row(0, s.done ? ON : OFF, s.done ? p.ok : (x) => x, s.text);
    if (!s.done && s.next) command(4, s.next);
  }
  row(0, OFF, (x) => x, 'reminder: keep a backup of the key file (PERCH_KEY_FILE); not checked');

  // ---- result
  out.push('', '═'.repeat(W));
  const failed = failedChecks(r);
  if (!r.checked) out.push(p.hint('· live checks skipped'));
  else if (failed) out.push(p.fail(`${FAIL} ${failed} check(s) failed`));
  else out.push(p.ok('✓ All checks passed'));
  return `${out.join('\n')}\n`;
}
