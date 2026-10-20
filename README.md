<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/perch-logo-white.svg">
  <img alt="Perch" src="brand/logo/perch-logo-black.svg" width="220">
</picture>

# Perch

Perch is an MCP server. It puts **several Google Drive accounts**, **several Notion workspaces**, **several mail accounts** (Gmail, Outlook.com/Microsoft 365, GMX and other IMAP/SMTP), **several Google Calendar/Contacts accounts**, **several Slack workspaces** and **WhatsApp** (through a self-hosted GOWA bridge) behind **one** connector for Claude Code, Codex and other MCP clients.

Everything is read-only by default. Writing (mail drafts, sending mail, Slack and WhatsApp messages, creating or changing private calendar events) is only possible through an explicit client grant (see [Read-only by default](#read-only-by-default-writes-through-client-grants)).

- Runs on a home server.
- Claude Code (or Codex) on the laptop connects once, through Tailscale Serve (HTTPS) or an SSH tunnel.
- No switching accounts, no sharing individual files.
- Every result carries the account or workspace id and label, so you always know where it came from.

Status as of 2026-10-14:
- Drive/Notion, mail, Calendar/Contacts, the mail workflow and Slack/WhatsApp are implemented and tested locally against mock upstreams and local test servers.
- **Not** verified live against Google, Notion, Microsoft, GMX, Slack or WhatsApp.
- Not deployed.

## Read-only by default, writes through client grants

Perch has two kinds of access tokens:

- **The global token** (`~/.config/perch/http-token`, or plain stdio) can **only read**, but across all connected accounts. Write tools are not even listed for it.
- **A client grant** is a separate token you create on the server for one client, e.g. "Claude Code on the laptop" or "Codex". It names exactly which capabilities it has and for which accounts:

  ```bash
  perch client add --label "Claude Code" --allow read,send --account gmail-1a2b3c4d
  perch client add --label "Codex" --allow slack_read,slack_send --account slack-5e6f7a8b
  ```

  The first client can read and send mail from that one Gmail account only; it cannot write anywhere else. "Local" means the grant is created with the CLI on the server itself; it cannot be created or widened over MCP.

Capabilities, per account family:

| Accounts | Capabilities |
| --- | --- |
| Mail (`gmail-…`, `microsoft-…`, `imap-…`) | `read`, `draft`, `send`, `modify` |
| Google Calendar/Contacts (`gprod-…`) | `calendar_read`, `calendar_write`, `contacts_read` |
| Slack (`slack-…`) | `slack_read`, `slack_send` |
| WhatsApp (`whatsapp-…`) | `whatsapp_read`, `whatsapp_send` |

Perch re-checks the grant before every tool call, so `perch client remove ID` takes effect immediately, even on open connections. Every send needs a `requestId`: repeating the same request never sends twice. All calls are written to a body-free audit log (`perch audit list`). Note that client grants cover these families only; Drive and Notion stay readable through the global token.

## Features

- **Google Drive** (`drive.readonly`, a separate OAuth grant per account):
  - search and list, optionally across all accounts
  - metadata
  - read text, base64 download
  - export Docs, Sheets and Slides to validated formats
  - size limit: 48 KiB by default because of client output limits, up to 10 MiB on request
  - never written to disk
- **Notion** (one personal access token per workspace):
  - title search over pages and data sources (no full-text search)
  - pages and paginated, nested block content
  - databases, data sources and data source queries
- **Mail** (`docs/EMAIL_MILESTONE.md`):
  - Gmail: its own OAuth grant, `gmail.readonly` by default, opt-in `gmail.send`/`gmail.compose`
  - Microsoft Graph: delegated with PKCE, `Mail.Read` by default, opt-in `Mail.ReadWrite`/`Mail.Send`
  - IMAP/SMTP (GMX presets): password only through a masked prompt, TLS ≥ 1.2 with certificate verification
  - search, read, attachments; drafts and sending from an explicitly chosen sender account
  - threading headers; outcome `accepted`/`rejected`/`indeterminate`, never a blind retry
  - organizing with the `modify` capability and the provider opt-in `--allow-modify` (`gmail.modify`, `Mail.ReadWrite`, IMAP opt-in): list folders and drafts, mark read/unread and starred, move, archive, trash and restore; deleting means trash only, never permanent deletion, emptying the trash, filters or forwarding rules
  - send an existing draft (`mail_send_draft`, idempotent per `requestId`; IMAP sends without the Bcc header and files the draft in Sent)
- **Google Calendar/Contacts** (`docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`):
  - its own OAuth grant, services chosen explicitly with `--services calendar,contacts`, `calendar.readonly`/`contacts.readonly` by default, opt-in `calendar.events.owned`
  - read calendars and events; create private events (idempotent per `requestId`) and change them (`If-Match`), without attendees, invitations or notifications
  - read contacts page by page (no search)
- **Slack** (`docs/SLACK_WHATSAPP_MILESTONE.md`; one internal app with a user token per workspace, manifest in `docs/slack-app-manifest.json`):
  - list channels, private channels, DMs and group DMs; read history and threads; Slack search across all workspaces
  - post as the connected user (also in threads), only with a `slack_send` grant, idempotent per `requestId`
- **WhatsApp** through GOWA (unofficial, self-hosted, localhost only):
  - pair with a pairing code from the CLI; several accounts in separate device slots
  - list chats, read and search messages (search covers the most recent chats); media as metadata only
  - send text messages only with a `whatsapp_send` grant, idempotent per `requestId`
- **One operator per installation:** Perch is self-hosted by the person whose accounts it serves. The earlier admin-provisioned users (`perch user add`, `PERCH_USER`) were removed; see `docs/SETUP.md` §4c for leftover files.
- **Luma** through the official Luma MCP server (`perch luma add`, OAuth, no Luma Plus needed; mock-tested only): read calendars, events and guests; create and change events, invite and approve guests, send blasts only with `luma_events` / `luma_guests` / `luma_blast` grants. A fixed tool list with pinned schemas, idempotent writes, and blasts only after Perch has counted the recipients (`confirmRecipientCount`). See `docs/SETUP.md` §4g.
- **Status:** `perch status` lists every connected account with a live, read-only check (exit code 1 if one fails), client grants, the send ledger fill level and recent activity. `GET /status` on the HTTP server shows the same as a read-only page (no secrets, no script; the global read-only token as the browser password; see `docs/SETUP.md` §5a).
- **Transports:** stdio and stateless Streamable HTTP (`POST /mcp`)
- **Public access (optional, mock-tested only):** `perch serve --http --public` adds a public OAuth 2.1 listener (MCP authorization) for claude.ai custom connectors and Claude Code without Tailscale. New devices are paired only inside a pairing window opened on the server (`perch oauth pair`): pairing code from the terminal, Google sign-in (allowlist), a Perch code (TOTP) and a final confirmation in the terminal. Rotating refresh tokens, per-device revocation, a kill switch (`perch public off`). See `docs/SETUP.md` §6a and `docs/PUBLIC_ACCESS_SPEC.md`.
- **Security:**
  - encrypted credential store (AES-256-GCM, key stored separately)
  - bearer auth that fails closed
  - allowlists for Host and Origin
  - binds to loopback or an explicit Tailscale IP only (the public listener too; a TLS proxy such as Tailscale Funnel exposes it)
  - allowlist of upstream endpoints; write endpoints only for the matching grant
  - fixed upstream origins, sanitised error messages

## Quick start

```bash
git clone https://github.com/frilabs/perch.git perch && cd perch
npm ci && npm run build
node dist/cli.js init
node dist/cli.js notion add --label "Personal"         # enter the PAT at the masked prompt
PERCH_GOOGLE_CLIENT_FILE=~/.config/perch/google-client.json \
  node dist/cli.js google add --label "Personal" --port 8766
node dist/cli.js serve --http                          # 127.0.0.1:8765, bearer token in ~/.config/perch/http-token
```

The full guide is [`docs/SETUP.md`](docs/SETUP.md) (German): Google Cloud setup, Slack and GOWA, Tailscale or SSH, Claude Code and Codex configuration, revocation and limits.

## Live test, step by step

Perch has only been tested against mocks. This is the first live run on the home server. Work top to bottom; after every connector run `perch status`, and note anything that fails (it ends up in `docs/PHASE1_REMAINING.md` §1). Details for every step: [`docs/SETUP.md`](docs/SETUP.md).

**You need:** a Linux server with Node.js ≥ 22.12 and Git, Tailscale on server and laptop, SSH from the laptop to the server (below called `homeserver`), Claude Code on the laptop.

### 1. Install on the server

```bash
gh auth login                                   # or a read-only deploy key: the repository is private
git clone https://github.com/frilabs/perch.git ~/perch && cd ~/perch
npm ci && npm run build && npm run check        # must be green before you connect real accounts
cp .env.example .env && chmod 600 .env          # replace USER with your user name
echo "alias perch='node --env-file=$HOME/perch/.env $HOME/perch/dist/cli.js'" >> ~/.bashrc && source ~/.bashrc
perch init
perch status --no-check                         # empty overview, no errors
```

Back up `~/.config/perch/store.key` **now**, separately from the data directory. Without it nothing can be decrypted.

### 2. Connect accounts (one at a time)

Browser logins redirect to `127.0.0.1` on the server. If the browser runs on the laptop, open a tunnel first and keep it open during the login: `ssh -N -L 8766:127.0.0.1:8766 homeserver` (Luma: port 8768).

| # | Connector | Prepare | Command on the server |
| --- | --- | --- | --- |
| a | Notion | create a personal access token per workspace and share the pages with it | `perch notion add --label "Personal"` |
| b | Google Drive | Google Cloud project: enable Drive, Gmail, Calendar and People APIs; consent screen "Testing" with yourself as test user and the scopes from SETUP §3–4b; OAuth client **Desktop app** → `~/.config/perch/google-client.json` (`chmod 600`) | `perch google add --label "Private" --port 8766` |
| c | Gmail | same Google client | `perch gmail add --label "Gmail" --port 8766` (later `--allow-send` for the send test) |
| d | Calendar/Contacts | same Google client | `perch google-productivity add --label "Private" --services calendar,contacts --port 8766` |
| e | Outlook | Entra app registration, public client, redirect `http://localhost`, `User.Read` + `Mail.Read`; set `PERCH_MICROSOFT_CLIENT_ID` in `.env` | `perch microsoft add --label "Outlook" --port 8766` |
| f | GMX | GMX webmail: allow IMAP; app password if 2FA is on | `perch imap add --label "GMX" --email you@gmx.at` |
| g | Slack | `perch slack manifest`, create the app per workspace at api.slack.com/apps, install, copy the **User OAuth Token** | `perch slack add --label "Workspace"` |
| h | WhatsApp | install GOWA as in SETUP §4f (localhost only, basic auth) | `perch whatsapp instance set --url http://127.0.0.1:3000`, then `perch whatsapp add --label "Private" --phone +43…` and enter the pairing code on the phone |
| i | Luma | check `curl -s https://frilabs.dev/perch/luma-client.json` returns the document | `perch luma add --label "Luma" --port 8768`, then `perch luma tools <id>` |

Google refresh tokens expire after 7 days while the consent screen is in "Testing"; reconnect then.

### 3. Run the server

```bash
loginctl enable-linger "$USER"                  # keep user services running after logout
# ~/.config/systemd/user/perch.service as in SETUP §6, ExecStart: node --env-file=%h/perch/.env %h/perch/dist/cli.js serve --http
systemctl --user daemon-reload && systemctl --user enable --now perch
sudo tailscale serve --bg http://127.0.0.1:8765
# add the MagicDNS name to .env: PERCH_ALLOWED_HOSTS=homeserver.<tailnet>.ts.net, then restart the service
perch status                                    # every account "ok"
```

Open `https://homeserver.<tailnet>.ts.net/status` in the browser (password: the content of `~/.config/perch/http-token`).

### 4. Connect Claude Code on the laptop (read-only)

```bash
TOKEN="$(ssh homeserver 'cat ~/.config/perch/http-token')"
claude mcp add --scope user --transport http perch https://homeserver.<tailnet>.ts.net/mcp --header "Authorization: Bearer ${TOKEN}"
unset TOKEN; chmod 600 ~/.claude.json
```

Try in Claude Code: "list my Perch accounts", "search Drive for X", "latest mails about Y", "what was said about Z in Slack and WhatsApp", "my events next week", "my Luma events".

### 5. Test writing (only to yourself)

```bash
perch client add --label "Claude Code write test" --allow read,send,slack_read,slack_send --account <gmail-…> --account <slack-…> \
  --token-file ~/.config/perch/clients/write-test.token
```

Register that token as a second MCP server on the laptop (`perch-write`). Then: send one mail to yourself, post one Slack message in a private test channel, and repeat the same request with the same `requestId`: it must answer `replayed: true` and send nothing. Check `perch audit list`. Remove the grant afterwards: `perch client remove <client-…>`.

### 6. Optional: public access (claude.ai on web and phone)

Only after steps 1–5 work, and read the known gaps in `docs/PHASE1_REMAINING.md` §3 first. Steps: SETUP §6a.2 (Funnel, Google **Web application** client, `perch public setup`), restart with `serve --http --public`, then `perch oauth pair` and add `https://homeserver.<tailnet>.ts.net/mcp` as a custom connector in claude.ai. Kill switch: `perch public off`.

### 7. Report back

For each connector: works / fails with the message from `perch status`. Plus the live questions in `docs/PHASE1_REMAINING.md` §1 (Luma registration type, WhatsApp stability, claude.ai pairing, Funnel client IP).

## Development

```bash
npm run typecheck
npm test          # vitest; Google (Drive/Gmail/Calendar/People), Notion, Graph, Slack and GOWA only as clearly marked mocks, IMAP/SMTP against local test servers
npm run smoke     # builds and tests dist/cli.js over stdio and HTTP
```

| Path | Purpose |
| --- | --- |
| `src/cli.ts`, `src/cli/` | CLI (`init`, `serve`, `google`, `notion`, `gmail`, `microsoft`, `imap`, `google-productivity`, `slack`, `whatsapp`, `client`, `user`, `accounts`, `status`, `audit`, `token`) |
| `src/status/` | `perch status` report and the read-only `/status` page |
| `src/auth/` | client grants (capabilities per account family), principals |
| `src/slack/` | Slack Web API (user token per workspace), app manifest |
| `src/whatsapp/` | GOWA bridge: instance, pairing, chats, messages, sending |
| `src/messaging/` | idempotent send flow for Slack and WhatsApp (shares the ledger with mail) |
| `src/oauth/` | PKCE loopback, refresh with single-flight and rotation (fail closed) |
| `src/mail/` | MailService, MIME building, Gmail, Graph and IMAP/SMTP adapters, GMX presets, send workflow and ledger |
| `src/microsoft/` | Microsoft OAuth and accounts |
| `src/store/` | encrypted credential store, lock |
| `src/secureFs.ts` | permissions, symlinks, atomic writes |
| `src/upstream.ts` | fixed origins, allowlist with capability tags, timeouts and size limits, sanitised errors |
| `src/google/` | OAuth (loopback and PKCE), token refresh, Drive, Calendar, Contacts, productivity grant |
| `src/notion/` | Notion (PAT, `Notion-Version: 2026-03-11`) |
| `src/fanout.ts` | queries across several accounts, composite cursors, partial results |
| `src/mcp/` | MCP tools, HTTP server |

## Documents

The detailed documents are in German.

- [`docs/BRIEFING.md`](docs/BRIEFING.md): briefing (approved)
- [`docs/SPEC.md`](docs/SPEC.md): specification
- [`docs/SETUP.md`](docs/SETUP.md): setup and operation
- [`docs/EMAIL_MILESTONE.md`](docs/EMAIL_MILESTONE.md): email milestone (specification, TDD evidence)
- [`docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`](docs/GOOGLE_PRODUCTIVITY_MILESTONE.md): Calendar/Contacts milestone (specification, TDD evidence)
- [`docs/USER_ISOLATION_MILESTONE.md`](docs/USER_ISOLATION_MILESTONE.md): user isolation milestone (historical; removed 2026-10-14)
- [`docs/MAIL_WORKFLOW_MILESTONE.md`](docs/MAIL_WORKFLOW_MILESTONE.md): audit log and idempotent sending
- [`docs/SLACK_WHATSAPP_MILESTONE.md`](docs/SLACK_WHATSAPP_MILESTONE.md): Slack/WhatsApp milestone (decisions, allowlist, limits)
- [`docs/PROJECT_SCOPE.md`](docs/PROJECT_SCOPE.md): broader project direction
- [`docs/HANDOFF.md`](docs/HANDOFF.md): current state
- [`docs/PHASE1_REMAINING.md`](docs/PHASE1_REMAINING.md): done vs. open (live validation, operations, known gaps)
- [`AGENTS.md`](AGENTS.md): working rules
- `brand/logo/`: Perch logo (a branch with two twigs, frilabs standard: black/white, symbol, favicon, app icon)

## Roadmap

- Docker/Compose, backup, migrations
- Rollover for the send ledger (Mail, Slack and WhatsApp share 1000 send records per namespace)
- Calendar invitations, recurring events, deleting; writing contacts
- Live tests for Slack and WhatsApp; loading older WhatsApp history
- LinkedIn is out of scope

## License

MIT, see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
