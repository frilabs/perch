// `perch whatsapp install` (docs/WHATSAPP_INSTALL_SPEC.md). MOCK download (synthetic ZIP built here), MOCK
// systemctl, MOCK GOWA. Nothing is downloaded from GitHub and nothing is installed on this machine; the
// production SHA-256 pins stay untouched (tests inject their own pin for the synthetic ZIP).
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/run.js';
import { PerchError } from '../src/errors.js';
import { CredentialStore } from '../src/store/credentialStore.js';
import { GOWA_PINS, gowaDownloadUrl, installGowa, MAX_ARCHIVE_BYTES, type InstallDeps, type RunResult } from '../src/whatsapp/install.js';
import { extractZipEntry, listZipEntries } from '../src/whatsapp/zip.js';
import { makeTempDirs, rejection, type TempDirs } from './support/fixtures.js';
import { MockGowa } from './support/mockGowa.js';

// ---------- synthetic ZIP ----------

interface ZipEntrySpec {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Lie in the central directory (hostile archives). */
  declaredSize?: number;
  crc?: number;
}

function buildZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(size, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BINARY = Buffer.from('#!/bin/sh\n# MOCK GOWA binary for tests\n'.repeat(50));
const goodZip = () =>
  buildZip([
    { name: 'readme.md', data: Buffer.from('MOCK readme') },
    { name: 'linux-amd64', data: BINARY },
  ]);
const PASSWORD = `DUMMY-TEST-GOWA-${'ab12'.repeat(8)}`;
const ASSET_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/mock?sig=x';

// ---------- harness ----------

let dirs: TempDirs;
let home: string;
let fetched: string[];
let runs: string[][];
let stored: Array<[string, string, string]>;
let out: string[];
let clock: number;
let sleeps: number;

beforeEach(async () => {
  dirs = await makeTempDirs();
  home = path.join(dirs.root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  fetched = [];
  runs = [];
  stored = [];
  out = [];
  clock = 0;
  sleeps = 0;
});
afterEach(async () => {
  await dirs.cleanup();
});

/** MOCK GitHub: the release URL redirects to the asset host, which serves `zip`. */
function githubFetch(zip: Buffer, redirectTo = ASSET_URL): InstallDeps['fetch'] {
  return async (url) => {
    fetched.push(url);
    if (url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: redirectTo } });
    if (url === redirectTo) return new Response(new Uint8Array(zip), { status: 200, headers: { 'content-length': String(zip.length) } });
    return new Response('not found', { status: 404 });
  };
}

function deps(over: Partial<InstallDeps> = {}, zip = goodZip()): InstallDeps {
  return {
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    home,
    fetch: githubFetch(zip),
    run: async (cmd, args): Promise<RunResult> => {
      runs.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    },
    probe: async (origin, user, pw) => {
      if (user !== 'perch' || pw.length < 32 || !origin.startsWith('http://127.0.0.1:')) throw new Error('MOCK: 401');
    },
    store: async (o, u, p) => void stored.push([o, u, p]),
    configuredOrigin: async () => stored.at(-1)?.[0],
    ask: async () => 'y',
    out: (s) => void out.push(s),
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
    },
    now: () => clock,
    password: () => PASSWORD,
    healthTimeoutMs: 5000,
    pollIntervalMs: 1000,
    pins: { linux_amd64: { sha256: sha(zip), entry: 'linux-amd64' } },
    ...over,
  };
}

const gowaDir = () => path.join(home, 'gowa');
const unitPath = () => path.join(home, '.config', 'systemd', 'user', 'gowa.service');
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const codeOf = async (p: Promise<unknown>) => ((await rejection(p)) as PerchError).code;

// ---------- tests ----------

