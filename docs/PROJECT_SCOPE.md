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
- Authenticated remote MCP and local stdio: implemented single-user milestone. Multi-user ownership and per-client grants are **not implemented**: current bearer authorizes the one operator's connected accounts. Do not deploy as shared multi-user service.
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

## Next implementation order

1. Ownership-aware client authorization and explicit read/write capability grants, regression tests preserving this Drive/Notion milestone.
2. Google Gmail/Calendar/Contacts and their separate OAuth scope onboarding.
3. Microsoft Graph mail and delegated consent.
4. IMAP/SMTP and GMX setup.
5. GOWA adapter after primary API/license verification.
6. License/dependency notices and compose/backup documentation.

`docs/SPEC.md` describes only the implemented Drive/Notion milestone. This expanded direction supersedes its roadmap timing, not its tested acceptance criteria. Complete each incremental artifact and report fake-upstream versus live verification separately.
