# Email connector milestone: Gmail, Microsoft Graph (Outlook.com / Microsoft 365), GMX / generic IMAP+SMTP

As of 2026-10-05, branch `feat/perch-email-connectors` (based on `50db560`).

**Approval:** Fritz explicitly approved the expanded `docs/PROJECT_SCOPE.md` and this follow-up through the orchestrator: email search, read, attachments, drafts and send for Gmail, Microsoft Graph and GMX/generic IMAP+SMTP. The read-only-only exclusions in `docs/BRIEFING.md` and `docs/SPEC.md` §10 are **superseded for this milestone only**. The Drive/Notion acceptance criteria in `docs/SPEC.md` remain in force unchanged.

**Verification status:** implemented and tested locally against **fake upstreams (MOCK)** and **local test servers** (real TLS handshakes, real SMTP via `smtp-server` on 127.0.0.1). **Nothing was verified live:** no real OAuth flow, no real Gmail/Graph/GMX account, no real message sent. Nothing was deployed, committed or pushed by this run.

## 1. Scope of this milestone

| Area | Implemented |
| --- | --- |
| Gmail | separate OAuth grant per account (Desktop client, loopback + PKCE); default `gmail.readonly`; explicit opt-ins `--allow-send` (`gmail.send`) and `--allow-drafts` (`gmail.compose`); search, read, attachments, create drafts, send |
| Microsoft Graph | delegated auth code flow + PKCE on a loopback redirect (public client, no secret); default `offline_access User.Read Mail.Read`; opt-ins `Mail.ReadWrite` (drafts) and `Mail.Send` (send); search, read, attachments, create drafts (MIME), send (MIME) |
| GMX / generic IMAP+SMTP | IMAP via `imapflow` (implicit TLS only), SMTP via `nodemailer` (implicit TLS or STARTTLS with `requireTLS`), TLS ≥ 1.2 with mandatory certificate validation; GMX presets; masked password onboarding (never argv); read-only mailbox locks; UIDVALIDITY-bound ids; drafts via APPEND to `\Drafts`; send via SMTP |
| Authorization | global HTTP token and default stdio remain the **read-only operator** (all Drive/Notion/mail read tools, unchanged); explicit **local per-client grants** are **mail-only** and bound to named mail account ids, with read/draft/send capabilities; the grant is re-checked from the store before every tool call; provider scopes/opt-ins are checked in addition |
| Not implemented | multi-user isolation, Calendar/Contacts, WhatsApp, Sent-copy after SMTP send, deleting/moving/flagging mail, sending existing drafts, live verification |

## 2. Authorization model (single operator, per-client grants)

- **Principals:**
  - **Operator (read-only):** the global HTTP bearer token, and `perch serve --stdio` without a client token. This keeps the earlier behaviour: every read-only Drive, Notion and mail tool, for all connected accounts, and `perch_list_accounts` with Google, Notion and mail metadata. The tools `mail_create_draft` and `mail_send` are **not registered** on such a connection, and the service layer denies them anyway.
  - **Client grant** (`perch client add --label L --allow read,draft,send --account ID ...`): a random 256-bit token, written once to a new `0600` file and never printed. The encrypted store keeps only its SHA-256. Over HTTP it is presented as `Authorization: Bearer <token>`. Over stdio, `PERCH_CLIENT_TOKEN_FILE=<file>` selects the grant.
- **Client grants are mail-only and least-privilege:**
  - **No Drive or Notion tools**, and no Drive/Notion metadata: `perch_list_accounts` returns only `mail` and `connection` (no `google`/`notion` keys).
  - **Only the named accounts** are visible: `perch_list_accounts`, `mail_search` and every other mail tool see the grant's account ids only. Other accounts' ids, labels and addresses are never returned.
  - **No existence oracle:** for a client, an ungranted account id and a nonexistent one both fail with the same `capability_denied`.
  - **Tools by capability:** `mail_search`/`mail_read_message`/`mail_get_attachment` only with `read`, `mail_create_draft` only with `draft`, `mail_send` only with `send`.