describe('pins', () => {
  it('pins v9.6.0 with the release hashes from the spec and only GitHub HTTPS URLs', () => {
    expect(GOWA_PINS.linux_amd64.sha256).toBe('96173e28d963f591a13907d6abfee7a83b18c15c6bad25c193cdbc6fab088154');
    expect(GOWA_PINS.linux_arm64.sha256).toBe('4999212cdc7fe39753ea85a18cb52a0477ae694cf7a8966d5cb182b621d4e035');
    expect(gowaDownloadUrl('linux_arm64')).toBe(
      'https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v9.6.0/whatsapp_9.6.0_linux_arm64.zip',
    );
  });

  it('without the test seam, the production pin rejects the synthetic ZIP', async () => {
    const d = deps();
    delete d.pins;
    expect(await codeOf(installGowa({ yes: true }, d))).toBe('hash_mismatch');
    expect(await exists(gowaDir())).toBe(false);
  });
});

describe('fresh install [MOCK download, MOCK systemctl]', () => {
  it('installs the program, .env and unit with private modes, starts the service and stores the bridge', async () => {
    const r = await installGowa({ yes: false }, deps());
    expect(r).toEqual({ status: 'installed', origin: 'http://127.0.0.1:3000', dir: gowaDir() });
    expect(fetched).toEqual([gowaDownloadUrl('linux_amd64'), ASSET_URL]);
    expect(await mode(gowaDir())).toBe(0o700);
    expect(await mode(path.join(gowaDir(), 'whatsapp'))).toBe(0o700);
    expect(await readFile(path.join(gowaDir(), 'whatsapp'))).toEqual(BINARY);
    expect(await mode(path.join(gowaDir(), '.env'))).toBe(0o600);
    expect((await readdir(gowaDir())).sort()).toEqual(['.env', '.perch-gowa.json', 'whatsapp']); // no readme, no temp files
    const env = await readFile(path.join(gowaDir(), '.env'), 'utf8');
    for (const line of [
      'APP_HOST=127.0.0.1',
      'APP_PORT=3000',
      `APP_BASIC_AUTH=perch:${PASSWORD}`,
      'APP_UI_ENABLED=false',
      'APP_UI_AUTO_UPDATE=false',
      'MCP_ENABLED=false',
      'WHATSAPP_AUTO_MARK_READ=false',
      'WHATSAPP_AUTO_DOWNLOAD_MEDIA=false',
      'WHATSAPP_WEBHOOK=',
      'WHATSAPP_PRESENCE_ON_CONNECT=unavailable',
    ]) {
      expect(env.split('\n')).toContain(line);
    }
    expect(await readFile(unitPath(), 'utf8')).toBe(
      '[Unit]\nDescription=GOWA WhatsApp bridge (localhost only)\n\n[Service]\nWorkingDirectory=%h/gowa\nExecStart=%h/gowa/whatsapp rest\n' +
        'Restart=on-failure\nUMask=0077\n\n[Install]\nWantedBy=default.target\n',
    );
    expect(runs).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'gowa'],
    ]);
    expect(stored).toEqual([['http://127.0.0.1:3000', 'perch', PASSWORD]]);
    expect(out.join('')).toMatch(/UNOFFICIAL/);
    expect(out.join('')).not.toContain(PASSWORD);
  });

  it('honours --dir and --port (absolute paths in the unit)', async () => {
    const dir = path.join(dirs.root, 'bridge');
    const r = await installGowa({ yes: true, dir, port: 3111 }, deps());
    expect(r.origin).toBe('http://127.0.0.1:3111');
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toContain('APP_PORT=3111\n');
    const unit = await readFile(unitPath(), 'utf8');
    expect(unit).toContain(`WorkingDirectory=${dir}\n`);
    expect(unit).toContain(`ExecStart=${dir}/whatsapp rest\n`);
    expect(stored[0]![0]).toBe('http://127.0.0.1:3111');
  });

  it('extracts stored (uncompressed) entries too', async () => {
    const zip = buildZip([{ name: 'linux-amd64', data: BINARY, method: 0 }]);
    await installGowa({ yes: true }, deps({}, zip));
    expect(await readFile(path.join(gowaDir(), 'whatsapp'))).toEqual(BINARY);
  });

  it('a re-run on a complete installation changes nothing and only checks', async () => {
    await installGowa({ yes: true }, deps());
    const before = await Promise.all(['whatsapp', '.env', '.perch-gowa.json'].map((f) => stat(path.join(gowaDir(), f))));
    const unitBefore = await stat(unitPath());
    fetched = [];
    runs = [];
    stored = [];
    const r = await installGowa({ yes: false }, deps({ ask: undefined, password: () => 'X'.repeat(40) }));
    expect(r.status).toBe('already_installed');
    expect(fetched).toEqual([]);
    expect(runs).toEqual([]);
    expect(stored).toEqual([['http://127.0.0.1:3000', 'perch', PASSWORD]]); // credentials from the existing .env
    const after = await Promise.all(['whatsapp', '.env', '.perch-gowa.json'].map((f) => stat(path.join(gowaDir(), f))));
    expect(after.map((s) => s.mtimeMs)).toEqual(before.map((s) => s.mtimeMs));
    expect((await stat(unitPath())).mtimeMs).toBe(unitBefore.mtimeMs);
    expect(out.join('')).toMatch(/already installed/);
    expect(out.join('')).not.toContain(PASSWORD);
  });

  it('a re-run with a different --port is refused', async () => {
    await installGowa({ yes: true }, deps());
    expect(await codeOf(installGowa({ yes: true, port: 3999 }, deps()))).toBe('foreign_files');
  });

  it('a re-run completes a missing unit without re-downloading or touching .env', async () => {
    await installGowa({ yes: true }, deps());
    await (await import('node:fs/promises')).unlink(unitPath());
    fetched = [];
    runs = [];
    await installGowa({ yes: true }, deps({ password: () => 'Y'.repeat(40) }));
    expect(fetched).toEqual([]);
    expect(await exists(unitPath())).toBe(true);
    expect(await readFile(path.join(gowaDir(), '.env'), 'utf8')).toContain(PASSWORD);
    expect(runs).toHaveLength(2);
  });

  it('leaves a different configured bridge alone', async () => {
    const r = await installGowa({ yes: true }, deps({ configuredOrigin: async () => 'http://127.0.0.1:4000' }));
    expect(r.status).toBe('installed');
    expect(stored).toEqual([]);
    expect(out.join('')).toMatch(/already uses the bridge http:\/\/127\.0\.0\.1:4000/);
  });
});

