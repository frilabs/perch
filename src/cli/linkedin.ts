import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';
import { linkedinExpiry, removeLinkedinAccount } from '../linkedin/linkedin.js';
import {
  fetchLinkedinIdentity,
  LINKEDIN_OAUTH_PORT,
  LINKEDIN_OAUTH_REDIRECT_URI,
  parseLinkedinClient,
  readLinkedinClient,
  runLinkedinAuthorization,
  saveLinkedinClient,
  shortLinkedinClientId,
  upsertLinkedinAccount,
  type LinkedinClient,
} from '../linkedin/oauth.js';
import { DEFAULT_AUTH_TIMEOUT_MS, MAX_AUTH_TIMEOUT_MS } from '../oauth/loopback.js';
import { CredentialStore } from '../store/credentialStore.js';
import { createFetchTransport, Upstream } from '../upstream.js';
import { loginPrompts } from './loginPrompt.js';
import { yes } from './onboarding.js';
import type { CliIo } from './run.js';

/** perch linkedin … (docs/LINKEDIN_X_SPEC.md). Local CLI only. */
const usage = (m: string) => new PerchError(m, 'usage');

export const LINKEDIN_APPS_URL = 'https://www.linkedin.com/developers/apps';
export const LINKEDIN_PAGE_URL = 'https://www.linkedin.com/company/setup/new/';

const UNUSABLE = new Set(['not_found', 'bad_client_file']);

async function tryRead(file: string): Promise<LinkedinClient | undefined> {
  try {
    return await readLinkedinClient(file);
  } catch (err) {
    if (err instanceof PerchError && UNUSABLE.has(err.code)) return undefined;
    throw err; // insecure permissions, symlink: stay an error, never "fixed" by the guide
  }
}

/** The steps of the LinkedIn app setup (lines at most 80 columns wide). */
export function linkedinClientGuide(): string {
  return (
    '\nLinkedIn app (once per Perch installation; Perch posts with your own app):\n\n' +
    `1. Open ${LINKEDIN_APPS_URL} and click "Create app".\n` +
    '2. App name "Perch". "LinkedIn Page": LinkedIn requires a company page\n' +
    '   for every app. Pick one you administer, or create one first:\n' +
    `   ${LINKEDIN_PAGE_URL}\n` +
    '   Add a logo, accept the terms, "Create app". If LinkedIn asks you to\n' +
    '   verify the app, open the verification link as admin of that page.\n' +
    '3. Tab "Products": add "Sign In with LinkedIn using OpenID Connect" and\n' +
    '   "Share on LinkedIn".\n' +
    '4. Tab "Auth", "OAuth 2.0 settings", "Authorized redirect URLs":\n' +
    `   add ${LINKEDIN_OAUTH_REDIRECT_URI} and click "Update".\n` +
    '5. Same tab: copy the "Client ID" and the "Primary Client Secret".\n' +
    '   Scopes Perch asks for: openid, profile, w_member_social.\n\n'
  );
}

/** Guided app setup: steps, then Client ID and Client Secret pasted hidden (three attempts), stored 0600. */
export async function runLinkedinClientGuide(io: Pick<CliIo, 'stdout' | 'readSecret' | 'readLine'>, file: string): Promise<LinkedinClient> {
  if (!io.readLine) throw new PerchError('perch linkedin client setup needs an interactive terminal', 'no_tty');
  io.stdout(linkedinClientGuide());
  for (let attempt = 1; ; attempt++) {
    const clientId = await io.readSecret('Client ID (input hidden): ');
    const clientSecret = await io.readSecret('Primary Client Secret (input hidden): ');
    try {
      const client = parseLinkedinClient({ clientId, clientSecret });
      await saveLinkedinClient(file, client);
      io.stdout(`Saved the LinkedIn app (${shortLinkedinClientId(client.clientId)}) with mode 0600 to\n  ${file}\n\n`);
      return client;
    } catch (err) {
      if (!(err instanceof PerchError) || err.code !== 'usage' || attempt >= 3) throw err;
      io.stdout(`${err.message}. Try again.\n`);
    }
  }
}

/** The app for `perch linkedin add`: the file, else the guide (terminal only), else a clear error. */
async function ensureLinkedinClient(config: PerchConfig, io: CliIo): Promise<LinkedinClient> {
  const file = config.linkedinClientFile;
  const existing = await tryRead(file);
  if (existing) return existing;
  if (!io.readLine) throw new PerchError(`No usable LinkedIn app at ${file}. Run perch linkedin client setup in a terminal (guided).`, 'bad_config');
  io.stdout(`\nPerch needs your LinkedIn app first; none is stored yet at\n  ${file}\n`);
  if (!yes(await io.readLine('Set it up now, guided step by step? [Y/n] '), true)) {
    throw new PerchError('Skipped: no LinkedIn app yet. Later: perch linkedin client setup', 'bad_config');
  }
  return runLinkedinClientGuide(io, file);
}

