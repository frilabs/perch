import { z } from 'zod';
import { MAX_LINKEDIN_TEXT } from '../../linkedin/linkedin.js';
import { REQUEST_ID_PATTERN } from '../../mail/workflow.js';
import { DESTRUCTIVE, READ_ONLY, type ToolModule } from './kit.js';

const POST_NOTE =
  'requestId is required: generate a new random id (8-128 chars of A-Z a-z 0-9 . _ : -) for every new post and reuse it only to ' +
  'retry or check THAT post (linkedin_post_status). A repeat with the same requestId and identical text is never posted twice: it ' +
  'returns the stored outcome (replayed: true); the same requestId with different text fails (idempotency_conflict). "accepted" = ' +
  'published by LinkedIn, "rejected" = not posted, "indeterminate" = unknown: Perch never retries, so check the profile before using a new requestId.';

/**
 * LinkedIn (docs/LINKEDIN_X_SPEC.md): login state for linkedin_read (and the read-only operator), posting to the
 * member's own profile only for client grants holding linkedin_post for that account.
 */
export const linkedinTools: ToolModule = {
  readTools: ['linkedin_status'],
  writeTools: ['linkedin_post', 'linkedin_post_status'],
  // Audited by the shared message send workflow (src/messaging/send.ts), atomically with the send record.
  selfAudited: ['linkedin_post'],
  auditedWrites: [],
  register(server, ctx, principal, operator, tool) {
    const accountId = z.string().max(64).describe('LinkedIn account id from perch_list_accounts, e.g. linkedin-1a2b3c4d');

    if (operator || principal.capabilities.has('linkedin_read')) {
      server.registerTool(
        'linkedin_status',
        {
          description:
            'Login state of one connected LinkedIn account: member name, person URN, until when the login lasts (connectedUntil) and ' +
            'whether it expires soon or has expired (then "renew" names the local command to run). No LinkedIn call.',
          inputSchema: { accountId },
          annotations: READ_ONLY,
        },
        (a) => tool('linkedin_status', a, (p) => ctx.linkedin.status(p, a)),
      );
    }

    if (principal.capabilities.has('linkedin_post')) {
      server.registerTool(
        'linkedin_post',
        {
          description:
            'Publish one public text post on the explicitly chosen LinkedIn member profile (visible to everyone, main feed). Plain text ' +
            `only, at most ${MAX_LINKEDIN_TEXT} characters; Perch escapes LinkedIn's reserved characters so the text appears literally ` +
            '(no mentions or hashtag links). Only use after the user confirmed account and exact text. Returns postId and url. ' +
            `Requires a client grant with linkedin_post. ${POST_NOTE}`,
          inputSchema: {
            accountId: accountId.describe('LinkedIn account to post as (explicit)'),
            text: z.string().min(1).max(MAX_LINKEDIN_TEXT * 2).describe(`Post text (at most ${MAX_LINKEDIN_TEXT} characters)`),
            requestId: z.string().min(8).max(128).regex(REQUEST_ID_PATTERN).describe('Required idempotency key (see the tool description)'),
          },
          annotations: DESTRUCTIVE,
        },
        (a) => tool('linkedin_post', a, (p) => ctx.linkedin.post(p, a)),
      );
      server.registerTool(
        'linkedin_post_status',
        {
          description: 'Current outcome of one of YOUR earlier linkedin_post calls (same client, account and requestId), without posting anything.',
          inputSchema: { accountId, requestId: z.string().min(8).max(128).regex(REQUEST_ID_PATTERN) },
          annotations: READ_ONLY,
        },
        (a) => tool('linkedin_post_status', a, (p) => ctx.linkedin.postStatus(p, a)),
      );
    }
  },
};
