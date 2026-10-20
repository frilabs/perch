import type { PerchConfig } from '../config.js';
import { PerchError } from '../errors.js';
import { pathExists } from '../secureFs.js';
import { runMicrosoftClientGuide, shortClientId } from '../microsoft/clientSetup.js';
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
 * Client ID for `perch microsoft add`: PERCH_MICROSOFT_CLIENT_ID, else the client-id file, else the guided
 * Entra registration (interactive only; without a terminal a clear error as before).
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