describe('download and archive checks', () => {
  it('hash mismatch: nothing is extracted or written, systemctl is not called', async () => {
    const d = deps({ pins: { linux_amd64: { sha256: 'f'.repeat(64), entry: 'linux-amd64' } } });
    const err = await rejection(installGowa({ yes: true }, d));
    expect((err as PerchError).code).toBe('hash_mismatch');
    expect(err.message).toMatch(/Nothing was installed/);
    expect(await exists(gowaDir())).toBe(false);
    expect(await exists(unitPath())).toBe(false);
    expect(runs).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('refuses redirects away from GitHub release hosts and plain HTTP', async () => {
    for (const target of ['https://evil.example.com/x.zip', 'http://release-assets.githubusercontent.com/x.zip', 'https://release-assets.githubusercontent.com:8443/x']) {
      fetched = [];
      const d = deps({ fetch: githubFetch(goodZip(), target) });
      expect(await codeOf(installGowa({ yes: true }, d))).toBe('download_refused');
      expect(fetched).toHaveLength(1); // the hostile target is never requested
    }
    expect(await exists(gowaDir())).toBe(false);
  });

  it('refuses an oversized download (declared and streamed)', async () => {
    const declared: InstallDeps['fetch'] = async () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_ARCHIVE_BYTES + 1) } });
    expect(await codeOf(installGowa({ yes: true }, deps({ fetch: declared })))).toBe('download_too_large');
    const chunk = new Uint8Array(1024 * 1024);
    let n = 0;
    const streamed: InstallDeps['fetch'] = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ > 65) c.close();
            else c.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    expect(await codeOf(installGowa({ yes: true }, deps({ fetch: streamed })))).toBe('download_too_large');
    expect(await exists(gowaDir())).toBe(false);
  });

  it('a hostile archive with the pinned hash is still refused, nothing written', async () => {
    const zip = buildZip([
      { name: '../evil', data: Buffer.from('x') },
      { name: 'linux-amd64', data: BINARY },
    ]);
    expect(await codeOf(installGowa({ yes: true }, deps({}, zip)))).toBe('bad_archive');
    expect(await exists(gowaDir())).toBe(false);
    expect(await exists(path.join(dirs.root, 'evil'))).toBe(false);
  });

  it('ZIP reader: traversal, absolute names, missing/duplicate entries, oversize, bombs and CRC errors', () => {
    const ok = buildZip([{ name: 'linux-amd64', data: BINARY }]);
    expect(extractZipEntry(ok, 'linux-amd64', 1 << 20)).toEqual(BINARY);
    expect(listZipEntries(ok)).toEqual(['linux-amd64']);
    for (const name of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'a\\..\\x']) {
      expect(() => extractZipEntry(buildZip([{ name, data: Buffer.from('x') }, { name: 'linux-amd64', data: BINARY }]), 'linux-amd64', 1 << 20)).toThrow(/unsafe entry name/);
    }
    expect(() => extractZipEntry(ok, 'whatsapp', 1 << 20)).toThrow(/missing/);
    expect(() => extractZipEntry(buildZip([{ name: 'whatsapp', data: BINARY }]), 'linux-amd64', 1 << 20)).toThrow(/missing/);
    const dup = buildZip([
      { name: 'linux-amd64', data: BINARY },
      { name: 'linux-amd64', data: Buffer.from('other') },
    ]);
    expect(() => extractZipEntry(dup, 'linux-amd64', 1 << 20)).toThrow(/more than once/);
    expect(() => extractZipEntry(ok, 'linux-amd64', 100)).toThrow(/exceeds/);
    // A deflate bomb that lies about its size: declared small, inflates past the limit.
    const bomb = buildZip([{ name: 'linux-amd64', data: Buffer.alloc(5 * 1024 * 1024), declaredSize: 10 }]);
    expect(() => extractZipEntry(bomb, 'linux-amd64', 1024 * 1024)).toThrow(/could not be decompressed|exceeds|does not match/);
    expect(() => extractZipEntry(buildZip([{ name: 'linux-amd64', data: BINARY, crc: 1 }]), 'linux-amd64', 1 << 20)).toThrow(/CRC-32/);
    expect(() => extractZipEntry(Buffer.from('not a zip at all, definitely not'), 'linux-amd64', 1 << 20)).toThrow(/end of central directory/);
    expect(() => extractZipEntry(ok, '../x', 1 << 20)).toThrow();
  });
});

