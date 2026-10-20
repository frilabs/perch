<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo/perch-logo-white.svg">
  <img alt="Perch" src="brand/logo/perch-logo-black.svg" width="220">
</picture>

# Perch

Perch is an MCP server. It puts **several Google Drive accounts**, **several Notion workspaces**, **several mail accounts** (Gmail, Outlook.com/Microsoft 365, GMX and other IMAP/SMTP), **several Google Calendar/Contacts accounts**, **several Slack workspaces** and **WhatsApp** (through a self-hosted GOWA bridge) behind **one** connector for Claude Code, Codex and other MCP clients.

Everything is read-only by default. Writing (mail drafts, replies, forwards and sending, Slack and WhatsApp messages, calendar events and invitations) is only possible through an explicit client grant (see [Read-only by default](#read-only-by-default-writes-through-client-grants)).

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
- **A client grant** is a separate token you create on the server for one client, e.g. "Claude Code on the laptop" or "Codex". The simple way is **full access**: read and write on every connected account, including accounts you connect later:

  ```bash
  perch client add --label "Claude Code" --full
  ```

  Or narrow it down to exact capabilities and accounts, e.g. a client that may only read and send mail from one Gmail account:

  ```bash
  perch client add --label "Uni laptop" --allow read,send --account gmail-1a2b3c4d
  ```

  Grants are created with the CLI on the server itself; they cannot be created or widened over MCP. Devices paired over the internet (`perch oauth pair`) are asked the same at pairing: read only or full.

Capabilities, per account family:

| Accounts | Capabilities |
| --- | --- |
| Mail (`gmail-…`, `microsoft-…`, `imap-…`) | `read`, `draft`, `send`, `modify` |
| Google Calendar/Contacts (`gprod-…`) | `calendar_read`, `calendar_write`, `calendar_invite`, `contacts_read` |
| Slack (`slack-…`) | `slack_read`, `slack_send` |
| WhatsApp (`whatsapp-…`) | `whatsapp_read`, `whatsapp_send` |
| Google Drive (`google-…`) | `drive_read`, `drive_write` |
| Notion (`notion-…`) | `notion_read`, `notion_write` |
| Luma (`luma-…`) | `luma_read`, `luma_events`, `luma_guests`, `luma_blast` |

**One Google login:** `perch google add --label NAME` connects a Google account for Drive, Gmail, Calendar and Contacts with one browser login (asks which services, default all). The accounts keep their ids per family (`google-…`, `gmail-…`, `gprod-…`) and form one *Google account group* (`ggroup-…`) that stores the refresh token once; a refresh or a revoked grant applies to all of them together. Google lets you untick single permissions: Perch connects what was granted and names what is missing. Running the same command again for the same account updates the group (same ids). Read/write per service: `perch google access ggroup-…` shows the rights of each service and changes them (`--service gmail --write`, `--service drive --read-only`, `--add contacts`; granting logs in again for the same account, revoking is local and needs no login; write means Drive edit/share/trash, Gmail drafts + send + organize, Calendar own events + invitations; Contacts are read-only). `perch gmail add` and `perch google-productivity add` still connect one service with its own login.

**Provider permissions:** when you connect an account, `perch <service> add` asks *"read only, or read + write?"* and requests the matching permissions from Google, Microsoft or the mail server (`--read-only` / `--write` skip the question). A client can only write where the account was connected with write permissions.

Perch re-checks the grant before every tool call, so `perch client remove ID` takes effect immediately, even on open connections. Every send needs a `requestId`: repeating the same request never sends twice. All calls are written to a body-free audit log (`perch audit list`). 

## Features

- **Google Drive** (`drive.readonly`, or `drive` with `perch google access ggroup-… --service drive --write`; part of the Google account's one login, `docs/SETUP.md` §3):
  - search and list, optionally across all accounts
  - metadata, sharing entries and comments
  - read text, base64 download
  - export Docs, Sheets and Slides to validated formats
  - size limit: 48 KiB by default because of client output limits, up to 10 MiB on request
  - never written to disk
  - client grants with `drive_read` read only their granted accounts
  - writes (client grants with `drive_write` on accounts connected with `--allow-write` only): upload (up to 10 MiB), create folders and Google Docs/Sheets/Slides (empty or from text/CSV), replace content, rename, move, copy, share (user, group, domain, anyone with the link; reader/commenter/writer), unshare, comment, trash and restore
  - creating, copying, sharing and commenting need a `requestId` and never run twice; deleting means trash only (no permanent delete, no empty trash, no ownership transfer)
- **Notion** (one personal access token per workspace):
  - title search over pages and data sources (no full-text search)
  - pages and paginated, nested block content
  - databases, data sources and data source queries, page comments
  - with a client grant holding `notion_write`: create pages (under a page or as a data source row), change properties and blocks, append blocks, move pages and blocks to the trash and restore pages (never permanent deletion), add comments; creating writes are idempotent per `requestId`
- **Mail** (`docs/EMAIL_MILESTONE.md`):
  - Gmail: through the Google account's one login (`perch google add`) or its own grant (`perch gmail add`), `gmail.readonly` by default, opt-in `gmail.send`/`gmail.compose`
  - Microsoft Graph: delegated with PKCE, `Mail.Read` by default, opt-in `Mail.ReadWrite`/`Mail.Send`
  - IMAP/SMTP (GMX presets): password only through a masked prompt, TLS ≥ 1.2 with certificate verification
  - search, read, attachments; drafts and sending from an explicitly chosen sender account
  - threading headers; outcome `accepted`/`rejected`/`indeterminate`, never a blind retry
  - organizing with the `modify` capability and the provider opt-in `--allow-modify` (`gmail.modify`, `Mail.ReadWrite`, IMAP opt-in): list folders and drafts, mark read/unread and starred, move, archive, trash and restore; deleting means trash only, never permanent deletion, emptying the trash, filters or forwarding rules
  - send an existing draft (`mail_send_draft`, idempotent per `requestId`; IMAP sends without the Bcc header and files the draft in Sent)
  - reply, reply all and forward (`mail_reply`, `mail_forward`; recipients and threading derived from the original, forwards keep the original attachments up to 10 MiB): a draft by default (`draft`), sent directly with `send: true` (`send`, idempotent per `requestId`)
  - IMAP files every sent message in the Sent folder (off per account with `--no-sent-copy`; not for Gmail/Outlook SMTP, which file it themselves)
- **Google Calendar/Contacts** (`docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`):
  - through the Google account's one login (`perch google add --services calendar,contacts`) or its own grant (`perch google-productivity add`), `calendar.readonly`/`contacts.readonly` by default, opt-in `calendar.events.owned`
  - read calendars and events; create events (idempotent per `requestId`) and change them (`If-Match`): private and silent by default
  - with `calendar_invite`: guests and invitations (`sendUpdates`), answer invitations (`calendar_respond_event`); also recurring series (RRULE), Google Meet links, any visibility
  - delete events or whole series permanently (`calendar_delete_event`); single occurrences of a series cannot be changed
  - read contacts page by page (no search)
- **Slack** (`docs/SLACK_WHATSAPP_MILESTONE.md`; one internal app with a user token per workspace, manifest in `docs/slack-app-manifest.json`):
  - list channels, private channels, DMs and group DMs; read history and threads; Slack search across all workspaces
  - post as the connected user (also in threads), only with a `slack_send` grant, idempotent per `requestId`
  - read file metadata and content (`slack_get_file`, size-bounded, never truncated); with `slack_send`: add/remove reactions, edit own messages, upload files up to 10 MiB (idempotent per `requestId`). Open DMs and group DMs (`slack_open_conversation`), schedule messages (`slack_schedule_message`, idempotent per `requestId`), list and cancel scheduled ones. Never deletes posted messages or files. Needs the current manifest (`reactions:*`, `files:*`, `im:write`, `mpim:write`): reinstall the app and run `perch slack add` again
- **WhatsApp** through GOWA (unofficial, self-hosted, localhost only):
  - pair with a pairing code from the CLI; several accounts in separate device slots
  - list chats, read and search messages (search covers the most recent chats); download one message's media with `whatsapp_download_media` (base64, default limit 48 KiB, max 16 MiB, refused rather than truncated)
  - send text messages and media (`whatsapp_send_media`: image, video, audio or file as base64, max 16 MiB, never URLs) only with a `whatsapp_send` grant, idempotent per `requestId`. Sending media raises the risk of WhatsApp restricting the account even more than text
- **One operator per installation:** Perch is self-hosted by the person whose accounts it serves. The earlier admin-provisioned users (`perch user add`, `PERCH_USER`) were removed; see `docs/SETUP.md` §4c for leftover files.
- **Luma** through the official Luma MCP server (`perch luma add`, OAuth, no Luma Plus needed; mock-tested only): read calendars, events and guests; create and change events, invite and approve guests, send blasts only with `luma_events` / `luma_guests` / `luma_blast` grants. A fixed tool list with pinned schemas, idempotent writes, and blasts only after Perch has counted the recipients (`confirmRecipientCount`). See `docs/SETUP.md` §4g.
- **Status:** `perch status` lists every connected account with a live, read-only check (exit code 1 if one fails), its enabled capabilities and the exact command for each missing one, unconnected services with their `perch … add` command (Google as one entry: one line when no Google account is connected, otherwise one block per Google account with its services and their ☑/☐ rights and the `perch google access …` command for a missing one), client grants, the send ledger fill level, recent activity and an onboarding checklist (checkboxes; colour only on a terminal, off with `NO_COLOR`; `--plain` for the previous one-line-per-account text, `--json` for scripts). `GET /status` on the HTTP server shows the same as a read-only page (no secrets, no script; the global read-only token as the browser password; see `docs/SETUP.md` §5a).
- **Transports:** stdio and stateless Streamable HTTP (`POST /mcp`)
- **Public access (optional, mock-tested only):** `perch serve --http --public` adds a public OAuth 2.1 listener (MCP authorization) for claude.ai custom connectors and Claude Code without Tailscale. New devices are paired only inside a pairing window opened on the server (`perch oauth pair`): pairing code from the terminal, Google sign-in (allowlist), a Perch code (TOTP) and a final confirmation in the terminal. Rotating refresh tokens, per-device revocation, a kill switch (`perch public off`). See `docs/SETUP.md` §6a and `docs/PUBLIC_ACCESS_SPEC.md`.
- **Security:**
  - encrypted credential store (AES-256-GCM, key stored separately)
  - bearer auth that fails closed
  - allowlists for Host and Origin
  - binds to loopback or an explicit Tailscale IP only (the public listener too; a TLS proxy such as Tailscale Funnel exposes it)
  - allowlist of upstream endpoints; write endpoints only for the matching grant
  - fixed upstream origins, sanitised error messages

## Onboarding

### Who does what

- **The operator** (whoever runs the server) sets Perch up **once per installation**: registers Perch at the providers where they require it (below), connects the accounts and starts the server.
- **Every further Claude or Codex account** then needs only one command on the server and works with all connected accounts, also ones added later.

### 1. Prepare the providers (once per installation, only for the services you want)

Perch is self-hosted, so there is no central Perch app that Google or Microsoft already know. Where a provider only lets registered apps sign in, you register your own "Perch" there once. `perch setup` walks you through this in the terminal, step by step with direct links, when it is missing; the table is the overview.

| Service | What to do once | Time |
| --- | --- | --- |
| **GMX / IMAP** | GMX webmail → settings: allow POP3/IMAP; with two-factor sign-in create an app password | 2 min |
| **Luma** | nothing (sign-in in the browser; Perch's client document is served at `https://frilabs.dev/perch/luma-client.json`) | – |
| **Notion** (per workspace) | [notion.so/my-integrations](https://www.notion.so/my-integrations): new internal integration "Perch" with *Read/Update/Insert content* and *Read/Insert comments*; copy the token; in Notion share the pages with it (••• → Connections → Perch) | 5 min |
| **Slack** (per workspace) | guided in the terminal by `perch slack add` / `perch setup`: it prints the manifest and the link [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1) → *From a manifest* → workspace → paste → *Create* → *Install to Workspace* (some workspaces need an admin's approval) → copy the **User OAuth Token** (`xoxp-…`), asked hidden (`--skip-guide` to skip the steps) | 5 min |
| **Google** (Drive, Gmail, Calendar, Contacts; once for all Google accounts) | guided in the terminal (`perch setup`, any Google `add`, or `perch google client setup`): own Google Cloud project → enable the APIs of the chosen services → Google Auth Platform *External*, *Testing*, yourself as **test user**, the printed scope list → OAuth client type **Desktop app** → paste the downloaded JSON (hidden); Perch checks it and stores it `0600` at `~/.config/perch/google-client.json` | 10 min |
| **Outlook / Microsoft 365** | guided in the terminal by `perch microsoft add` / `perch setup` (or `perch microsoft client setup`), with direct links: [Entra admin center](https://entra.microsoft.com) → new app registration "Perch", include personal Microsoft accounts, platform *Mobile and desktop applications* with redirect `http://localhost`, no secret → API permissions (delegated): `User.Read`, `Mail.Read` (+ `Mail.ReadWrite`, `Mail.Send` for write) → paste the *Application (client) ID*; Perch stores it in `~/.config/perch/microsoft-client-id` (`PERCH_MICROSOFT_CLIENT_ID` in `.env` still wins) | 10 min |
| **WhatsApp** (unofficial) | nothing beforehand: `perch whatsapp install` (or choosing WhatsApp in `perch setup`) downloads the pinned GOWA bridge from GitHub, checks its SHA-256, runs it as a systemd user service on 127.0.0.1 and stores it in Perch (Linux, asks first; manual way in `docs/SETUP.md` §4f.1a) | 2 min |

Notes: Google sign-ins of a project in *Testing* expire after 7 days (reconnect then: `perch google add` again updates the account's group). The Google services of one account share one login: revoking it (`perch google remove ggroup-… --revoke` or at myaccount.google.com) disconnects all of them. Google revokes the whole grant of the OAuth client for that account, so `--revoke` is refused while another stored login of the same account uses the same client (other group or separately connected account), unless `--force`. WhatsApp via GOWA is an unofficial linked-device integration and can get the account restricted, more likely when sending.

### 2. Install and connect the accounts (server)

```bash
gh auth login                                   # the repository is private
git clone https://github.com/frilabs/perch.git ~/perch && cd ~/perch
npm ci && npm run build
cp .env.example .env && chmod 600 .env          # replace USER; add the values from step 1
echo "alias perch='node --env-file=$HOME/perch/.env $HOME/perch/dist/cli.js'" >> ~/.bashrc && source ~/.bashrc
perch setup
```

`perch setup` creates the key, store and token, then asks service by service:

- *Connect …?* → a label (e.g. Private, Work) → the login: Google (one step and one login for Drive, Gmail, Calendar and Contacts; asks which of them), Outlook and Luma open a browser page; Outlook first walks through the Entra app registration if no client ID is configured; Slack first shows the app manifest and the steps; Notion and Slack tokens and the IMAP password are asked hidden; WhatsApp first offers to install the GOWA bridge if none is configured (warning and `[y/N]`, same as `perch whatsapp install`), then shows a pairing code for the phone (WhatsApp → Linked devices → Link with phone number).
- *Access: read only, or read + write?* (Google, Outlook, IMAP) → choose `w` where Claude should be able to change things.
- At the end: *create a client with full access?* → it prints the ready-to-paste `claude mcp add` command.

Browser logins need no tunnel: if the browser runs on your laptop, it shows "This site can't be reached" after you approved; copy the complete address from the address bar and paste it into the terminal (hidden). Alternatively open a tunnel on the laptop before the login: `ssh -N -L 8766:127.0.0.1:8766 <server>` (Luma: port 8768).

**Back up `~/.config/perch/store.key` now**, separately from the data directory. Without it nothing can be decrypted.

### 3. Run the server

```bash
loginctl enable-linger "$USER"
# ~/.config/systemd/user/perch.service as in docs/SETUP.md §6, ExecStart: node --env-file=%h/perch/.env %h/perch/dist/cli.js serve --http
systemctl --user daemon-reload && systemctl --user enable --now perch
sudo tailscale serve --bg http://127.0.0.1:8765
# in .env: PERCH_ALLOWED_HOSTS=<server>.<tailnet>.ts.net, then: systemctl --user restart perch
perch status                                    # every account with a live check
```

### 4. Connect Claude Code or Codex (laptop)

Paste the command `perch setup` printed (it reads the token over SSH, never shows it). Claude can then read and write in every connected account. Codex: see `docs/SETUP.md` §6.

### 5. Every further Claude or Codex account

- **In the Tailnet:** on the server `perch client add --label "Claude account 2" --full`, then paste the printed command on that device.
- **claude.ai over the internet** (web and phone): once set up public access (`docs/SETUP.md` §6a: Funnel, `perch public setup`); then per account `perch oauth pair` on the server, add the connector in claude.ai, enter pairing code, Google sign-in and Perch code in the browser, confirm with `y` in the terminal and choose `f` (full).

### 6. Later

- Another account: `perch <service> add --label …` or `perch setup` again. Full-access clients see it at once.
- Overview: `perch status` or `https://<server>.<tailnet>.ts.net/status` (browser password: content of `~/.config/perch/http-token`).
- Take access away: `perch client remove <client-…>`, `perch oauth revoke <oc-…>`, everything public at once: `perch public off`.
- A client that may only read or only some accounts: `perch client add --allow … --account …`, or use the global token (read-only).

Full details in [`docs/SETUP.md`](docs/SETUP.md) (German).

## Live test, step by step

Perch has only been tested against mocks; the first real run follows the onboarding above. Before connecting real accounts run `npm run check` (must be green). After every connector run `perch status` and note what fails (it ends up in `docs/PHASE1_REMAINING.md` §1).

1. **Onboarding steps 1–4** with one account per service you use.
2. **Read** in Claude Code: "list my Perch accounts", "search Drive for X", "latest mails about Y", "what was said about Z in Slack and WhatsApp", "my events next week", "my Luma events".
3. **Write, only to yourself:** send one mail to yourself, post in a private Slack test channel, create a test Notion page and a test Drive file, move the test mail to the trash. Repeat one send with the same `requestId`: it must answer `replayed: true` and send nothing. Check `perch audit list`.
4. **Optional, public access:** only after 1–3 work; read the known gaps in `docs/PHASE1_REMAINING.md` §3 first. Kill switch: `perch public off`.
5. **Report back:** per connector "works" or the message from `perch status`, plus the live questions in `docs/PHASE1_REMAINING.md` §1.

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
| `src/whatsapp/` | GOWA bridge: install (pinned download, ZIP reader, systemd unit), instance, pairing, chats, messages, sending |
| `src/messaging/` | idempotent send flow for Slack and WhatsApp (shares the ledger with mail) |
| `src/oauth/` | PKCE loopback, refresh with single-flight and rotation (fail closed) |
| `src/mail/` | MailService, MIME building, Gmail, Graph and IMAP/SMTP adapters, GMX presets, send workflow and ledger |
| `src/microsoft/` | Microsoft OAuth and accounts |
| `src/store/` | encrypted credential store, lock |
| `src/secureFs.ts` | permissions, symlinks, atomic writes |
| `src/upstream.ts` | fixed origins, allowlist with capability tags, timeouts and size limits, sanitised errors |
| `src/google/` | OAuth (loopback and PKCE), token refresh, Drive, Calendar, Contacts, productivity grant, Google account groups (one login: `group.ts`, `groupStore.ts`) |
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

- Fewer provider steps: ship a frilabs Microsoft app id as default (no Entra registration per installation); optionally a Google-verified frilabs app
- Docker/Compose, backup, migrations
- Rollover for the send ledger (Mail, Slack and WhatsApp share 1000 send records per namespace)
- Changing single occurrences of a recurring event
- Live tests for all connectors
- LinkedIn is out of scope

## License

MIT, see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
