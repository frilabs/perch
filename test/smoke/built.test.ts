// Smoke tests of the BUILT artifact (dist/cli.js) with an empty, freshly initialised store.
// No accounts are configured, so no upstream (Google/Notion) is contacted.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDirs, type TempDirs } from '../support/fixtures.js';

const CLI = path.resolve('dist/cli.js');
let dirs: TempDirs;
let env: Record<string, string>;

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ text: string }>)[0]!.text;

beforeAll(async () => {
  expect(existsSync(CLI), 'run `npm run build` first').toBe(true);
  dirs = await makeTempDirs();
  env = {
    PATH: process.env.PATH ?? '',
    HOME: dirs.root,
    PERCH_DATA_DIR: dirs.dataDir,
    PERCH_KEY_FILE: dirs.keyFile,
    PERCH_HTTP_TOKEN_FILE: dirs.tokenFile,
  };
  const init = spawnSync(process.execPath, [CLI, 'init'], { env, encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
});
afterAll(async () => {
  await dirs?.cleanup();
});

describe('built artifact', () => {
  it('prints version and lists no accounts', () => {
    const v = spawnSync(process.execPath, [CLI, '--version'], { env, encoding: 'utf8' });
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const a = spawnSync(process.execPath, [CLI, 'accounts'], { env, encoding: 'utf8' });
    expect(a.status).toBe(0);
    expect(a.stdout).toContain('(none)');
  });

  it('serves MCP over stdio', async () => {
    const client = new Client({ name: 'smoke-stdio', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--stdio'], env, stderr: 'pipe' }));
    expect(client.getServerVersion()?.name).toBe('perch');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    const res = await client.callTool({ name: 'perch_list_accounts', arguments: {} });
    expect(JSON.parse(text(res))).toMatchObject({ google: [], notion: [] });
    await client.close();
  });

  it('serves MCP over authenticated HTTP and shuts down on SIGTERM', async () => {
    const child: ChildProcess = spawn(process.execPath, [CLI, 'serve', '--http', '--port', '0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = '';
        child.stderr!.on('data', (c: Buffer) => {
          buf += c.toString();
          const m = /listening on (http:\/\/\S+)/.exec(buf);
          if (m) resolve(m[1]!);
        });
        child.once('exit', (code) => reject(new Error(`exited early (${code}): ${buf}`)));
      });
      expect(new URL(url).hostname).toBe('127.0.0.1');

      const unauth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauth.status).toBe(401);

      const token = (await readFile(dirs.tokenFile, 'utf8')).trim();
      const client = new Client({ name: 'smoke-http', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      );
      expect((await client.listTools()).tools).toHaveLength(14);
      const res = await client.callTool({ name: 'drive_search', arguments: { query: 'x' } });
      expect(JSON.parse(text(res))).toMatchObject({ results: [], hasMore: false });
      await client.close();
    } finally {
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    }
  });
});
