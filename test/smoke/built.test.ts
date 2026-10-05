// Smoke tests of the BUILT artifact (dist/cli.js) with a freshly initialised store.
// No upstream (Google/Notion/Gmail/Graph/IMAP/SMTP/Calendar/People) is contacted: the only accounts are
// dummy entries seeded directly into the store, and every mail/calendar call below is denied before any I/O.
// Every child process additionally runs under the test-only offline guard (test/smoke/offlineGuard.mjs,
// preloaded with --import): its fetch, outbound sockets and DNS APIs are blocked and logged. The suite first proves
// the guard is active in a child and finally asserts that the smoke run itself made zero network attempts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principalForClientToken } from '../../src/auth/grants.js';
import { MailService, type MailProviders } from '../../src/mail/service.js';
import type { MailProvider } from '../../src/mail/types.js';
import { MailWorkflowLedger } from '../../src/mail/workflowLedger.js';
import { CredentialStore } from '../../src/store/credentialStore.js';
import { openUserStore } from '../../src/users/registry.js';
import { dummySecret, makeTempDirs, type TempDirs } from '../support/fixtures.js';

/** Read-only tool count (Drive/Notion 14 + mail read 3 + Calendar read 3 + Contacts read 2). Write tools need a client grant. */
const READ_ONLY_TOOLS = 22;

const CLI = path.resolve('dist/cli.js');
const GUARD = pathToFileURL(path.resolve('test/smoke/offlineGuard.mjs')).href;
let dirs: TempDirs;
let env: Record<string, string>;
let guardLog: string;

