import { existsSync } from 'node:fs';
import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';
import { GOOGLE_SERVICES, parseGoogleServices, type GoogleService } from '../google/group.js';

/**
 * Easier onboarding (2026-10-20):
 * - every `perch <service> add` with provider-side write permissions asks "read only or read + write?"
 *   (or takes --read-only / --write) and requests the matching provider scopes;
 * - `perch setup` walks through every service and finally creates one full-access client for Claude Code.
 * Writing still needs a client grant (perch client add --full is the one-step way).
 */

/** Provider opt-in flags that "write" turns on, per command (services without provider-side scopes are absent). */
export const WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // One Google login for every service: "write" turns on each selected service's write opt-in (perch google add
  // ignores the flags of services that were not selected).
  google: ['allow-write', 'allow-drafts', 'allow-send', 'allow-modify', 'allow-calendar-write'],
  gmail: ['allow-drafts', 'allow-send', 'allow-modify'],
  microsoft: ['allow-drafts', 'allow-send', 'allow-modify'],
  imap: ['allow-drafts', 'allow-send', 'allow-modify'],
  'google-productivity': ['allow-calendar-write'],
};

export type Ask = (prompt: string) => Promise<string>;

/**
 * Decides read-only vs read + write for a new account and sets the provider opt-in flags in `values`.
 * Explicit legacy flags (--allow-…) win; without a terminal the account is connected read-only.
 * Returns true when write access was requested.
 */
export async function chooseAccess(cmd: string, values: Record<string, unknown>, ask: Ask | undefined, note: (s: string) => void): Promise<boolean> {
  const flags = WRITE_FLAGS[cmd];
  if (!flags) return false;
  const legacy = flags.filter((f) => values[f] === true);
  if (values.write === true && values['read-only'] === true) throw new PerchError('Choose either --write or --read-only', 'usage');
  if (values['read-only'] === true) {
    if (legacy.length) throw new PerchError(`--read-only cannot be combined with ${legacy.map((f) => `--${f}`).join(', ')}`, 'usage');
    return false;
  }
  if (values.write === true) {
    for (const f of flags) values[f] = true;
    return true;
  }
  if (legacy.length) return true;
  let answer: string;
  try {
    if (!ask) throw new PerchError('no terminal', 'no_tty');
    answer = (await ask('Access for this account: [r]ead only, or read + [w]rite? [r/w] ')).trim().toLowerCase();
  } catch {
    note('No interactive terminal: connecting read-only (repeat with --write for write access).\n');
    return false;
  }
  if (answer === 'w' || answer === 'write') {
    for (const f of flags) values[f] = true;
    return true;
  }
  if (answer === '' || answer === 'r' || answer === 'read') return false;
  throw new PerchError('Answer r (read only) or w (read + write)', 'usage');
}

/**
 * Services for `perch google add`: --services wins; otherwise asked (Enter = all); without a terminal all of them.
 */
export async function chooseGoogleServices(values: Record<string, unknown>, ask: Ask | undefined, note: (s: string) => void): Promise<GoogleService[]> {
  if (typeof values.services === 'string') return parseGoogleServices(values.services.split(','));
  const all = [...GOOGLE_SERVICES];
  let answer: string;
  try {
    if (!ask) throw new PerchError('no terminal', 'no_tty');
    answer = await ask(`Google services to connect [${all.join(',')}] (Enter = all): `);
  } catch {
    note(`No interactive terminal: connecting all Google services (${all.join(', ')}); choose with --services.\n`);
    return all;
  }
  return answer.trim() ? parseGoogleServices(answer.split(/[\s,]+/)) : all;
}

export const yes = (a: string, def = false) => {
  const v = a.trim().toLowerCase();
  return v === '' ? def : v === 'y' || v === 'yes' || v === 'j' || v === 'ja';
};

interface SetupService {
  cmd: string;
  title: string;
  /** Wording of the "connect another …?" question (default: another <title> account). */
  another?: string;
  /** Shown before the first account: what has to exist already. */
  needs: (config: PerchConfig) => string | undefined;
  /** Extra arguments for `add` (asked interactively). */
  args: (ask: Ask) => Promise<string[]>;
  /** Runs once after the service was chosen; false skips the service (prerequisite missing). */
  prepare?: (ctx: SetupContext) => Promise<boolean>;
}

