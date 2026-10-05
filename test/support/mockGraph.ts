/**
 * MOCK Microsoft identity platform (token endpoint) + Microsoft Graph mail subset, for tests only.
 * This is an in-memory fake of the HTTP APIs; nothing here talks to Microsoft, and passing tests
 * that use it are NOT evidence of a live integration.
 */
import { createHash } from 'node:crypto';
import { PerchError } from '../../src/errors.js';
import type { UpstreamRequest, UpstreamResponse, UpstreamTransport } from '../../src/upstream.js';
import { dummySecret } from './fixtures.js';

export interface MockGraphAttachment {
  '@odata.type': string;
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
}

export interface MockGraphMessage {
  id: string;
  folder: string;
  conversationId: string;
  subject: string;
  from: string;
  to: string[];
  receivedDateTime: string;
  body: string;
  internetMessageId: string;
  headers?: Array<{ name: string; value: string }>;
  attachments?: MockGraphAttachment[];
  /** MOCK only: answer with this HTML body even when the text Prefer header is sent. */
  htmlBody?: string;
}

export interface MockMsAccount {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  refreshToken: string;
  messages: MockGraphMessage[];
}

export interface MockGraphOptions {
  /** Scope string returned by the token endpoint (default: full URIs for User.Read + Mail.Read). */
  grantedScope?: string;
  omitRefreshToken?: boolean;
  /** Rotate the refresh token on every refresh_token grant (Microsoft's usual behaviour). Default true. */
  rotateOnRefresh?: boolean;
  pageSize?: number;
}

const json = (status: number, body: unknown): UpstreamResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});
const graphError = (status: number, code: string) => json(status, { error: { code, message: 'mock error' } });

