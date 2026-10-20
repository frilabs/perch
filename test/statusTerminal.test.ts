// Terminal rendering of `perch status` (docs/STATUS_UI_GOWA_HARDENING_SPEC.md §1) on hand-built, secret-bearing
// DUMMY store data: TTY vs. pipe vs. NO_COLOR, capability hints with the exact enabling commands, unconnected
// services, width handling, and that no secret or terminal escape from a label ever reaches the output.
import { describe, expect, it } from 'vitest';
import { GMAIL_READONLY_SCOPE } from '../src/mail/gmailAccounts.js';
import { SLACK_USER_SCOPES } from '../src/slack/slack.js';
import { formatStatusText, type StatusReport } from '../src/status/status.js';
import { accountCapabilities, fit, formatStatusTerminal, shellQuote } from '../src/status/terminal.js';
import type { StoreData } from '../src/store/credentialStore.js';

const AT = '2026-10-20T20:45:00.000Z';
const SECRETS = ['DUMMY-imap-password-1234', 'DUMMY-gowa-password-5678', 'DUMMY-gmail-refresh-9999', 'xoxp-DUMMY-slack-token'];
const ANSI = /\u001b\[/;

/** One GMX account (read, drafts, send), one WhatsApp account, one full client. */
function baseStore(): StoreData {
  return {
    version: 1,
    google: [],
    notion: [],
    gmail: [],
    microsoft: [],
    imap: [
      {
        id: 'imap-fac20c59',
        label: 'GMX',
        email: 'fritz@example.org',
        username: 'fritz@example.org',
        password: SECRETS[0]!,
        preset: 'gmx',
        imap: { host: 'imap.gmx.net', port: 993 },
        smtp: { host: 'mail.gmx.net', port: 465, security: 'tls' },
        allowDrafts: true,
        allowSend: true,
        allowModify: false,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    clients: [{ id: 'client-5cda7d00', label: 'Claude Code Mac', tokenSha256: 'a'.repeat(64), capabilities: ['read'], accountIds: [], full: true, createdAt: AT }],
    googleProductivity: [],
    users: [],
    slack: [],
    whatsappInstance: { origin: 'http://127.0.0.1:3000', username: 'perch', password: SECRETS[1]!, createdAt: AT, updatedAt: AT },
    whatsapp: [{ id: 'whatsapp-c3da7b43', label: 'Whatsapp', deviceId: 'perch-0123456789abcdef', jid: '4366012345678@s.whatsapp.net', createdAt: AT, updatedAt: AT }],
    luma: [],
  };
}

function baseReport(): StatusReport {
  return {
    generatedAt: AT,
    version: '0.1.0',
    namespace: 'root',
    checked: true,
    accounts: [
      { family: 'mail', id: 'imap-fac20c59', label: 'GMX', provider: 'imap (gmx)', identity: 'fritz@example.org', permissions: 'read, draft, send', connectedAt: AT, check: { state: 'ok', ms: 732 } },
      { family: 'whatsapp', id: 'whatsapp-c3da7b43', label: 'Whatsapp', provider: 'gowa', identity: '+4366012345678', permissions: 'read, send', connectedAt: AT, check: { state: 'ok', ms: 16 } },
    ],
    clients: [{ id: 'client-5cda7d00', label: 'Claude Code Mac', capabilities: ['read'], accountIds: [], full: true, createdAt: AT }],
    whatsappBridge: { origin: 'http://127.0.0.1:3000', configuredAt: AT },
    ledger: { sends: 0, maxSends: 1000, pending: 0, auditEvents: 0, auditDropped: 0 },
    publicAccess: { state: 'not_set_up', totp: false, allowedAccounts: 0, activeDevices: 0 },
  };
}

const render = (r: StatusReport, d: StoreData, opts: Partial<Parameters<typeof formatStatusTerminal>[2]> = {}) =>
  formatStatusTerminal(r, accountCapabilities(d), { tty: false, env: {}, ...opts });

describe('perch status terminal rendering', () => {
  it('renders sections, checkboxes and the result without ANSI when not a TTY', () => {
    const out = render(baseReport(), baseStore());
    expect(out).not.toMatch(ANSI);
    expect(out).toMatch(/^Perch 0\.1\.0 · namespace root +2026-10-20 20:45 UTC\n═{80}\n/);
    expect(out).toMatch(/── Mail · IMAP \(GMX …\) ─+\n☑ GMX  fritz@example\.org +ok · 732 ms\n {2}imap-fac20c59 · imap \(gmx\) · since 2026-10-20\n {2}☑ read {3}☑ drafts {3}☑ send\n/);
    expect(out).toMatch(/── WhatsApp ─+\n☑ Whatsapp  \+4366012345678 +ok · 16 ms\n/);
    expect(out).toMatch(/☑ client Claude Code Mac  client-5cda7d00 +full access\n {4}read \+ write on every account, also later ones/);
    expect(out).toMatch(/☐ public access \(OAuth for claude\.ai, ChatGPT …\) +not set up\n {4}perch public setup\n/);
    expect(out).toMatch(/☑ WhatsApp bridge  http:\/\/127\.0\.0\.1:3000/);
    expect(out).toMatch(/Send ledger {3}░{10,30}  0 \/ 1000 records\nAudit {9}0 events/);
    expect(out).toMatch(/── Onboarding 3\/4 ─+\n☑ at least one account connected\n☑ a client is set up\n☑ a client may write/);
    expect(out).toMatch(/☐ reminder: keep a backup of the key file/);
    expect(out.trimEnd().split('\n').pop()).toBe('✓ All checks passed');
    for (const line of out.split('\n')) if (!line.startsWith('    perch ')) expect([...line].length, line).toBeLessThanOrEqual(80);
  });

  it('colours only status on a TTY, and NO_COLOR turns colour off', () => {
    const r = baseReport();
    r.accounts[1]!.check = { state: 'error', message: 'Not logged in to WhatsApp: pair again with perch whatsapp add', ms: 5 };
    const tty = render(r, baseStore(), { tty: true, columns: 100 });
    expect(tty).toContain('\u001b[32m☑\u001b[0m GMX');
    expect(tty).toContain('\u001b[31m✗\u001b[0m Whatsapp');
    expect(tty).toContain('\u001b[31mNot logged in to WhatsApp');
    expect(tty).toContain('\u001b[31m✗ 1 check(s) failed\u001b[0m');
    // The ☐ hint stays monochrome; colour is for status only.
    expect(tty).toMatch(/\n {2}☐ organize/);
    for (const env of [{ NO_COLOR: '1' }, { NO_COLOR: 'true' }]) {
      const out = render(r, baseStore(), { tty: true, columns: 100, env });
      expect(out).not.toMatch(ANSI);
      expect(out).toContain('✗ Whatsapp');
      expect(out).toContain('☑ GMX');
    }
    // NO_COLOR="" does not count (no-color.org).
    expect(render(r, baseStore(), { tty: true, env: { NO_COLOR: '' } })).toMatch(ANSI);
  });

  it('shows a missing IMAP capability with the exact command that keeps the other opt-ins', () => {
    const out = render(baseReport(), baseStore());
    expect(out).toContain(
      '  ☐ organize (flags, move, archive, trash)\n' +
        '    perch imap remove imap-fac20c59 && perch imap add --label GMX --email fritz@example.org --preset gmx --allow-drafts --allow-send --allow-modify\n',
    );
    expect(out).not.toMatch(/☐ (read|drafts|send)\b/);
  });

  it('keeps non-default IMAP settings in the command and quotes labels for the shell', () => {
    const d = baseStore();
    Object.assign(d.imap[0]!, {
      label: "Fritz's mail",
      preset: undefined,
      username: 'fritz',
      imap: { host: 'imap.example.org', port: 993 },
      smtp: { host: 'smtp.example.org', port: 587, security: 'starttls' },
      allowDrafts: false,
      allowSend: false,
      allowModify: true,
      draftsMailbox: 'Entwürfe',
      sentCopy: false,
    });
    const caps = accountCapabilities(d)['imap-fac20c59']!;
    expect(caps.map((c) => [c.name, c.enabled])).toEqual([['read', true], ['drafts', false], ['send', false], ['organize', true]]);
    expect(caps.find((c) => c.name === 'send')!.enable).toBe(
      "perch imap remove imap-fac20c59 && perch imap add --label 'Fritz'\\''s mail' --email fritz@example.org --username fritz " +
        '--imap-host imap.example.org --imap-port 993 --smtp-host smtp.example.org --smtp-port 587 --smtp-security starttls ' +
        "--allow-send --allow-modify --drafts-mailbox 'Entwürfe' --no-sent-copy",
    );
    expect(shellQuote('a b')).toBe("'a b'");
  });

  it('derives Gmail, Microsoft, Drive, Calendar and Slack capabilities from the stored scopes', () => {
    const d = baseStore();
    d.gmail.push({ id: 'gmail-0000000a', label: 'Work Gmail', email: 'w@example.test', clientId: 'c', clientSecret: 'DUMMY-secret', refreshToken: SECRETS[2]!, scopes: [GMAIL_READONLY_SCOPE], createdAt: AT, updatedAt: AT });
    d.microsoft.push({ id: 'microsoft-0000000a', label: 'Outlook', email: 'o@example.test', tenant: 'common', clientId: 'c', refreshToken: 'DUMMY-ms', scopes: ['Mail.Read', 'Mail.Send'], createdAt: AT, updatedAt: AT });
    d.google.push({ id: 'google-0000000a', label: 'Drive', email: 'd@example.test', clientId: 'c', clientSecret: 'DUMMY-secret', refreshToken: 'DUMMY-drive', scopes: ['https://www.googleapis.com/auth/drive.readonly'], createdAt: AT, updatedAt: AT });
    d.googleProductivity.push({
      id: 'gprod-0000000a',
      label: 'Calendar',
      email: 'c@example.test',
      sub: '1',
      clientId: 'c',
      clientSecret: 'DUMMY-secret',
      refreshToken: 'DUMMY-gprod',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      services: ['calendar'],
      allowCalendarWrite: false,
      createdAt: AT,
      updatedAt: AT,
    });
    d.slack.push({ id: 'slack-0000000a', label: 'Company', token: SECRETS[3]!, teamId: 'T123', userId: 'U123', scopes: SLACK_USER_SCOPES.filter((s) => s !== 'im:write' && s !== 'mpim:write'), createdAt: AT, updatedAt: AT });
    const caps = accountCapabilities(d);
    const off = (id: string) => caps[id]!.filter((c) => !c.enabled).map((c) => [c.name, c.enable]);
    expect(off('gmail-0000000a')).toEqual([
      ['drafts', 'perch gmail remove gmail-0000000a && perch gmail add --label \'Work Gmail\' --allow-drafts --login-hint w@example.test'],
      ['send', 'perch gmail remove gmail-0000000a && perch gmail add --label \'Work Gmail\' --allow-send --login-hint w@example.test'],
      ['organize', 'perch gmail remove gmail-0000000a && perch gmail add --label \'Work Gmail\' --allow-modify --login-hint w@example.test'],
    ]);
    // Mail.ReadWrite covers drafts and organizing; the stored Mail.Send is kept in the command.
    expect(off('microsoft-0000000a')).toEqual([
      ['drafts', 'perch microsoft remove microsoft-0000000a && perch microsoft add --label Outlook --allow-drafts --allow-send --login-hint o@example.test'],
      ['organize', 'perch microsoft remove microsoft-0000000a && perch microsoft add --label Outlook --allow-send --allow-modify --login-hint o@example.test'],
    ]);
    expect(off('google-0000000a')).toEqual([['write', 'perch google remove google-0000000a && perch google add --label Drive --allow-write --login-hint d@example.test']]);
    const cal = 'perch google-productivity remove gprod-0000000a && perch google-productivity add --label Calendar --services calendar';
    expect(off('gprod-0000000a')).toEqual([
      ['contacts', `${cal},contacts --login-hint c@example.test`],
      ['calendar write', `${cal} --allow-calendar-write --login-hint c@example.test`],
      ['invitations', `${cal} --allow-calendar-write --login-hint c@example.test`],
    ]);
    expect(off('slack-0000000a')).toEqual([
      ['open DMs', 'reinstall the Slack app with the current manifest (perch slack manifest), then perch slack remove slack-0000000a && perch slack add --label Company'],
    ]);
  });

  it('lists unconnected services with their add command and a one-line description', () => {
    const out = render(baseReport(), baseStore());
    const block = out.slice(out.indexOf('── Not connected'), out.indexOf('── Access'));
    for (const [title, cmd] of [
      ['Google Drive', 'perch google add --label NAME [--allow-write]'],
      ['Notion', 'perch notion add --label NAME'],
      ['Gmail', 'perch gmail add --label NAME [--allow-drafts] [--allow-send] [--allow-modify]'],
      ['Outlook / Microsoft 365', 'perch microsoft add --label NAME'],
      ['Google Calendar/Contacts', 'perch google-productivity add --label NAME --services calendar,contacts [--allow-calendar-write]'],
      ['Slack', 'perch slack manifest, then perch slack add --label NAME'],
      ['Luma', 'perch luma add --label NAME'],
    ]) {
      expect(block).toMatch(new RegExp(`☐ ${title!.replace(/[/()]/g, '\\$&')} +\\S`));
      expect(block).toContain(`    ${cmd}`);
    }
    expect(block).not.toMatch(/IMAP|WhatsApp/);
    // Without a bridge the WhatsApp hint starts with the installer.
    const r = baseReport();
    r.accounts = [];
    delete r.whatsappBridge;
    r.clients = [];
    const empty = render(r, { ...baseStore(), imap: [], whatsapp: [], clients: [] });
    expect(empty).toContain('    perch whatsapp install, then perch whatsapp add --label NAME --phone +43…');
    expect(empty).toContain('☐ no client yet');
    expect(empty).toMatch(/── Onboarding 0\/4/);
  });

  it('adapts to the terminal width (min 60) and cuts long values', () => {
    const r = baseReport();
    r.accounts[0]!.label = `Very long label ${'x'.repeat(200)}`;
    for (const [columns, w] of [[40, 60], [72, 72], [300, 120]] as const) {
      const out = render(r, baseStore(), { columns });
      expect(out.split('\n')[1]).toBe('═'.repeat(w));
      const line = out.split('\n').find((l) => l.startsWith('☑ Very long'))!;
      expect([...line].length).toBe(w);
      expect(line).toMatch(/…  ok · 732 ms$/);
    }
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('abc', 4)).toBe('abc');
  });

  it('never prints a secret or a terminal escape from a label', () => {
    const d = baseStore();
    const r = baseReport();
    d.imap[0]!.label = 'evil\u001b[2J\u0007label';
    r.accounts[0]!.label = d.imap[0]!.label;
    for (const opts of [{ tty: false }, { tty: true }]) {
      const out = render(r, d, opts);
      for (const s of SECRETS) expect(out).not.toContain(s);
      expect(out).not.toContain('\u001b[2J');
      expect(out).not.toContain('\u0007');
    }
  });

  it('shows a failed check, skipped checks and a full ledger', () => {
    const r = baseReport();
    r.accounts[0]!.check = { state: 'error', message: 'Internal error (details withheld)', ms: 3 };
    r.ledger = { sends: 1000, maxSends: 1000, pending: 2, auditEvents: 12, auditDropped: 3, lastActivityAt: AT };
    const out = render(r, baseStore());
    expect(out).toMatch(/✗ GMX  fritz@example\.org +FAILED\n {2}imap-fac20c59 · imap \(gmx\) · since 2026-10-20\n {2}Internal error \(details withheld\)\n/);
    expect(out).toMatch(/Send ledger {3}█+  1000 \/ 1000 records\n {14}2 pending/);
    expect(out).toMatch(/Audit {9}12 events \(\+3 rotated out\) · last activity 2026-10-20 20:45 UTC/);
    expect(out.trimEnd().split('\n').pop()).toBe('✗ 1 check(s) failed');
    const skipped = render({ ...baseReport(), checked: false, accounts: baseReport().accounts.map(({ check: _c, ...a }) => a) }, baseStore());
    expect(skipped).toMatch(/☑ GMX  fritz@example\.org +not checked/);
    expect(skipped.trimEnd().split('\n').pop()).toBe('· live checks skipped');
  });

  it('keeps the plain renderer unchanged', () => {
    expect(formatStatusText(baseReport())).toBe(
      [
        'Perch 0.1.0 · namespace root · 2026-10-20 20:45 UTC',
        '',
        'Google Drive: none',
        'Notion: none',
        'Mail',
        '  ✓ imap-fac20c59  "GMX"  fritz@example.org  [imap (gmx): read, draft, send]  since 2026-10-20  ok (732 ms)',
        'Google Calendar/Contacts: none',
        'Slack: none',
        'WhatsApp',
        '  ✓ whatsapp-c3da7b43  "Whatsapp"  +4366012345678  [gowa: read, send]  since 2026-10-20  ok (16 ms)',
        'Luma: none',
        '',
        'Client grants',
        '  client-5cda7d00  "Claude Code Mac"  FULL access → every account (also later ones)',
        '',
        'WhatsApp bridge: http://127.0.0.1:3000',
        '',
        'Send ledger: 0 / 1000 records used',
        'Audit: 0 events',
        'Public access: not set up · Perch code missing · 0 allowed Google account(s) · 0 active device(s)',
        '',
        'All checks passed.',
        '',
      ].join('\n'),
    );
  });
});
