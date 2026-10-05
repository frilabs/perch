# Phase 1: exact remaining acceptance criteria

As of 2026-10-05. This is a completion checklist, **not a claim that phase 1 is finished**. No merge, deployment, public exposure or visibility change is authorised.

## Delivered feature branches (not merged)

- Email: PR #2, `feat/perch-email-connectors`, based on PR #1. Gmail/Graph/IMAP-SMTP search/read/attachments/draft/send, single-operator scoped client grants. See `EMAIL_MILESTONE.md`.
- OSS licensing: PR #3, `feat/perch-oss-license`, an independent sibling based on PR #2. MIT source license, dependency inventory/notices and gate; not yet combined with the later feature branches. See that branch's `OSS_LICENSE_MILESTONE.md`. Precise copied type-fest revision provenance must be confirmed before container distribution.
- This Calendar/Contacts increment: separate productivity OAuth, five read tools and private owned-calendar create/update with opt-in grants, explicit private visibility and popup-only reminders. See `GOOGLE_PRODUCTIVITY_MILESTONE.md`. It does not add multi-user hosting.
- User ownership/isolation: PR #5, `feat/perch-user-isolation` (`560c6ae`), based on the Calendar commit `acc3eeb`: committed, pushed, review-approved, CI green; verified 468 tests + 9 smoke. See `USER_ISOLATION_MILESTONE.md`.
- Body-free audit and idempotent mail send workflow: working branch `feat/perch-mail-workflow`, based on `560c6ae`. Implemented and mock-tested, **not yet committed or pushed**; two review/repair rounds done, a final independent re-review is still open (539 tests + 10 smoke on Node 26.7.0 and 22.12.0 after repair 2). See `MAIL_WORKFLOW_MILESTONE.md`.
- Operations (container/backup) sibling: separate branch, not combined here. It backs up each namespace's `mail-workflow.enc` per the shared storage contract in `MAIL_WORKFLOW_MILESTONE.md` §3.

The sibling branches have separate test reports. Do not sum them into a fictional combined test run. They need a reviewed integration branch and full regression verification before any combined release; no automatic merge is authorised.

## 1. User ownership and isolation — admin-provisioned subset implemented, mock-tested, review-approved

Implemented on delivery branch `feat/perch-user-isolation` (independently tested/review-approved; MOCK upstreams only, not live-verified). Evidence: `USER_ISOLATION_MILESTONE.md` §5–§6. Each criterion below is marked done only where a test covers it:

