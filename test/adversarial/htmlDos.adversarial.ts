// Adversarial HTML bodies through the real Gmail and Graph read paths (MOCK upstreams only).
// Run in a child process by test/htmlDos.test.ts; each conversion must finish well under a second.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGmailTokenProvider, GMAIL_READONLY_SCOPE, registerGmailAccount } from '../../src/mail/gmailAccounts.js';
import { GmailProvider } from '../../src/mail/gmail.js';
import { GraphMailProvider } from '../../src/mail/graph.js';
import { CredentialStore, initStore, type GmailAccount, type MicrosoftAccount } from '../../src/store/credentialStore.js';
import { Upstream } from '../../src/upstream.js';
import { dummySecret, makeTempDirs, type TempDirs } from '../support/fixtures.js';
import { MockGmail, mime, type MockMessage } from '../support/mockGmail.js';
import { MockGraph, type MockGraphMessage } from '../support/mockGraph.js';

/** Inputs that make backtracking `<[^>]*>` / lazy `[\s\S]*?</x>` patterns quadratic (~2 MB each). */
const ADVERSARIAL: Array<[string, string]> = [
  ['many "<" without ">"', '<'.repeat(2_000_000)],
  ['unclosed "<style" repeated', '<style'.repeat(300_000)],
  ['unclosed "<!--" repeated', '<!--'.repeat(500_000)],
  ['unclosed "<script>" repeated', '<script>'.repeat(250_000)],
  ['"<a" without ">" repeated', '<a '.repeat(650_000)],
  ['"</" repeated', '</'.repeat(1_000_000)],
];
const BUDGET_MS = 1000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

describe('Gmail read() with adversarial HTML-only bodies [MOCK Gmail]', () => {
  let dirs: TempDirs;
  let provider: GmailProvider;
  let account: GmailAccount;

  beforeAll(async () => {
    dirs = await makeTempDirs();
    await initStore({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const store = await CredentialStore.open({ dataDir: dirs.dataDir, keyFile: dirs.keyFile });
    const gmail = new MockGmail();
    const messages: MockMessage[] = ADVERSARIAL.map(([, html], i) => ({
      id: `adv${i}`,
      threadId: 't',
      internalDate: Date.UTC(2026, 0, 1),
      snippet: '',
      payload: mime('text/html', { headers: { Subject: `adv ${i}` }, content: html }),
    }));
    const acct = gmail.addAccount('dummy.adv@example.test', messages);
    account = await registerGmailAccount(store, new Upstream(gmail.transport), {
      label: 'Adversarial',
      client: { clientId: dummySecret('CLIENT'), clientSecret: dummySecret('CLIENT-SECRET') },
      grant: { refreshToken: acct.refreshToken, accessToken: gmail.issueAccessToken(acct), expiresAt: Date.now() + 3600_000, scopes: [GMAIL_READONLY_SCOPE] },
    });
    const upstream = new Upstream(gmail.transport);
    provider = new GmailProvider(upstream, createGmailTokenProvider(store, upstream));
  });
  afterAll(async () => {
    await dirs?.cleanup();
  });

  ADVERSARIAL.forEach(([name], i) => {
    it(`converts "${name}" in under ${BUDGET_MS} ms with a bounded, flagged result`, async () => {
      const { value: msg, ms } = await timed(() => provider.read(account, `adv${i}`, { maxBytes: 4096 }));
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(msg.textSource).toBe('text/html');
      expect(Buffer.byteLength(msg.text ?? '')).toBeLessThanOrEqual(4096);
    });
  });
});

describe('Graph read() with adversarial HTML bodies [MOCK Graph]', () => {
  const now = new Date().toISOString();
  const account: MicrosoftAccount = {
    id: 'microsoft-0000000a', label: 'Outlook', email: 'dummy.one@example.test', tenant: 'consumers',
    clientId: '00000000-0000-4000-8000-00000000d0d0', refreshToken: 'DUMMY-RT', scopes: ['User.Read', 'Mail.Read'], createdAt: now, updatedAt: now,
  };
  const ms = new MockGraph();
  const messages: MockGraphMessage[] = ADVERSARIAL.map(([, html], i) => ({
    id: `adv${i}`, folder: 'inbox', conversationId: 'c', subject: `adv ${i}`, from: 'sender@example.test',
    to: ['dummy.one@example.test'], receivedDateTime: '2026-01-01T00:00:00Z', body: 'unused', internetMessageId: `<adv${i}@example.test>`,
    // MOCK: the server ignores the Prefer text header and answers with HTML.
    htmlBody: html,
  }));
  const user = ms.addAccount('dummy.one@example.test', undefined, messages);
  const token = ms.issueAccessToken(user);
  const provider = new GraphMailProvider(new Upstream(ms.transport), { getAccessToken: async () => token, invalidate: () => {} });

  ADVERSARIAL.forEach(([name], i) => {
    it(`converts "${name}" in under ${BUDGET_MS} ms with a bounded result`, async () => {
      const { value: msg, ms: elapsed } = await timed(() => provider.read(account, `adv${i}`, { maxBytes: 4096 }));
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(msg.textSource).toBe('text/html');
      expect(Buffer.byteLength(msg.text ?? '')).toBeLessThanOrEqual(4096);
    });
  });
});