describe('refusals', () => {
  it('refuses non-Linux, unsupported CPUs and root before any download', async () => {
    expect(await codeOf(installGowa({ yes: true }, deps({ platform: 'darwin' })))).toBe('unsupported_platform');
    expect(await codeOf(installGowa({ yes: true }, deps({ arch: 'ia32' })))).toBe('unsupported_platform');
    const root = await rejection(installGowa({ yes: true }, deps({ uid: 0 })));
    expect((root as PerchError).code).toBe('refused_root');
    expect(fetched).toEqual([]);
  });

  it('arm64 uses the arm64 asset and entry', async () => {
    const zip = buildZip([{ name: 'linux-arm64', data: BINARY }]);
    const d = deps({ arch: 'arm64', pins: { linux_arm64: { sha256: sha(zip), entry: 'linux-arm64' } } }, zip);
    await installGowa({ yes: true }, d);
    expect(fetched[0]).toBe(gowaDownloadUrl('linux_arm64'));
  });

  it('without a terminal and without --yes nothing happens; "no" aborts too', async () => {
    expect(await codeOf(installGowa({ yes: false }, deps({ ask: undefined })))).toBe('no_tty');
    expect(await codeOf(installGowa({ yes: false }, deps({ ask: async () => Promise.reject(new Error('no TTY')) })))).toBe('no_tty');
    expect(await codeOf(installGowa({ yes: false }, deps({ ask: async () => 'n' })))).toBe('aborted');
    expect(await codeOf(installGowa({ yes: false }, deps({ ask: async () => '' })))).toBe('aborted');
    expect(fetched).toEqual([]);
    expect(await exists(gowaDir())).toBe(false);
  });

  it('refuses foreign files, another version and a different unit', async () => {
    await mkdir(gowaDir(), { mode: 0o700 });
    await writeFile(path.join(gowaDir(), 'notes.txt'), 'mine');
    expect(await codeOf(installGowa({ yes: true }, deps()))).toBe('foreign_files');
    await (await import('node:fs/promises')).rm(gowaDir(), { recursive: true });

    await mkdir(gowaDir(), { mode: 0o700 });
    await writeFile(path.join(gowaDir(), '.perch-gowa.json'), JSON.stringify({ version: '9.5.0', arch: 'linux_amd64' }), { mode: 0o600 });
    const other = await rejection(installGowa({ yes: true }, deps()));
    expect((other as PerchError).code).toBe('other_version');
    expect(other.message).toMatch(/9\.5\.0/);
    await (await import('node:fs/promises')).rm(gowaDir(), { recursive: true });

    await mkdir(path.dirname(unitPath()), { recursive: true });
    await writeFile(unitPath(), '[Service]\nExecStart=/somewhere/else\n');
    expect(await codeOf(installGowa({ yes: true }, deps()))).toBe('foreign_files');
    expect(fetched).toEqual([]);
  });

  it('accepts an existing empty private directory', async () => {
    await mkdir(gowaDir(), { mode: 0o700 });
    expect((await installGowa({ yes: true }, deps())).status).toBe('installed');
  });
});

