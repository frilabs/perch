import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PerchError } from '../errors.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic, writePrivateFileExclusive } from '../secureFs.js';
import { extractZipEntry } from './zip.js';

/**
 * `perch whatsapp install` (docs/WHATSAPP_INSTALL_SPEC.md): downloads the GOWA release pinned below from
 * GitHub, checks it against the SHA-256 in this file, extracts only the program, writes the .env and a
 * systemd user unit, starts the service, waits for GET /devices and stores the bridge in Perch.
 * Updating GOWA is a code change: new version, new hashes.
 */
export const GOWA_VERSION = '9.6.0';

export type GowaArch = 'linux_amd64' | 'linux_arm64';

export interface GowaPin {
  /** SHA-256 of the release ZIP (as published by GitHub for the release asset). */
  sha256: string;
  /** Name of the program inside the ZIP (top level); installed as `whatsapp`. */
  entry: string;
}

export const GOWA_PINS: Readonly<Record<GowaArch, GowaPin>> = Object.freeze({
  linux_amd64: { sha256: '96173e28d963f591a13907d6abfee7a83b18c15c6bad25c193cdbc6fab088154', entry: 'linux-amd64' },
  linux_arm64: { sha256: '4999212cdc7fe39753ea85a18cb52a0477ae694cf7a8966d5cb182b621d4e035', entry: 'linux-arm64' },
});

const NODE_ARCH: Readonly<Record<string, GowaArch>> = { x64: 'linux_amd64', arm64: 'linux_arm64' };

export const gowaDownloadUrl = (arch: GowaArch) =>
  `https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v${GOWA_VERSION}/whatsapp_${GOWA_VERSION}_${arch}.zip`;

/** github.com serves the release URL; the asset itself comes from GitHub's release asset hosts. */
const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_REDIRECTS = 5;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_GOWA_PORT = 3000;
export const GOWA_USER = 'perch';
const MARKER = '.perch-gowa.json';
const BINARY = 'whatsapp';
const ENV = '.env';
const SAFE_DIR = /^\/[A-Za-z0-9._/-]+$/;

