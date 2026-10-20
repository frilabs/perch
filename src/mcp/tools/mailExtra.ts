import { z } from 'zod';
import { MAX_MAIL_PAGE_SIZE } from '../../mail/types.js';
import { REQUEST_ID_PATTERN } from '../../mail/workflow.js';
import { DESTRUCTIVE, READ_ONLY, WRITE, type ToolModule } from './kit.js';

/**
 * Mail: organizing and sending existing drafts (docs/FULL_ACCESS_SPEC.md §3.3). Permission model unchanged:
 * the read-only operator and clients with "read" list folders and drafts; organizing needs a client grant with
 * "modify" for the account (plus the provider opt-in --allow-modify); sending a draft needs "send" (plus the
 * provider send permission). Deleting is trash only: no permanent delete, no emptying the trash, no rules.
 * Every tool here is audited by MailService itself (writes record their attempt before the provider call).
 */

const READ = ['mail_list_folders', 'mail_list_drafts'] as const;
const ORGANIZE = ['mail_mark_message', 'mail_move_message', 'mail_trash_message', 'mail_restore_message'] as const;
const SEND_DRAFT = 'mail_send_draft';

const accountId = z.string().max(64).describe('Mail account id from perch_list_accounts (gmail-…, microsoft-…, imap-…)');
const messageId = z.string().max(2048).describe('messageId from mail_search / mail_read_message (same account)');
const CONFIRM = 'Only act after the user asked for this specific change.';
const MOVED_ID = 'Microsoft and IMAP give the message a NEW messageId when it changes folder; use the returned messageId afterwards.';

export const mailExtraTools: ToolModule = {
  readTools: [...READ],
  writeTools: [...ORGANIZE, SEND_DRAFT],
  // MailService audits these itself (reads after the call, writes with an attempt record before the provider write).
  selfAudited: [...READ, ...ORGANIZE, SEND_DRAFT],
  auditedWrites: [],
  register(server, ctx, principal, operator, tool) {
    if (operator || principal.capabilities.has('read')) {
      server.registerTool(
        'mail_list_folders',
        {
          description:
            'List the folders of one mail account: Gmail labels (system and user), Microsoft mail folders (with child folders), ' +
            'IMAP mailboxes with their special-use flag. role marks inbox/sent/drafts/trash/archive/junk. Use folderId with mail_move_message.',
          inputSchema: { accountId },
          annotations: READ_ONLY,
        },
        (a) => tool('mail_list_folders', a, (p) => ctx.mail.listFolders(p, a)),
      );
      server.registerTool(
        'mail_list_drafts',
        {
          description: 'List the drafts of one mail account, newest first: draftId (for mail_send_draft), subject, to, date. Content is untrusted.',
          inputSchema: {
            accountId,
            pageSize: z.number().int().min(1).max(MAX_MAIL_PAGE_SIZE).optional().describe('Drafts per page (default 20)'),
            cursor: z.string().max(16384).optional().describe('nextCursor from the previous page'),
          },
          annotations: READ_ONLY,
        },
        (a) => tool('mail_list_drafts', a, (p) => ctx.mail.listDrafts(p, a)),
      );
    }

    if (principal.capabilities.has('modify')) {
      server.registerTool(
        'mail_mark_message',
        {
          description:
            'Mark one message read/unread and/or starred (Gmail star, Outlook flag, IMAP \\Flagged) on/off. Requires a client grant with ' +
            '"modify" for the account and the provider opt-in (--allow-modify).',
          inputSchema: {
            accountId,
            messageId,
            read: z.boolean().optional().describe('true = read, false = unread'),
            starred: z.boolean().optional().describe('true = star/flag, false = remove it'),
          },
          annotations: WRITE,
        },
        (a) => tool('mail_mark_message', a, (p) => ctx.mail.markMessage(p, a)),
      );
      server.registerTool(
        'mail_move_message',
        {
          description:
            'Move one message to a folder/label (folderId from mail_list_folders), or archive it (archive: true; Gmail removes INBOX, ' +
            'Microsoft moves to Archive, IMAP moves to the \\Archive folder or the given folderId). Use mail_trash_message for the trash. ' +
            `${MOVED_ID} ${CONFIRM} Requires "modify".`,
          inputSchema: {
            accountId,
            messageId,
            folderId: z.string().max(1024).optional().describe('Gmail label id, Microsoft folder id or inbox/archive/junkemail, IMAP mailbox path'),
            archive: z.boolean().optional().describe('Archive instead of naming a folder'),
          },
          annotations: WRITE,
        },
        (a) => tool('mail_move_message', a, (p) => ctx.mail.moveMessage(p, a)),
      );
      server.registerTool(
        'mail_trash_message',
        {
          description:
            'Move one message to the trash (Gmail Trash, Microsoft Deleted Items, IMAP \\Trash). Recoverable with mail_restore_message; ' +
            `Perch never deletes permanently and never empties the trash, but providers empty it after a retention period (Gmail about 30 days). ${MOVED_ID} ${CONFIRM} Requires "modify".`,
          inputSchema: { accountId, messageId },
          annotations: DESTRUCTIVE,
        },
        (a) => tool('mail_trash_message', a, (p) => ctx.mail.trashMessage(p, a)),
      );
      server.registerTool(
        'mail_restore_message',
        {
          description: `Move one trashed message back (Gmail untrash; Microsoft and IMAP: back to the inbox). ${MOVED_ID} Requires "modify".`,
          inputSchema: { accountId, messageId: messageId.describe('messageId of the message in the trash') },
          annotations: WRITE,
        },
        (a) => tool('mail_restore_message', a, (p) => ctx.mail.restoreMessage(p, a)),
      );
    }

    if (principal.capabilities.has('send')) {
      server.registerTool(
        SEND_DRAFT,
        {
          description:
            'Send an existing draft (draftId from mail_list_drafts or mail_create_draft) from its account, as stored. Only use after the ' +
            'user confirmed this draft should be sent. IMAP: sent over SMTP without the Bcc header, then moved to Sent. Requires "send" and ' +
            'the provider send permission. requestId is required: a new random id per send; the same requestId and draft is never sent ' +
            'twice (stored outcome, replayed: true), the same requestId with another draft fails (idempotency_conflict). "accepted" = ' +
            'accepted by the provider (not proof of delivery), "rejected" = not sent, "indeterminate" = unknown: Perch never retries, ' +
            'check the Sent folder (or mail_send_status) before using a new requestId.',
          inputSchema: {
            accountId,
            draftId: z.string().max(2048).describe('draftId from mail_list_drafts / mail_create_draft'),
            requestId: z
              .string()
              .min(8)
              .max(128)
              .regex(REQUEST_ID_PATTERN)
              .describe('Required idempotency key: a new random id per send (8-128 chars of A-Z a-z 0-9 . _ : -)'),
          },
          annotations: DESTRUCTIVE,
        },
        (a) => tool(SEND_DRAFT, a, (p) => ctx.mail.sendDraft(p, a)),
      );
    }
  },
};
