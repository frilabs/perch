/**
 * MOCK Slack Web API (in-memory fake of the methods Perch uses) for tests only.
 * Nothing here talks to Slack; passing tests are NOT evidence of a live integration.
 */
import type { UpstreamRequest, UpstreamResponse, UpstreamTransport } from '../../src/upstream.js';
import { dummySecret } from './fixtures.js';

export interface MockSlackMessage {
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  files?: Array<{ name: string; mimetype: string; size: number }>;
}

export interface MockSlackChannel {
  id: string;
  name?: string;
  user?: string;
  kind: 'public_channel' | 'private_channel' | 'mpim' | 'im';
  messages: MockSlackMessage[];
  replies?: Record<string, MockSlackMessage[]>;
}

export interface MockSlackTeam {
  token: string;
  teamId: string;
  team: string;
  userId: string;
  user: string;
  scopes: string[];
  users: Record<string, string>;
  channels: MockSlackChannel[];
  posted: Array<{ channel: string; text: string; thread_ts?: string; reply_broadcast?: boolean }>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): UpstreamResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

let tsCounter = 0;
export const mockTs = () => `${1_760_000_000 + ++tsCounter}.000${String(100 + (tsCounter % 900)).padStart(3, '0')}`;

export class MockSlack {
  readonly calls: UpstreamRequest[] = [];
  readonly teams: MockSlackTeam[] = [];
  /** Next requests answer HTTP 429 with this Retry-After. */
  rateLimitQueue: string[] = [];
  /** chat.postMessage behaviour: ok, a Slack error code, an HTTP status, or a thrown transport error. */
  postMode: { kind: 'ok' } | { kind: 'error'; code: string } | { kind: 'http'; status: number } | { kind: 'throw' } = { kind: 'ok' };
  private teamCounter = 0;

  addTeam(name: string, opts: { scopes?: string[] } = {}): MockSlackTeam {
    this.teamCounter++;
    const n = this.teamCounter;
    const team: MockSlackTeam = {
      token: `xoxp-${dummySecret('SLACK').replace(/[^A-Za-z0-9-]/g, '')}`,
      teamId: `T0MOCK${n}`,
      team: `Mock team ${name}`,
      userId: `U0ME${n}`,
      user: `me${n}`,
      scopes: opts.scopes ?? ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history', 'users:read', 'search:read', 'chat:write'],
      users: {},
      channels: [],
      posted: [],
    };
    this.teams.push(team);
    return team;
  }

  readonly transport: UpstreamTransport = async (req) => {
    this.calls.push(req);
    if (req.url.origin !== 'https://slack.com') throw new Error(`MOCK Slack: unexpected origin ${req.url.origin}`);
    if (this.rateLimitQueue.length) return json(429, { ok: false, error: 'ratelimited' }, { 'retry-after': this.rateLimitQueue.shift()! });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const team = this.teams.find((t) => t.token === token);
    if (!team) return json(200, { ok: false, error: 'invalid_auth' });
    const q = req.url.searchParams;
    const method = req.url.pathname.replace('/api/', '');
    switch (method) {
      case 'auth.test':
        return json(
          200,
          { ok: true, url: `https://mock-${team.teamId.toLowerCase()}.slack.example/`, team: team.team, user: team.user, team_id: team.teamId, user_id: team.userId },
          { 'x-oauth-scopes': team.scopes.join(',') },
        );
      case 'conversations.list': {
        const types = (q.get('types') ?? '').split(',');
        const all = team.channels.filter((c) => types.includes(c.kind));
        const start = Number(q.get('cursor') ?? 0);
        const limit = Number(q.get('limit') ?? 100);
        const page = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : '';
        return json(200, {
          ok: true,
          channels: page.map((c) => ({
            id: c.id,
            ...(c.name ? { name: c.name } : {}),
            ...(c.user ? { user: c.user } : {}),
            is_im: c.kind === 'im',
            is_mpim: c.kind === 'mpim',
            is_private: c.kind === 'private_channel',
            is_member: true,
          })),
          response_metadata: { next_cursor: next },
        });
      }
      case 'conversations.history': {
        const ch = team.channels.find((c) => c.id === q.get('channel'));
        if (!ch) return json(200, { ok: false, error: 'channel_not_found' });
        const oldest = Number(q.get('oldest') ?? 0);
        const latest = Number(q.get('latest') ?? Infinity);
        const msgs = ch.messages.filter((m) => Number(m.ts) > oldest && Number(m.ts) < latest).sort((a, b) => Number(b.ts) - Number(a.ts));
        const start = Number(q.get('cursor') ?? 0);
        const limit = Number(q.get('limit') ?? 100);
        const next = start + limit < msgs.length ? String(start + limit) : '';
        return json(200, { ok: true, messages: msgs.slice(start, start + limit), has_more: Boolean(next), response_metadata: { next_cursor: next } });
      }
      case 'conversations.replies': {
        const ch = team.channels.find((c) => c.id === q.get('channel'));
        const replies = ch?.replies?.[q.get('ts') ?? ''];
        if (!replies) return json(200, { ok: false, error: 'thread_not_found' });
        return json(200, { ok: true, messages: replies, response_metadata: { next_cursor: '' } });
      }
      case 'users.info': {
        const name = team.users[q.get('user') ?? ''];
        if (!name) return json(200, { ok: false, error: 'user_not_found' });
        return json(200, { ok: true, user: { id: q.get('user'), name: name.toLowerCase(), profile: { real_name: name, display_name: '' } } });
      }
      case 'search.messages': {
        if (!team.scopes.includes('search:read')) return json(200, { ok: false, error: 'missing_scope' });
        const needle = (q.get('query') ?? '').toLowerCase();
        const matches = team.channels.flatMap((c) =>
          c.messages
            .filter((m) => m.text.toLowerCase().includes(needle))
            .map((m) => ({ ...m, channel: { id: c.id, name: c.name ?? c.id }, username: m.user ? team.users[m.user]?.toLowerCase() : undefined, permalink: `https://mock.slack.example/${c.id}/${m.ts}` })),
        );
        const count = Number(q.get('count') ?? 20);
        const page = Number(q.get('page') ?? 1);
        return json(200, {
          ok: true,
          messages: { matches: matches.slice((page - 1) * count, page * count), paging: { page, pages: Math.max(1, Math.ceil(matches.length / count)) } },
        });
      }
      case 'chat.postMessage': {
        if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
        if (this.postMode.kind === 'throw') throw new Error('MOCK: connection reset after send');
        if (this.postMode.kind === 'http') return json(this.postMode.status, { ok: false });
        if (this.postMode.kind === 'error') return json(200, { ok: false, error: this.postMode.code });
        const body = JSON.parse(req.body ?? '{}') as { channel: string; text: string; thread_ts?: string; reply_broadcast?: boolean };
        if (!team.channels.some((c) => c.id === body.channel)) return json(200, { ok: false, error: 'channel_not_found' });
        team.posted.push(body);
        return json(200, { ok: true, channel: body.channel, ts: mockTs() });
      }
      default:
        return json(404, { ok: false, error: 'unknown_method' });
    }
  };
}