export function gowaWarning(dir: string, port: number): string {
  return (
    'WhatsApp through GOWA is UNOFFICIAL. GOWA logs in like WhatsApp Web as a linked device; this can violate\n' +
    "WhatsApp's terms, and WhatsApp may restrict or ban the account (sending raises the risk).\n" +
    `GOWA stores all messages UNENCRYPTED on this disk (${dir}/storages).\n` +
    `This downloads GOWA v${GOWA_VERSION} (MIT) from GitHub, checks its pinned SHA-256, installs it to ${dir}\n` +
    `and runs it as a systemd user service on 127.0.0.1:${port} (never public).\n`
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InstallDeps {
  platform: string;
  arch: string;
  uid: number | undefined;
  home: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Runs a program without a shell (systemctl). Never rejects; reports the exit code. */
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  /** Calls GET /devices with basic auth; rejects while the bridge is not ready. */
  probe: (origin: string, username: string, password: string) => Promise<void>;
  /** Stores the bridge in Perch (same path as `perch whatsapp instance set`). */
  store: (origin: string, username: string, password: string) => Promise<void>;
  /** Origin of the bridge Perch already uses, if any. */
  configuredOrigin: () => Promise<string | undefined>;
  /** Visible one-line prompt; undefined or rejecting means no terminal. */
  ask?: (prompt: string) => Promise<string>;
  out: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  password: () => string;
  healthTimeoutMs: number;
  pollIntervalMs: number;
  /** TESTS ONLY: replaces the pinned hashes/entry names (production never sets this). */
  pins?: Partial<Record<GowaArch, GowaPin>>;
}

export interface InstallOptions {
  yes: boolean;
  dir?: string;
  port?: number;
}

export interface InstallResult {
  status: 'installed' | 'already_installed';
  origin: string;
  dir: string;
}

interface Marker {
  version: string;
  arch: GowaArch;
  binarySha256?: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fail = (msg: string, code = 'whatsapp_install') => new PerchError(msg, code);

export function envFileContent(port: number, password: string): string {
  return [
    '# Written by perch whatsapp install. Keep this file private (0600).',
    'APP_HOST=127.0.0.1',
    `APP_PORT=${port}`,
    `APP_BASIC_AUTH=${GOWA_USER}:${password}`,
    'APP_OS=Perch',
    '# no web UI (it would keep fetching HTML from GitHub)',
    'APP_UI_ENABLED=false',
    'APP_UI_AUTO_UPDATE=false',
    "# GOWA's own MCP server offers send and delete tools: off",
    'MCP_ENABLED=false',
    'WHATSAPP_CHAT_STORAGE=true',
    'WHATSAPP_AUTO_REPLY=',
    'WHATSAPP_AUTO_MARK_READ=false',
    'WHATSAPP_AUTO_REJECT_CALL=false',
    'WHATSAPP_AUTO_DOWNLOAD_MEDIA=false',
    'WHATSAPP_WEBHOOK=',
    'WHATSAPP_PRESENCE_ON_CONNECT=unavailable',
    '',
  ].join('\n');
}

export function unitFileContent(dir: string, home: string): string {
  const d = dir === path.join(home, 'gowa') ? '%h/gowa' : dir;
  return [
    '[Unit]',
    'Description=GOWA WhatsApp bridge (localhost only)',
    '',
    '[Service]',
    `WorkingDirectory=${d}`,
    `ExecStart=${d}/${BINARY} rest`,
    'Restart=on-failure',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function parseEnv(text: string): { port: number; username: string; password: string } | undefined {
  const get = (k: string) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(text);
    return m ? m[1]!.trim() : undefined;
  };
  const port = Number(get('APP_PORT'));
  const auth = get('APP_BASIC_AUTH');
  const i = auth?.indexOf(':') ?? -1;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !auth || i < 1 || i === auth.length - 1 || auth.includes(',')) return undefined;
  return { port, username: auth.slice(0, i), password: auth.slice(i + 1) };
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Downloads `url` over HTTPS, following redirects only to GitHub release hosts, within the size limit. */
async function download(deps: InstallDeps, url: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(current.hostname) || current.port || current.username || current.password) {
      throw fail(`Refusing to download GOWA from ${current.protocol}//${current.host}: only HTTPS from GitHub release hosts is allowed`, 'download_refused');
    }
    let res: Response;
    try {
      res = await deps.fetch(current.href, { redirect: 'manual', signal });
    } catch {
      throw fail(`Downloading GOWA from ${current.host} failed (network error or timeout)`, 'download_failed');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw fail('GitHub answered with a redirect without a location', 'download_failed');
      current = new URL(loc, current);
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw fail(`Downloading GOWA failed: HTTP ${res.status} from ${current.host}`, 'download_failed');
    }
    const tooLarge = () => fail(`The GOWA download exceeds the ${MAX_ARCHIVE_BYTES} byte limit`, 'download_too_large');
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!res.body) throw fail('GitHub returned an empty download', 'download_failed');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      if (err instanceof PerchError) throw err;
      throw fail('Downloading GOWA failed while reading the response', 'download_failed');
    }
    return Buffer.concat(chunks);
  }
  throw fail('Too many redirects while downloading GOWA', 'download_failed');
}

