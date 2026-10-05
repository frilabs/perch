# User ownership and isolation milestone (admin-provisioned users)

As of 2026-10-05. Delivery branch `feat/perch-user-isolation`, based on the verified Calendar/Contacts commit `acc3eeb` (PR4). Independently tested and review-approved; GitHub is the authority for publication/merge state. Fritz authorised this expanded phase-1 increment on 2026-10-05 via the orchestrator.

**Status:** implemented and locally tested against **MOCK** upstreams only. **Not live-verified.** This is **not** hosted multi-tenant hardening and **not** phase-1 completion (see §8).

## 1. Scope

In scope:
- local, admin-only user provisioning (`perch user add|list|remove`);
- a physically separate encrypted store and key per user;
- a separate context (store, upstream, access-token caches, mail providers) per user;
- per-user read-only token and per-user client grants;
- resolution of every credential to exactly one namespace before provider I/O;
- the trusted local selector `PERCH_USER`;
- revocation on every HTTP request and every tool call;
- namespace-bound cursors.

Out of scope (unchanged, still pending):
- public signup or self-service;
- audit log and the idempotent send workflow;
- containers, backup/restore and migrations;
- WhatsApp;
- live validation;
- deployment;
- hosted production multi-tenancy.

## 2. Namespace model

| Namespace | Store | Key | Selected by |
| --- | --- | --- | --- |
| root (local operator) | `$PERCH_DATA_DIR/store.enc` (unchanged) | `$PERCH_KEY_FILE` (unchanged) | global HTTP token, root client grants, stdio without `PERCH_USER` |
| user `user-<16 hex>` | `$PERCH_DATA_DIR/users/<id>/store.enc` | `<dir of PERCH_KEY_FILE>/user-keys/<id>.key` (outside the data dir, checked) | that user's read-only token, that user's client grants, `PERCH_USER=<id>` locally |

**Registry.** The root store gains a section `users` (default `[]`, so older stores open unchanged and are not rewritten by opening). Each entry holds:
- `id`, `label`, `status` (`active`/`removed`), `createdAt`, `removedAt`;
- `readTokenSha256`: only the hash of the user's read-only token.

Existing root accounts keep their ownership. Nothing is moved, and there is no automatic migration. An unknown store version is refused and never overwritten.

**Paths.**
- Paths are derived only from a generated, pattern-checked id (`^user-[a-f0-9]{16}$`), never from caller input. Traversal-shaped ids are refused before any filesystem access.
- Opening a user store never creates anything. Every one of these fails closed and is never re-initialised:
  - the `users/` directory, the user directory or the `user-keys/` directory is missing, a symlink, foreign-owned or group/other-accessible (existing `secureFs` checks);
  - the key or store is missing, symlinked or corrupt;
  - the key belongs to another user;
  - the user store itself contains a registry.
- A cached user context is re-validated on every use: on every HTTP resolution **and before every tool call of a user session (HTTP and persistent stdio)**. The check repeats the directory invariants above (private, non-symlinked `users/`, user and `user-keys/` directories, containment), re-reads the key file (missing, symlinked or changed → fail) and the store (corrupt or symlinked → fail). A failed check never re-creates anything; the cached context keeps failing until the files are restored or the user is removed.

**Cap.** At most **100** registry entries. Removed users count, because ids are never reused and entries are never deleted.

**Contexts.**
- One `PerchContext` per namespace: own `CredentialStore`, own `Upstream`, own Google/Gmail/Microsoft/productivity token providers (access-token caches) and own mail providers. Colliding account ids in different namespaces therefore never share credentials or cached tokens.
- Contexts are kept warm. **Membership is not cached:** it is re-read from the root registry on every request and every tool call.

**Powers.**

| Who | Can |
| --- | --- |
| Local admin (host account with the root key and `user-keys/`) | everything: provision/remove users, select any namespace with `PERCH_USER`, read every key. This is the legitimate privileged boundary. Perch does **not** protect users from the host admin. |
| User read-only token (remote) | all read-only tools (Drive, Notion, mail, Calendar/Contacts) for the accounts in **its own** namespace; no writes |
| User client grant (remote) | exactly the capabilities/accounts of that grant in its own namespace (mail grants mail-only, `gprod` grants Calendar/Contacts-only, as before) |
| Global HTTP token / root client grants | root namespace only, unchanged (operator read-only, grants as before) |

## 3. Resolution and revalidation

**HTTP** (`perch serve --http`) routes all users through one server. The host/origin/bearer checks, the loopback default and the bind-address rules are unchanged.

