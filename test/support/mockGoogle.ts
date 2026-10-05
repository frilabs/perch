/**
 * MOCK Google upstream (OAuth token endpoint + Drive v3 subset) for tests only.
 * This is an in-memory fake of the HTTP API; nothing here talks to Google, and passing
 * tests that use it are NOT evidence of a live integration.
 */
import { createHash } from 'node:crypto';
import { PerchError } from '../../src/errors.js';
import type { UpstreamRequest, UpstreamResponse, UpstreamTransport } from '../../src/upstream.js';
import { dummySecret } from './fixtures.js';

export interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  content?: Buffer;
  exports?: Record<string, Buffer>;
  parents?: string[];
}

export interface MockGoogleAccount {
  email: string;
  displayName: string;
  refreshToken: string;
  files: MockDriveFile[];
}

export interface MockGoogleOptions {
  /** Scope string returned by the token endpoint. */
  grantedScope?: string;
  /** Omit refresh_token from the authorization_code response. */
  omitRefreshToken?: boolean;
  /** Refresh token returned by refresh_token grants (undefined = omit, Google's usual behaviour). */
  rotateRefreshTokenTo?: string;
  pageSize?: number;
}

const json = (status: number, body: unknown): UpstreamResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

export class MockGoogle {
  readonly calls: UpstreamRequest[] = [];
  readonly accounts: MockGoogleAccount[] = [];
  /** code -> pending authorization */
  readonly codes = new Map<string, { challenge: string; redirectUri: string; account: MockGoogleAccount }>();
  readonly accessTokens = new Map<string, MockGoogleAccount>();
  readonly revoked: string[] = [];
  tokenCalls = 0;
  /** Accounts (by email) whose Drive calls fail with HTTP 500, to exercise partial results. */
  failingEmails = new Set<string>();
  /** Runs while a refresh_token grant is "in flight" (to simulate concurrent store changes). */
  beforeRefreshResponse?: () => Promise<void>;

  constructor(public opts: MockGoogleOptions = {}) {}

  addAccount(email: string, files: MockDriveFile[] = []): MockGoogleAccount {
    const acct = { email, displayName: `Dummy ${email}`, refreshToken: dummySecret('GOOGLE-REFRESH'), files };
    this.accounts.push(acct);
    return acct;
  }

  /** Simulates the user approving consent in the browser for `account`; returns the auth code. */
  approve(authUrl: string, account: MockGoogleAccount): string {
    const u = new URL(authUrl);
    const code = dummySecret('AUTHCODE');
    this.codes.set(code, {
      challenge: u.searchParams.get('code_challenge')!,
      redirectUri: u.searchParams.get('redirect_uri')!,
      account,
    });
    return code;
  }

  issueAccessToken(account: MockGoogleAccount): string {
    const t = dummySecret('GOOGLE-ACCESS');
    this.accessTokens.set(t, account);
    return t;
  }

  transport: UpstreamTransport = async (req) => {
    this.calls.push(req);
    const { origin, pathname } = req.url;
    if (pathname === '/token' && new URLSearchParams(req.body ?? '').get('grant_type') === 'refresh_token') {
      await this.beforeRefreshResponse?.();
    }
    if (origin === 'https://oauth2.googleapis.com') return this.oauth(req, pathname);
    if (origin === 'https://www.googleapis.com') return this.drive(req, pathname);
    return json(404, { error: 'not_found' });
  };

  private oauth(req: UpstreamRequest, pathname: string): UpstreamResponse {
    const form = new URLSearchParams(req.body ?? '');
    if (pathname === '/revoke') {
      this.revoked.push(form.get('token') ?? '');
      return json(200, {});
    }
    this.tokenCalls++;
    const scope = this.opts.grantedScope ?? 'https://www.googleapis.com/auth/drive.readonly';
    if (form.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      if (!pending) return json(400, { error: 'invalid_grant' });
      this.codes.delete(form.get('code')!);
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== pending.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (form.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'redirect_uri_mismatch' });
      return json(200, {
        access_token: this.issueAccessToken(pending.account),
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
        ...(this.opts.omitRefreshToken ? {} : { refresh_token: pending.account.refreshToken }),
      });
    }
    if (form.get('grant_type') === 'refresh_token') {
      const acct = this.accounts.find((a) => a.refreshToken === form.get('refresh_token'));
      if (!acct) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      if (this.opts.rotateRefreshTokenTo) acct.refreshToken = this.opts.rotateRefreshTokenTo;
      return json(200, {
        access_token: this.issueAccessToken(acct),
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
        ...(this.opts.rotateRefreshTokenTo ? { refresh_token: this.opts.rotateRefreshTokenTo } : {}),
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private drive(req: UpstreamRequest, pathname: string): UpstreamResponse {
    const auth = req.headers.authorization ?? '';
    const acct = this.accessTokens.get(auth.replace(/^Bearer /, ''));
    if (!acct) return json(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'mock' } });
    if (this.failingEmails.has(acct.email)) return json(500, { error: { code: 500, status: 'INTERNAL' } });
    const q = req.url.searchParams;
    if (pathname === '/drive/v3/about') {
      return json(200, { user: { emailAddress: acct.email, displayName: acct.displayName } });
    }
    if (pathname === '/drive/v3/files') {
      let files = acct.files;
      const query = q.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      if (parent) files = files.filter((f) => f.parents?.includes(parent));
      const term = /(?:fullText|name) contains '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, '$1');
      if (term) files = files.filter((f) => f.name.toLowerCase().includes(term.toLowerCase()));
      const size = Math.min(Number(q.get('pageSize') ?? 100), this.opts.pageSize ?? 100);
      const start = Number(q.get('pageToken') ?? 0);
      const page = files.slice(start, start + size);
      const next = start + size < files.length ? String(start + size) : undefined;
      return json(200, { files: page.map((f) => this.meta(f)), ...(next ? { nextPageToken: next } : {}) });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(pathname);
    const file = m && acct.files.find((f) => f.id === m[1]);
    if (!m || !file) return json(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
    if (m[2]) {
      const out = file.exports?.[q.get('mimeType') ?? ''];
      if (!out) return json(400, { error: { code: 400, errors: [{ reason: 'badRequest' }] } });
      return { status: 200, headers: { 'content-type': q.get('mimeType')! }, body: out };
    }
    if (q.get('alt') === 'media') {
      if (!file.content) return json(403, { error: { code: 403, errors: [{ reason: 'fileNotDownloadable' }] } });
      // Mirrors the real transport's streamed size cap.
      if (file.content.length > req.maxBytes) throw new PerchError('Upstream response exceeds the limit', 'response_too_large');
      return { status: 200, headers: { 'content-type': file.mimeType }, body: file.content };
    }
    return json(200, this.meta(file));
  }

  private meta(f: MockDriveFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      ...(f.content ? { size: String(f.content.length) } : {}),
      modifiedTime: '2026-01-01T00:00:00.000Z',
      parents: f.parents ?? ['root'],
    };
  }
}
