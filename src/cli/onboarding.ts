import { existsSync } from 'node:fs';
import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';

/**
 * Easier onboarding (2026-10-20):
 * - every `perch <service> add` with provider-side write permissions asks "read only or read + write?"
 *   (or takes --read-only / --write) and requests the matching provider scopes;
 * - `perch setup` walks through every service and finally creates one full-access client for Claude Code.
 * Writing still needs a client grant (perch client add --full is the one-step way).
 */

/** Provider opt-in flags that "write" turns on, per command (services without provider-side scopes are absent). */
export const WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  google: ['allow-write'],
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

const yes = (a: string, def = false) => {
  const v = a.trim().toLowerCase();
  return v === '' ? def : v === 'y' || v === 'yes' || v === 'j' || v === 'ja';
};

interface SetupService {
  cmd: string;
  title: string;
  /** Shown before the first account: what has to exist already. */
  needs: (config: PerchConfig) => string | undefined;
  /** Extra arguments for `add` (asked interactively). */
  args: (ask: Ask) => Promise<string[]>;
}

const tunnel = (port: number) =>
  `The login opens in your browser and returns to 127.0.0.1:${port} on this server. If the browser runs on your laptop, first run there: ssh -N -L ${port}:127.0.0.1:${port} <this server>\n`;

const SERVICES: readonly SetupService[] = [
  {
    cmd: 'google',
    title: 'Google Drive',
    needs: (c) =>
      c.googleClientFile && existsSync(c.googleClientFile)
        ? tunnel(8766)
        : 'Needs a Google Cloud OAuth client of type "Desktop app" (docs/SETUP.md §3.1) saved as a 0600 file, and PERCH_GOOGLE_CLIENT_FILE set to it in .env. Skip for now if you have not done that.\n',
    args: async () => ['--port', '8766'],
  },
  {
    cmd: 'gmail',
    title: 'Gmail',
    needs: (c) => (c.googleClientFile && existsSync(c.googleClientFile) ? tunnel(8766) : 'Needs the same Google OAuth client as Drive (PERCH_GOOGLE_CLIENT_FILE).\n'),
    args: async () => ['--port', '8766'],
  },
  {
    cmd: 'google-productivity',
    title: 'Google Calendar and Contacts',
    needs: (c) => (c.googleClientFile && existsSync(c.googleClientFile) ? tunnel(8766) : 'Needs the same Google OAuth client as Drive (PERCH_GOOGLE_CLIENT_FILE).\n'),
    args: async () => ['--services', 'calendar,contacts', '--port', '8766'],
  },
  {
    cmd: 'microsoft',
    title: 'Outlook / Microsoft 365',
    needs: (c) => (c.microsoftClientId ? tunnel(8766) : 'Needs an Entra app registration and PERCH_MICROSOFT_CLIENT_ID in .env (docs/SETUP.md §4a.2).\n'),
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
      'Create a personal access token per workspace (notion.so/my-integrations); for writing enable "Read/Update/Insert content" and "Read/Insert comments", and share the pages with it. The token is asked hidden.\n',
    args: async () => [],
  },
  {
    cmd: 'slack',
    title: 'Slack',
    needs: () =>
      'Per workspace: create an app from the manifest (perch slack manifest) at api.slack.com/apps, install it, copy the "User OAuth Token" (xoxp-…). It is asked hidden.\n',
    args: async () => [],
  },
  {
    cmd: 'whatsapp',
    title: 'WhatsApp (via the self-hosted GOWA bridge, unofficial)',
    needs: () => 'Needs a running GOWA bridge on this server (docs/SETUP.md §4f) and `perch whatsapp instance set --url http://127.0.0.1:3000` done once.\n',
    args: async (ask) => {
      const phone = (await ask('  Phone number in international format (e.g. +4366012345678): ')).trim();
      return ['--phone', phone];
    },
  },
  {
    cmd: 'luma',
    title: 'Luma',
    needs: () => tunnel(8768),
    args: async () => ['--port', '8768'],
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
): Promise<number> {
  const ask = io.readLine;
  if (!ask) throw new PerchError('perch setup needs an interactive terminal', 'no_tty');
  io.stdout('Perch setup: connect your accounts step by step. Every step can be skipped; run perch setup again any time.\n\n');
  if ((await run(['init'])) !== 0) return 1;
  io.stdout('\n');
  for (const s of SERVICES) {
    if (!yes(await ask(`Connect ${s.title}? [y/N] `))) continue;
    const hint = s.needs(config);
    if (hint) io.stdout(hint);
    for (let more = true; more; more = yes(await ask(`Connect another ${s.title} account? [y/N] `))) {
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