- [x] Explicit admin user provisioning (`perch user add|list|remove`). Ownership-bound storage: a physically separate encrypted store and key per user. Each namespace has its own context and access-token caches, so provider requests, downloaded content and results use only the owner's credentials. Cursors are sealed per namespace; MCP sessions are bound to one namespace.
- [x] Every request resolves to exactly one namespace before credentials/context are selected; ambiguous token hashes fail closed. The global bearer token sees only the root operator namespace; the local operator token stays valid only there.
- [x] Per-client grants belong to the user's own store, enumerate accounts and capabilities, and are rechecked, together with user membership and the integrity of the owner namespace (directories, key file, store), on every HTTP request and before every tool call, including persistent stdio. The global token is refused if its hash matches any user token or any active user's client grant; a damaged active namespace therefore makes all HTTP tokens answer 503 (documented availability trade-off).
- [x] Tests with two users plus root, all with colliding account ids. Each of these fails without upstream I/O or identifying metadata, for the other user and for the global token:
  - another user's account listing, read, attachment/download and search/fan-out;
  - cross-user and forged cursors;
  - draft/send and Calendar create/update (each acts only in the owner's namespace);
  - a reused persistent session after user removal;
  - grant revocation and narrowing.
  All pre-existing tests pass unmodified.
- [x] Local-admin versus remote-user powers are documented (`USER_ISOLATION_MILESTONE.md` §2, `SETUP.md` §4c); there is no bare `ownerId` field.
- Still open:
  - merge of PR #5 (needs Fritz's OK);
  - live validation;
  - user token rotation/re-activation and destructive deletion (not implemented, documented);
  - hosted production multi-tenancy hardening (per-user quotas/rate limits, separate processes or OAuth apps, public exposure), which remains phase 2.

## 2. Body-free audit and idempotent mail workflow — implemented on `feat/perch-mail-workflow`, mock-tested, not yet reviewed

Evidence: `MAIL_WORKFLOW_MILESTONE.md` §7–§8 (MOCK providers only, not live-verified). Each criterion is marked done only where a test covers it:

- [x] Audit records hold:
  - timestamp, namespace, actor/client, Perch account id/provider, operation id, operation type and a fixed outcome/code;
  - no body, attachment names or bytes, credentials, recipients, subjects, labels, addresses, queries, ids or request keys (decrypted-ledger marker tests).
- [x] Coverage:
  - every MCP tool call that passes the namespace guard (shared runner); writes are audited before the provider call, fail closed; read results are withheld if their audit cannot be written;
  - `mail_send` is audited by the workflow itself.
- [x] Audit reads are local and per namespace (`perch audit list`, `PERCH_USER`). There is no MCP audit tool.
- [x] Atomic, durable namespace/actor/account/requestId workflow with explicit pending/accepted/rejected/indeterminate states:
  - `requestId` is required on `mail_send` (documented pre-release break);
  - repeated or concurrent same-key requests submit exactly once (same instance, separate instances, 6 real processes);
  - a changed payload fails before provider I/O.
- [x] A lost response, crash/kill after the claim or a finalization write failure stays indeterminate (`pending`) forever, with no automatic retry. Only a local admin can record a human-verified outcome, which never sends. Provider-native idempotency limits are documented.
- [x] Tests cover:
  - duplicate concurrent requests; network loss before/after acceptance (MOCK); restart and kill recovery;
  - cross-user colliding account/grant/request ids; other-client status denial;
  - revoked/narrowed grants on cached results; redaction;
  - ledger corruption/missing/symlink/limits/locks/write failure;
  - built stdio+HTTP smoke under the offline guard with zero network attempts.
  No real outgoing sends.
- Still open:
  - independent review, commit and PR of this branch;
  - live validation of real sends.
  - Known limits (`MAIL_WORKFLOW_MILESTONE.md` §9): a pending record is forever unless resolved; ledger capacity (1000 sends per namespace, no prune, rollover not built); upgrade step `perch mail-workflow init` only for namespaces that never had a ledger; no deterministic Message-ID.
- Email limitations remain:
  - Graph MIME cap and unverified live Bcc semantics;
  - no SMTP Sent-folder copy;
  - IMAP fetch/search/APPEND only mock-validated.
  Sending an already stored draft and mail move/delete/flags are not implemented and are outside the current delivered subset.

## 3. Docker/compose, persistence, backup/restore and migrations — NOT implemented

- Build and actually exercise a non-root image and compose configuration. No host-wide runtime/service installation or deployment without separate approval. This host currently has no Docker/Podman runtime; configuration alone is not a verified container delivery.
- Default network binding must not publish a public port. Remote/Tailscale exposure remains a separately authorised operation. Preserve existing MCP host/origin/bearer protections.
- Persistent encrypted store and separated key material, protected mounts/files, no secrets baked into image or logged. Production-only locked dependency install; include source license, dependency notices and OS/base-image notices.
- Backups must include each namespace's `mail-workflow.enc` next to `store.enc` (it has no own key file; the store key covers it, `MAIL_WORKFLOW_MILESTONE.md` §3). Restoring an older ledger forgets newer send keys, so a retried old `requestId` could be sent again: document that in recovery.
- Restore into a fresh isolated directory with real encrypted fixture data; verify decryption and account/grant recovery, no missing-key regeneration or corrupt-store overwrite. Document safe backup custody and recovery of stale locks.
- Versioned controlled migration with pre-migration backup, malformed/future-schema rejection and rollback/recovery tests. Existing backward-compatible defaults are not a complete migration system.
- Integrate the licence sibling, regenerate/check notices, run production-only installation verification, then exercise the exact image/compose artifact.

## 4. Replaceable self-hosted WhatsApp adapter — NOT implemented

- Candidate primary source reviewed: `aldinokemal/go-whatsapp-web-multidevice`, commit `3971c4cbdfec00d5b8f0b4cdbd61bf310b962756` (2026-10-04), `docs/openapi.yaml` declares API version 9.0.0. Repository license endpoint reports MIT (`LICENCE.txt` blob `34fbff4c1e783c4df65975eead02a08fd745936e`). This is API/license research, **not connector or runtime verification**.
- Pin/test the adopted version and its redistribution/dependency obligations. Keep a replaceable adapter interface; no cloud vendor required. No WhatsApp account was supplied or paired.
- Local protected pairing/admin onboarding and account/device status; never ask for pairing/verification secrets in chat. API credentials encrypted and not included in URL/logs. Each account must be bound to its own verified device id (`X-Device-Id`) and user namespace.
- Implement bounded chat listing and message read/search against the actual documented REST contract, explicit provenance, default read-only, opt-in per-client sends from the selected account, one submission attempt and honest ambiguity handling.
- Contract excerpt: `/chats` supports chat-name search; `/chat/{chat_jid}/messages` supports content-text search within a chat. Do not describe this as a tested global/full-history search. `/chat/{chat_jid}/history` requests older history asynchronously and requires an existing stored anchor; it does not return older messages directly.
- Test the adapter against a local authenticated fake upstream, hostile routes/redirects/device ids, bounds, cross-user denial, send ambiguity and revocation; then exercise the pinned self-hosted backend without a live account before claiming runtime compatibility. Real pairing/read/send requires separately supplied consent and user-side onboarding.
- Clearly disclose unofficial linked-device integration, platform/account risks and incomplete history. No automatic public ports or production deployment.

Primary sources: [repository](https://github.com/aldinokemal/go-whatsapp-web-multidevice), [pinned license](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/3971c4cbdfec00d5b8f0b4cdbd61bf310b962756/LICENCE.txt) and [pinned OpenAPI](https://github.com/aldinokemal/go-whatsapp-web-multidevice/blob/3971c4cbdfec00d5b8f0b4cdbd61bf310b962756/docs/openapi.yaml). Retrieval copies are in the orchestrator scratch area. The actual adapter must verify again against the version it adopts.

## 5. Live validation and operations — unavailable without user onboarding

No real Google/Microsoft/GMX/Notion/WhatsApp credentials or consents have been supplied. All connector evidence is mocks/local protocol/MCP tests, not live-account validation. One dummy Google refresh request escaped an early Calendar mutation test and was rejected; the subsequent test-only child-process preload guard is verified across supported Node versions. No real token or event was involved.

- User-side OAuth app/API/consent setup, provider tenant-policy checks, masked IMAP app-password onboarding and protected WhatsApp pairing.
- Validate real search/read/attachments and sender provenance; any live mail or WhatsApp send/private Calendar write needs explicit test targets and consent. Check accepted versus delivered and actual provider threading/Bcc behavior.
- Calendar delivered writes are private events on owned calendars only: no attendees, email reminders, recurrence, conferences/attachments, sharing, delete/move or free/busy. Contacts are list/get only, no writes/search/directory. Expanded notification/recurrence support requires a separately reviewed grant model, not an implicit default.
- Tomorrow's actual app-visible coding workflow remains to be resolved through supported secure interactive onboarding. Today's invisible-background exception does not change the standing visibility preference. Preserve the existing Remote Control and never label an idle launcher as the actual writer.

## Phase 2 — separate roadmap, NOT phase 1 delivery

Public signup, billing, company-hosted product, hosted production multi-tenancy hardening, provider public-app verification and public release remain separate. LinkedIn is excluded. Perch contains no LLM.
