/**
 * MOCK Notion API (in-memory fake of the 2026-03-11 read endpoints Perch uses) for tests only.
 * Nothing here talks to Notion; passing tests are NOT evidence of a live integration.
 */
import type { UpstreamRequest, UpstreamResponse, UpstreamTransport } from '../../src/upstream.js';
import { dummySecret } from './fixtures.js';

export const NOTION_VERSION = '2026-03-11';

export interface MockBlock {
  id: string;
  text: string;
  children?: MockBlock[];
}

export interface MockWorkspace {
  token: string;
  owner: { id: string; name: string };
  pages: Array<{ id: string; title: string; blocks?: MockBlock[] }>;
  dataSources: Array<{ id: string; title: string; rows: Array<{ id: string; title: string }> }>;
  databases: Array<{ id: string; title: string; dataSourceIds: string[] }>;
}

let counter = 0;
/** Deterministic, obviously fake Notion-style ids (32 hex chars). */
export function mockId(): string {
  counter++;
  return `0000dead${String(counter).padStart(24, '0')}`;
}

const json = (status: number, body: unknown): UpstreamResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

const richText = (s: string) => [{ type: 'text', plain_text: s, text: { content: s } }];

function paginate<T>(items: T[], startCursor: string | null | undefined, pageSize: number) {
  const start = startCursor ? Number(startCursor.replace('cursor-', '')) : 0;
  const page = items.slice(start, start + pageSize);
  const more = start + pageSize < items.length;
  return { page, next_cursor: more ? `cursor-${start + pageSize}` : null, has_more: more };
}

export class MockNotion {
  readonly calls: UpstreamRequest[] = [];
  readonly workspaces: MockWorkspace[] = [];
  failingTokens = new Set<string>();
  /** Next requests answer 429; each entry is the Retry-After header value (null = no header). */
  rateLimitQueue: Array<string | null> = [];
  /** Every distinct request is rate limited this many times before it succeeds. */
  rateLimitEachRequest = 0;
  private rateLimited = new Map<string, number>();
  /** Block ids whose children endpoint fails with HTTP 500. */
  failingBlockIds = new Set<string>();

  addWorkspace(name: string): MockWorkspace {
    const ws: MockWorkspace = {
      token: dummySecret('NOTION-PAT'),
      owner: { id: mockId(), name: `Dummy owner ${name}` },
      pages: [],
      dataSources: [],
      databases: [],
    };
    this.workspaces.push(ws);
    return ws;
  }

  private findBlocks(ws: MockWorkspace, id: string): MockBlock[] | undefined {
    const page = ws.pages.find((p) => p.id === id);
    if (page) return page.blocks ?? [];
    const walk = (blocks: MockBlock[]): MockBlock[] | undefined => {
      for (const b of blocks) {
        if (b.id === id) return b.children ?? [];
        const found = b.children && walk(b.children);
        if (found) return found;
      }
      return undefined;
    };
    for (const p of ws.pages) {
      const found = walk(p.blocks ?? []);
      if (found) return found;
    }
    return undefined;
  }

