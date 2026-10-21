import { PerchError } from '../errors.js';
import { SLACK_APP_MANIFEST } from '../slack/manifest.js';
import { yes } from './onboarding.js';

export const SLACK_NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';
export const SLACK_WEB_CLIENT_URL = 'https://app.slack.com/client';

interface Io {
  stdout: (s: string) => void;
  readLine?: (prompt: string) => Promise<string>;
}

/** True when the prompt failed only because there is no terminal (then the caller falls back). */
const noTty = (e: unknown) => e instanceof PerchError && e.code === 'no_tty';

/**
 * Guide before the Slack token prompt (docs/GUIDED_PROVIDER_SETUP_SPEC.md §4): manifest, link, steps, Enter.
 * Skipped with --skip-guide, without a terminal (the masked prompt then fails as before), and asked
 * ("Show …? [y/N]") when a workspace is already connected. Returns true when the guide was shown.
 */
export async function maybeShowSlackGuide(io: Io, opts: { skip: boolean; hasWorkspace: boolean }): Promise<boolean> {
  const ask = io.readLine;
  if (opts.skip || !ask) return false;
  if (opts.hasWorkspace && !yes(await ask('Show the steps to create the Slack app for this workspace? [y/N] '))) return false;
  io.stdout(
    '\nSlack: create one internal Slack app per workspace from this manifest (user scopes only; Perch acts as you):\n\n' +
      `${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n\n` +
      `1. Open ${SLACK_NEW_APP_URL}\n` +
      '2. Choose "From a manifest" and pick the workspace.\n' +
      '3. Paste the manifest above (JSON tab), then Next → Create.\n' +
      '4. "Install to Workspace" (OAuth & Permissions) and allow.\n' +
      '5. Copy the "User OAuth Token" (starts with xoxp-) from OAuth & Permissions.\n\n',
  );
  await ask('Press Enter when you have copied the User OAuth Token. ');
  return true;
}

/**
 * App or session (docs/SLACK_SESSION_NOTION_GUIDE_SPEC.md §1), asked only on a terminal when neither --session
 * was given. Anything but "s" means the app (the official way); without a terminal it stays the app.
 */
export async function chooseSlackMode(io: Io): Promise<'app' | 'session'> {
  if (!io.readLine) return 'app';
  let answer: string;
  try {
    answer = await io.readLine(
      'Connect with\n' +
        '  [a]pp      official; needs the Perch app installed (often an admin approval)\n' +
        '  [s]ession  unofficial; your browser session, no admin needed\n' +
        'Choice [a/s]: ',
    );
  } catch (e) {
    if (noTty(e)) return 'app';
    throw e;
  }
  return answer.trim().toLowerCase().startsWith('s') ? 'session' : 'app';
}

export const SLACK_SESSION_WARNING =
  '\nSlack session mode is UNOFFICIAL. Perch then uses your browser session (token\n' +
  'xoxc-… and cookie d=xoxd-…) instead of an installed app:\n' +
  "  - This probably violates Slack's terms and may violate your organisation's\n" +
  '    policies. Company workspaces can detect it and sign you out or suspend\n' +
  '    the account.\n' +
  '  - Token and cookie are as powerful as your password: whoever has them reads\n' +
  '    and writes as you. Perch stores them encrypted and never prints them.\n' +
  '  - The session ends when you sign out of Slack in that browser; then run this\n' +
  '    command again (it updates the same workspace).\n\n';

/**
 * Warning before session mode, then [y/N]. --yes accepts it (required without a terminal); otherwise anything
 * but "y" aborts. Throws when not confirmed, so nothing is asked or stored.
 */
export async function confirmSlackSession(io: Io, opts: { yes: boolean }): Promise<void> {
  io.stdout(SLACK_SESSION_WARNING);
  if (opts.yes) return;
  const refuse = () => new PerchError('Session mode needs a confirmation: answer y on a terminal, or rerun with --yes. Nothing was stored', 'confirmation_required');
  if (!io.readLine) throw refuse();
  let answer: string;
  try {
    answer = await io.readLine('Use session mode anyway? [y/N] ');
  } catch (e) {
    if (noTty(e)) throw refuse();
    throw e;
  }
  if (!yes(answer)) throw new PerchError('Not confirmed; nothing was stored', 'aborted');
}

/**
 * Browser console line that prints the name and the session token (xoxc-…) of the workspace open in the tab.
 * The Slack web client keeps its teams in localStorage.localConfig_v2, keyed by team id; the open team is the
 * id in the address (/client/T…/…), else the last active one.
 */
export const SLACK_TOKEN_CONSOLE_LINE =
  "c = JSON.parse(localStorage.localConfig_v2); t = c.teams[location.pathname.split('/')[2]] || c.teams[c.lastActiveTeamId]; console.log(t.name + '\\n' + t.token)";

/**
 * Steps to copy cookie and token from the browser (session mode). Same rules as maybeShowSlackGuide, except that
 * the [y/N] question comes only when a session workspace already exists (Enter skips the steps).
 */
export async function maybeShowSlackSessionGuide(io: Io, opts: { skip: boolean; hasWorkspace: boolean }): Promise<boolean> {
  const ask = io.readLine;
  if (opts.skip || !ask) return false;
  try {
    if (opts.hasWorkspace && !yes(await ask('Show the steps to copy cookie and token from the browser again? [y/N, Enter skips] '))) return false;
  } catch (e) {
    if (noTty(e)) return false;
    throw e;
  }
  io.stdout(
    '\nSlack session: copy two values from the Slack web app in your browser.\n\n' +
      `1. Open ${SLACK_WEB_CLIENT_URL} and sign in to the workspace.\n` +
      '2. Open the developer tools:\n' +
      '     Chrome, Edge, Brave, Firefox: Cmd+Opt+I (Windows/Linux: Ctrl+Shift+I)\n' +
      '     Safari: first turn on Settings > Advanced > "Show features for\n' +
      '             web developers", then Cmd+Opt+I\n' +
      '3. Cookie: Application (Firefox, Safari: Storage) > Cookies >\n' +
      '   https://app.slack.com, row "d": copy the value (starts with xoxd-).\n' +
      '4. Token: in the Console, paste this line and press Enter (Chrome may first\n' +
      '   ask you to type "allow pasting"). It prints the workspace name and its\n' +
      '   token (starts with xoxc-):\n\n' +
      `${SLACK_TOKEN_CONSOLE_LINE}\n\n` +
      'Check that the printed name is the workspace you want. Both values are asked\n' +
      'hidden next, the cookie first.\n\n',
  );
  await ask('Press Enter when you have both values. ');
  return true;
}