For each request:
1. **Global token:** constant-time compare. Root read-only operator, unless its hash also appears as a user read-only token (active **or removed**), a root client grant or a client grant in any **active** user's store; then the request is rejected as ambiguous (401 plus a log line), never treated as root. Proving that requires opening every active user store, so a damaged active namespace makes the global token answer **503** as well (see §8).
2. **Any other token:** looked up by SHA-256 among root client grants, active users' read-only token hashes and active users' client grants.
   - Exactly one match: that namespace's context and principal.
   - No match: 401.
   - More than one match: 401 plus a log line. Perch never chooses.
   - An active user's namespace that cannot be opened: **503 for all bearer tokens, the global token included** (fail closed, no guessing) until the files are restored or the user is removed. Removed users are skipped.
   - A user only contributes a match after its namespace opened successfully, so a user removed between the registry read and opening its store resolves to nothing (401), never to a session without a context.
3. There is **no** user header, query or route. A user id is not a credential.

**Revalidation.**
- Every tool call (HTTP and persistent stdio, including `perch_list_accounts`) first runs the namespace guard. It checks that the user is still active, for the user's read-only token that the stored hash is unchanged, and then runs the full namespace re-validation of §2 (paths, key, store) and that the session is still bound to the cached context. The root operator session has no guard and is unchanged.
- Then the existing client-grant re-read runs, so narrowing and `perch client remove` still apply.
- Both happen before any provider I/O. This covers `perch_list_accounts`, Drive/Notion, mail read/draft/send and Calendar create/update.

**stdio.**
- `PERCH_USER=<id> perch serve --stdio` is the user's read-only session.
- `PERCH_CLIENT_TOKEN_FILE` must resolve to a grant of exactly the selected namespace (root when `PERCH_USER` is unset), otherwise the server refuses to start.
- A malformed or empty `PERCH_USER` is an error, never a fallback to root.
- In user mode these are refused: `init`, `token`, `user …` (no nested user administration) and `serve --http`.

**Cursors.**
- Every opaque cursor is sealed with an HMAC keyed per namespace store (subkey `HMAC(store key, "perch-cursor-v1" ‖ namespace)`) and bound to its kind:
  - fan-out cursors of Drive, Notion search, mail, calendars, events and contacts;
  - Notion block-children cursors, bound to workspace and parent block;
  - Notion data-source query cursors, bound to workspace and data source.
- A cursor from another namespace (even with identical account ids), from another query/parent, or edited by hand fails with `bad_cursor` before provider I/O.
- Cursors issued before this milestone are no longer accepted: restart pagination.

## 4. CLI

```bash
perch user add --label "Alice" [--token-file PATH]   # default token file: <dir of PERCH_HTTP_TOKEN_FILE>/users/<id>.token (0600)
perch user list
perch user remove user-0123456789abcdef              # disables membership; store and key are kept; id never reused
PERCH_USER=user-0123456789abcdef perch imap add --label GMX --email alice@gmx.at
PERCH_USER=user-0123456789abcdef perch client add --label Laptop --allow read,send --account imap-1a2b3c4d
PERCH_USER=user-0123456789abcdef perch serve --stdio
```

The token is written once to a new `0600` file (never overwritten, never printed). Setup instructions: `docs/SETUP.md` §4c.

## 5. Test strategy and labels

All upstreams are MOCK (`test/support/namespaceFixtures.ts`).
- Each namespace (root, A, B) gets its own fake "world": Drive, Notion, Gmail, Graph, IMAP sessions plus SMTP sender, and Calendar/Contacts.
- Each store is seeded with the **same** account ids (`google-0000000a`, `notion-0000000a`, `gmail-0000000a`, `microsoft-0000000a`, `imap-0000000a`, `gprod-0000000a`) bound to that world's dummy credentials.
- Every upstream request is logged with the tag of the world that received it. Tests assert which namespace's credentials an operation used, and that denied operations caused **zero** provider requests.
- Real MCP SDK clients run over local HTTP and over a persistent in-memory session (the stdio code path).
- The built-artifact smoke runs every child process under the existing test-only offline guard (`--import`). The probe proves the guard active before anything else, and the last test asserts zero attempts.