/** Writes the program via an exclusive temp file and rename, mode 0700. */
async function writeExecutable(file: string, data: Buffer): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o700);
  try {
    await fh.writeFile(data);
    await fh.chmod(0o700);
    await fh.sync();
  } catch (err) {
    await fh.close();
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function busHint(r: RunResult): string {
  const text = `${r.stderr}\n${r.stdout}`;
  return /bus|XDG_RUNTIME_DIR|DBUS/i.test(text)
    ? ' systemctl --user cannot reach your user session. Log in as this user directly (not via su/sudo), or set ' +
        'XDG_RUNTIME_DIR=/run/user/$(id -u); on a server without login sessions run: sudo loginctl enable-linger $USER'
    : '';
}

async function systemctl(deps: InstallDeps, args: string[]): Promise<void> {
  const r = await deps.run('systemctl', ['--user', ...args]);
  if (r.code !== 0) {
    const detail = r.stderr.trim().split('\n')[0]?.slice(0, 300) ?? '';
    throw fail(`systemctl --user ${args.join(' ')} failed (exit ${r.code})${detail ? `: ${detail}` : ''}.${busHint(r)}`, 'systemd_failed');
  }
}

async function waitHealthy(deps: InstallDeps, origin: string, username: string, password: string): Promise<void> {
  const deadline = deps.now() + deps.healthTimeoutMs;
  for (;;) {
    try {
      await deps.probe(origin, username, password);
      return;
    } catch {
      if (deps.now() >= deadline) {
        throw fail(
          `GOWA did not answer GET ${origin}/devices within ${Math.round(deps.healthTimeoutMs / 1000)} s. ` +
            'Check: systemctl --user status gowa and journalctl --user -u gowa -n 50',
          'gowa_unhealthy',
        );
      }
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

const isYes = (a: string) => ['y', 'yes', 'j', 'ja'].includes(a.trim().toLowerCase());

/** Shows the warning and asks for an explicit yes; aborts without a terminal unless --yes. */
async function confirm(deps: InstallDeps, opts: InstallOptions, dir: string, port: number): Promise<void> {
  deps.out(gowaWarning(dir, port));
  if (opts.yes) return;
  let answer: string;
  try {
    if (!deps.ask) throw new Error('no terminal');
    answer = await deps.ask('Install GOWA and connect it to Perch? [y/N] ');
  } catch {
    throw fail('No interactive terminal: confirm in a terminal or pass --yes. Nothing was installed.', 'no_tty');
  }
  if (!isYes(answer)) throw fail('Aborted. Nothing was installed.', 'aborted');
}

/** Stores the bridge unless Perch already uses a different one (then only reports). */
async function storeInstance(deps: InstallDeps, origin: string, username: string, password: string): Promise<boolean> {
  const configured = await deps.configuredOrigin();
  if (configured && configured !== origin) {
    deps.out(`Note: Perch already uses the bridge ${configured}; it was left unchanged. To switch: perch whatsapp instance set --url ${origin}\n`);
    return false;
  }
  await deps.store(origin, username, password);
  return true;
}

export async function installGowa(opts: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  if (deps.platform !== 'linux') {
    throw fail('perch whatsapp install supports Linux with systemd only. Install GOWA by hand as in docs/SETUP.md §4f.1.', 'unsupported_platform');
  }
  const arch = NODE_ARCH[deps.arch];
  if (!arch) throw fail(`Unsupported CPU architecture ${deps.arch} (x64 and arm64 only). Install GOWA by hand as in docs/SETUP.md §4f.1.`, 'unsupported_platform');
  if (deps.uid === 0) throw fail('Refusing to install GOWA as root. Run perch as the normal user that runs Perch.', 'refused_root');
  const pin = deps.pins?.[arch] ?? GOWA_PINS[arch];
  const dir = path.resolve(opts.dir ?? path.join(deps.home, 'gowa'));
  if (!SAFE_DIR.test(dir) || dir.split('/').includes('..')) throw fail('--dir must be a plain absolute path (letters, digits, ".", "_", "-", "/")', 'usage');
  const unitDir = path.join(deps.home, '.config', 'systemd', 'user');
  const unitFile = path.join(unitDir, 'gowa.service');
  const unit = unitFileContent(dir, deps.home);

  // --- inspect what is already there (nothing is written in this phase) ---
  const unitSt = await lstatOrNull(unitFile);
  if (unitSt) {
    if (unitSt.isSymbolicLink() || !unitSt.isFile()) throw fail(`${unitFile} is not a regular file; remove it or install by hand.`, 'foreign_files');
    if ((await readPrivateFileOrPlain(unitFile)) !== unit) {
      throw fail(`A different ${unitFile} exists. Remove it (systemctl --user disable --now gowa) or install by hand.`, 'foreign_files');
    }
  }
  let marker: Marker | undefined;
  const dirSt = await lstatOrNull(dir);
  if (dirSt) {
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) throw fail(`${dir} is not a directory. Choose another --dir.`, 'foreign_files');
    const entries = await readdir(dir);
    if (entries.includes(MARKER)) {
      try {
        marker = JSON.parse((await readPrivateFile(path.join(dir, MARKER))).toString('utf8')) as Marker;
      } catch {
        throw fail(`${path.join(dir, MARKER)} is unreadable. Remove ${dir} by hand or choose another --dir.`, 'foreign_files');
      }
      if (marker.version !== GOWA_VERSION || marker.arch !== arch) {
        throw fail(
          `${dir} holds GOWA ${marker.version} (${marker.arch}); this Perch installs ${GOWA_VERSION} (${arch}). ` +
            'Upgrades are not automatic: choose another --dir or remove the old installation by hand.',
          'other_version',
        );
      }
    } else if (entries.length) {
      throw fail(`${dir} already contains files not installed by Perch. Choose another --dir or remove them by hand.`, 'foreign_files');
    }
  }
  const binaryPath = path.join(dir, BINARY);
  const envPath = path.join(dir, ENV);
  let haveBinary = false;
  if (marker && (await lstatOrNull(binaryPath))) {
    const st = await lstat(binaryPath);
    if (!st.isFile() || !marker.binarySha256 || sha256(await readPrivateFileOrPlainBuf(binaryPath)) !== marker.binarySha256) {
      throw fail(`${binaryPath} was changed or not installed completely. Remove ${dir} by hand or choose another --dir.`, 'foreign_files');
    }
    haveBinary = true;
  }
  let existingEnv: { port: number; username: string; password: string } | undefined;
  if (marker && (await lstatOrNull(envPath))) {
    existingEnv = parseEnv((await readPrivateFile(envPath)).toString('utf8'));
    if (!existingEnv) throw fail(`${envPath} lacks APP_PORT or APP_BASIC_AUTH. Fix it or remove ${dir} by hand.`, 'foreign_files');
    if (opts.port !== undefined && opts.port !== existingEnv.port) {
      throw fail(`GOWA in ${dir} is configured for port ${existingEnv.port}; --port ${opts.port} would need a new installation (another --dir).`, 'foreign_files');
    }
  }
  const port = existingEnv?.port ?? opts.port ?? DEFAULT_GOWA_PORT;
  const origin = `http://127.0.0.1:${port}`;

  // --- already installed: only check and report ---
  if (haveBinary && existingEnv && unitSt) {
    deps.out(`GOWA ${GOWA_VERSION} is already installed in ${dir}; nothing was changed. Checking ${origin} ...\n`);
    try {
      await deps.probe(origin, existingEnv.username, existingEnv.password);
    } catch {
      throw fail(`GOWA is installed but does not answer on ${origin}/devices. Check: systemctl --user status gowa and journalctl --user -u gowa -n 50`, 'gowa_unhealthy');
    }
    const stored = await storeInstance(deps, origin, existingEnv.username, existingEnv.password);
    deps.out(`GOWA answers on ${origin}${stored ? ' and is stored in Perch' : ''}.\n`);
    return { status: 'already_installed', origin, dir };
  }

  // --- install ---
  await confirm(deps, opts, dir, port);
  let binary: Buffer | undefined;
  if (!haveBinary) {
    const url = gowaDownloadUrl(arch);
    deps.out(`Downloading ${url} ...\n`);
    const zip = await download(deps, url);
    const got = sha256(zip);
    if (got !== pin.sha256) {
      throw fail(`SHA-256 mismatch for the GOWA download (expected ${pin.sha256}, got ${got}). Nothing was installed.`, 'hash_mismatch');
    }
    binary = extractZipEntry(zip, pin.entry, MAX_BINARY_BYTES);
  }
  await ensurePrivateDir(dir);
  if (!marker) {
    marker = { version: GOWA_VERSION, arch };
    await writePrivateFileExclusive(path.join(dir, MARKER), Buffer.from(`${JSON.stringify(marker)}\n`));
  }
  if (binary) {
    await writeExecutable(binaryPath, binary);
    marker = { ...marker, binarySha256: sha256(binary) };
    await writePrivateFileAtomic(path.join(dir, MARKER), Buffer.from(`${JSON.stringify(marker)}\n`));
  }
  let creds = existingEnv;
  if (!creds) {
    const password = deps.password();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(password)) throw fail('Internal error: unusable generated password', 'internal');
    if (!(await writePrivateFileExclusive(envPath, Buffer.from(envFileContent(port, password))))) {
      throw fail(`${envPath} appeared while installing; remove it or run the install again.`, 'foreign_files');
    }
    creds = { port, username: GOWA_USER, password };
  }
  if (!unitSt) {
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    if (!(await writePrivateFileExclusive(unitFile, Buffer.from(unit)))) throw fail(`${unitFile} appeared while installing; run the install again.`, 'foreign_files');
  }
  await systemctl(deps, ['daemon-reload']);
  await systemctl(deps, ['enable', '--now', 'gowa']);
  deps.out(`GOWA service started; waiting for ${origin}/devices ...\n`);
  await waitHealthy(deps, origin, creds.username, creds.password);
  const stored = await storeInstance(deps, origin, creds.username, creds.password);
  deps.out(
    `GOWA ${GOWA_VERSION} installed in ${dir} and running on ${origin}${stored ? '; stored in Perch (password encrypted, never shown)' : ''}.\n` +
      'So that GOWA keeps running after you log out: sudo loginctl enable-linger $USER\n',
  );
  return { status: 'installed', origin, dir };
}

/** The unit file is not secret; read it without the owner-only check of readPrivateFile. */
async function readPrivateFileOrPlain(file: string): Promise<string> {
  return (await readPrivateFileOrPlainBuf(file)).toString('utf8');
}

async function readPrivateFileOrPlainBuf(file: string): Promise<Buffer> {
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Production dependencies (real network, real systemctl, real file system). */
export function defaultInstallDeps(
  base: Pick<InstallDeps, 'probe' | 'store' | 'configuredOrigin' | 'ask' | 'out'> & { home: string; sleep?: (ms: number) => Promise<void> },
): InstallDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    fetch: (url, init) => fetch(url, init),
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === 127 ? `${cmd} not found` : '')) });
        });
      }),
    sleep: base.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: () => Date.now(),
    password: () => randomBytes(32).toString('base64url'),
    healthTimeoutMs: 60_000,
    pollIntervalMs: 1000,
    ...base,
  };
}
