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
| Public access over MCP OAuth | pairing windows, Google login + Perch code (TOTP), kill switch; two independent reviews | `PUBLIC_ACCESS_SPEC.md`, `SETUP.md` §6a |
| OSS licence | MIT, third-party notices, `npm run licenses:check` | `OSS_LICENSE_MILESTONE.md` |
| User isolation | **removed** on purpose (one operator per installation) | `USER_ISOLATION_MILESTONE.md` (historical) |

## 1. Live validation — open (next step)

Follow the README live test. Points that only a live run can answer:

- Every connector once with a real account: Drive, Notion, Gmail, Outlook, GMX, Calendar/Contacts, Slack, WhatsApp/GOWA, Luma.
- Google: refresh tokens expire after 7 days while the consent screen is in "Testing".
- WhatsApp: does the session stay stable with GOWA's daily presence pulse; actual history after pairing.
- Luma: registration type (DCR or CIMD at `https://frilabs.dev/perch/luma-client.json`), refresh behaviour, the real tool list, response formats of `get_self` and `list_guests`, whether redirect URIs without port are accepted.
- Public access: does claude.ai keep the up-to-10-minute pairing open; which CIMD URL the hosted Claude apps send; does Funnel pass the client IP (only then `PERCH_PUBLIC_TRUST_FORWARDED=on`); how Codex signs in.
- Codex configuration (`SETUP.md` §6) is taken from the Codex docs and untested.

## 2. Operations — not implemented

- Docker/compose image (non-root, no public port by default, no secrets baked in).
- Backup and restore: today the operator backs up `store.key` (separately!), `store.enc`, `mail-workflow.enc` and `oauth.enc` by hand. Restoring an older `mail-workflow.enc` forgets newer send keys, so an old `requestId` could send again.
- Versioned migrations with pre-migration backup and rollback. There is no downgrade path once Slack, WhatsApp or Luma events are in the ledger (strict schema, unchanged ledger version).
- A rollover for the send ledger: mail, Slack, WhatsApp and Luma writes share 1000 send records; at the limit every send fails closed, including mail.

## 3. Known gaps in the code

- Public access:
  - anyone on the internet can detect and close an open pairing window (no data leaks, but pairing can be denied and alarms lose meaning); mitigate before relying on Funnel;
  - `/mcp` calls of public devices are audited as `operator_readonly` / `client-…`, not with the device id;
  - refresh rotation has no grace window (two concurrent refreshes sign a device out);
  - `/oauth/token` with a well-formed refresh token rewrites `oauth.enc` even without a change (≤ 30/min); `readBody` keeps reading after its limit until the timeout.
- Luma: refresh rotation between CLI and server has no shared lock; Luma tool descriptions appear in Perch's tool descriptions and are untrusted.
- Features not built: sending stored drafts, mail move/delete/flags, IMAP "Sent" copy; calendar invitations, recurring events, deleting; writing contacts; Slack files and reactions; WhatsApp media and older-history loading.
- WhatsApp stays an unofficial linked-device integration (account restriction risk, especially when sending); GOWA stores messages unencrypted.

## 4. Repository

- GitHub Actions does not start jobs at the moment (account billing / spending limit). Verify locally with `npm run check`.
- Before making the repository public: commit author email in 13 old commits, server paths (`~/...`) in milestone docs.

## Phase 2 — separate roadmap

Public signup, billing, hosted multi-tenancy, provider app verification and a public release remain separate. LinkedIn is excluded. Perch contains no LLM.
