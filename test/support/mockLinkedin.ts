/**
 * MOCK LinkedIn (OAuth token endpoint, OpenID userinfo, Posts API) for tests only. An in-memory fake of the HTTP
 * API; nothing here talks to LinkedIn, and passing tests that use it are NOT evidence of a live integration.
 */
import { PerchError } from '../../src/errors.js';
import type { UpstreamRequest, UpstreamResponse, UpstreamTransport } from '../../src/upstream.js';
import { dummySecret } from './fixtures.js';

export interface MockMember {
  sub: string;
  name: string;
  /** Access tokens handed out for this member. */
  tokens: Set<string>;
  posts: Array<{ id: string; body: Record<string, unknown>; headers: Record<string, string> }>;
}

export type PostFault = { mode: 'status'; status: number; body?: unknown } | { mode: 'timeout' } | { mode: 'unreachable' } | { mode: 'no-id' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): UpstreamResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

export class MockLinkedin {
  readonly client = { id: 'mockli01clientid', secret: dummySecret('LINKEDIN-CLIENT-SECRET') };
  readonly members: MockMember[] = [];
  /** Every request, in order (method, url, headers, body). */
  readonly calls: UpstreamRequest[] = [];
  readonly tokenRequests: Array<Record<string, string>> = [];
  /** Token responses carry refresh_token (LinkedIn partners only) when true. */
  issuesRefreshTokens = false;
  /** expires_in of issued access tokens (LinkedIn: 60 days). */
  accessLifetimeS = 60 * 24 * 3600;
  /** Faults for the next POST /rest/posts calls (consumed in order). */
  readonly postFaults: PostFault[] = [];
  /** Kind of post URN returned in x-restli-id. */
  urnKind: 'share' | 'ugcPost' = 'share';
  readonly issuedSecrets: string[] = [];
  private codes = new Map<string, { member: MockMember; redirectUri: string }>();
  private refreshTokens = new Map<string, MockMember>();
  private nextPost = 7100000000000000000n;

  addMember(name: string): MockMember {
    const m: MockMember = { sub: `mock${dummySecret('sub').slice(-10).replace(/[^A-Za-z0-9]/g, '')}`, name, tokens: new Set(), posts: [] };
    this.members.push(m);
    return m;
  }

  /** The member approved the consent screen: returns the code the browser redirect would carry. */
  approve(authUrl: string, member: MockMember): string {
    const u = new URL(authUrl);
    if (u.origin + u.pathname !== 'https://www.linkedin.com/oauth/v2/authorization') throw new Error('MOCK: wrong authorize URL');
    if (u.searchParams.get('client_id') !== this.client.id) throw new Error('MOCK: wrong client id');
    if (u.searchParams.get('scope') !== 'openid profile w_member_social') throw new Error('MOCK: wrong scopes');
    if (u.searchParams.get('response_type') !== 'code' || !u.searchParams.get('state')) throw new Error('MOCK: bad authorize params');
    const code = dummySecret('LINKEDIN-CODE');
    this.codes.set(code, { member, redirectUri: u.searchParams.get('redirect_uri')! });
    return code;
  }

  private issue(member: MockMember) {
    const access = dummySecret('LINKEDIN-ACCESS');
    member.tokens.add(access);
    this.issuedSecrets.push(access);
    const refresh = this.issuesRefreshTokens ? dummySecret('LINKEDIN-REFRESH') : undefined;
    if (refresh) {
      this.refreshTokens.set(refresh, member);
      this.issuedSecrets.push(refresh);
    }
    return {
      access_token: access,
      expires_in: this.accessLifetimeS,
      scope: 'openid,profile,w_member_social',
      token_type: 'Bearer',
      id_token: 'eyJ.dummy.idtoken',
      ...(refresh ? { refresh_token: refresh, refresh_token_expires_in: 365 * 24 * 3600 } : {}),
    };
  }

  private member(req: UpstreamRequest): MockMember | undefined {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    return this.members.find((m) => token !== undefined && m.tokens.has(token));
  }

  readonly transport: UpstreamTransport = async (req) => {
    this.calls.push(req);
    const where = `${req.method} ${req.url.origin}${req.url.pathname}`;
    if (where === 'POST https://www.linkedin.com/oauth/v2/accessToken') {
      const form = Object.fromEntries(new URLSearchParams(req.body ?? ''));
      this.tokenRequests.push(form);
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request' });
      if (form.client_id !== this.client.id || form.client_secret !== this.client.secret) return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        const c = this.codes.get(form.code ?? '');
        if (!c || c.redirectUri !== form.redirect_uri) return json(400, { error: 'invalid_grant' });
        this.codes.delete(form.code!);
        return json(200, this.issue(c.member));
      }
      if (form.grant_type === 'refresh_token') {
        const m = this.refreshTokens.get(form.refresh_token ?? '');
        if (!m) return json(400, { error: 'invalid_grant' });
        this.refreshTokens.delete(form.refresh_token!);
        return json(200, this.issue(m));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (where === 'GET https://api.linkedin.com/v2/userinfo') {
      const m = this.member(req);
      if (!m) return json(401, { status: 401, serviceErrorCode: 65600, code: 'INVALID_ACCESS_TOKEN', message: 'Invalid access token' });
      const [given, ...rest] = m.name.split(' ');
      return json(200, { sub: m.sub, name: m.name, given_name: given, family_name: rest.join(' '), locale: { country: 'AT', language: 'de' } });
    }
    if (where === 'POST https://api.linkedin.com/rest/posts') {
      const fault = this.postFaults.shift();
      if (fault?.mode === 'timeout') throw new PerchError('Upstream request timed out', 'upstream_timeout');
      if (fault?.mode === 'unreachable') throw new Error('MOCK: connection reset');
      if (fault?.mode === 'status') return json(fault.status, fault.body ?? { status: fault.status, message: 'MOCK failure' });
      const m = this.member(req);
      if (!m) return json(401, { status: 401, serviceErrorCode: 65600, code: 'INVALID_ACCESS_TOKEN', message: 'Invalid access token' });
      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      if (body.author !== `urn:li:person:${m.sub}`) return json(403, { status: 403, code: 'ACCESS_DENIED', message: 'author mismatch' });
      const id = `urn:li:${this.urnKind}:${(this.nextPost++).toString()}`;
      m.posts.push({ id, body, headers: req.headers });
      return { status: 201, headers: fault?.mode === 'no-id' ? {} : { 'x-restli-id': id }, body: Buffer.alloc(0) };
    }
    return json(404, { message: `MOCK: no route ${where}` });
  };
}
