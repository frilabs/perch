# Body-free audit and idempotent mail send workflow milestone

As of 2026-10-05. Working branch `feat/perch-mail-workflow` in `/home/hermes/perch-audit-work`, based on the verified user-isolation commit `560c6ae` (PR5: open, pushed, CI green; verified baseline **468 tests + 9 smoke**). Fritz authorised the expanded self-hosted phase 1 on 2026-10-05 ("Continue implementing the remaining stuff"); this increment covers `PHASE1_REMAINING.md` §2 only.

**Status:** implemented and locally tested against **MOCK** providers only. **Not live-verified**: no real account, OAuth flow or send. Nothing committed, pushed, merged or deployed by this run. **Phase 1 is not complete** (see §9). The operations/backup work (sibling branch) and the licence branch (PR #3) are **not combined** with this branch yet.

## 1. Scope

In scope:
- a durable, idempotent `mail_send` workflow keyed by an explicit caller `requestId`, per namespace/actor/account;
- a body-free audit trail of every MCP tool call, plus the workflow's own send events;
- an MCP status tool `mail_send_status`;
- local admin CLI `perch audit list` and `perch mail-workflow list|resolve|init` (`prune` was removed in repair 1 and now refuses, §8).

Out of scope (unchanged):
- WhatsApp;
- containers, backup/restore tooling and migrations (the operations sibling backs up the file defined in §3);
- public signup;
- live validation;
- deployment.

## 2. Breaking (pre-release) API change: `requestId` is required on `mail_send`

`mail_send` now **requires** `requestId`. Without it, the MCP SDK rejects the call against the input schema; the service layer rejects it as well. `mail_create_draft` is unchanged and has no requestId.

**How a client should use it:**
- **Generate** a new random id for every new message (8–128 characters of `A-Z a-z 0-9 . _ : -`, e.g. a UUID). Never derive it from content, and never put addresses or text in it.
- **Retry** a timed-out or failed call with the **same** `requestId` and the **identical** arguments. Perch then never sends a second time. It returns the stored outcome with `replayed: true` (or, while the first attempt is still unresolved, `status: "indeterminate"` with `requestState: "pending"`).
- **Check** the outcome later with `mail_send_status {accountId, requestId}`. This tool sends nothing.
- **Conflict:** the same `requestId` with **different** content fails with `idempotency_conflict` before any provider I/O.
- **New attempt:** only after `rejected`, or after checking the Sent folder following `indeterminate`, and only with a **new** `requestId`. Perch never retries automatically.

The result gains the following fields:
- `operationId` (`op-<24 hex>`, stable per key, never derived reversibly from the request id);
- `requestState` (`pending|accepted|rejected|indeterminate`);
- `replayed`;
- optionally `manualResolution`.

`status` stays `accepted|rejected|indeterminate`. `accepted` always carries the fixed text "Accepted by the provider for delivery. This is not proof of delivery to the recipient."

## 3. Storage contract (shared with the operations sibling)

| Item | Value |
| --- | --- |
| File | `mail-workflow.enc`, directly in the namespace's store data dir (root: `$PERCH_DATA_DIR/`, user: `$PERCH_DATA_DIR/users/<id>/`) |
| Lock | `mail-workflow.lock` (atomic `mkdir` directory with owner token), same dir; held only for local read/encrypt/write, never across provider I/O |
| Key | HKDF-SHA256 subkey of the namespace owner's store key read from `store.storePaths.keyFile`; salt `perch-mail-workflow-v1`; info `enc\0<namespace>` (encryption) and `mac\0<namespace>` (HMACs). No new key file: backing up the existing store key covers the ledger. |
| Envelope | the existing store envelope (`{v,alg:"AES-256-GCM",kid,iv,tag,ct}`, 12-byte IV per write, 16-byte tag, canonical base64). AAD `perch-mail-workflow|v1|AES-256-GCM|<namespace>`. Algorithm unchanged. `src/store/crypto.ts` only gained an optional AAD parameter whose default keeps the store AAD. |
| Plaintext | `{format:"perch-mail-workflow", version:1, namespace, createdAt, sends[≤1000], audit[≤2000], auditDropped}`, strictly validated on every read and write; independent of the credential store's schema version 1, which is unchanged |
| Bounds | file ≤ 4 MiB; plaintext ≤ 2 MiB; send records never evicted automatically (full → `ledger_full`, fail closed); audit events form a ring (oldest dropped, counted in `auditDropped`) |
| Creation | by `initStore` together with a **new** store (`perch init`, `perch user add`). For a namespace created before this version, only by the explicit `perch mail-workflow init` (exclusive create, never overwrite). |
| Initialised marker | optional field `mailWorkflowLedger: {createdAt}` **inside the existing encrypted `store.enc`** (credential store schema version stays 1, like earlier additive fields; no new file or path). Set by `initStore` for new stores and by `perch mail-workflow init` (after creating or validating the ledger, under the store lock). **Repair 2: every ledger write (audit event, send claim, finalization, resolution) first checks the marker in the persisted `store.enc`** (never an in-memory flag, so a marker removed on disk is noticed). If it is missing, the existing ledger must open (key, namespace, schema) and the marker is written under the store lock **before** the ledger lock is taken; if that store write fails, the ledger write (and so any send claim and provider I/O) is refused. A missing or corrupt ledger is never marked, so `init` stays possible for a namespace that never had one. With the marker set, a missing ledger is **lost**: `perch mail-workflow init` refuses (`ledger_missing`, restore from backup) and never resets it. Lock order: store lock, released, then ledger lock; never the reverse. Limits: a crash between ledger creation and marker write leaves a valid, **empty** unmarked ledger (no used keys to forget) that the next init/write marks. **Downgrade/restore risk (not prevented by code):** an older Perch binary (e.g. base `560c6ae`) drops the unknown marker field on its next store write, and restoring a `store.enc` backup older than the marker removes it too; if the ledger is then also lost before this version writes to it again, `init` cannot tell and would create an empty ledger, forgetting used requestIds (possible duplicate sends for retried old ids). Perch never resets or rewrites an existing ledger or its pending records; downgrades are unsupported and `store.enc` and `mail-workflow.enc` must be restored together from the same backup. |
| Fail closed | missing ledger (`ledger_missing`); corrupt, tampered or foreign (`ledger_corrupt` or `ledger_wrong_key`); future version; wrong namespace; symlink, non-regular file or group/other permissions (`insecure_path`); store key missing or replaced (`key_missing`, `wrong_key`); stale lock (`lock_stale`, never taken over) or lock timeout; write failure. A ledger is **never reset or overwritten** over corruption. |

Send record fields (all non-content):
- `key`: HMAC of namespace, actor kind, client id, account id and requestId (the raw requestId is never stored);
- `fp`: HMAC of the canonical caller payload; never returned or logged;
- `binding`: HMAC of the sender account identity;
- `operationId`, `accountId`, `provider`, `actor`, `state`, `attempt` (a random finalization token);
- timestamps, a fixed `reason` enum, and `resolution`;
- `providerMessageId`, only if it matches `^[A-Za-z0-9_-]{1,128}$` (Gmail ids). SMTP `<id@host>` values are dropped.

## 4. Workflow semantics

Order for `mail_send`, all **before** any provider I/O:
1. namespace guard and grant re-read (MCP runner);
2. `send` capability, plus `read` when `replyToMessageId` is used;
3. the account exists;
4. provider scope or opt-in;
5. `requestId` validation;
6. full local validation of the caller payload;
7. key, fingerprint and account binding;
8. atomic claim under `mail-workflow.lock`:
   - new key: a `pending` record and a `pending` audit event are written in one atomic write;
   - same key, same fingerprint: replay of the stored record (audit `replayed`), with no reply lookup, recompose or resubmission;
   - same key, different fingerprint: audit `conflict`, then `idempotency_conflict`;
   - sender account binding changed: audit `denied/account_changed`, then `account_changed`;
   - ledger full: `ledger_full`.

After a new claim there is exactly **one** attempt:
1. Reply context is fetched (provider read). On failure the result is `rejected` / `not_submitted_reply_context`.
2. The message is composed. On failure: `rejected` / `not_submitted_compose`.
3. The store is re-read and the account binding re-checked. If the account changed: `rejected` / `not_submitted_account_changed`, nothing submitted.
4. One `provider.send`. Adapter `PerchError` (thrown only before the transport: scope, token, size, validation) → `rejected` / `not_submitted_provider_precheck`. Any other throw → `indeterminate` / `adapter_error`. Otherwise the adapter's accepted/rejected/indeterminate.
5. Finalize, only by the claiming attempt (`attempt` token). If the outcome **cannot be persisted**, the response is `indeterminate` ("could not be recorded") and the durable `pending` record survives.

**Status and restart semantics:**
- A record still `pending` (crash, kill, hang, finalization failure) is reported as `status: "indeterminate", requestState: "pending"` to every later replay or status call, **forever**. It is never resent.
- Only the local admin can add a human-verified note: `perch mail-workflow resolve <op> --outcome sent|not-sent`. This never sends and never frees the key.
- `rejected` and `indeterminate` are terminal and never retried. `accepted` ≠ delivered.

**Identity binding:** HMAC over kind, id, lowercase address, `createdAt`, plus:
- Gmail: OAuth client id;
- Graph: client id and tenant;
- IMAP: username, password, IMAP/SMTP host, port and security.

Rotating OAuth refresh tokens are deliberately excluded, otherwise a refresh would invalidate the binding. A changed binding fails closed for new attempts, replays and status reads.

**Re-validation before revealing:** replays and `mail_send_status` re-check the current grant (`send` on the account, plus `read` for replies), the account, the provider send scope (replay **and** status) and the binding **before** anything stored is revealed. Revoked or narrowed grants and removed users fail in the runner, before the service is called, and again inside the service (below). The status view is minimal (state, fixed detail, operation id, opaque provider id, timestamps) and contains no reply-derived data, so status needs `send` but not `read`.

**`MailService` is its own authorization boundary (repair 1).** A passed-in `Principal` is never trusted:
- every public method (`listAccounts`, `search`, `read`, `getAttachment`, `createDraft`, `send`, `sendStatus`) first runs the namespace guard and re-resolves the client grant from the store (`currentPrincipal`: same client id and token hash). A revoked, replaced or narrowed grant fails closed on direct service calls too, so a stale principal cannot replay, read status, read mail or draft;
- the namespace guard is passed by `NamespaceRouter` into every user context (`ContextFactory(store, guard)` → `createPerchContext(..., guard)` → `MailService`): user still active, namespace paths/key/store intact, and still served by this context. The root namespace has no user to deactivate;
- a claimed send re-checks guard + stored grant + `send` (+ `read` for replies) before the reply lookup and **again immediately before `provider.send`** (after the reply lookup and composing). Then the sender binding and the provider send scope of the account as stored now. A failure there is final `rejected` with reason `not_submitted_authorization` (or `not_submitted_account_changed` / `not_submitted_provider_precheck`); the key stays used and restoring the grant does not resend;
- `createDraft` re-checks the same way after its reply lookup, before the provider draft write, including the **full sender binding** (repair 2: kind, id, address, `createdAt`, OAuth client/tenant, IMAP username, password, IMAP/SMTP hosts, ports and security), not just kind and address; a substituted credential or server during the lookup fails `account_changed` with no draft write.
- Known window: a revocation that lands after that final check, while the provider call is in flight, cannot be recalled.

**Isolation:**
- Every namespace has its own ledger file and subkeys.
- Keys additionally bind namespace, actor (client id) and account.
- Another client, user or account therefore never finds someone else's record (`unknown_request`), even with colliding account ids, grant ids and request ids (tested).

**Provider-native idempotency (limitation, not promised away):**
- Gmail `users.messages.send`, Graph `sendMail` and SMTP offer no idempotency key. This ledger is Perch's only duplicate protection.
- It cannot see messages sent outside Perch, by another Perch installation, or with a different `requestId`.
- After `indeterminate`, a human must check the Sent folder.
- Perch does not set a deterministic `Message-ID`, so Sent-folder matching is by time, recipients and subject.

**Concurrency choice:** a durable cross-process claim with bounded lock waits (15 s wait; locks older than 60 s fail closed with the manual `rm -r` hint, never auto-takeover) instead of holding a lock across the network. A stale lock blocks sends (and audited tool calls) until the admin removes it with no Perch process running. There is no blind cleanup that could allow a duplicate.

## 5. Audit trail and exact coverage

**Fields** (strict schema, allowlist):
- `at`, `ns` (namespace), `actor` (`operator_readonly` | `client` + `clientId` | `local_admin`);
- `operationId`, `type` (tool or operation name);
- `accountId` and `provider` (`drive|notion|gmail|microsoft|imap|google_productivity`), only when the argument has Perch's own generated id shape;
- `outcome`, from a fixed enum;
- `code`: a Perch error code or fixed reason.

**Never recorded:**
- arguments or results, queries;
- message, file, event or attachment ids, filenames, bytes;
- subjects, bodies, recipients, addresses, labels;
- tokens, request ids, provider error text.

**Covered:**

| What | Where | Events |
| --- | --- | --- |
| every MCP tool call that passes the namespace guard: Drive, Notion, Calendar/Contacts read, `perch_list_accounts` | shared tool runner (`src/mcp/server.ts`) | one event after the call: `ok`, or `denied`/`invalid`/`error` + code |
| `calendar_create_event`, `calendar_update_event` | shared tool runner | `attempt` **durably before** the provider call (fail closed), then `ok` or error (same `operationId`) |
| mail reads and status, **direct or via MCP**: `MailService.read` (`mail_read_message`), `getAttachment` (`mail_get_attachment`), `search` (`mail_search`), `listAccounts` (`mail_list_accounts`), `sendStatus` (`mail_send_status`) | `MailService` itself (repair 2); the runner does not record these tools again | one event after the call: `ok`, or `denied`/`invalid`/`error` + code; a result whose event cannot be written is withheld (`audit_unavailable`). `perch_list_accounts` produces its own runner event plus the service's `mail_list_accounts` event (two different operations) |
| `MailService.createDraft` (`mail_create_draft`), **direct or via MCP** | `MailService` itself (repair 2) | `attempt` **durably before** any provider I/O (reply lookup or draft write; missing/corrupt/full/locked ledger → nothing written), then `ok` or error (same `operationId`) |
| `mail_send` | the send workflow (`MailService.send`), atomically with the ledger record; the runner skips it (no duplicates) | pre-claim failures (`denied`/`invalid`/`error`), `pending`, then `accepted`/`rejected`/`indeterminate` + reason, `replayed` + state, `conflict` |
| grant revoked/replaced | shared tool runner (MCP) or `MailService` (direct) | `denied/grant_revoked` (exactly one event per call) |
| `perch mail-workflow resolve` | CLI | `resolved` (actor `local_admin`, code `sent`/`not_sent`). (`pruned` stays in the outcome enum for schema stability; nothing writes it any more.) |

**Fail closed:**
- A write whose `attempt` cannot be persisted is not executed.
- A read whose outcome event cannot be persisted returns an error instead of its result: "result was withheld ... (code)". Its provider read may already have happened.
- After a completed draft or calendar write, a failure to record `ok` is reported on stderr with a fixed text; the result is still returned, and the `attempt` event exists.

**Not covered (limits):**
- calls rejected by the MCP SDK's input-schema validation (they never reach Perch code);
- calls rejected by the namespace guard (removed user, damaged namespace), deliberately, because that namespace must not be written to;
- HTTP 401/403/503 at the transport (never reach a tool);
- local admin CLI actions other than resolve (account onboarding, client grants, user admin);
- direct library calls to the non-mail providers (Drive, Notion, Calendar, Contacts) outside MCP: only their MCP tools are audited. All `MailService` methods are audited at the service (repair 2);
- events beyond the 2000-event ring (counted, not kept).

**Inspection:** local only, per namespace (`PERCH_USER` selects), via `perch audit list [--limit N] [--client ID] [--account ID]`. There is **no MCP audit tool**: user read-only tokens and other clients cannot read audit events, and no grant family was expanded. `mail_send_status` is the only MCP read of workflow state. It is bound to the caller's own client id, account and `send` capability and is registered only for send grants (never for the global token or read-only tokens).

## 6. CLI

```bash
perch audit list [--limit N] [--client client-…] [--account imap-…]   # body-free events, oldest first
perch mail-workflow list [--state pending|accepted|rejected|indeterminate]
perch mail-workflow resolve op-<24 hex> --outcome sent|not-sent       # after checking the Sent folder; never sends
perch mail-workflow prune ...                                          # REFUSED (prune_unsupported): used requestIds are never forgotten
perch mail-workflow init                                               # only for stores created before this version; refuses if the namespace ever had a ledger
PERCH_USER=user-… perch audit list                                     # a user's namespace
```

`perch init` prints the ledger state; on an existing store with a missing ledger it says so and does **not** recreate it.

## 7. Test strategy (MOCK only)

| File | Covers |
| --- | --- |
| `test/mailWorkflowLedger.test.ts` (13) | created by `initStore`, `0600`, envelope only, subkey ≠ store key; persistence across instances; concurrent instances (no lost update); missing → fail closed, explicit init exclusive; garbage/tampered/future/foreign-key/store-swapped/empty → fail closed, bytes unchanged; validly encrypted wrong namespace/version; symlink, `0640`, oversize, directory; key missing/replaced; stale lock kept and not taken over; send cap (`ledger_full`) and audit ring; unsafe fields (newline type, long code, address as account, extra field, `<id@host>` provider id) refused before writing; write failure leaves the previous ledger; domain-separated, length-prefixed, namespace-bound MACs |
| `test/mailWorkflow.test.ts` (17) | requestId validation (8 cases) before I/O, audited `invalid`; pending persisted before the attempt; replay without reply lookup or recompose; 8 concurrent duplicates → 1 send; 4 service and store instances × 2 → 1 send; 7 changed-payload variants → conflict, no I/O; provider rejected (network loss before acceptance) terminal; indeterminate (lost response after acceptance) terminal; adapter crash → indeterminate, pre-submission `PerchError` → rejected; finalization write failure → indeterminate, pending survives restart; hanging attempt + restarted instance → pending, no resend; account replaced between claim and send → rejected, no send; replay/status after identity change → `account_changed`; narrowed/revoked grant and withdrawn provider opt-in block cached results; other client `unknown_request`, second namespace with colliding account, grant and request ids uses only its own provider; no body, subject, recipient, attachment, requestId, label, address, password or provider-text markers in the decrypted ledger; provider id sanitising; full ledger → no I/O; missing/corrupt ledger → no I/O |
| `test/mailWorkflowConcurrency.test.ts` (2) | compiled sources in **real subprocesses**: 3 rounds × 6 concurrent processes with one key → exactly one attempt per round; a process `SIGKILL`ed after its claim leaves `pending`; two restarted processes replay `indeterminate/pending`, still one attempt, no lock left |
| `test/auditMcp.test.ts` (7) | real MCP SDK client: `requestId` required in the schema and validated; `mail_send_status` only for send grants, never for the operator; replay/conflict/status over MCP; another client's status invisible; narrowing/revocation deny replay and status before I/O; exact audit sequence for list/search/drive/read/attachment/draft/send/replay/conflict/status/denied with allowlisted keys only; no markers (body, subject, recipients, attachment, query, message id, labels, addresses, token, dummy secrets) in the decrypted ledger; corrupt ledger → draft and send not executed, read withheld; cross-user colliding ids/grant id/request id → one SMTP send per world, per-namespace audit, nothing in root; Calendar write `attempt`+`ok` and read audited in the owner namespace without summary or request id |
| `test/auditCli.test.ts` (6) | `perch audit list` safe output and filters, bad filter values → usage; `mail-workflow list` (not-delivered note, state filter); `resolve` (bad args, double resolve, accepted refused, unknown op, replay afterwards shows `manualResolution` and sends nothing, audited as `local_admin`); `prune` keeps unresolved pending; `init` refuses existing, missing ledger fails, `perch init` does not recreate; `PERCH_USER` scoping |
| `test/mailServiceAudit.test.ts` (11, repair 2) | direct (non-MCP) `MailService` calls: exact body-free event per read/attachment/search/account list/draft (`attempt`+`ok`)/send/status with no message id, attachment id, query, draft id, address, label or requestId in the decrypted ledger; denied/invalid direct reads with fixed codes; read withheld and status refused without a ledger; draft with corrupt or missing ledger (also a reply) → no provider I/O; draft refused when the IMAP password, IMAP host or account `createdAt` is substituted during the reply lookup; send refused (no claim, no I/O) when a missing marker cannot be persisted, also after an earlier successful write by the same instance; unmarked existing ledger is marked before its first write so `init` refuses after a loss; a missing unmarked ledger is not marked |
| `test/smoke/built.test.ts` (+1, now 10) | built CLI under the offline guard: `mail_send` schema requires `requestId`; a pending record claimed by an interrupted attempt is replayed by the built stdio server as unknown; conflict, missing key and bad recipient fail without I/O; status over stdio; another client over HTTP cannot see it; the global token has no status tool; `mail-workflow list/resolve` and `audit list` children; no markers in the decrypted ledger, child stderr or CLI output; zero network attempts |

Existing tests changed only for the intentional contract:
- a `requestId` was added to send calls in `mailService`, `mailMcp`, `userIsolation` and smoke;
- `mail_send_status` was added to four exact tool lists;
- repair 2: `auditMcp` expects one additional `mail_list_accounts` row (service event inside `perch_list_accounts`) and its operation-id index assertions moved by one.

No authorisation assertion was removed or relaxed. The offline guard was **strengthened** (§8).

## 8. TDD evidence (RED → GREEN)

All commands ran in `/home/hermes/perch-audit-work` with `TMPDIR=/home/hermes/.hermes/cache/scratch` (host Node 26.7.0 unless stated). Baseline before the milestone: `npx vitest run` → **468/468** (39 files).

| # | Slice | RED (command → observed) | GREEN |
| --- | --- | --- | --- |
| 1 | Encrypted ledger | `npx vitest run test/mailWorkflowLedger.test.ts` → `Cannot find module '../src/mail/workflowLedger.js'` | **13/13**; full suite 481/481 |
| 2 | Idempotent send in `MailService` | `npx vitest run test/mailWorkflow.test.ts` → **17 failed / 17**: the old route sent duplicates (`expected [...] to have a length of 1 but got 8`, same instance and across instances), no pending record (`expected [] to deeply equal ['pending']`), invalid request ids accepted | **17/17** after one production fix in GREEN (live `accepted` detail forced to the fixed not-delivered note) |
| 3 | Cross-process claim | written after slice 2 (implementation existed), proven by **mutation M1** | **2/2** |
| 4 | MCP schema, status tool, shared audit runner | `npx vitest run test/auditMcp.test.ts` → **7 failed / 7**: no `mail_send_status`, `requestId` stripped by the schema, no audit events, read not withheld | **7/7** after one test-assumption fix (`unknown_account` is classified `denied`; no production change) |
| 5 | CLI | `npx vitest run test/auditCli.test.ts` → **6 failed / 6** (`init` printed no ledger line; commands unknown) | **6/6** after one test-timing fix (the seed helper also waits for the hanging attempt, since pending is persisted before it) |
| 6 | Built-artifact smoke | written after GREEN, proven by **mutation M2** | **10/10** |
| R2 | Repair 2: direct `MailService` audit, draft sender binding, durable marker | `npx vitest run test/mailServiceAudit.test.ts` → **9 failed / 11** (direct read/attachment/search/list/draft/status recorded no event; draft written with corrupt/missing ledger; draft sent after password/host/`createdAt` substitution; send claimed and submitted although the marker could not be persisted, also after a cached earlier mark). The 2 "marker" guard tests (backfill before the first write, missing ledger not marked) passed before and after. Then per slice: binding → 3/3, marker → 4/4, audit → 11/11. One own-test expectation fixed before GREEN: a withheld direct read reports `audit_unavailable` (as over MCP), not `ledger_missing`. Full suite then: `auditMcp` 1 failed (extra `mail_list_accounts` row), expectation extended, 7/7 | **11/11**; 539/539 |

**Mutation probes.** Each mutation was applied to one file, the named tests were run, and the file was restored from a copy and checked SHA-256-identical. After M2, `dist` was rebuilt clean.

| # | Mutation | Result |
| --- | --- | --- |
| M1 | ledger `transact` without the cross-process `withFileLock` (`src/mail/workflowLedger.ts`) | `mailWorkflowConcurrency` round 0: `expected [...] to have a length of 1 but got 6` (**6 duplicate sends**); ledger lost-update and stale-lock tests failed |
| M2 | claim never replays (`src/mail/workflow.ts`) | unit: 9 failed. Smoke, **first run**: the replay test failed, but the zero-attempt test **passed**. Cause: nodemailer resolves with its own `dns.Resolver` (`resolve4`/`resolve6`) and `dns.lookup` before connecting, which the guard did not cover. The mutated built child sent DNS queries for the reserved non-existent name `smtp.invalid.example` to the system resolver: DNS only, no socket connection, credential or message content. The test-only guard was hardened to block and log every `node:dns` API (callback, promises, `Resolver`; IP-literal lookups such as the `127.0.0.1` bind address are passed through), and the probe child now proves DNS blocking too. **Rerun:** the guard logged `resolve4`/`resolve6`/`lookup smtp.invalid.example` in-process and the zero-attempt test failed as intended. |
| M3 | runner without the pre-write `attempt` record (`src/mcp/server.ts`) | `auditMcp` 3 failed (sequence, fail-closed draft, Calendar attempt) |
| M4 | `sendStatus` without the capability check (`src/mail/service.ts`) | 2 failed (narrowed status over MCP and service) |
| M5 | finalization failure reported as the provider result (`src/mail/service.ts`) | `mailWorkflow` 1 failed (could-not-be-recorded / pending survives) |

### Final checks (2026-10-05)

After repair 2 (logs `$TMPDIR/perch-audit-repair2-*.log`):
- Host Node **26.7.0**: `npm run check` exit 0: typecheck/build clean, `npm test` **539/539** (46 files; 468 before the milestone), smoke **10/10** (9 before).
- Portable Node **22.12.0** (`PATH=/home/hermes/.hermes/cache/scratch/nodes/node-v22.12.0-linux-x64/bin:$PATH`, host and `engines` unchanged): `npm run check` exit 0: **539/539**, smoke **10/10**.
- The orchestrator's 10 independent probes (`perch-audit-independent-probes.mjs`, unmodified, importing the compiled `dist`, including the still-exported refusing `pruneSends`) on Node 22.12.0 with `--import ./test/smoke/offlineGuard.mjs`: **10/10 PASS**, exit 0, guard log **0** attempts; guard positive control logged the blocked `fetch` and `dns lookup`.
- `npm audit --omit=dev`: 0 vulnerabilities. `git diff HEAD --check`: clean.
- All test temp directories were in `$TMPDIR` scratch (none in `/tmp`). No real account, OAuth flow, provider call or send. Network: zero attempts in the final smoke runs. The only escape was the M2 DNS lookup described above.

## 9. Known limitations and exact remaining scope

- **Not live-verified.** Provider behaviour (Gmail/Graph acceptance vs delivery, SMTP partial acceptance) is as documented in `EMAIL_MILESTONE.md`, mock-tested only.
- **Pending is forever:** after a crash between claim and finalization, the key stays `pending` (unknown) until the admin records a verified outcome. It is never resent. A new `requestId` sends a new message.
- **Ledger full:**
  - At 1000 send records per namespace, new sends fail closed (`ledger_full`). **There is no prune**: forgetting keys would allow duplicates, so `perch mail-workflow prune` and `pruneSends` refuse (`prune_unsupported`). A durable rollover (e.g. compact tombstones in a bounded archive) is open design work; until then a namespace that reaches 1000 sends cannot send again. Reads, drafts and status are unaffected.
  - Audit is a ring of 2000 events; older events are dropped and counted.
- **Upgrade step:** namespaces created before this version have no ledger. Every audited tool call and every send then fails closed (`ledger_missing`) until the admin runs `perch mail-workflow init` once per namespace (`PERCH_USER=<id>` for users). A namespace that ever had a ledger (initialised marker in `store.enc`) is refused: only a backup restore helps.
- **Availability:** a corrupt or missing ledger, stale lock or write failure blocks audited tool calls of that namespace (fail closed). The global-token and HTTP routing semantics of the user-isolation milestone are unchanged.
- **Cost:** every tool call does one locked read-decrypt-encrypt-write of the namespace ledger (≤ 2 MiB plaintext) with `fsync`.
- **Same-uid tampering:** the host admin (or any process as the Perch uid) can read, delete or replace the ledger and key. Deleting the ledger makes Perch fail closed; restoring an **old** backup reintroduces forgotten keys (possible duplicates for retried old request ids).
- **No deterministic Message-ID**, no provider-side duplicate detection (§4).
- **Not part of this milestone (still pending, `PHASE1_REMAINING.md`):**
  - Docker/compose, backup/restore and migrations (operations sibling, not yet combined);
  - WhatsApp;
  - live validation;
  - integration with the licence branch (PR #3) and the operations sibling into a reviewed combined release.