| File | Covers |
| --- | --- |
| `test/userRegistry.test.ts` (17) | provisioning; paths and key outside the data dir; only the hash stored; removal keeps files; no id reuse; cap; token-file no-overwrite; nested admin refused; registry inside a user store refused; traversal/malformed ids; missing/corrupt/wrong/symlinked key, store, user dir, `users/`, `user-keys/` and never-created namespaces fail closed without re-init; old root store opens unchanged; unknown version not overwritten |
| `test/cursorBinding.test.ts` (3) | colliding-id stores reject each other's fan-out and Notion cursors before I/O; tampered and unsigned (pre-milestone) cursors; parent binding |
| `test/userIsolation.test.ts` (19) | per-namespace listing with colliding ids; Drive search/read/download, Notion search/content, mail search/read/attachments (Gmail, Graph, IMAP), Calendar list/get, Contacts list/get all use only the caller's world; separate token caches; cross-namespace and forged cursors (Drive search/list, Notion children/page content, events, contacts) fail without I/O for the other user and for root; another namespace's account ids are unknown, without I/O or metadata, for the other user and the global token; user client grants: mail draft/send (IMAP, Gmail) and Calendar create/update only in the owner's world, mail-only and Calendar-only families kept; root client grant root-only; user removal fails HTTP (401) and the next call of persistent read-only/mail/Calendar sessions before I/O; narrowing and revocation inside a user namespace; ambiguous hashes (user/user, user client/root client, global/user) → 401; damaged namespace → 503 without fallback, removal restores the others; unknown tokens and bare user ids select nothing; fix round: key missing / replaced / symlinked, store corrupt and namespace dir symlinked each fail `perch_list_accounts` and Drive/mail/Notion tools of persistent read-only-token, client-grant and `PERCH_USER` sessions before I/O while the user stays active, nothing re-created, root stdio still works, HTTP 503 for all tokens; global token equal to a user client token → 401 without I/O; user removed between registry read and namespace open → `null` |
| `test/userCli.test.ts` (6) | `perch user add/list/remove`; `PERCH_USER` onboarding/accounts/client grants per namespace; malformed/empty/unknown selectors leave the root store byte-identical; admin/global commands refused in user mode; stdio refuses a client token of another namespace |
| `test/smoke/built.test.ts` (+1, now 9) | built CLI: `user add`, colliding `imap-0000000a` per namespace, HTTP routing by token, `PERCH_USER` stdio listing, `perch user remove` against a running stdio session (next call fails before I/O), 401 over HTTP, bad selectors, zero network attempts |

## 6. TDD evidence (RED → GREEN)

Commands ran in `/home/hermes/perch-users-work` (host Node 26.7.0). Baseline before the milestone: `npm test` → **423/423** (35 files).

| # | Slice | RED (command → observed) | GREEN |
| --- | --- | --- | --- |
| 1 | Namespace-bound sealed cursors (fan-out and Notion raw cursors) | `npx vitest run test/cursorBinding.test.ts test/userRegistry.test.ts test/userIsolation.test.ts` → cursorBinding **2 failed / 1 passed**: Drive `expected the promise to reject` (store B **accepted store A's cursor** and fetched with B's credentials); Notion `expected 'Notion API request failed (HTTP 404, …' to match /cursor/i` (raw cursor sent upstream). The tampered/unsigned test already held through the query hash and stays as a guard | `npx vitest run test/cursorBinding.test.ts test/notion.test.ts test/drive.test.ts test/calendarRead.test.ts test/contactsRead.test.ts test/mailService.test.ts` → **64/64** |
| 2 | Registry, provisioning, fail-closed opening | same run → `Cannot find module '../src/users/registry.js'` (suite failed) | `npx vitest run test/userRegistry.test.ts` → **17/17** |
| 3 | Router (token → exactly one namespace), per-tool guard, HTTP routing | same run → `Cannot find module '../src/users/namespaces.js'` (suite failed) | `npx vitest run test/userIsolation.test.ts`: first **3 failed / 9 passed**, then **2 failed**. All were wrong test assumptions, fixed in the test or fixture with no production change in between: mail list field is `accountLabel`; Drive read returns `text`/`data`; the Calendar mock page size was 2 (fixture set to 10); a Drive read makes metadata + media requests (4 token presentations, not 2). Then **12/12**; full `npm test` **455/455** (38 files) |
| 4 | CLI `perch user …`, `PERCH_USER` selector, stdio namespace match | `npx vitest run test/userCli.test.ts` → **6 failed / 0 passed**, e.g. `Unknown command: user`, and an invalid `PERCH_USER` was **silently ignored** (the `imap add` landed in the root store) | **6/6**; with `cli`, `mailCli`, `productivityCli`, `userRegistry`: **47/47** |
| 5 | Built-artifact smoke (user add, HTTP routing, `PERCH_USER` stdio, removal against a running session) | Written after slice 4 was GREEN, so it is proven by **mutation** (M1 below). The offline-guard probe in `beforeAll` verified the guard active in a child before every smoke run, including the mutated one | **9/9** |

**Mutation probes.** Each mutation was applied to one file, run, and then restored from a copy. All four restored files were checked SHA-256-identical to the copies.

