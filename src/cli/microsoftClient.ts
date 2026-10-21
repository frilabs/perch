import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';
import { pathExists } from '../secureFs.js';
import { adminConsentBlock, adminConsentTenant } from '../microsoft/authErrors.js';
import { runMicrosoftClientGuide, shortClientId } from '../microsoft/clientSetup.js';
import { FRILABS_MICROSOFT_APP_NAME } from '../microsoft/defaultApp.js';
import { yes } from './onboarding.js';

/** The parts of CliIo the Microsoft client commands use. */
interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readLine?: (prompt: string) => Promise<string>;
}

const noTerminalHint =
  'Set PERCH_MICROSOFT_CLIENT_ID to the Application (client) ID of your Entra app registration, ' +
  'or run perch microsoft client setup in a terminal (guided, docs/SETUP.md §4a)';

/**
 * Client ID for `perch microsoft add`: PERCH_MICROSOFT_CLIENT_ID, else the client-id file, else the built-in
 * frilabs app (no guide), else the guided Entra registration (interactive only; without a terminal a clear error).
 */
export async function ensureMicrosoftClientId(config: PerchConfig, io: Io, write: boolean): Promise<string> {
  if (config.microsoftClientId) return config.microsoftClientId;
  if (config.microsoftClientIdFileError) {
    throw new PerchError(`The Microsoft client-id file is not usable: ${config.microsoftClientIdFileError}. Fix it or run perch microsoft client setup`, 'bad_config');
  }
  if (!io.readLine) throw new PerchError(noTerminalHint, 'bad_config');
  return runMicrosoftClientGuide({ stdout: io.stdout, ask: io.readLine }, { file: config.microsoftClientIdFile, write });
}

/** `perch microsoft client setup | show`. */
export async function cmdMicrosoftClient(config: PerchConfig, io: Io, action: string | undefined): Promise<void> {
  const file = config.microsoftClientIdFile;
  if (action === 'show') {
    if (config.microsoftClientIdSource === 'env') {
      io.stdout(`Client ID ${shortClientId(config.microsoftClientId!)} from PERCH_MICROSOFT_CLIENT_ID (takes precedence over ${file}).\n`);
    } else if (config.microsoftClientIdSource === 'file') {
      io.stdout(`Client ID ${shortClientId(config.microsoftClientId!)} from ${file}.\n`);
    } else if (config.microsoftClientIdSource === 'frilabs') {
      io.stdout(
        `Client ID ${shortClientId(config.microsoftClientId!)}: frilabs default (the built-in ${FRILABS_MICROSOFT_APP_NAME} app).\n` +
          'Your own app registration instead: perch microsoft client setup\n' +
          `(or PERCH_MICROSOFT_CLIENT_ID; both take precedence over the default).\n`,
      );
    } else if (config.microsoftClientIdFileError) {
      io.stdout(`No usable client ID: ${config.microsoftClientIdFileError}. Run perch microsoft client setup.\n`);
    } else {
      io.stdout(`No client ID configured (neither PERCH_MICROSOFT_CLIENT_ID nor ${file}). Run perch microsoft client setup.\n`);
    }
    io.stdout(`Tenant: ${config.microsoftTenant}\n`);
    return;
  }
  if (action !== 'setup') throw new PerchError('Usage: perch microsoft client setup|show', 'usage');
  if (!io.readLine) throw new PerchError('perch microsoft client setup needs an interactive terminal', 'no_tty');
  if (config.microsoftClientIdSource === 'env') {
    io.stdout(`Note: PERCH_MICROSOFT_CLIENT_ID is set and takes precedence; the file ${file} is only used without it.\n`);
  }
  if (await pathExists(file)) {
    if (!yes(await io.readLine(`${file} already exists. Replace it with a new client ID? [y/N] `))) {
      io.stdout('Kept the existing client ID.\n');
      return;
    }
  }
  await runMicrosoftClientGuide({ stdout: io.stdout, ask: io.readLine }, { file });
  io.stdout('Next: perch microsoft add --label NAME\n');
}

/** `perch microsoft admin-consent-link [--tenant DOMAIN|GUID]`: the link an organisation's admin approves Perch with. */
export function cmdMicrosoftAdminConsentLink(config: PerchConfig, io: Io, tenantArg: string | undefined): void {
  const tenant = adminConsentTenant(tenantArg);
  if (!config.microsoftClientId) {
    throw new PerchError(
      config.microsoftClientIdFileError
        ? `The Microsoft client-id file is not usable: ${config.microsoftClientIdFileError}. Fix it or run perch microsoft client setup`
        : 'No Microsoft client ID configured. Run perch microsoft client setup\n(or set PERCH_MICROSOFT_CLIENT_ID) first',
      'bad_config',
    );
  }
  io.stdout(adminConsentBlock({ clientId: config.microsoftClientId, frilabs: config.microsoftClientIdSource === 'frilabs' }, tenant));
  if (tenantArg === undefined) {
    io.stdout('\nSpecific organisation: perch microsoft admin-consent-link --tenant DOMAIN\n');
  }
}
