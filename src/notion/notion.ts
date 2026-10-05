import { createHash } from 'node:crypto';
import { PerchError, safeMessage } from '../errors.js';
import { fanOut, type FanOutResult } from '../fanout.js';
import { newAccountId, validateLabel } from '../ids.js';
import type { CredentialStore, NotionWorkspace } from '../store/credentialStore.js';
import { UpstreamError, type Upstream } from '../upstream.js';

/** Pinned Notion API version (data sources model). */
export const NOTION_VERSION = '2026-03-11';
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_MAX_DEPTH = 2;
export const MAX_DEPTH = 5;
export const DEFAULT_MAX_BLOCKS = 200;
export const MAX_BLOCKS = 1000;
/** Rate-limit handling (Notion answers 429 with Retry-After). */
export const MAX_RETRIES_PER_REQUEST = 3;
export const MAX_RETRIES_PER_CALL = 6;
export const MAX_RETRY_WAIT_MS = 10_000;

interface NotionList<T = Record<string, unknown>> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

type RichText = Array<{ plain_text?: string }>;
type NotionObject = Record<string, unknown>;

export interface WorkspaceProvenance {
  workspaceId: string;
  workspaceLabel: string;
}

export interface SearchHit {
  object: string;
  id: string;
  title: string;
  url?: string;
  parent?: unknown;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
}

export interface BlockNode extends NotionObject {
  id: string;
  type: string;
  has_children: boolean;
  text?: string;
  children?: BlockNode[];
  childrenHasMore?: boolean;
  childrenNextCursor?: string | null;
  childrenNotLoaded?: boolean;
  childrenError?: string;
}

export function normaliseNotionId(id: string): string {
  const compact = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new PerchError('Invalid Notion id (expected 32 hex chars or a UUID)', 'bad_argument');
  return compact;
}

function bounded(name: string, value: number | undefined, def: number, max: number): number {
  const n = value ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new PerchError(`${name} must be between 1 and ${max}`, 'bad_argument');
  return n;
}

const plain = (rt: unknown) => (Array.isArray(rt) ? (rt as RichText).map((t) => t.plain_text ?? '').join('') : '');

function titleOf(obj: NotionObject): string {
  if (Array.isArray(obj.title)) return plain(obj.title);
  const props = obj.properties as Record<string, { type?: string; title?: unknown }> | undefined;
  const titleProp = props && Object.values(props).find((p) => p?.type === 'title');
  return titleProp ? plain(titleProp.title) : '';
}

function toBlock(raw: NotionObject): BlockNode {
  const { object: _object, ...rest } = raw;
  const type = String(raw.type ?? 'unknown');
  const data = raw[type] as { rich_text?: unknown; title?: unknown } | undefined;
  const text = data?.rich_text !== undefined ? plain(data.rich_text) : typeof data?.title === 'string' ? data.title : undefined;
  return { ...rest, id: String(raw.id), type, has_children: raw.has_children === true, ...(text !== undefined ? { text } : {}) };
}

const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex');

function headers(token: string) {
  return { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION };
}

/** Validates a PAT with GET /v1/users/me and stores it under a user-assigned label. */
export async function addNotionWorkspace(
  store: CredentialStore,
  upstream: Upstream,
  input: { label: string; token: string },
): Promise<NotionWorkspace> {
  const label = validateLabel(input.label);
  const token = input.token.trim();
  if (!token) throw new PerchError('Empty token', 'bad_argument');
  const existing = (await store.read()).notion.find((w) => fingerprint(w.token) === fingerprint(token));
  if (existing) throw new PerchError(`This token is already connected as ${existing.id} ("${existing.label}")`, 'duplicate_account');
  const me = await upstream.json<{ id?: string; name?: string; type?: string }>('notion', {
    method: 'GET',
    path: '/v1/users/me',
    headers: headers(token),
  });
  return store.update((data) => {
    if (data.notion.some((w) => fingerprint(w.token) === fingerprint(token))) {
      throw new PerchError('This token is already connected', 'duplicate_account');
    }
    const now = new Date().toISOString();
    const ws: NotionWorkspace = {
      id: newAccountId('notion', data.notion.map((w) => w.id)),
      label,
      token,
      ...(me.id ? { tokenOwner: { id: me.id, ...(me.name ? { name: me.name } : {}), ...(me.type ? { type: me.type } : {}) } } : {}),
      createdAt: now,
      updatedAt: now,
    };
    data.notion.push(ws);
    return ws;
  });
}

/** Local disconnect only. The PAT itself must be revoked in Notion's settings. */
export async function removeNotionWorkspace(store: CredentialStore, id: string): Promise<void> {
  await store.update((data) => {
    if (!data.notion.some((w) => w.id === id)) throw new PerchError(`Unknown Notion workspace: ${id}`, 'unknown_account');
    data.notion = data.notion.filter((w) => w.id !== id);
  });
}