describe('service start and health poll', () => {
  it('waits until GET /devices answers', async () => {
    let calls = 0;
    const r = await installGowa(
      { yes: true },
      deps({
        probe: async () => {
          if (++calls < 4) throw new Error('MOCK: connection refused');
        },
      }),
    );
    expect(r.status).toBe('installed');
    expect(calls).toBe(4);
    expect(sleeps).toBe(3);
  });

  it('times out with a journalctl hint and does not store the bridge', async () => {
    const err = await rejection(installGowa({ yes: true }, deps({ probe: async () => Promise.reject(new Error('MOCK: refused')) })));
    expect((err as PerchError).code).toBe('gowa_unhealthy');
    expect(err.message).toContain('journalctl --user -u gowa -n 50');
    expect(err.message).not.toContain(PASSWORD);
    expect(stored).toEqual([]);
  });

  it('explains a missing user bus (XDG_RUNTIME_DIR)', async () => {
    const run = async (cmd: string, args: string[]): Promise<RunResult> => {
      runs.push([cmd, ...args]);
      return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found\n' };
    };
    const err = await rejection(installGowa({ yes: true }, deps({ run })));
    expect((err as PerchError).code).toBe('systemd_failed');
    expect(err.message).toMatch(/XDG_RUNTIME_DIR/);
    expect(err.message).toMatch(/enable-linger/);
    expect(stored).toEqual([]);
  });
});

// ---------- CLI and setup ----------