const guardAttempts = async (file: string) =>
  existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; target: string }) : [];

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
    // Network guard (test-only preload, works on every supported Node version): even a regression that
    // let a call past authorization cannot reach Google or anything else; the attempt is logged instead.
    NODE_OPTIONS: `--import=${GUARD}`,
    PERCH_SMOKE_GUARD_LOG: '',
  };
  // Prove the guard is active before any child touches the store: a probe child under the same options
  // tries a token request and a raw TLS connect to Google. Both must be blocked and logged.
  const probeLog = path.join(dirs.root, 'guard-probe.log');
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const tls = require('node:tls');
       const dns = require('node:dns');
       const out = { fetchName: globalThis.fetch.name };
       const viaCb = (f) => new Promise((r) => f((e) => r(e ? e.message : 'SENT')));
       fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: 'grant_type=refresh_token' })
         .then(() => { out.fetch = 'SENT'; }, (e) => { out.fetch = e.message; })
         .then(() => { try { tls.connect(443, 'oauth2.googleapis.com'); out.tls = 'SENT'; } catch (e) { out.tls = e.message; } })
         .then(() => viaCb((cb) => new dns.Resolver().resolve4('smtp.invalid.example', cb))).then((m) => { out.resolver = m; })
         .then(() => viaCb((cb) => dns.lookup('smtp.invalid.example', { all: true }, cb))).then((m) => { out.lookup = m; })
         .then(() => dns.promises.resolve6('smtp.invalid.example').then(() => 'SENT', (e) => e.message)).then((m) => { out.promises = m; })
         .then(() => console.log(JSON.stringify(out)));`,
    ],
    { env: { ...env, PERCH_SMOKE_GUARD_LOG: probeLog }, encoding: 'utf8', timeout: 15_000 },
  );
  expect(probe.status, probe.stderr).toBe(0);
  const out = JSON.parse(probe.stdout);
  expect(out.fetchName, 'offline guard not loaded in the child').toBe('perchSmokeOfflineFetch');
  expect(out.fetch).toMatch(/offline guard: blocked fetch to https:\/\/oauth2\.googleapis\.com\/token/);
  expect(out.tls).toMatch(/offline guard: blocked socket connect/);
  // DNS too (nodemailer resolves with its own dns.Resolver before connecting): no query leaves the child.
  for (const k of ['resolver', 'lookup', 'promises']) expect(out[k], k).toMatch(/offline guard: blocked dns/);
  expect((await guardAttempts(probeLog)).map((a) => a.kind)).toEqual(['fetch', 'connect', 'dns', 'dns', 'dns']);
  // From here on every child logs blocked attempts here; the last test asserts there were none.
  guardLog = path.join(dirs.root, 'guard.log');
  env.PERCH_SMOKE_GUARD_LOG = guardLog;
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
    expect(names.sort()).toEqual(['mail_send', 'mail_send_status', 'perch_list_accounts']);
    const other = await client.callTool({
      name: 'mail_send',
      arguments: { requestId: 'smoke-send-0001', accountId: 'imap-0000000b', to: ['x@example.test'], subject: 's', text: 't' },
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
      arguments: { requestId: 'smoke-send-0002', accountId: 'imap-0000000a', to: ['x@example.test'], subject: 's', text: 't' },
    });
    expect(narrowed.isError).toBe(true);
    expect(text(narrowed)).toMatch(/not granted/i);

    const remove = spawnSync(process.execPath, [CLI, 'client', 'remove', grantId], { env, encoding: 'utf8' });
    expect(remove.status, remove.stderr).toBe(0);
    for (const [name, args] of [
      ['perch_list_accounts', {}],
      ['mail_search', {}],
      ['mail_send', { requestId: 'smoke-send-0003', accountId: 'imap-0000000a', to: ['x@example.test'], subject: 's', text: 't' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/revoked/i);
    }
    await client.close();
  });

  it('serves a Calendar client grant over stdio: capability-specific tools, no mail, denial before I/O, revocation', async () => {
    const store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const now = new Date().toISOString();
    await store.update((d) => {
      for (const id of ['gprod-0000000a', 'gprod-0000000b']) {
        d.googleProductivity.push({
          id,
          label: `Dummy ${id}`,
          email: `${id}@example.test`,
          sub: `1${id.slice(-2)}`,
          clientId: dummySecret('C'),
          clientSecret: dummySecret('S'),
          refreshToken: dummySecret('RT'),
          scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events.owned'],
          services: ['calendar'],
          allowCalendarWrite: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const tokenFile = path.join(dirs.root, 'config', 'clients', 'calendar.token');
    const add = spawnSync(
      process.execPath,
      [CLI, 'client', 'add', '--label', 'Cal', '--allow', 'calendar_read,calendar_write', '--account', 'gprod-0000000a', '--token-file', tokenFile],
      { env, encoding: 'utf8' },
    );
    expect(add.status, add.stderr).toBe(0);
    const grantId = (await store.read()).clients.find((c) => c.label === 'Cal')!.id;

    const client = new Client({ name: 'smoke-calendar', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--stdio'], env: { ...env, PERCH_CLIENT_TOKEN_FILE: tokenFile }, stderr: 'pipe' }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['calendar_create_event', 'calendar_get_event', 'calendar_list_calendars', 'calendar_list_events', 'calendar_update_event', 'perch_list_accounts']);
    const accounts = JSON.parse(text(await client.callTool({ name: 'perch_list_accounts', arguments: {} })));
    expect(Object.keys(accounts).sort()).toEqual(['connection', 'googleProductivity']);
    expect(accounts.googleProductivity.map((a: { accountId: string }) => a.accountId)).toEqual(['gprod-0000000a']);
    const event = { requestId: 'smoke-req-0001', summary: 's', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } };
    const other = await client.callTool({ name: 'calendar_create_event', arguments: { accountId: 'gprod-0000000b', ...event } });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/not granted/i);
    const invite = await client.callTool({ name: 'calendar_create_event', arguments: { accountId: 'gprod-0000000a', ...event, attendees: [{ email: 'x@example.test' }] } });
    expect(invite.isError).toBe(true);
    expect(text(invite)).toMatch(/attendees is not supported/i);
    const mail = await client.callTool({ name: 'mail_search', arguments: {} }).catch(() => ({ isError: true }));
    expect(mail.isError).toBe(true);

    await store.update((d) => {
      d.clients.find((c) => c.id === grantId)!.capabilities = ['calendar_read'];
    });
    const narrowed = await client.callTool({ name: 'calendar_create_event', arguments: { accountId: 'gprod-0000000a', ...event } });
    expect(narrowed.isError).toBe(true);
    expect(text(narrowed)).toMatch(/not granted/i);

    const remove = spawnSync(process.execPath, [CLI, 'client', 'remove', grantId], { env, encoding: 'utf8' });
    expect(remove.status, remove.stderr).toBe(0);
    for (const [name, args] of [
      ['perch_list_accounts', {}],
      ['calendar_list_events', {}],
      ['calendar_create_event', { accountId: 'gprod-0000000a', ...event }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toMatch(/revoked/i);
    }
    await client.close();
  });

  it('keeps a mail-only client free of Calendar/Contacts tools in the built artifact', async () => {
    const tokenFile = path.join(dirs.root, 'config', 'clients', 'mailonly.token');
    const add = spawnSync(process.execPath, [CLI, 'client', 'add', '--label', 'MailOnly', '--allow', 'read', '--account', 'imap-0000000a', '--token-file', tokenFile], {
      env,
      encoding: 'utf8',
    });
    expect(add.status, add.stderr).toBe(0);
    const client = new Client({ name: 'smoke-mailonly', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--stdio'], env: { ...env, PERCH_CLIENT_TOKEN_FILE: tokenFile }, stderr: 'pipe' }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['mail_get_attachment', 'mail_read_message', 'mail_search', 'perch_list_accounts']);
    const listed = text(await client.callTool({ name: 'perch_list_accounts', arguments: {} }));
    expect(listed).not.toMatch(/gprod-|googleProductivity/);
    await client.close();
  });

  it('provisions users and routes HTTP by token; PERCH_USER stdio sees only its namespace and stops on user removal', async () => {
    // Root already holds imap-0000000a (seeded above); both users get the SAME id with their own label.
    const ids: Record<string, string> = {};
    for (const label of ['Alice', 'Bob']) {
      const add = spawnSync(process.execPath, [CLI, 'user', 'add', '--label', label], { env, encoding: 'utf8' });
      expect(add.status, add.stderr).toBe(0);
      ids[label] = /Created user (user-[a-f0-9]{16})/.exec(add.stdout)![1]!;
      const store = await openUserStore(await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile }), ids[label]!);
      const now = new Date().toISOString();
      await store.update((d) => {
        d.imap.push({
          id: 'imap-0000000a',
          label: `${label} GMX`,
          email: `${label.toLowerCase()}@example.test`,
          username: `${label.toLowerCase()}@example.test`,
          password: dummySecret('PW'),
          imap: { host: 'imap.invalid.example', port: 993 },
          smtp: { host: 'smtp.invalid.example', port: 465, security: 'tls' },
          allowDrafts: false,
          allowSend: false,
          createdAt: now,
          updatedAt: now,
        });
      });
    }
    const userToken = async (label: string) => (await readFile(path.join(path.dirname(dirs.tokenFile), 'users', `${ids[label]}.token`), 'utf8')).trim();
    const labelsOf = (listed: { mail: Array<{ accountLabel: string }> }) => listed.mail.map((m) => m.accountLabel).sort();

    // A malformed or unknown selector never falls back to root.
    for (const bad of ['', 'user-0123456789abcdef', '../x']) {
      const r = spawnSync(process.execPath, [CLI, 'accounts'], { env: { ...env, PERCH_USER: bad }, encoding: 'utf8' });
      expect(r.status, bad).not.toBe(0);
      expect(r.stdout).toBe('');
    }

    const child: ChildProcess = spawn(process.execPath, [CLI, 'serve', '--http', '--port', '0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const stdio = new Client({ name: 'smoke-user-stdio', version: '0.0.0' });
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
      const listOver = async (token: string) => {
        const c = new Client({ name: 'smoke-user-http', version: '0.0.0' });
        await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        const listed = JSON.parse(text(await c.callTool({ name: 'perch_list_accounts', arguments: {} })));
        await c.close();
        return listed;
      };
      const alice = await listOver(await userToken('Alice'));
      expect(labelsOf(alice)).toEqual(['Alice GMX']);
      expect(alice.connection).toMatchObject({ kind: 'operator_readonly', user: ids.Alice });
      expect(labelsOf(await listOver(await userToken('Bob')))).toEqual(['Bob GMX']);
      const root = await listOver((await readFile(dirs.tokenFile, 'utf8')).trim());
      expect(labelsOf(root)).not.toContain('Alice GMX');
      expect(JSON.stringify(root)).not.toMatch(/Alice|Bob|user-[a-f0-9]{16}/);

      await stdio.connect(
        new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--stdio'], env: { ...env, PERCH_USER: ids.Alice! }, stderr: 'pipe' }),
      );
      expect(labelsOf(JSON.parse(text(await stdio.callTool({ name: 'perch_list_accounts', arguments: {} }))))).toEqual(['Alice GMX']);

      const remove = spawnSync(process.execPath, [CLI, 'user', 'remove', ids.Alice!], { env, encoding: 'utf8' });
      expect(remove.status, remove.stderr).toBe(0);
      // The running stdio session fails on its next tool call, before any provider I/O (mail_search would
      // otherwise try to reach the unresolvable IMAP host and be logged by the offline guard).
      const results: Array<[string, boolean, string]> = [];
      for (const [name, args] of [
        ['mail_search', {}],
        ['perch_list_accounts', {}],
        ['drive_search', { query: 'x' }],
      ] as const) {
        const r = await stdio.callTool({ name, arguments: args });
        results.push([name, r.isError === true, text(r)]);
      }
      for (const [name, isError, body] of results) {
        expect(isError, name).toBe(true);
        expect(body, name).toMatch(/removed or disabled/i);
      }
      const after = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${await userToken('Alice')}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }),
      });
      expect(after.status).toBe(401);
      expect(labelsOf(await listOver(await userToken('Bob')))).toEqual(['Bob GMX']);
      const reselect = spawnSync(process.execPath, [CLI, 'accounts'], { env: { ...env, PERCH_USER: ids.Alice! }, encoding: 'utf8' });
      expect(reselect.status).not.toBe(0);
    } finally {
      await stdio.close().catch(() => {});
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    }
  });

  it('keeps idempotent send records and a body-free audit trail in the built artifact (stdio + HTTP), without network', async () => {
    const MARK = { text: 'BODY-MARKER-smoke', subject: 'SUBJECT-MARKER-smoke', to: 'rcpt-marker-smoke@example.test', requestId: 'REQ-MARKER-smoke-01' };
    const tokenFile = path.join(dirs.root, 'config', 'clients', 'workflow.token');
    const add = spawnSync(process.execPath, [CLI, 'client', 'add', '--label', 'WorkflowClient', '--allow', 'read,send', '--account', 'imap-0000000a', '--token-file', tokenFile], {
      env,
      encoding: 'utf8',
    });
    expect(add.status, add.stderr).toBe(0);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    // A send whose process "died" mid-attempt: claimed (pending) in this test process by the same ledger code,
    // with a MOCK provider that never returns. The built server must replay it as unknown and never send it.
    const store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    let attempts = 0;
    const hanging = {
      kind: 'imap',
      providerCapabilities: () => ({ draft: true, send: true }),
      replyContext: async () => ({ references: [] }),
      send: () => (attempts++, new Promise(() => {})),
    } as unknown as MailProvider<unknown>;
    const args = { accountId: 'imap-0000000a', requestId: MARK.requestId, to: [MARK.to], subject: MARK.subject, text: MARK.text };
    void new MailService(store, { gmail: hanging, microsoft: hanging, imap: hanging } as unknown as MailProviders).send((await principalForClientToken(store, token))!, args);
    for (let i = 0; i < 300 && attempts === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(attempts).toBe(1);

    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'serve', '--stdio'], env: { ...env, PERCH_CLIENT_TOKEN_FILE: tokenFile }, stderr: 'pipe' });
    let childErr = '';
    transport.stderr?.on('data', (c: Buffer) => (childErr += c.toString()));
    const client = new Client({ name: 'smoke-workflow', version: '0.0.0' });
    await client.connect(transport);
    const sendTool = (await client.listTools()).tools.find((t) => t.name === 'mail_send')!;
    expect(sendTool.inputSchema.required).toContain('requestId');
    const replay = await client.callTool({ name: 'mail_send', arguments: args });
    expect(replay.isError, text(replay)).toBeFalsy();
    expect(JSON.parse(text(replay))).toMatchObject({ status: 'indeterminate', replayed: true, requestState: 'pending' });
    const conflict = await client.callTool({ name: 'mail_send', arguments: { ...args, text: 'changed' } });
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toMatch(/different message/);
    const missingKey = await client.callTool({ name: 'mail_send', arguments: { ...args, requestId: undefined } }).catch((e: Error) => ({ isError: true, e }));
    expect(missingKey.isError).toBe(true);
    const badRecipient = await client.callTool({ name: 'mail_send', arguments: { ...args, requestId: 'fresh-key-0001', to: ['not an address'] } });
    expect(badRecipient.isError).toBe(true);
    const status = JSON.parse(text(await client.callTool({ name: 'mail_send_status', arguments: { accountId: 'imap-0000000a', requestId: MARK.requestId } })));
    expect(status).toMatchObject({ status: 'indeterminate', requestState: 'pending' });
    await client.close();

    // HTTP: another client cannot see this status; the global token is audited as the read-only operator.
    const other = path.join(dirs.root, 'config', 'clients', 'workflow-other.token');
    expect(spawnSync(process.execPath, [CLI, 'client', 'add', '--label', 'Other', '--allow', 'send', '--account', 'imap-0000000a', '--token-file', other], { env, encoding: 'utf8' }).status).toBe(0);
    const http: ChildProcess = spawn(process.execPath, [CLI, 'serve', '--http', '--port', '0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let httpErr = '';
    try {
      const url = await new Promise<string>((resolve, reject) => {
        http.stderr!.on('data', (c: Buffer) => {
          httpErr += c.toString();
          const m = /listening on (http:\/\/\S+)/.exec(httpErr);
          if (m) resolve(m[1]!);
        });
        http.once('exit', (code) => reject(new Error(`exited early (${code}): ${httpErr}`)));
      });
      const over = async (t: string) => {
        const c = new Client({ name: 'smoke-workflow-http', version: '0.0.0' });
        await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
        return c;
      };
      const o = await over((await readFile(other, 'utf8')).trim());
      const peek = await o.callTool({ name: 'mail_send_status', arguments: { accountId: 'imap-0000000a', requestId: MARK.requestId } });
      expect(peek.isError).toBe(true);
      expect(text(peek)).toMatch(/No send with this requestId/);
      await o.close();
      const g = await over((await readFile(dirs.tokenFile, 'utf8')).trim());
      expect((await g.listTools()).tools.map((t) => t.name)).not.toContain('mail_send_status');
      await g.callTool({ name: 'perch_list_accounts', arguments: {} });
      await g.close();
    } finally {
      const exited = new Promise<number | null>((r) => http.once('exit', (code) => r(code)));
      http.kill('SIGTERM');
      expect(await exited).toBe(0);
    }

    const list = spawnSync(process.execPath, [CLI, 'mail-workflow', 'list', '--state', 'pending'], { env, encoding: 'utf8' });
    expect(list.status, list.stderr).toBe(0);
    const op = /(op-[a-f0-9]{24})  pending/.exec(list.stdout)![1]!;
    const resolve = spawnSync(process.execPath, [CLI, 'mail-workflow', 'resolve', op, '--outcome', 'not-sent'], { env, encoding: 'utf8' });
    expect(resolve.status, resolve.stderr).toBe(0);
    const audit = spawnSync(process.execPath, [CLI, 'audit', 'list'], { env, encoding: 'utf8' });
    expect(audit.status, audit.stderr).toBe(0);
    expect(audit.stdout).toMatch(/mail_send  replayed  client client-[a-f0-9]{8}  imap-0000000a \(imap\)  pending/);
    expect(audit.stdout).toMatch(/mail_send  conflict/);
    expect(audit.stdout).toMatch(/mail_send_status  invalid .*unknown_request/);
    expect(audit.stdout).toMatch(/perch_list_accounts  ok  operator \(read-only\)/);
    expect(audit.stdout).toMatch(/workflow_resolve  resolved  local admin  imap-0000000a \(imap\)  not_sent/);
    const ledger = JSON.stringify(await new MailWorkflowLedger(await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile })).read());
    const everything = [ledger, childErr, httpErr, list.stdout, list.stderr, resolve.stdout, resolve.stderr, audit.stdout, audit.stderr].join('\n');
    for (const m of [...Object.values(MARK), 'WorkflowClient', token, 'DUMMY-TEST']) expect(everything, m).not.toContain(m);
    expect(attempts).toBe(1);
  });

  // Runs last (tests in a file run in order): no child process attempted any network connection.
  it('made zero network attempts in all child processes (offline guard log is empty)', async () => {
    expect(await guardAttempts(guardLog)).toEqual([]);
  });
});
