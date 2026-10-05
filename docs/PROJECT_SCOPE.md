# Perch: confirmed expanded project direction

User: Fritz. Product name Perch. This records the approved direction, **not an implementation claim**. The Drive/Notion read-only PR is the first verified milestone; the additional phase-1 connectors below remain follow-up work.

## Delivery model

1. Open-source, self-hostable connector gateway for Claude Code, Hermes, and compatible MCP clients. No LLM built into Perch.
2. Later optional company-hosted product with one Perch login and separate consent for every upstream account/workspace. Shared hosting does not replace upstream authorization.

## Expanded phase 1

- Multiple accounts per service with provenance and explicit sender selection.
- Google: implemented Drive read-only milestone; follow-up Gmail search/read/attachments/draft/send, Calendar read/create/update, Contacts read. Writes require explicit per-client grants; safe default read-only.
- Microsoft Graph delegated OAuth for Outlook.com/Microsoft 365 mail: search/read/attachments/draft/send; tenant policy limitations documented.
- GMX/generic mail: IMAP read, SMTP send, enforced TLS, secure local password onboarding, threading/reply headers, bounded attachments; app-password/IMAP setup documentation.
- Notion: implemented multiple PAT workspaces, title search, page/database/data-source read. Never promise full-text search.
- Private WhatsApp: replaceable self-hosted linked-device adapter, prefer GOWA only after actual API/license verification. Pairing/status/read/search/send; clearly unofficial with platform/account risks and incomplete history. Not implemented in this milestone.
- LinkedIn explicitly excluded.
- Authenticated remote MCP and local stdio: implemented single-operator milestone with explicit per-client capability/account grants. **Multi-user ownership/isolation is not implemented**; the operator bearer still reads that one operator's connected accounts. Do not deploy as shared multi-user service.
- Follow-up multi-user provisioning must enforce credential/request/file/session/result ownership; no global token exposing everyone's accounts. Test cross-user denial explicitly.
- Encrypted secrets/key separation/no logs: implemented storage milestone. Follow-up sending permissions, body-free audit, idempotent workflow and ambiguous-send handling.
- Docker/compose, persistent encrypted storage, backup/restore, migrations: follow-up. No deployment or public exposure authorized.
- Initial CLI/admin onboarding, no SaaS UI/payment in phase 1.
- Permissive OSS license (MIT preferred) only after dependency compatibility/notice review: **not yet licensed in this milestone**. No repository visibility change authorized.

## Delivery discipline

Use installed Claude Code and existing Max subscription, incrementally on feature branches with verified PRs; no merge/deployment. Tests/build/typecheck and real MCP transport smoke, local upstream contract tests explicitly labeled mocks. No real accounts/secrets supplied: live checks remain unavailable. Phase 2 signup/billing and hosted production multi-tenancy are roadmap, not completed by adding a user_id field.

## Status update 2026-10-05 (branch `feat/perch-email-connectors`)

The email milestone is implemented and locally tested with mocks and local test servers, but not live-verified. See `docs/EMAIL_MILESTONE.md`:
- Gmail, Microsoft Graph and GMX/IMAP+SMTP search/read/attachments/draft/send.
- Explicit per-client read/draft/send grants bound to mail account ids; the global token stays read-only.

Still open:
- multi-user ownership/isolation;
- Calendar/Contacts;
- body-free audit and idempotent send workflow;
- GOWA;
- license/notices;
- compose/backup.

## Status update 2026-10-05 (branch `feat/perch-calendar-contacts`, stacked on the email milestone)

The Google productivity milestone is implemented and locally tested against MOCK upstreams only, **not live-verified**. See `docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`:
- separate Google OAuth grant per account with explicit `--services calendar,contacts`, read-only by default, opt-in `--allow-calendar-write` (`calendar.events.owned`), verified email via the OpenID Connect userinfo endpoint;
- Calendar list calendars/events, get, create, update (private events only: no attendees/invitations/guest updates; explicit private visibility and popup-only reminders; requestId-idempotent create; If-Match update) and Contacts list/get, with multi-account provenance;
- explicit per-client capabilities `calendar_read`, `calendar_write`, `contacts_read`, bound to account ids, revalidated before every tool call; the operator stays read-only.

Still open after this milestone (exact remaining acceptance criteria):
- **multi-user ownership/isolation:** credential/request/file/session/result ownership per user, no global token exposing everyone's accounts, explicit cross-user denial tests. Not part of this increment; Perch remains a single-operator gateway;
- Calendar invitations/attendees and notifications, recurring events, deleting events, conferencing, attachments; Contacts writes and search;
- live verification of every Google, Microsoft and GMX flow with real accounts (user tasks);
- body-free audit log and an idempotent send workflow for mail;
- GOWA (after API/license verification), license/notices, Docker/compose/backup.

## Latest delivery checklist

`docs/PHASE1_REMAINING.md` contains the consolidated exact acceptance criteria and branch relationships. MIT/notices are delivered separately in sibling PR #3 (`feat/perch-oss-license`, based on email PR #2), not integrated into this Calendar branch. No combined-release test run or merge is claimed. Earlier status sections are historical snapshots.

## Next implementation order

1. Ownership-aware (multi-user) authorization, regression tests preserving the Drive/Notion, email and Calendar/Contacts milestones. (Explicit per-client capability grants exist since the email and productivity milestones.)
2. Google Gmail/Calendar/Contacts and their separate OAuth scope onboarding: implemented (mocks only); live verification pending.
3. Microsoft Graph mail and delegated consent.
4. IMAP/SMTP and GMX setup.
5. GOWA adapter after primary API/license verification.
6. License/dependency notices and compose/backup documentation.

`docs/SPEC.md` describes only the implemented Drive/Notion milestone. This expanded direction supersedes its roadmap timing, not its tested acceptance criteria. Complete each incremental artifact and report fake-upstream versus live verification separately.