- **Revocation and narrowing apply to running connections.** Before **every** tool invocation (including `perch_list_accounts` and the read tools), the client grant is resolved again from the store by grant id **and** token hash.
  - If `perch client remove` deleted it (or it was replaced), the call fails with `grant_revoked` before any provider call.
  - If capabilities or account ids were narrowed, the call is checked against the current grant (`capability_denied`).
  - This holds for long-lived stdio sessions as well as HTTP. HTTP additionally re-authenticates every POST, so a removed token gets `401`.
  - The tool list of an already-connected stdio session is not refreshed; tools that are no longer granted remain listed but fail closed.
- **Checks per mail operation, in this order, before any provider I/O:**
  1. the principal holds the capability (`read`/`draft`/`send`) for that account id. `replyToMessageId` reads the original message, so draft/send with `replyToMessageId` also needs **`read`** on that account;
  2. the account exists;
  3. the stored provider grant allows it: Gmail `gmail.compose` for drafts and `gmail.send`/`gmail.compose` for send; Graph `Mail.ReadWrite` for drafts and `Mail.Send` for send; IMAP `allowDrafts`/`allowSend` opt-ins recorded at onboarding.
- **Defence in depth:** draft and send HTTP routes in the upstream allowlist carry a capability tag and are only reachable when the caller passes the same tag.
- **HTTP body limit:** 1 MiB as before. Only for authenticated principals with draft/send it rises to 16 MiB, for inline attachments.
- **Honest limitation:** this is **not** multi-user isolation. Every principal acts for the one operator who owns the credential store. Client grants narrow what a client may do; they do not separate users. Do not deploy Perch as a shared multi-user service.

## 3. MCP tools (new)

| Tool | Registered for | Purpose |
| --- | --- | --- |
| `mail_search` | operator; client grants with `read` | search one or all readable mail accounts (fan-out with per-account cursor, `partial`/`errors[]`); provenance `accountId`, `accountLabel`, `provider` |
| `mail_read_message` | operator; client grants with `read` | headers, threading ids, text body bounded by `maxBytes` (`truncated` flag; HTML-only → text via a bounded linear scanner), attachment metadata |
| `mail_get_attachment` | operator; client grants with `read` | one attachment as base64, refused (never truncated) above `maxBytes` |
| `mail_create_draft` | client grants with `draft` | create a draft in the chosen account |
| `mail_send` | client grants with `send` | send from the explicitly chosen account; result `accepted` / `rejected` / `indeterminate` |

**Update (mail workflow milestone, `docs/MAIL_WORKFLOW_MILESTONE.md`):** `mail_send` now requires an idempotency `requestId` and goes through the durable send ledger. Same key and same payload is sent at most once; a different payload fails. The new `mail_send_status` tool (send grants only) reports a client's own sends. Every tool call is audited without content.

`perch_list_accounts` is registered for everyone. For the operator it returns `google[]`, `notion[]`, `mail[]` (all accounts) and `connection`. For a client grant it returns only `mail[]` (the granted accounts) and `connection` (principal kind, client id/label, capabilities). Drive and Notion tools are registered for the operator only.

## 4. Outbound mail rules (all providers)

- **Explicit sender:** `accountId` is required. `from`, if given, must equal the account address. The From header is always the stored account address.
- **One MIME builder** (`src/mail/compose.ts`, nodemailer MailComposer with file/URL access disabled), used for every provider:
  - **Header injection denied:** CR/LF/control characters are rejected in every header-bound field. Each recipient entry is exactly one mailbox. Message-IDs must match `<id@host>`. Non-ASCII subjects are RFC 2047-encoded.
  - **Limits:** at most 100 recipients; body ≤ 1 MiB; at most 10 attachments with ≤ 10 MiB decoded in total.
  - **Attachments** are inline base64 only. Fields such as `path`/`href` are rejected, so there are no file paths or URLs.
