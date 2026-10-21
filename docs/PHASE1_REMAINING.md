# Phase 1: what is done and what remains

As of 2026-10-19 (`main` after PR #9). This is a completion checklist, **not a claim that phase 1 is finished**. Everything below was tested only against mocks and local test servers; **nothing has been verified live** and Perch is **not deployed**. The first live run follows the README section "Live test, step by step".

## Done on `main` (mock-tested)

| Area | State | Details |
| --- | --- | --- |
| Drive, Notion | read-only, multi-account, fan-out with provenance | `SPEC.md` |
| Mail (Gmail, Microsoft Graph, IMAP/SMTP incl. GMX) | read; drafts/send only with client grant; idempotent send ledger | `EMAIL_MILESTONE.md`, `MAIL_WORKFLOW_MILESTONE.md` |
| Google Calendar/Contacts | read; private own-calendar events with `calendar_write` | `GOOGLE_PRODUCTIVITY_MILESTONE.md` |
| Body-free audit log, idempotent sending | shared ledger for mail, Slack, WhatsApp and Luma writes | `MAIL_WORKFLOW_MILESTONE.md` |
| Slack (several workspaces) | read; post with `slack_send` | `SLACK_WHATSAPP_MILESTONE.md` |
| WhatsApp via self-hosted GOWA | read; text send with `whatsapp_send` | `SLACK_WHATSAPP_MILESTONE.md` |
| Luma via the official Luma MCP | read; events/guests/blasts only with grants; pinned tool schemas | `LUMA_SPEC.md` |
| `perch status` and read-only `/status` page | live check per account | `SETUP.md` §5a |
| Write extensions (2026-10-20) | Drive create/edit/share/trash, Notion create/edit/trash/comments, mail organize + send drafts, Slack files/reactions/edit, WhatsApp media; all only with client grants, delete = trash only | `FULL_ACCESS_SPEC.md` (implemented subset) |
| Public access over MCP OAuth | pairing windows, Google login + Perch code (TOTP), kill switch; two independent reviews | `PUBLIC_ACCESS_SPEC.md`, `SETUP.md` §6a |
| Mail reply/forward, calendar invitations/series/delete, Slack DMs/scheduled (2026-10-20) | `mail_reply`, `mail_forward`, IMAP Sent copy; `calendar_invite`, `calendar_delete_event` (permanent), `calendar_respond_event`, RRULE, Meet; `slack_open_conversation`, `slack_schedule_message` | `MAIL_CALENDAR_SLACK_SPEC.md` |
| One Google login (2026-10-21) | `perch google add` connects Drive, Gmail, Calendar and Contacts with one OAuth flow; account groups share one stored refresh token; granular consent; re-add updates in place | `GOOGLE_UNIFIED_SPEC.md`, `SETUP.md` §3 |
| Guided Google preparation, login without a tunnel (2026-10-21) | `perch google client setup|show`; every Google `add` starts the guide when the client file is missing/invalid (direct links, scope list, hidden JSON paste, 0600 at the default path); every loopback login (Google, Microsoft, Luma) also accepts the pasted browser address, racing the callback | `GUIDED_PROVIDER_SETUP_SPEC.md` §1–2, `SETUP.md` §3 |
| OSS licence | MIT, third-party notices, `npm run licenses:check` | `OSS_LICENSE_MILESTONE.md` |
| User isolation | **removed** on purpose (one operator per installation) | `USER_ISOLATION_MILESTONE.md` (historical) |

## 1. Live validation — open (next step)

Follow the README live test. Points that only a live run can answer:

- Every connector once with a real account: Drive, Notion, Gmail, Outlook, GMX, Calendar/Contacts, Slack, WhatsApp/GOWA, Luma.
- Google: refresh tokens expire after 7 days while the consent screen is in "Testing".
- Google one login (`perch google add`): granular consent (unticking single scopes on the consent screen; is the token response `scope` exactly what was ticked?), `include_granted_scopes=true` (does the new grant report the earlier scopes of the same OAuth client, also those of separately connected Gmail/Calendar accounts; does a refresh return the combined `scope`?), whether re-adding the same account issues a new refresh token and keeps the old one valid, and whether one revoke really ends Drive, Gmail and Calendar access together.
- Guided Google preparation and paste login: do the Cloud Console direct links (`/projectcreate`, `/apis/library/<api>?project=ID`, `/auth/branding|audience|scopes|clients/create?project=ID`) still land on the right pages; does the downloaded Desktop-app JSON still contain `redirect_uris: ["http://localhost"]`; does the "Manually add scopes" field accept the printed list (`openid`, `.../auth/userinfo.email`, …). After consent, does the laptop browser show "This site can't be reached" with the **complete** redirect address (`http://127.0.0.1:PORT/oauth2/callback?state=…&code=…&scope=…`) in the address bar, so that pasting it works (Chrome, Safari, Firefox); same for Outlook (`http://localhost:PORT/?code=…`) and Luma. Does pasting into the hidden raw-mode prompt work over SSH from macOS Terminal/iTerm (one-line paste of the client JSON).
- WhatsApp: does the session stay stable with GOWA's daily presence pulse; actual history after pairing.
- Luma: registration type (DCR or CIMD at `https://frilabs.dev/perch/luma-client.json`), refresh behaviour, the real tool list, response formats of `get_self` and `list_guests`, whether redirect URIs without port are accepted.
- Public access: does claude.ai keep the up-to-10-minute pairing open; which CIMD URL the hosted Claude apps send; does Funnel pass the client IP (only then `PERCH_PUBLIC_TRUST_FORWARDED=on`); how Codex signs in.
- Codex configuration (`SETUP.md` §6) is taken from the Codex docs and untested.
- Mail reply/forward: Outlook conversation grouping of MIME replies, Graph 4 MB MIME limit, GMX Sent copy (duplicate?). Calendar: `calendar.events.owned` for answering others' invitations, If-Match on delete, Meet creation. Slack: `chat.scheduledMessages.list` with a user token, scheduled-id format, reinstall with `im:write`/`mpim:write`.
- Slack session mode (`SETUP.md` §4e.4): `Authorization: Bearer xoxc-…` plus `Cookie: d=…` accepted by every endpoint Perch uses (incl. `search.messages`, `chat.scheduledMessages.list`, `files.getUploadURLExternal`/`completeUploadExternal`), `files.slack.com` downloads with the cookie, the pre-signed upload URL without cookie, Enterprise Grid (URL `/client/E…`, team keys in `localConfig_v2`), whether the console line still finds the token, session lifetime and the error codes on expiry, rate limits for session tokens, the cookie format as browsers show it (Chrome/Safari/Firefox: URL-encoded?).
- Write extensions: Drive `drive` scope consent, multipart upload, Doc/Sheet conversion, content replacement on native Docs, permission ids; Notion PAT capability names, 403 `restricted_resource`, `after` vs `position` on append, `in_trash` on PATCH; Gmail `gmail.modify` for drafts/send, Graph move response and draft send, GMX MOVE/UIDPLUS and special-use folders, IMAP send-draft without Bcc leak; Slack new scopes after reinstall, upload URL/flow, download URL format; GOWA multipart bodies, captions/replies, `/statics` media path and auth.
- Notion OAuth (public integration, `perch notion add --oauth`): does Notion accept `http://localhost:8769/notion/callback`, does the token endpoint return `refresh_token`/`expires_in` (and rotate it), token-response fields (`workspace_id`, `owner.user`); post-connect search count with a fresh internal token and with OAuth page selection.

## 2. Operations — not implemented

- Docker/compose image (non-root, no public port by default, no secrets baked in).
- Backup and restore: today the operator backs up `store.key` (separately!), `store.enc`, `mail-workflow.enc` and `oauth.enc` by hand. Restoring an older `mail-workflow.enc` forgets newer send keys, so an old `requestId` could send again.
- Versioned migrations with pre-migration backup and rollback. There is no downgrade path once Slack, WhatsApp or Luma events are in the ledger (strict schema, unchanged ledger version).
- A rollover for the send ledger: mail, Slack (including scheduled messages), WhatsApp and Luma writes share 1000 send records; at the limit every send fails closed, including mail.

## 3. Known gaps in the code

- Public access:
  - anyone on the internet can detect and close an open pairing window (no data leaks, but pairing can be denied and alarms lose meaning); mitigate before relying on Funnel;
  - `/mcp` calls of public devices are audited as `operator_readonly` / `client-…`, not with the device id;
  - refresh rotation has no grace window (two concurrent refreshes sign a device out);
  - `/oauth/token` with a well-formed refresh token rewrites `oauth.enc` even without a change (≤ 30/min); `readBody` keeps reading after its limit until the timeout.
- Luma: refresh rotation between CLI and server has no shared lock; Luma tool descriptions appear in Perch's tool descriptions and are untrusted.
- Features not built: changing single occurrences of a recurring event; writing contacts (decided: read only); WhatsApp edit, read receipts, older-history loading (decided: not now); Notion sharing (not in the Notion API).
- WhatsApp stays an unofficial linked-device integration (account restriction risk, especially when sending); GOWA stores messages unencrypted.

## 4. Repository

- GitHub Actions does not start jobs at the moment (account billing / spending limit). Verify locally with `npm run check`.
- Before making the repository public: commit author email in 13 old commits, server paths (`~/...`) in milestone docs.

## Phase 2 — separate roadmap

Public signup, billing, hosted multi-tenancy, provider app verification and a public release remain separate. LinkedIn is excluded. Perch contains no LLM.