export interface SetupHooks {
  /** True when a WhatsApp bridge is stored in Perch. */
  whatsappConfigured?: () => Promise<boolean>;
}

interface SetupContext {
  ask: Ask;
  run: (argv: string[]) => Promise<number>;
  io: { stdout: (s: string) => void; stderr: (s: string) => void };
  hooks: SetupHooks;
}

/**
 * WhatsApp in setup: without a stored bridge, run `perch whatsapp install` (it shows the warning and asks
 * [y/N] itself), then pair. Declined or failed: skip WhatsApp.
 */
async function prepareWhatsapp({ run, io, hooks }: SetupContext): Promise<boolean> {
  if (!hooks.whatsappConfigured || (await hooks.whatsappConfigured())) return true;
  io.stdout('No WhatsApp bridge is configured yet. Perch can install GOWA on this server now (perch whatsapp install, Linux with systemd).\n');
  if ((await run(['whatsapp', 'install'])) !== 0) {
    io.stdout('Skipping WhatsApp. Later: perch whatsapp install, or install GOWA by hand (docs/SETUP.md §4f) and run perch whatsapp instance set.\n');
    return false;
  }
  return true;
}

const tunnel = (port: number) =>
  'The login opens in your browser. Afterwards the browser shows "This site can\'t be reached" (it tries 127.0.0.1 on your laptop): ' +
  `copy the complete address from its address bar and paste it here. Or: tunnel first, on the laptop: ssh -N -L ${port}:127.0.0.1:${port} <this server>\n`;

const SERVICES: readonly SetupService[] = [
  {
    // One step and one Google login for Drive, Gmail, Calendar and Contacts (docs/GOOGLE_UNIFIED_SPEC.md).
    cmd: 'google',
    title: 'Google account (Drive, Gmail, Calendar, Contacts)',
    another: 'another Google account',
    needs: (c) =>
      existsSync(c.googleClientFile ?? c.googleClientDefaultFile)
        ? tunnel(8766)
        : 'First Perch walks you through your own Google Cloud OAuth client (once, about 10 minutes, links included).\n' + tunnel(8766),
    args: async () => ['--port', '8766'],
  },
  {
    cmd: 'microsoft',
    title: 'Outlook / Microsoft 365',
    needs: (c) =>
      c.microsoftClientId
        ? tunnel(8766)
        : 'Needs your own Entra app registration (once per installation): Perch guides you through it step by step first.\n' + tunnel(8766),
    args: async () => ['--port', '8766'],
  },
  {
    cmd: 'imap',
    title: 'GMX or another IMAP/SMTP mailbox',
    needs: () => 'GMX: allow IMAP in the GMX settings; with two-factor sign-in use an app password. The password is asked hidden.\n',
    args: async (ask) => {
      const email = (await ask('  E-mail address: ')).trim();
      if (!email) throw new PerchError('An e-mail address is required', 'usage');
      const gmx = /@gmx\.(at|de|net|ch)$/i.test(email) ? ['--preset', 'gmx'] : /@gmx\.com$/i.test(email) ? ['--preset', 'gmx-com'] : [];
      if (!gmx.length) {
        const host = (await ask('  IMAP server (e.g. imap.example.org): ')).trim();
        const smtp = (await ask('  SMTP server (e.g. smtp.example.org): ')).trim();
        return ['--email', email, '--imap-host', host, '--imap-port', '993', '--smtp-host', smtp, '--smtp-port', '465', '--smtp-security', 'tls'];
      }
      return ['--email', email, ...gmx];
    },
  },
  {
    cmd: 'notion',
    title: 'Notion',
    needs: () =>
      'Per workspace: a token (Perch shows the steps) or OAuth (no owner rights needed).\n',
    args: async () => [],
  },
  {
    cmd: 'slack',
    title: 'Slack',
    needs: () =>
      'Per workspace: either the Slack app (official; Perch shows the manifest and the steps, then asks for the "User OAuth Token" xoxp-… hidden) ' +
      'or your browser session (unofficial, no admin needed; Perch warns first and shows how to copy cookie and token).\n',
    args: async () => [],
  },
  {
    cmd: 'whatsapp',
    title: 'WhatsApp (via the self-hosted GOWA bridge, unofficial)',
    needs: () => 'Pairing shows a code to enter on the phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead".\n',
    args: async (ask) => {
      const phone = (await ask('  Phone number in international format (e.g. +4366012345678): ')).trim();
      return ['--phone', phone];
    },
    prepare: prepareWhatsapp,
  },
  {
    cmd: 'luma',
    title: 'Luma',
    needs: () => tunnel(8768),
    args: async () => ['--port', '8768'],
  },
  {
    cmd: 'linkedin',
    title: 'LinkedIn (post to your own profile)',
    needs: (c) =>
      existsSync(c.linkedinClientFile)
        ? tunnel(8770)
        : 'First Perch walks you through your own LinkedIn app (once; LinkedIn requires a company page for it).\n' + tunnel(8770),
    args: async () => [],
  },
];