- **Threading:** `replyToMessageId` fetches the original's Message-ID/References (and the Gmail threadId) and sets `In-Reply-To`, `References` and the subject `Re: …`. It requires `read` in addition to `draft`/`send`.
  - Upstream ids are untrusted: malformed ones (no angle brackets, comments, whitespace) are **dropped**, not passed on. An invalid original Message-ID means no `In-Reply-To`; the valid References are kept.
  - Explicit caller-supplied `inReplyTo`/`references` stay **strict**: a malformed one is rejected with `bad_argument`.
- **Bcc:** kept in the MIME for API sends and all drafts (the provider strips it on send). Dropped for SMTP, where Bcc recipients travel in the envelope only.
- **No blind retries.** Results:
  - `accepted` means accepted by the provider. It is **not** proof of delivery (Graph answers 202 Accepted).
  - `rejected` means it was refused before acceptance and not sent.
  - `indeterminate` means a network loss, timeout or 5xx after the request left. The outcome is unknown, and the user must check the Sent folder before resending.

## 5. Provider details

### Gmail

- **Origins:** `https://gmail.googleapis.com`; tokens via `https://oauth2.googleapis.com`.
- **Scopes:** per https://developers.google.com/workspace/gmail/api/auth/scopes:
  - `gmail.readonly` is restricted.
  - `gmail.send` is sensitive.
  - `gmail.compose` is restricted and covers drafts and send.