| # | Mutation | Command → result |
| --- | --- | --- |
| M1 | per-tool namespace guard removed (`src/mcp/server.ts`) | `npx vitest run test/userIsolation.test.ts` → **1 failed** (removed user, persistent session). `npm run smoke` → **2 failed / 7 passed**: `mail_search: expected false to be true`, and the zero-attempt test `expected [ { pid, kind: 'connect', target: 'imap.invalid.example:993' } ] to deeply equal []`. The removed user's stdio session got past authorization; the attempted IMAP connection was **blocked in-process by the offline guard** (the host is unresolvable anyway). No request left the machine |
| M2 | cursor MAC not checked (`src/store/credentialStore.ts`) | `npx vitest run test/cursorBinding.test.ts test/userIsolation.test.ts` → **4 failed / 11 passed** |
| M3 | ambiguous matches not refused (`src/users/namespaces.ts`) | `npx vitest run test/userIsolation.test.ts` → **1 failed** (ambiguous hashes) |
| M4 | HTTP ignores the router, legacy root-only lookup (`src/mcp/http.ts`) | `npx vitest run test/userIsolation.test.ts` → **9 failed / 3 passed** |

### Final checks (2026-10-05)

- Orchestrator independently ran `npm run check` after the review fixes on host Node **26.7.0**: typecheck/build clean, `npm test` **468/468** (39 files), smoke **9/9** (before fixes: 461 tests).
- Orchestrator independently repeated the full check on portable Node **22.12.0** (`PATH=/home/hermes/.hermes/cache/scratch/nodes/node-v22.12.0-linux-x64/bin:$PATH`; host and `engines` untouched): **468/468**, smoke **9/9**.
- The independent offline compiled-artifact probe caught both gaps before repairs (exit 1: global/user-client collision not detected; persistent read still allowed after deleting its user key). After repairs it exits 0: collision detected, read after key deletion denied, **zero external calls**.
- Fresh final independent security/correctness review passed with empty security/logic blocker arrays. Clarified the root-stdio availability exception below; an explicit maximum at the shared MCP cursor input schema remains a nonblocking hardening follow-up (the seal already bounds payload length).
- `npm audit --omit=dev`: 0 vulnerabilities. `git diff --check`: clean.
- All tests used private `mkdtemp` scratch directories; the real default Perch data and key directories were never touched.
- No real account, OAuth flow, send or provider call; zero network attempts in the smoke children.

## 7. Preserved behaviour

- `startHttpServer` without `namespaces` is the legacy root-only server, unchanged.
- `createMcpServer(ctx, principal)` defaults to no namespace guard.
- The global token and default stdio remain the root read-only operator.
- Root client grants, capability families and per-call grant revalidation are unchanged.
- All 423 pre-existing unit/integration tests pass unmodified. The 8 pre-existing smoke tests also pass unmodified; the smoke file only gained one test. The only behavioural change visible to existing clients is the cursor format (sealed; old cursors are rejected).

## 8. Known limitations and exact remaining scope

- **Not hosted multi-tenancy:**
  - one process serves all users;
  - no per-user rate limits or quotas;
  - one shared Google/Microsoft OAuth app configuration for all users;
  - the host admin can read every key. Do not expose this as a public or shared service.
- **Availability trade-off:** a damaged active user namespace makes **every** HTTP bearer token answer 503, including the global operator token (fail closed: the token's uniqueness against that store's client grants cannot be proven). Local root stdio (`perch serve --stdio` without either `PERCH_USER` or `PERCH_CLIENT_TOKEN_FILE`) is not affected. Starting root stdio with a client token still requires namespace-uniqueness resolution and fails closed if any active user namespace is damaged. Recovery: restore the files from backup or `perch user remove <id>`.
- **Re-validation cost:** every non-global HTTP request and every global-token request opens/re-validates all active user namespaces (up to 100; decrypted data is cached by file stamp), and every user tool call re-validates its own namespace.
- **Same-uid path swaps:** directory and key checks run before each use, but a process running as the Perch host user can still swap a path between check and use. That is within the trusted host-admin boundary, not defended.
- **Failed `perch user add`:** the token file (and possibly key/store) is written before the registry entry is saved. If the add fails, leftovers can never be resolved (no registry entry, ids are not reused), but the admin should delete the reported token file and any `users/<id>/` and `user-keys/<id>.key` without a matching `perch user list` entry.
- **Lifecycle commands missing:**
  - no user token rotation and no re-activation; removal is final for that id;
  - no destructive delete command: store and key stay on disk until the admin deletes or archives them;
  - a user who needs a new token is provisioned again (new id) and re-onboarded.
- **Running sessions:** the tool list of a running stdio session is not refreshed; calls fail closed instead.
- **Ids are not sealed:** message, file, event and attachment ids are not namespace-sealed. They only ever address the caller's own accounts, so an id from another namespace hits only the caller's own provider (as for any wrong id).
- **Not part of this milestone (still pending, see `docs/PHASE1_REMAINING.md`):**
  - body-free audit and the idempotent send workflow;
  - Docker/compose, backup/restore and migrations;
  - WhatsApp;
  - live validation with real accounts;
  - integration of the licence branch (PR #3) into a combined release.
