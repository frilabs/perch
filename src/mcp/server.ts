import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PerchContext } from '../context.js';
import { PerchError, safeMessage } from '../errors.js';
import { DEFAULT_MAX_BYTES, HARD_MAX_BYTES, MAX_PAGE_SIZE as DRIVE_MAX_PAGE } from '../google/drive.js';
import { MAX_BLOCKS, MAX_DEPTH, MAX_PAGE_SIZE as NOTION_MAX_PAGE } from '../notion/notion.js';
import { PERCH_VERSION } from '../version.js';

export const TOOL_NAMES = [
  'perch_list_accounts',
  'drive_search',
  'drive_list_files',
  'drive_get_file',
  'drive_read_file',
  'drive_download_file',
  'drive_export_file',
  'notion_search',
  'notion_get_page',
  'notion_get_page_content',
  'notion_get_block_children',
  'notion_get_database',
  'notion_get_data_source',
  'notion_query_data_source',
] as const;

const NOTION_SEARCH_NOTE =
  'Notion search matches page and data source titles only. It is not full-text and may not return every ' +
  'object the token can access; use notion_get_page_content to read page bodies.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (err) {
    if (!(err instanceof PerchError)) process.stderr.write(`perch: unexpected tool error (${(err as Error)?.name ?? 'unknown'})\n`);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: safeMessage(err) }) }] };
  }
}

const accountId = z.string().describe('Google account id from perch_list_accounts, e.g. google-1a2b3c4d');
const optAccountId = accountId.optional().describe('Restrict to one Google account; omit to query all accounts');
const workspaceId = z.string().describe('Notion workspace id from perch_list_accounts, e.g. notion-1a2b3c4d');
const fileId = z.string().describe('Drive file id');
const maxBytes = z
  .number()
  .int()
  .min(1)
  .max(HARD_MAX_BYTES)
  .optional()
  .describe(
    `Maximum content bytes (default ${DEFAULT_MAX_BYTES}, max ${HARD_MAX_BYTES}). Larger values can exceed the ` +
      "client's tool output limit (Claude Code: MAX_MCP_OUTPUT_TOKENS); base64 adds ~33%.",
  );
const cursor = z.string().optional().describe('nextCursor from the previous page');
const drivePageSize = z.number().int().min(1).max(DRIVE_MAX_PAGE).optional().describe('Results per account per page (default 25)');
const notionPageSize = z.number().int().min(1).max(NOTION_MAX_PAGE).optional().describe('Results per page (default 25)');