export class MockGraph {
  readonly calls: UpstreamRequest[] = [];
  readonly accounts: MockMsAccount[] = [];
  readonly codes = new Map<string, { challenge: string; redirectUri: string; account: MockMsAccount }>();
  readonly accessTokens = new Map<string, MockMsAccount>();
  tokenCalls = 0;
  /** Created drafts / sent MIME bodies (decoded). */
  readonly drafts: string[] = [];
  readonly sent: string[] = [];
  /** Intercepts any request before normal handling (inject failures, timeouts, odd payloads). */
  intercept?: (req: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse> | undefined;
  /** Runs while a refresh_token grant is "in flight". */
  beforeRefreshResponse?: () => Promise<void>;

  constructor(public opts: MockGraphOptions = {}) {}

  addAccount(mail: string | null, upn = mail ?? 'dummy@example.test', messages: MockGraphMessage[] = []): MockMsAccount {
    const acct: MockMsAccount = {
      id: dummySecret('MS-USER'),
      displayName: `Dummy ${upn}`,
      mail,
      userPrincipalName: upn,
      refreshToken: dummySecret('MS-REFRESH'),
      messages,
    };
    this.accounts.push(acct);
    return acct;
  }

  approve(authUrl: string, account: MockMsAccount): string {
    const u = new URL(authUrl);
    const code = dummySecret('MS-AUTHCODE');
    this.codes.set(code, {
      challenge: u.searchParams.get('code_challenge')!,
      redirectUri: u.searchParams.get('redirect_uri')!,
      account,
    });
    return code;
  }

  issueAccessToken(account: MockMsAccount): string {
    const t = dummySecret('MS-ACCESS');
    this.accessTokens.set(t, account);
    return t;
  }

  transport: UpstreamTransport = async (req) => {
    this.calls.push(req);
    const intercepted = await this.intercept?.(req);
    if (intercepted) return intercepted;
    if (req.url.origin === 'https://login.microsoftonline.com') return this.token(req);
    if (req.url.origin === 'https://graph.microsoft.com') return this.graph(req);
    return json(404, { error: 'not_found' });
  };

  private async token(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.tokenCalls++;
    const form = new URLSearchParams(req.body ?? '');
    if (form.has('client_secret')) return json(400, { error: 'invalid_request' });
    const scope = this.opts.grantedScope ?? 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read';
    if (form.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      if (!pending) return json(400, { error: 'invalid_grant' });
      this.codes.delete(form.get('code')!);
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== pending.challenge) return json(400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'invalid_request' });
      return json(200, {
        token_type: 'Bearer',
        scope,
        expires_in: 3599,
        access_token: this.issueAccessToken(pending.account),
        ...(this.opts.omitRefreshToken ? {} : { refresh_token: pending.account.refreshToken }),
      });
    }
    if (form.get('grant_type') === 'refresh_token') {
      await this.beforeRefreshResponse?.();
      const acct = this.accounts.find((a) => a.refreshToken === form.get('refresh_token'));
      if (!acct) return json(400, { error: 'invalid_grant' });
      if (this.opts.rotateOnRefresh !== false) acct.refreshToken = dummySecret('MS-REFRESH-ROTATED');
      return json(200, {
        token_type: 'Bearer',
        scope,
        expires_in: 3599,
        access_token: this.issueAccessToken(acct),
        refresh_token: acct.refreshToken,
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private summary(m: MockGraphMessage) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      subject: m.subject,
      from: { emailAddress: { name: `Name ${m.from}`, address: m.from } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.body.slice(0, 50),
      hasAttachments: (m.attachments ?? []).some((a) => !a.isInline),
      internetMessageId: m.internetMessageId,
    };
  }

  private graph(req: UpstreamRequest): UpstreamResponse {
    const acct = this.accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!acct) return graphError(401, 'InvalidAuthenticationToken');
    const path = req.url.pathname;
    const q = req.url.searchParams;
    if (req.method === 'GET' && path === '/v1.0/me') {
      return json(200, { id: acct.id, displayName: acct.displayName, mail: acct.mail, userPrincipalName: acct.userPrincipalName });
    }
    const list = /^\/v1\.0\/me(?:\/mailFolders\/([^/]+))?\/messages$/.exec(path);
    if (req.method === 'GET' && list) {
      const folder = list[1] ? decodeURIComponent(list[1]) : undefined;
      let msgs = acct.messages.filter((m) => !folder || m.folder === folder);
      const search = q.get('$search');
      if (search) {
        if (q.has('$orderby')) return graphError(400, 'BadRequest');
        const term = search.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
        msgs = msgs.filter((m) => m.subject.toLowerCase().includes(term));
      }
      const top = Math.min(Number(q.get('$top') ?? 10), this.opts.pageSize ?? 1000);
      const skip = Number(q.get('$skiptoken') ?? 0);
      const page = msgs.slice(skip, skip + top);
      const body: Record<string, unknown> = { value: page.map((m) => this.summary(m)) };
      if (skip + top < msgs.length) {
        const next = new URL(req.url.toString());
        next.searchParams.set('$skiptoken', String(skip + top));
        body['@odata.nextLink'] = next.toString();
      }
      return json(200, body);
    }
    const att = /^\/v1\.0\/me\/messages\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(path);
    const one = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(path);
    const msgId = att?.[1] ?? one?.[1];
    if (req.method === 'GET' && msgId) {
      const m = acct.messages.find((x) => x.id === decodeURIComponent(msgId));
      if (!m) return graphError(404, 'ErrorItemNotFound');
      if (att && att[2]) {
        const a = m.attachments?.find((x) => x.id === decodeURIComponent(att[2]!));
        if (!a) return graphError(404, 'ErrorItemNotFound');
        const out = json(200, a);
        // Mirrors the real transport's streamed size cap.
        if (out.body.length > req.maxBytes) throw new PerchError('Upstream response exceeds the limit', 'response_too_large');
        return out;
      }
      if (att) {
        return json(200, {
          value: (m.attachments ?? []).map(({ contentBytes: _drop, ...meta }) => meta),
        });
      }
      const html = req.headers.prefer !== 'outlook.body-content-type="text"';
      return json(200, {
        ...this.summary(m),
        ccRecipients: [],
        replyTo: [],
        internetMessageHeaders: m.headers ?? [],
        body:
          m.htmlBody !== undefined
            ? { contentType: 'html', content: m.htmlBody }
            : html
              ? { contentType: 'html', content: `<p>${m.body}</p>` }
              : { contentType: 'text', content: m.body },
      });
    }
    if (req.method === 'POST' && path === '/v1.0/me/messages') {
      const mime = Buffer.from(req.body ?? '', 'base64').toString('utf8');
      this.drafts.push(mime);
      const id = `draft${this.drafts.length}`;
      return json(201, { id, conversationId: `conv-${id}`, internetMessageId: `<${id}@mock.example>`, isDraft: true });
    }
    if (req.method === 'POST' && path === '/v1.0/me/sendMail') {
      this.sent.push(Buffer.from(req.body ?? '', 'base64').toString('utf8'));
      return { status: 202, headers: {}, body: Buffer.alloc(0) };
    }
    return graphError(404, 'ResourceNotFound');
  }
}