async function cmdLinkedinClient(config: PerchConfig, io: CliIo, action: string | undefined): Promise<void> {
  const file = config.linkedinClientFile;
  if (action === 'show') {
    const c = await tryRead(file);
    io.stdout(
      c
        ? `LinkedIn app ${shortLinkedinClientId(c.clientId)}\n  file: ${file}\n  redirect URL: ${LINKEDIN_OAUTH_REDIRECT_URI}\n  LinkedIn-Version: ${config.linkedinVersion}\n`
        : `No usable LinkedIn app at ${file}. Set one up: perch linkedin client setup\n`,
    );
    return;
  }
  if (action !== 'setup') throw usage('Usage: perch linkedin client setup|show');
  if (!io.readLine) throw new PerchError('perch linkedin client setup needs an interactive terminal', 'no_tty');
  const existing = await tryRead(file);
  if (existing && !yes(await io.readLine(`A LinkedIn app (${shortLinkedinClientId(existing.clientId)}) is stored at ${file}. Replace it? [y/N] `))) {
    io.stdout('Kept the existing app.\n');
    return;
  }
  await runLinkedinClientGuide(io, file);
  io.stdout('Next: perch linkedin add --label NAME\n');
}

export async function cmdLinkedin(config: PerchConfig, io: CliIo, sub: string | undefined, rest: string[], values: Record<string, unknown>): Promise<void> {
  if (sub === 'client') return cmdLinkedinClient(config, io, rest[0]);
  const store = await CredentialStore.open({ dataDir: config.dataDir, keyFile: config.keyFile });
  if (sub === 'list') {
    const d = await store.read();
    const lines = ['LinkedIn accounts (labels are user-assigned):'];
    if (!d.linkedin.length) lines.push('  (none)');
    for (const a of d.linkedin) {
      const exp = linkedinExpiry(a);
      const until = exp.until ? `${exp.state === 'expired' ? 'EXPIRED' : 'connected until'} ${exp.until.slice(0, 10)}` : 'refreshing login';
      lines.push(`  ${a.id}  "${a.label}"  ${a.name ?? a.personUrn}  ${until}  connected ${a.createdAt}`);
    }
    io.stdout(`${lines.join('\n')}\n`);
    return;
  }
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) throw usage('Usage: perch linkedin remove ID');
    const { removedGrants } = await removeLinkedinAccount(store, id);
    io.stdout(
      `Removed ${id} locally. The login stays valid at LinkedIn until it expires; to end it now, remove the app in\n` +
        'LinkedIn: Settings > Data privacy > Permitted services.\n' +
        (removedGrants.length ? `Client grants that covered only this account were removed: ${removedGrants.join(', ')}\n` : ''),
    );
    return;
  }
  if (sub !== 'add') throw usage('Usage: perch linkedin add|list|remove|client');
  if (typeof values.label !== 'string') throw usage('--label is required');
  if (values.port !== undefined) throw usage(`--port is not supported: the redirect URL registered in the LinkedIn app is fixed (port ${LINKEDIN_OAUTH_PORT})`);
  const timeoutS = values.timeout !== undefined ? Number(values.timeout) : DEFAULT_AUTH_TIMEOUT_MS / 1000;
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_AUTH_TIMEOUT_MS / 1000) throw usage(`--timeout must be 1-${MAX_AUTH_TIMEOUT_MS / 1000} seconds`);
  const client = await ensureLinkedinClient(config, io);
  const upstream = new Upstream(io.transport ?? createFetchTransport());
  const grant = await runLinkedinAuthorization({
    client,
    upstream,
    timeoutMs: timeoutS * 1000,
    ...loginPrompts(io, 'sign in to the LinkedIn account you want to post as', timeoutS * 1000),
  });
  const identity = await fetchLinkedinIdentity(upstream, grant.access_token!);
  const { account, updated } = await upsertLinkedinAccount(store, { label: values.label, client, grant, identity });
  const exp = linkedinExpiry(account);
  io.stdout(
    `${updated ? 'Updated' : 'Connected'} LinkedIn account ${account.id} "${account.label}"${account.name ? ` (${account.name})` : ''}.\n` +
      (updated ? 'Same member, same id: client grants stay valid.\n' : '') +
      (exp.refreshable
        ? `LinkedIn issued a refresh token: Perch renews the access by itself${exp.until ? ` until ${exp.until.slice(0, 10)}` : ''}.\n`
        : `Connected until ${exp.until!.slice(0, 10)} (LinkedIn logins last 60 days). perch status warns 7 days before;\n` +
          `then run this command again (same account, same id).\n`) +
      `Posting needs a client grant: perch client add --label NAME --allow linkedin_read,linkedin_post --account ${account.id}\n`,
  );
}
