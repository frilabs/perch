import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { PerchError } from '../errors.js';
import { ensurePrivateDir, writePrivateFileAtomic } from '../secureFs.js';

/**
 * Guided Entra app registration (docs/GUIDED_PROVIDER_SETUP_SPEC.md §3). The Application (client) ID of a
 * public client is not a secret; it is still kept in an owner-only file (0600) next to Perch's other config.
 * PERCH_MICROSOFT_CLIENT_ID keeps precedence over the file.
 */

export const ENTRA_APP_LIST_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
export const ENTRA_NEW_APP_URL = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 256;

/** Normalises a pasted Application (client) ID; throws unless it is a GUID. */
export function parseMicrosoftClientId(raw: string): string {
  const v = raw.trim().replace(/^\{(.*)\}$/, '$1').toLowerCase();
  if (!GUID.test(v)) throw new PerchError('The Application (client) ID must be a GUID like 01234567-89ab-cdef-0123-456789abcdef', 'usage');
  return v;
}

/** Default location of the client-id file: $XDG_CONFIG_HOME/perch/microsoft-client-id (~/.config/perch/…). */
export function defaultMicrosoftClientIdFile(configHome: string): string {
  return path.join(configHome, 'perch', 'microsoft-client-id');
}

export type ClientIdFileResult = { id: string } | { missing: true } | { error: string };

/**
 * Reads the client-id file synchronously (config resolution is synchronous). Never throws: a missing file is
 * `missing`; a symlink, a non-regular file, a foreign owner, group/other-writable mode or content that is not a
 * GUID is reported as `error` and the file is not used.
 */
export function readMicrosoftClientIdFile(file: string): ClientIdFileResult {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true };
    if (code === 'ELOOP') return { error: `refusing symlinked file ${file}` };
    return { error: `cannot read ${file} (${code ?? 'error'})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: `${file} is not a regular file` };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { error: `${file} is not owned by the current user` };
    if ((st.mode & 0o077) !== 0) return { error: `insecure permissions on ${file} (run: chmod 600 '${file}')` };
    if (st.size > MAX_FILE_BYTES) return { error: `${file} is too large for a client ID` };
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    const n = readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
    try {
      return { id: parseMicrosoftClientId(buf.subarray(0, n).toString('utf8')) };
    } catch {
      return { error: `${file} does not contain an Application (client) ID (GUID)` };
    }
  } finally {
    closeSync(fd);
  }
}

/** Stores the client ID atomically with mode 0600 (the directory is created 0700 if missing). */
export async function saveMicrosoftClientId(file: string, id: string): Promise<void> {
  const clean = parseMicrosoftClientId(id);
  await ensurePrivateDir(path.dirname(file));
  await writePrivateFileAtomic(file, Buffer.from(`${clean}\n`, 'utf8'));
}

/** Shortened display of a client ID (status/show output). */
export const shortClientId = (id: string) => `${id.slice(0, 8)}-…`;

export interface MicrosoftGuideIo {
  stdout: (s: string) => void;
  ask: (prompt: string) => Promise<string>;
}

/**
 * Step-by-step guide for the Entra app registration, then asks for the Application (client) ID (GUID checked,
 * three attempts) and saves it to `file`. `write` = undefined lists the write permissions as optional.
 */
export async function runMicrosoftClientGuide(io: MicrosoftGuideIo, opts: { file: string; write?: boolean }): Promise<string> {
  const { stdout, ask } = io;
  const perms =
    opts.write === true
      ? 'User.Read, Mail.Read, Mail.ReadWrite, Mail.Send'
      : opts.write === false
        ? 'User.Read, Mail.Read'
        : 'User.Read, Mail.Read (for drafts, sending and organising also Mail.ReadWrite, Mail.Send)';
  stdout(
    '\nOutlook / Microsoft 365 needs your own Entra app registration (self-hosted: one per installation, about 5 minutes, free).\n' +
      'It works for personal Microsoft accounts (outlook.com, hotmail) and work/school accounts. No secret is created.\n\n',
  );
  const step = async (n: number, text: string) => {
    stdout(`Step ${n}: ${text}\n`);
    await ask('  Press Enter when done. ');
  };
  await step(
    1,
    `Open the new app registration in the Entra admin center (sign in with the Microsoft account you want to connect, or any account that may register apps):\n` +
      `  ${ENTRA_NEW_APP_URL}\n` +
      `  (or: ${ENTRA_APP_LIST_URL} → "New registration")\n` +
      '  Name: Perch\n' +
      '  Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"\n' +
      '    (personal accounts only is fine, too, with PERCH_MICROSOFT_TENANT=consumers)\n' +
      '  Redirect URI: platform "Public client/native (mobile & desktop)", URI http://localhost\n' +
      '  Click "Register".',
  );
  await step(
    2,
    'Check Authentication: the platform "Mobile and desktop applications" lists http://localhost.\n' +
      '  Do NOT create a client secret or certificate (Perch is a public client).',
  );
  await step(
    3,
    `API permissions → Add a permission → Microsoft Graph → Delegated permissions:\n  ${perms}\n` +
      '  offline_access is requested by Perch at sign-in automatically. Personal accounts need no admin consent.',
  );
  stdout('Step 4: On the app\'s Overview page copy the "Application (client) ID".\n');
  for (let attempt = 1; ; attempt++) {
    const raw = await ask('  Application (client) ID: ');
    try {
      const id = parseMicrosoftClientId(raw);
      await saveMicrosoftClientId(opts.file, id);
      stdout(`Saved the client ID to ${opts.file} (0600). PERCH_MICROSOFT_CLIENT_ID in .env would take precedence over this file.\n\n`);
      return id;
    } catch (err) {
      if (!(err instanceof PerchError) || err.code !== 'usage' || attempt >= 3) throw err;
      stdout('  That is not a GUID (format 01234567-89ab-cdef-0123-456789abcdef). Copy the "Application (client) ID", not the Object or Directory ID.\n');
    }
  }
}