  transport: UpstreamTransport = async (req) => {
    this.calls.push(req);
    if (req.url.origin !== 'https://api.notion.com') return json(404, {});
    if (req.headers['notion-version'] !== NOTION_VERSION) {
      return json(400, { object: 'error', code: 'missing_version', message: 'mock' });
    }
    const ws = this.workspaces.find((w) => `Bearer ${w.token}` === req.headers.authorization);
    if (!ws) return json(401, { object: 'error', code: 'unauthorized', message: 'mock' });
    if (this.failingTokens.has(ws.token)) return json(503, { object: 'error', code: 'service_unavailable' });
    const limited = (retryAfter: string | null): UpstreamResponse => ({
      ...json(429, { object: 'error', code: 'rate_limited', message: 'mock' }),
      headers: { 'content-type': 'application/json', ...(retryAfter !== null ? { 'retry-after': retryAfter } : {}) },
    });
    if (this.rateLimitQueue.length) return limited(this.rateLimitQueue.shift()!);
    if (this.rateLimitEachRequest) {
      const key = `${req.method} ${req.url} ${req.body ?? ''}`;
      const n = this.rateLimited.get(key) ?? 0;
      if (n < this.rateLimitEachRequest) {
        this.rateLimited.set(key, n + 1);
        return limited('1');
      }
    }
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const p = req.url.pathname;
    const qp = req.url.searchParams;

    if (p === '/v1/users/me') return json(200, { object: 'user', id: ws.owner.id, name: ws.owner.name, type: 'person' });
    if (p === '/v1/search') {
      const query = String(body.query ?? '').toLowerCase();
      const filter = (body.filter as { value?: string } | undefined)?.value;
      const items = [
        ...ws.pages.map((x) => ({
          object: 'page',
          id: x.id,
          url: `https://www.notion.so/${x.id}`,
          properties: { Name: { type: 'title', title: richText(x.title) } },
        })),
        ...ws.dataSources.map((x) => ({ object: 'data_source', id: x.id, title: richText(x.title) })),
      ].filter((x) => (!filter || x.object === filter) && JSON.stringify(x).toLowerCase().includes(query));
      const { page, next_cursor, has_more } = paginate(items, body.start_cursor as string, Number(body.page_size ?? 100));
      return json(200, { object: 'list', results: page, next_cursor, has_more });
    }
    let m = /^\/v1\/pages\/([^/]+)$/.exec(p);
    if (m) {
      const page = ws.pages.find((x) => x.id === m![1]);
      return page
        ? json(200, { object: 'page', id: page.id, properties: { Name: { type: 'title', title: richText(page.title) } } })
        : json(404, { object: 'error', code: 'object_not_found' });
    }
    m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(p);
    if (m) {
      if (this.failingBlockIds.has(m[1]!)) return json(500, { object: 'error', code: 'internal_server_error' });
      const blocks = this.findBlocks(ws, m[1]!);
      if (!blocks) return json(404, { object: 'error', code: 'object_not_found' });
      const { page, next_cursor, has_more } = paginate(blocks, qp.get('start_cursor'), Number(qp.get('page_size') ?? 100));
      return json(200, {
        object: 'list',
        results: page.map((b) => ({
          object: 'block',
          id: b.id,
          type: 'paragraph',
          has_children: (b.children?.length ?? 0) > 0,
          paragraph: { rich_text: richText(b.text) },
        })),
        next_cursor,
        has_more,
      });
    }
    m = /^\/v1\/databases\/([^/]+)$/.exec(p);
    if (m) {
      const db = ws.databases.find((x) => x.id === m![1]);
      return db
        ? json(200, {
            object: 'database',
            id: db.id,
            title: richText(db.title),
            data_sources: db.dataSourceIds.map((id) => ({ id, name: ws.dataSources.find((d) => d.id === id)?.title })),
          })
        : json(404, { object: 'error', code: 'object_not_found' });
    }
    m = /^\/v1\/data_sources\/([^/]+)(\/query)?$/.exec(p);
    if (m) {
      const ds = ws.dataSources.find((x) => x.id === m![1]);
      if (!ds) return json(404, { object: 'error', code: 'object_not_found' });
      if (!m[2]) return json(200, { object: 'data_source', id: ds.id, title: richText(ds.title), properties: {} });
      const { page, next_cursor, has_more } = paginate(ds.rows, body.start_cursor as string, Number(body.page_size ?? 100));
      return json(200, {
        object: 'list',
        results: page.map((r) => ({ object: 'page', id: r.id, properties: { Name: { type: 'title', title: richText(r.title) } } })),
        next_cursor,
        has_more,
      });
    }
    return json(404, { object: 'error', code: 'invalid_request_url' });
  };
}
