# Phase 1: exact remaining acceptance criteria

As of 2026-10-05. This is a completion checklist, **not a claim that phase 1 is finished**. No merge, deployment, public exposure or visibility change is authorised.

## Delivered feature branches (not merged)

- Email: PR #2, `feat/perch-email-connectors`, based on PR #1. Gmail/Graph/IMAP-SMTP search/read/attachments/draft/send, single-operator scoped client grants. See `EMAIL_MILESTONE.md`.
- OSS licensing: PR #3, `feat/perch-oss-license`, an independent sibling based on PR #2. MIT source license, dependency inventory/notices and gate; not yet combined with this Calendar branch. See that branch's `OSS_LICENSE_MILESTONE.md`. Precise copied type-fest revision provenance must be confirmed before container distribution.
- This Calendar/Contacts increment: separate productivity OAuth, five read tools and private owned-calendar create/update with opt-in grants, explicit private visibility and popup-only reminders. See `GOOGLE_PRODUCTIVITY_MILESTONE.md`. It does not add multi-user hosting.
- User ownership/isolation: branch `feat/perch-user-isolation`, based on the Calendar commit `acc3eeb`. **Not yet committed, pushed or reviewed.** See `USER_ISOLATION_MILESTONE.md`.

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
  - review, commit and PR of this branch;
  - live validation;
  - user token rotation/re-activation and destructive deletion (not implemented, documented);
  - hosted production multi-tenancy hardening (per-user quotas/rate limits, separate processes or OAuth apps, public exposure), which remains phase 2.

## 2. Body-free audit and idempotent mail workflow — NOT implemented

- Record actor/client, owned account/provider, operation id, timestamp and outcome without body, attachment bytes, credentials or recipient content in default logs. Audit reads must be ownership-bound.
- Atomic actor/account/request-key workflow with explicit pending/accepted/rejected/indeterminate states. Repeated or concurrent same-key requests must not silently submit a second message; mismatched payload fingerprints must fail.
- A lost response or interrupted pending operation must remain indeterminate until checked. Never automatically retry an uncertain send. Provider-native idempotency limitations must be documented rather than promised away.
- Tests for duplicate concurrent requests, network loss before/after upstream acceptance, restart recovery, cross-user keys, redaction and revoked grants. No real outgoing sends in automated tests.
- Email limitations remain: Graph MIME cap and unverified live Bcc semantics; no SMTP Sent-folder copy; IMAP fetch/search/APPEND only mock validated. Sending an already stored draft and mail move/delete/flags are not implemented and are outside the current delivered subset.

## 3. Docker/compose, persistence, backup/restore and migrations — NOT implemented

- Build and actually exercise a non-root image and compose configuration. No host-wide runtime/service installation or deployment without separate approval. This host currently has no Docker/Podman runtime; configuration alone is not a verified container delivery.
- Default network binding must not publish a public port. Remote/Tailscale exposure remains a separately authorised operation. Preserve existing MCP host/origin/bearer protections.
- Persistent encrypted store and separated key material, protected mounts/files, no secrets baked into image or logged. Production-only locked dependency install; include source license, dependency notices and OS/base-image notices.
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