interface RetryBudget {
  remaining: number;
}

const newBudget = (): RetryBudget => ({ remaining: MAX_RETRIES_PER_CALL });

export class NotionService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: CredentialStore,
    private readonly upstream: Upstream,
    opts: { sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async workspace(id: string): Promise<NotionWorkspace> {
    const ws = (await this.store.read()).notion.find((w) => w.id === id);
    if (!ws) throw new PerchError(`Unknown Notion workspace: ${id}`, 'unknown_account');
    return ws;
  }

  private prov(ws: NotionWorkspace): WorkspaceProvenance {
    return { workspaceId: ws.id, workspaceLabel: ws.label };
  }

  /**
   * Retries HTTP 429 up to MAX_RETRIES_PER_REQUEST times, waiting the (sanitised) Retry-After
   * capped at MAX_RETRY_WAIT_MS, within a retry budget shared by the whole tool call.
   */
  private async withRetry<T>(budget: RetryBudget, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const limited = err instanceof UpstreamError && err.status === 429;
        if (!limited || attempt >= MAX_RETRIES_PER_REQUEST || budget.remaining <= 0) throw err;
        budget.remaining--;
        await this.sleep(Math.min((err.retryAfterSeconds ?? 1) * 1000, MAX_RETRY_WAIT_MS));
      }
    }
  }

  private get<T>(budget: RetryBudget, ws: NotionWorkspace, path: string, query?: Record<string, string | number | undefined>) {
    return this.withRetry(budget, () => this.upstream.json<T>('notion', { method: 'GET', path, query, headers: headers(ws.token) }));
  }

  private post<T>(budget: RetryBudget, ws: NotionWorkspace, path: string, json: unknown) {
    return this.withRetry(budget, () => this.upstream.json<T>('notion', { method: 'POST', path, json, headers: headers(ws.token) }));
  }

  /** Title search over pages and data sources (Notion does not guarantee full-text matching). */
  async search(input: {
    workspaceId?: string;
    query?: string;
    filter?: 'page' | 'data_source';
    pageSize?: number;
    cursor?: string;
  }): Promise<FanOutResult<SearchHit & WorkspaceProvenance>> {
    const pageSize = bounded('pageSize', input.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const workspaces = input.workspaceId ? [await this.workspace(input.workspaceId)] : (await this.store.read()).notion;
    const budget = newBudget();
    const res = await fanOut<SearchHit>({
      kind: 'notion',
      queryKey: { q: input.query ?? '', f: input.filter ?? null, pageSize, ws: input.workspaceId ?? null },
      sources: workspaces,
      cursor: input.cursor,
      fetchPage: async (source, startCursor) => {
        const ws = workspaces.find((w) => w.id === source.id)!;
        const list = await this.post<NotionList>(budget, ws, '/v1/search', {
          ...(input.query ? { query: input.query } : {}),
          ...(input.filter ? { filter: { property: 'object', value: input.filter } } : {}),
          page_size: pageSize,
          ...(startCursor ? { start_cursor: startCursor } : {}),
        });
        return {
          items: list.results.map((o) => ({
            object: String(o.object),
            id: String(o.id),
            title: titleOf(o),
            ...(o.url ? { url: String(o.url) } : {}),
            ...(o.parent ? { parent: o.parent } : {}),
            ...(o.created_time ? { created_time: String(o.created_time) } : {}),
            ...(o.last_edited_time ? { last_edited_time: String(o.last_edited_time) } : {}),
            ...(typeof o.in_trash === 'boolean' ? { in_trash: o.in_trash } : {}),
          })),
          next: list.has_more ? list.next_cursor : null,
        };
      },
    });
    return {
      ...res,
      results: res.results.map(({ accountId, accountLabel, ...hit }) => ({
        ...hit,
        workspaceId: accountId,
        workspaceLabel: accountLabel,
      })),
    };
  }

  async getPage(workspaceId: string, pageId: string): Promise<NotionObject & WorkspaceProvenance> {
    const ws = await this.workspace(workspaceId);
    const page = await this.get<NotionObject>(newBudget(), ws, `/v1/pages/${normaliseNotionId(pageId)}`);
    return { ...this.prov(ws), ...page };
  }

  private async children(budget: RetryBudget, ws: NotionWorkspace, blockId: string, cursor: string | undefined, pageSize: number) {
    return this.get<NotionList>(budget, ws, `/v1/blocks/${normaliseNotionId(blockId)}/children`, {
      page_size: pageSize,
      start_cursor: cursor,
    });
  }

  /** One level of children for a block or page. */
  async getBlockChildren(workspaceId: string, blockId: string, opts: { cursor?: string; pageSize?: number }) {
    const ws = await this.workspace(workspaceId);
    const pageSize = bounded('pageSize', opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const list = await this.children(newBudget(), ws, blockId, opts.cursor, pageSize);
    return {
      ...this.prov(ws),
      blockId,
      blocks: list.results.map(toBlock),
      nextCursor: list.has_more ? list.next_cursor : null,
      hasMore: list.has_more,
    };
  }

  /**
   * One page of top-level blocks; children are loaded depth-first up to maxDepth within a
   * total budget of maxBlocks. Anything not loaded is flagged so callers can continue with
   * notion_get_block_children. If a nested fetch fails, the content loaded so far is still
   * returned with `partial`, `errors[]` and `childrenError` on the affected block; after a
   * rate-limit failure no further nested requests are made.
   */
  async getPageContent(
    workspaceId: string,
    pageId: string,
    opts: { cursor?: string; pageSize?: number; maxDepth?: number; maxBlocks?: number },
  ) {
    const ws = await this.workspace(workspaceId);
    const pageSize = bounded('pageSize', opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const maxDepth = bounded('maxDepth', opts.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH);
    let budget = bounded('maxBlocks', opts.maxBlocks, DEFAULT_MAX_BLOCKS, MAX_BLOCKS);
    const retries = newBudget();
    let truncated = false;
    let rateLimited = false;
    const errors: Array<{ blockId: string; message: string }> = [];

    const top = await this.children(retries, ws, pageId, opts.cursor, Math.min(pageSize, budget));
    budget -= top.results.length;
    const blocks = top.results.map(toBlock);

    const expand = async (nodes: BlockNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (!node.has_children) continue;
        if (depth >= maxDepth || budget <= 0 || rateLimited) {
          node.childrenNotLoaded = true;
          truncated = true;
          continue;
        }
        let list: NotionList;
        try {
          list = await this.children(retries, ws, node.id, undefined, Math.min(MAX_PAGE_SIZE, budget));
        } catch (err) {
          const message = safeMessage(err);
          node.childrenNotLoaded = true;
          node.childrenError = message;
          errors.push({ blockId: node.id, message });
          truncated = true;
          if (err instanceof UpstreamError && err.status === 429) rateLimited = true;
          continue;
        }
        budget -= list.results.length;
        node.children = list.results.map(toBlock);
        if (list.has_more) {
          node.childrenHasMore = true;
          node.childrenNextCursor = list.next_cursor;
          truncated = true;
        }
        await expand(node.children, depth + 1);
      }
    };
    await expand(blocks, 1);

    const total = (nodes: BlockNode[]): number => nodes.reduce((n, b) => n + 1 + total(b.children ?? []), 0);
    return {
      ...this.prov(ws),
      pageId,
      blocks,
      blocksReturned: total(blocks),
      nextCursor: top.has_more ? top.next_cursor : null,
      hasMore: top.has_more,
      truncated,
      partial: errors.length > 0,
      errors,
    };
  }

  async getDatabase(workspaceId: string, databaseId: string): Promise<NotionObject & WorkspaceProvenance> {
    const ws = await this.workspace(workspaceId);
    const db = await this.get<NotionObject>(newBudget(), ws, `/v1/databases/${normaliseNotionId(databaseId)}`);
    return { ...this.prov(ws), ...db };
  }

  async getDataSource(workspaceId: string, dataSourceId: string): Promise<NotionObject & WorkspaceProvenance> {
    const ws = await this.workspace(workspaceId);
    const ds = await this.get<NotionObject>(newBudget(), ws, `/v1/data_sources/${normaliseNotionId(dataSourceId)}`);
    return { ...this.prov(ws), ...ds };
  }

  /** POST /v1/data_sources/{id}/query is a read operation (filter/sort/paginate rows). */
  async queryDataSource(
    workspaceId: string,
    dataSourceId: string,
    opts: { filter?: unknown; sorts?: unknown; cursor?: string; pageSize?: number },
  ) {
    const ws = await this.workspace(workspaceId);
    const list = await this.post<NotionList>(newBudget(), ws, `/v1/data_sources/${normaliseNotionId(dataSourceId)}/query`, {
      ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
      ...(opts.sorts !== undefined ? { sorts: opts.sorts } : {}),
      page_size: bounded('pageSize', opts.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      ...(opts.cursor ? { start_cursor: opts.cursor } : {}),
    });
    return {
      ...this.prov(ws),
      dataSourceId,
      results: list.results,
      nextCursor: list.has_more ? list.next_cursor : null,
      hasMore: list.has_more,
    };
  }
}
