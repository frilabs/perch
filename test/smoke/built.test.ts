// Smoke tests of the BUILT artifact (dist/cli.js) with a freshly initialised store.
// No upstream (Google/Notion/Gmail/Graph/IMAP/SMTP) is contacted: the only mail account is a dummy
// IMAP entry seeded directly into the store, and every mail call below is denied before any I/O.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/store/credentialStore.js';
import { dummySecret, makeTempDirs, type TempDirs } from '../support/fixtures.js';

/** Read-only tool count (Drive/Notion 14 + mail read 3). Write tools need a client grant. */
const READ_ONLY_TOOLS = 17;

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
    expect(tools).toHaveLength(READ_ONLY_TOOLS);
    expect(tools.map((t) => t.name)).not.toContain('mail_send');
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
      expect((await client.listTools()).tools).toHaveLength(READ_ONLY_TOOLS);
      // The global token is read-only: the send tool does not exist on this connection.
      const denied = await client.callTool({ name: 'mail_send', arguments: {} }).catch(() => ({ isError: true }));
      expect(denied.isError).toBe(true);
      const res = await client.callTool({ name: 'drive_search', arguments: { query: 'x' } });
      expect(JSON.parse(text(res))).toMatchObject({ results: [], hasMore: false });
      await client.close();
    } finally {
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    }
  });

  it('selects a client grant over stdio via PERCH_CLIENT_TOKEN_FILE and enforces it', async () => {
    const store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const now = new Date().toISOString();
    await store.update((d) => {
      for (const id of ['imap-0000000a', 'imap-0000000b']) {
        d.imap.push({
          id,
          label: `Dummy ${id}`,
          email: `${id}@example.test`,
          username: `${id}@example.test`,
          password: dummySecret('PW'),
          imap: { host: 'imap.invalid.example', port: 993 },
          smtp: { host: 'smtp.invalid.example', port: 465, security: 'tls' },
          allowDrafts: true,
          allowSend: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const tokenFile = path.join(dirs.root, 'config', 'clients', 'smoke.token');
    const add = spawnSync(
      process.execPath,
      [CLI, 'client', 'add', '--label', 'Smoke', '--allow', 'send', '--account', 'imap-0000000a', '--token-file', tokenFile],
      { env, encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).not.toContain((await readFile(tokenFile, 'utf8')).trim());

    const client = new Client({ name: 'smoke-client', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', '--stdio'],
        env: { ...env, PERCH_CLIENT_TOKEN_FILE: tokenFile },
        stderr: 'pipe',
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    // A send-only client grant gets exactly the tools it needs: no Drive/Notion, no mail read tools.
    expect(names.sort()).toEqual(['mail_send', 'perch_list_accounts']);
    const other = await client.callTool({
      name: 'mail_send',
      arguments: { accountId: 'imap-0000000b', to: ['x@example.test'], subject: 's', text: 't' },
    });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/not granted/i);
    const read = await client
      .callTool({ name: 'mail_read_message', arguments: { accountId: 'imap-0000000a', messageId: 'imap:SU5CT1g:1:1' } })
      .catch(() => ({ isError: true }));
    expect(read.isError).toBe(true);
    const drive = await client.callTool({ name: 'drive_search', arguments: { query: 'x' } }).catch(() => ({ isError: true }));
    expect(drive.isError).toBe(true);
    await client.close();
  });

  it('applies grant narrowing and `perch client remove` to a running stdio server on the next tool call', async () => {
    // Accounts were seeded by the previous test; their hosts are unresolvable, and every call below that
    // reaches the mail service is denied before any I/O (or is perch_list_accounts, which does no I/O).
    const tokenFile = path.join(dirs.root, 'config', 'clients', 'revoke.token');
    const add = spawnSync(
      process.execPath,
      [CLI, 'client', 'add', '--label', 'Revoke', '--allow', 'read,send', '--account', 'imap-0000000a', '--token-file', tokenFile],
      { env, encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    const store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const grantId = (await store.read()).clients.find((c) => c.label === 'Revoke')!.id;

    const client = new Client({ name: 'smoke-revoke', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', '--stdio'],
        env: { ...env, PERCH_CLIENT_TOKEN_FILE: tokenFile },
        stderr: 'pipe',
      }),
    );
    const before = JSON.parse(text(await client.callTool({ name: 'perch_list_accounts', arguments: {} })));
    expect(Object.keys(before).sort()).toEqual(['connection', 'mail']);
    expect(before.mail.map((m: { accountId: string }) => m.accountId)).toEqual(['imap-0000000a']);

    await store.update((d) => {
      d.clients.find((c) => c.id === grantId)!.capabilities = ['read'];
    });
    const narrowed = await client.callTool({
      name: 'mail_send',
      arguments: { accountId: 'imap-0000000a', to: ['x@example.test'], subject: 's', text: 't' },
    });
    expect(narrowed.isError).toBe(true);
    expect(text(narrowed)).toMatch(/not granted/i);

    const remove = spawnSync(process.execPath, [CLI, 'client', 'remove', grantId], { env, encoding: 'utf8' });
    expect(remove.status, remove.stderr).toBe(0);
    for (const [name, args] of [
      ['perch_list_accounts', {}],
      ['mail_search', {}],
      ['mail_send', { accountId: 'imap-0000000a', to: ['x@example.test'], subject: 's', text: 't' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/revoked/i);
    }
    await client.close();
  });
});