/**
 * `perch setup`: guided onboarding. Runs the regular commands through `run` (same checks, hidden prompts),
 * so it adds no new way to store credentials.
 */
export async function runSetup(
  config: PerchConfig,
  io: { stdout: (s: string) => void; stderr: (s: string) => void; readLine?: Ask },
  run: (argv: string[]) => Promise<number>,
  hooks: SetupHooks = {},
): Promise<number> {
  const ask = io.readLine;
  if (!ask) throw new PerchError('perch setup needs an interactive terminal', 'no_tty');
  io.stdout('Perch setup: connect your accounts step by step. Every step can be skipped; run perch setup again any time.\n\n');
  if ((await run(['init'])) !== 0) return 1;
  io.stdout('\n');
  for (const s of SERVICES) {
    if (!yes(await ask(`Connect ${s.title}? [y/N] `))) continue;
    if (s.prepare && !(await s.prepare({ ask, run, io, hooks }))) {
      io.stdout('\n');
      continue;
    }
    const hint = s.needs(config);
    if (hint) io.stdout(hint);
    for (let more = true; more; more = yes(await ask(`Connect ${s.another ?? `another ${s.title} account`}? [y/N] `))) {
      const label = (await ask('  Label for this account (e.g. Private, Work): ')).trim() || 'Private';
      try {
        const code = await run([s.cmd, 'add', '--label', label, ...(await s.args(ask))]);
        if (code !== 0) io.stderr(`${s.title} "${label}" was not connected (see the message above).\n`);
      } catch (err) {
        io.stderr(`${s.title} "${label}" was not connected: ${err instanceof Error ? err.message : 'error'}\n`);
      }
    }
    io.stdout('\n');
  }
  if (yes(await ask('Create a client with full access (read and write, every account, also later ones) for Claude Code or Codex? [Y/n] '), true)) {
    const label = (await ask('  Client label (e.g. Claude Code): ')).trim() || 'Claude Code';
    await run(['client', 'add', '--label', label, '--full']);
  }
  io.stdout('\nOverview (live checks: perch status):\n');
  await run(['status', '--no-check']);
  return 0;
}

/** Ready-to-paste command for Claude Code on the laptop, reading the token over SSH (never printed). */
export function claudeAddCommand(config: PerchConfig, tokenFile: string): string {
  const host = config.allowedHosts.find((h) => !/^(127\.|localhost|\[::1\])/.test(h));
  const url = host ? `https://${host}/mcp` : 'https://<your-server>.<tailnet>.ts.net/mcp';
  return (
    'On the laptop (Claude Code):\n' +
    `  TOKEN="$(ssh <this server> 'cat ${tokenFile}')"\n` +
    `  claude mcp add --scope user --transport http perch ${url} --header "Authorization: Bearer \${TOKEN}"\n` +
    '  unset TOKEN; chmod 600 ~/.claude.json\n'
  );
}