/** Builds a read-only MCP server over the shared context. Cheap enough to create per HTTP request. */
export function createMcpServer(ctx: PerchContext): McpServer {
  const server = new McpServer(
    { name: 'perch', version: PERCH_VERSION },
    {
      instructions:
        'Perch gives read-only access to several Google Drive accounts and Notion workspaces. ' +
        'Call perch_list_accounts first. Every result carries accountId/workspaceId and label provenance.',
    },
  );

  server.registerTool(
    'perch_list_accounts',
    {
      description: 'List connected Google accounts and Notion workspaces (ids, labels; never secrets).',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const data = await ctx.store.read();
        return {
          google: data.google.map((g) => ({
            accountId: g.id,
            label: g.label,
            email: g.email,
            ...(g.displayName ? { displayName: g.displayName } : {}),
            scopes: g.scopes,
            connectedAt: g.createdAt,
          })),
          notion: data.notion.map((w) => ({
            workspaceId: w.id,
            label: w.label,
            ...(w.tokenOwner?.name ? { tokenOwner: w.tokenOwner.name } : {}),
            connectedAt: w.createdAt,
          })),
          note: 'Notion labels are user-assigned; Perch does not verify the Notion workspace identity.',
        };
      }),
  );

  server.registerTool(
    'drive_search',
    {
      description:
        'Search Google Drive files (full text, or name only) across all connected accounts or one. ' +
        'Returns metadata with account provenance, nextCursor/hasMore and partial/errors per account.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Text to search for'),
        nameOnly: z.boolean().optional().describe('Match file names only instead of full text'),
        accountId: optAccountId,
        mimeType: z.string().optional().describe('Exact MIME type filter'),
        pageSize: drivePageSize,
        cursor,
      },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.drive.search(a)),
  );

  server.registerTool(
    'drive_list_files',
    {
      description:
        'List Drive files (most recently modified first), optionally inside a folder. folderId requires accountId.',
      inputSchema: {
        accountId: optAccountId,
        folderId: z.string().optional().describe('Folder id (requires accountId)'),
        mimeType: z.string().optional().describe('Exact MIME type filter'),
        pageSize: drivePageSize,
        cursor,
      },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.drive.search(a)),
  );

  server.registerTool(
    'drive_get_file',
    { description: 'Get Drive file metadata.', inputSchema: { accountId, fileId }, annotations: READ_ONLY },
    (a) => run(() => ctx.drive.getFile(a.accountId, a.fileId)),
  );

  server.registerTool(
    'drive_read_file',
    {
      description:
        'Read a file as UTF-8 text. Google Docs export as Markdown, Sheets as CSV (first sheet), Slides as plain text. ' +
        'Binary files are refused (use drive_download_file).',
      inputSchema: { accountId, fileId, maxBytes },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.drive.readText(a.accountId, a.fileId, a)),
  );

  server.registerTool(
    'drive_download_file',
    {
      description: 'Download a non-Google-native file as base64 (bounded by maxBytes). Nothing is written to disk.',
      inputSchema: { accountId, fileId, maxBytes },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.drive.download(a.accountId, a.fileId, a)),
  );

  server.registerTool(
    'drive_export_file',
    {
      description:
        'Export a Google Docs/Sheets/Slides/Drawings/Apps Script file to a supported MIME type ' +
        '(e.g. application/pdf, text/markdown, text/csv, OOXML). Text formats return text, others base64.',
      inputSchema: { accountId, fileId, mimeType: z.string().describe('Target export MIME type'), maxBytes },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.drive.exportFile(a.accountId, a.fileId, a.mimeType, a)),
  );

  server.registerTool(
    'notion_search',
    {
      description: `Search Notion pages and data sources by title across all connected workspaces or one. ${NOTION_SEARCH_NOTE}`,
      inputSchema: {
        query: z.string().max(500).optional().describe('Title text; omit to list accessible objects'),
        filter: z.enum(['page', 'data_source']).optional(),
        workspaceId: workspaceId.optional().describe('Restrict to one workspace; omit for all'),
        pageSize: notionPageSize,
        cursor,
      },
      annotations: READ_ONLY,
    },
    (a) => run(async () => ({ ...(await ctx.notion.search(a)), note: NOTION_SEARCH_NOTE })),
  );

  server.registerTool(
    'notion_get_page',
    { description: 'Retrieve a Notion page object (properties).', inputSchema: { workspaceId, pageId: z.string() }, annotations: READ_ONLY },
    (a) => run(() => ctx.notion.getPage(a.workspaceId, a.pageId)),
  );

  server.registerTool(
    'notion_get_page_content',
    {
      description:
        'Read a page body: one page of top-level blocks (nextCursor/hasMore) with nested children loaded up to maxDepth ' +
        'within maxBlocks. Blocks with childrenNotLoaded or childrenHasMore can be continued via notion_get_block_children.',
      inputSchema: {
        workspaceId,
        pageId: z.string(),
        cursor,
        pageSize: notionPageSize,
        maxDepth: z.number().int().min(1).max(MAX_DEPTH).optional().describe('Nesting levels to load (default 2)'),
        maxBlocks: z.number().int().min(1).max(MAX_BLOCKS).optional().describe('Total block budget (default 200)'),
      },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.notion.getPageContent(a.workspaceId, a.pageId, a)),
  );

  server.registerTool(
    'notion_get_block_children',
    {
      description: 'List one level of child blocks of a block or page, paginated.',
      inputSchema: { workspaceId, blockId: z.string(), cursor, pageSize: notionPageSize },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.notion.getBlockChildren(a.workspaceId, a.blockId, a)),
  );

  server.registerTool(
    'notion_get_database',
    {
      description: 'Retrieve a Notion database including its data_sources list.',
      inputSchema: { workspaceId, databaseId: z.string() },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.notion.getDatabase(a.workspaceId, a.databaseId)),
  );

  server.registerTool(
    'notion_get_data_source',
    {
      description: 'Retrieve a Notion data source (schema/properties).',
      inputSchema: { workspaceId, dataSourceId: z.string() },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.notion.getDataSource(a.workspaceId, a.dataSourceId)),
  );

  server.registerTool(
    'notion_query_data_source',
    {
      description: 'Query rows of a Notion data source with optional Notion filter/sorts objects, paginated (read-only).',
      inputSchema: {
        workspaceId,
        dataSourceId: z.string(),
        filter: z.record(z.string(), z.unknown()).optional().describe('Notion filter object'),
        sorts: z.array(z.record(z.string(), z.unknown())).optional().describe('Notion sorts array'),
        cursor,
        pageSize: notionPageSize,
      },
      annotations: READ_ONLY,
    },
    (a) => run(() => ctx.notion.queryDataSource(a.workspaceId, a.dataSourceId, a)),
  );

  return server;
}