- **Grant:** a separate grant from Drive. The identity comes from `users/me/profile`.
- **Sending:** raw RFC 5322 MIME as base64url (https://developers.google.com/workspace/gmail/api/guides/sending) to `users.messages.send`. Drafts go to `users.drafts.create`.
- **Attachments:** addressed by **partId**, not by the volatile Gmail attachmentId, which is re-resolved on each download.

### Microsoft Graph

- **Origins:** `https://graph.microsoft.com` and `https://login.microsoftonline.com`.
- **Tenant** from `PERCH_MICROSOFT_TENANT`: `common` (default), `consumers`, `organizations`, a GUID or a domain.
- **Auth flow:** auth code + PKCE + state (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
  - Public client, no secret.
  - Redirect URI `http://localhost` (loopback; Entra ignores the port). The listener binds 127.0.0.1 only.
- **Permissions:** delegated Mail.Read/Mail.ReadWrite/Mail.Send are supported for personal accounts (https://learn.microsoft.com/en-us/graph/permissions-reference). Work/school tenants may require admin consent or block user consent; Perch then fails with the scope-missing error.
- **Refresh:** single-flight. The rotated refresh token is persisted under the store lock. Perch fails closed when the account was removed or changed during the refresh, or when the rotation cannot be persisted.
- **Sending:** `POST /v1.0/me/sendMail` with base64 MIME (`text/plain`); 202 means accepted, not delivered (https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0). Drafts: `POST /v1.0/me/messages` with base64 MIME.
- **Request size bound:** the create-message reference (https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0, checked 2026-10-05) says MIME payloads are "currently limited to 4 MB" and larger submissions get `413`. The sendMail page states no number.
  - Perch therefore refuses locally any draft or send whose **base64 request body** exceeds **4,000,000 bytes** (the smaller reading of "4 MB", applied to the larger, encoded size). That is about 3,000,000 bytes of MIME, or roughly 2.2 MB of attachments.
  - The error is `message_too_large` ("Not sent" / "No draft created"), raised before any token fetch or network call.
  - Larger attachments would need Graph upload sessions, which are not implemented.
- **Pagination:** the `@odata.nextLink` cursor is validated before use:
  - exact origin;
  - an allowlisted list route;
  - only known query keys.

  Perch never fetches an arbitrary URL.

### GMX / generic IMAP+SMTP

- **Presets** (https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html, https://support.gmx.com/pop-imap/imap/server.html):

  | Preset | Domains | IMAP | SMTP |
  | --- | --- | --- | --- |
  | `gmx` | gmx.at, gmx.de, gmx.net | `imap.gmx.net:993` | `mail.gmx.net:465` (TLS) or 587 (STARTTLS) |
  | `gmx-com` | gmx.com, gmx.us, gmx.co.uk, gmx.fr | `imap.gmx.com:993` | `mail.gmx.com:465` or 587 |

  Other providers need explicit `--imap-host/--smtp-host`.
- **Activation:** in GMX web mail, enable "POP3 und IMAP Zugriff erlauben" (Settings → POP3/IMAP Abruf). With two-factor authentication an application-specific password is required (`perch imap presets`).
- **TLS:**
  - `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, SNI = host name.
  - Host names only, no IP literals.
  - IMAP implicit TLS only.
  - SMTP implicit TLS or STARTTLS with `requireTLS`. Plaintext is impossible.
- **Logging:** `imapflow` runs with `logger: false` and nodemailer with logging off, so credentials never reach a log.
- **Mailbox access:**
  - Mailboxes are opened read-only (EXAMINE) for search/read/attachments.
  - Message ids are `imap:<base64url mailbox>:<UIDVALIDITY>:<UID>`. A changed UIDVALIDITY makes old ids fail closed (`stale_message_id`).
- **Size bounds:** parts are downloaded individually with `maxBytes`. Attachments above the bound are refused, never truncated.
- **Drafts** are appended to the `\Drafts` special-use mailbox (or `--drafts-mailbox`) with `\Draft`.
- **Send:** the SMTP envelope sender is the account address. The outcome is classified by SMTP stage: before DATA means `rejected`; during or after DATA, or an ambiguous socket loss, means `indeterminate`.
- **Licenses** (checked 2026-10-05, `npm view`): `imapflow` 2.2.5 MIT, `nodemailer` 10.0.14 MIT-0, dev-only `smtp-server` 3.19.17 MIT-0. `npm audit --omit=dev` reports 0 vulnerabilities.

## 6. Test strategy and labels

- All Gmail/Graph/identity-platform upstreams in tests are in-memory fakes labelled **MOCK** (`test/support/mockGmail.ts`, `test/support/mockGraph.ts`). IMAP logic is tested against a MOCK session (`test/support/mockImap.ts`).
- **Real local protocol tests (no internet):**
  - TLS certificate validation against local TLS servers with a throwaway self-signed certificate (imapflow and nodemailer must refuse);
  - a real SMTP exchange with `smtp-server` on 127.0.0.1 (AUTH, envelope Bcc, threading headers, RCPT rejection → `rejected`, connection loss during DATA → `indeterminate`).
- **Real MCP SDK clients** over local HTTP, an in-memory transport and the built artifact (`dist/cli.js`) over stdio and HTTP:
  - the new tools are registered and callable;
  - writes are denied on the read-only transports;
  - grants are bound to account ids;
  - client grants see no Drive/Notion tools or metadata and no ungranted accounts;
  - removing or narrowing a grant fails the next tool call closed, with zero provider calls (HTTP, in-memory persistent session, and the real `dist/cli.js serve --stdio` process).
- **Adversarial HTML:** `test/htmlDos.test.ts` runs `test/adversarial/htmlDos.adversarial.ts` (Gmail and Graph `read()` on ~2 MB hostile HTML bodies, 1 s budget each) in a **child process in its own process group, killed after 45 s**. A super-linear converter blocks the event loop, which no in-process timer can interrupt; the child keeps `npm test` from hanging and the parent fails cleanly.

## 7. TDD evidence (RED → GREEN)

See the evidence log below. Each slice: test written first, run, observed failure, then minimal implementation.

### Evidence log

Commands were run in `/home/hermes/perch-email-work` (Node 26.7.0, npm 11.19.0). "RED" lists the observed failure before the implementation existed or was complete. Slices marked (agent) were implemented by a subagent that wrote only its own files, and the orchestrating session re-verified them in the full run.

| # | Slice | RED (command → observed) | GREEN |
| --- | --- | --- | --- |
| 1 | Store migration + client grants | `npx vitest run test/grants.test.ts` → `Cannot find module '../src/auth/grants.js'` | 6/6 |
| 2 | MIME composer, header injection, attachment bounds | `npx vitest run test/compose.test.ts` → `Cannot find module '../src/mail/compose.js'`. First implementation: 1 failure, `Maximum call stack size exceeded` (anchored base64 regex on 14 MB input), fixed with a linear canonical check | 16/16 |
| 3 | Upstream origins + capability-tagged routes | `npx vitest run test/mailUpstream.test.ts` → 5 failed (`Cannot read properties of undefined (reading 'some')`: unknown services) | 5/5 |
| 4 | Generic refresh provider (single-flight, rotation, fail closed) | `npx vitest run test/tokenProvider.test.ts` → `Cannot find module '../src/oauth/tokenProvider.js'`. Existing Google tests stay green after rebasing `GoogleTokenProvider` on it | 5/5 |
| 4b | `interaction_required` → reconnect hint | same command → 1 failed (`expected … to match /revoked or expired/`) | 6/6 |
| 5 | PKCE loopback (localhost redirect, custom path) | `npx vitest run test/loopback.test.ts` → `Cannot find module '../src/oauth/loopback.js'`. Existing Google OAuth tests unchanged | 2/2 (+9 Google) |
| 6 | MailService: authorization order, provenance, threading | `npx vitest run test/mailService.test.ts` → `Cannot find module '../src/mail/service.js'`; then 1 failure from a wrong key in the test (`label` vs. provenance `accountLabel`), fixed in the test | 8/8 |
| 7 | MCP tools: global token read-only, client grants, in-memory transport | `npx vitest run test/mailMcp.test.ts` → 3 failed (`WRITE_TOOL_NAMES is not iterable`; client token → `401 Unauthorized`; `mail_create_draft` not registered) | 4/4 |
| 8 | CLI: imap/client/gmail/microsoft commands | `npx vitest run test/mailCli.test.ts` → `Cannot find module './imap.js'` (module chain missing) | 10/10 |
| 9 | Gmail adapter (agent), 10 slices | e.g. `registerGmailAccount is not a function`, `Cannot find module '../src/mail/gmail.js'`, 11 failed `not implemented` for send outcomes, `expected [] to deeply equal ['gmail-…']` for the 401 cache drop | 36/36 |
| 10 | Microsoft OAuth + Graph adapter (agent), 6 slices | `Cannot find module src/microsoft/accounts.js`; `Cannot find module src/mail/graph.js`; 4 failed (cursor validation); 5 failed (read); 3 failed (attachments); 6 failed (draft/send) | 13/13 + 23/23 |
| 11 | IMAP/SMTP + GMX (agent), 5 slices | module-not-found for presets/provider/onboarding; SMTP 10/10 RED against a throwing placeholder. TLS tests passed on first run (code existed), so they were proven by mutation: with `rejectUnauthorized:false` + `minVersion TLSv1`, 6 tests failed, and they passed again after restore | 5+20 / 10 / 11 (46 total) |
| 12 | Built-artifact smoke (stdio client grant, read-only HTTP denial) | added to `test/smoke/built.test.ts`; tool count updated from 14 to 17 read-only tools | 4/4 |
| 13a | Review fix: `replyToMessageId` needs `read`; malformed upstream threading ids; client account listing; no existence oracle | `npx vitest run test/mailService.test.ts` → **6 failed / 9 passed**: send-only and draft-only reply `expected the promise to reject`; `references must be a single Message-ID like <id@host>` (2×); listAccounts `expected [ 'gmail-0000000a', 'imap-0000000b' ] to deeply equal [ 'imap-0000000b' ]`; `expected 'unknown_account' to be 'capability_denied'`. The old draft-only threading test now uses `['read','draft']`; the misleading "removed grant" test (which never removed a grant) was replaced by real removal tests in 13b | 15/15 |
| 13b | Review fix: client grants mail-only (no Drive/Notion tools or metadata, read tools only with `read`); revalidation before every tool call | `npx vitest run test/mailMcp.test.ts` → **4 failed / 7 passed**: `expected [ 'drive_download_file', …(17) ] to deeply equal [ 'mail_send', 'perch_list_accounts' ]`; persistent session after `removeClientGrant` `mail_send: expected false to be true`; narrowed session `expected false to be true`; draft-only client `expected [ … ] to not include 'mail_read_message'`. The HTTP revoke/narrow tests passed on first run (HTTP already re-authenticated per POST) and remain as guards | 11/11 |
| 13c | Real stdio process: narrowing + `perch client remove` on a running `dist/cli.js serve --stdio` | new smoke test; proven by **mutation**: with `currentPrincipal` short-circuited, `npm run smoke` → **1 failed / 4 passed** (`expected undefined to be true`: narrowed `mail_send` not denied); passes after restore | 5/5 smoke |
| 13d | Review fix: quadratic HTML-to-text regexes (Gmail, Graph) → shared bounded linear scanner `src/mail/html.ts` (also used by IMAP) | `npx vitest run test/htmlDos.test.ts` → child suite **killed after 45 000 ms (hung)**, parent failed cleanly in 45.18 s. A first attempt killed only the child's main process and left a forked vitest worker spinning at 100% CPU, so the harness now kills the whole process group. `test/html.test.ts` → `Cannot find module '../src/mail/html.js'`; then 1 failure (`3<4` treated as a tag), fixed | 1/1 (12 child cases) + 7/7 |
| 13e | Graph MIME request bound (4,000,000 bytes base64), refused before token fetch/call | `npx vitest run test/graph.test.ts` → **1 failed** (`expected undefined to be 4000000`: no bound) | 24/24 |

### Final checks (2026-10-05)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | **337/337** passed in 26 files, after the review fixes (was 314/314 in 24 files) |
| `npm run build` + `npm run smoke` | build clean; **5/5** smoke tests against `dist/cli.js` (stdio, HTTP, client grant over stdio, revocation/narrowing of a running stdio server) |
| `npm audit --omit=dev` | 0 vulnerabilities |

## 8. Known limitations and open items

- **Not live-verified:**
  - no real Google, Microsoft or GMX login;
  - no real message sent;
  - Gmail/Graph request and response shapes come from the primary docs and MOCKs only;
  - the IMAP fetch/search/append commands are tested against a mocked imapflow client (connect/TLS/login/logout against a scripted local server).
- **No multi-user isolation:** single operator, per-client grants only.
- **Gmail:**
  - `folder` is ignored (use query syntax such as `in:sent`);
  - search fetches metadata with all headers;
  - restricted scopes need Google verification for production, and testing-mode refresh tokens expire after 7 days.
- **Graph:**
  - nextLinks outside the allowlisted shape end pagination flagged `incomplete`;
  - MIME messages over 4,000,000 bytes base64 are refused locally (no upload sessions, so large attachments cannot go via Graph);
  - whether Graph honours a Bcc header inside MIME is unverified;
  - tenant consent policies may block `Mail.*`.
- **IMAP:**
  - TEXT search, ordered by UID (not by date);
  - no Sent-folder copy after an SMTP send;
  - one connection per call (no IDLE or pool);
  - `draftId` is `appended` without UIDPLUS;
  - non-UTF-8 text attachments are returned converted to UTF-8;
  - only the GMX domains named in the help pages are auto-detected (use `--preset` for others).
- **Size:** over HTTP, write requests are limited to 16 MiB (attachments ≤ 10 MiB decoded). The client's MCP output limit still applies to reads.
- **Not implemented (later milestones):**
  - sending an existing draft, moving/deleting/flagging mail;
  - Calendar, Contacts;
  - body-free audit log;
  - WhatsApp;
  - Docker/backup;
  - license file.