describe('perch whatsapp install / perch setup [MOCK GOWA]', () => {
  let gowa: MockGowa;
  let cliOut: string;
  let cliErr: string;

  function io(answers: string[] = [], extra: Partial<CliIo> = {}): CliIo {
    return {
      env: { PERCH_DATA_DIR: dirs.dataDir, PERCH_KEY_FILE: dirs.keyFile, PERCH_HTTP_TOKEN_FILE: dirs.tokenFile, HOME: home },
      stdout: (s) => void (cliOut += s),
      stderr: (s) => void (cliErr += s),
      readSecret: async () => {
        throw new Error('no TTY in tests');
      },
      readLine: async () => {
        const a = answers.shift();
        if (a === undefined) throw new Error('MOCK: no more answers');
        return a;
      },
      transport: gowa.transport,
      sleep: async () => {},
      whatsappInstall: (() => {
        const d = deps();
        // The CLI supplies probe/store/configuredOrigin/ask/out itself (real Perch store, MOCK GOWA transport).
        return { platform: d.platform, arch: d.arch, uid: d.uid, fetch: d.fetch, run: d.run, sleep: d.sleep, now: d.now, password: d.password, pins: d.pins, healthTimeoutMs: 1000 };
      })(),
      ...extra,
    };
  }
  const openStore = () => CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });

  beforeEach(async () => {
    gowa = new MockGowa('http://127.0.0.1:3000', 'perch', PASSWORD);
    cliOut = '';
    cliErr = '';
    expect(await runCli(['init'], io())).toBe(0);
    cliOut = '';
  });

  it('installs, verifies against the bridge and stores it like instance set; the password is never printed', async () => {
    expect(await runCli(['whatsapp', 'install', '--yes'], io()), cliErr).toBe(0);
    const inst = (await (await openStore()).read()).whatsappInstance;
    expect(inst).toMatchObject({ origin: 'http://127.0.0.1:3000', username: 'perch', password: PASSWORD });
    expect(gowa.calls.some((c) => c.url.pathname === '/devices' && c.method === 'GET')).toBe(true);
    expect(cliOut).toMatch(/Next: perch whatsapp add --label NAME --phone/);
    expect(cliOut + cliErr).not.toContain(PASSWORD);
    cliOut = '';
    expect(await runCli(['whatsapp', 'install'], io())).toBe(0); // re-run: no prompt needed
    expect(cliOut).toMatch(/already installed/);
    expect(cliOut + cliErr).not.toContain(PASSWORD);
  });

  it('aborts without a terminal and without --yes', async () => {
    expect(await runCli(['whatsapp', 'install'], io([], { readLine: undefined }))).toBe(1);
    expect(cliErr).toMatch(/No interactive terminal/);
    expect(await exists(gowaDir())).toBe(false);
  });

  it('validates --port and refuses extra positionals', async () => {
    expect(await runCli(['whatsapp', 'install', '--yes', '--port', '70000'], io())).toBe(2);
    expect(await runCli(['whatsapp', 'install', 'now'], io())).toBe(2);
  });

  it('perch setup offers the install when no bridge is configured, then pairs', async () => {
    const answers = [
      'n', // Google Drive
      'n', // Gmail
      'n', // Calendar/Contacts
      'n', // Outlook
      'n', // IMAP
      'n', // Notion
      'n', // Slack
      'y', // WhatsApp
      'y', // install GOWA (warning shown)
      'Private', // label
      '+4366012345678', // phone
      'n', // another WhatsApp account
      'n', // Luma
      'n', // full-access client
    ];
    expect(await runCli(['setup'], io(answers)), cliErr).toBe(0);
    expect(answers).toHaveLength(0);
    expect(cliOut).toMatch(/No WhatsApp bridge is configured yet/);
    expect(cliOut).toMatch(/UNOFFICIAL/);
    expect(cliOut).toContain('Pairing code: ABCD-1234');
    const data = await (await openStore()).read();
    expect(data.whatsappInstance?.origin).toBe('http://127.0.0.1:3000');
    expect(data.whatsapp).toHaveLength(1);
    expect(cliOut + cliErr).not.toContain(PASSWORD);
  });

  it('perch setup skips WhatsApp when the install is declined', async () => {
    const answers = ['n', 'n', 'n', 'n', 'n', 'n', 'n', 'y', 'n', 'n', 'n'];
    expect(await runCli(['setup'], io(answers)), cliErr).toBe(0);
    expect(answers).toHaveLength(0);
    expect(cliOut).toMatch(/Skipping WhatsApp/);
    expect(await exists(gowaDir())).toBe(false);
    expect((await (await openStore()).read()).whatsapp).toHaveLength(0);
  });
});
