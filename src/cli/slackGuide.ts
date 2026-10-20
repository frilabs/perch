import { SLACK_APP_MANIFEST } from '../slack/manifest.js';
import { yes } from './onboarding.js';

export const SLACK_NEW_APP_URL = 'https://api.slack.com/apps?new_app=1';

interface Io {
  stdout: (s: string) => void;
  readLine?: (prompt: string) => Promise<string>;
}

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
