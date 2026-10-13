# Perch

Perch ist ein MCP-Server. Er bündelt **mehrere Google-Drive-Konten**, **mehrere Notion-Workspaces**, **mehrere Mail-Konten** (Gmail, Outlook.com/Microsoft 365, GMX bzw. IMAP/SMTP), **mehrere Google-Calendar/Contacts-Konten**, **mehrere Slack-Workspaces** und **WhatsApp** (über eine selbst gehostete GOWA-Bridge) hinter **einem** Connector, für Claude Code, Codex und andere MCP-Clients. Standardmäßig ist alles read-only. Mail-Entwürfe, Versand (Mail, Slack, WhatsApp) und das Anlegen/Ändern privater Kalendertermine gibt es nur über explizite lokale Client-Grants pro Konto.

- Läuft auf dem Heimserver.
- Claude Code auf dem Laptop bindet ihn einmal ein, per Tailscale Serve (HTTPS) oder SSH-Tunnel.
- Kein Kontowechsel, kein Teilen einzelner Dateien.
- Jedes Ergebnis trägt Konto- bzw. Workspace-ID und Label als Herkunftsangabe.

Stand 2026-10-14:
- Drive/Notion, Mail, Calendar/Contacts, Nutzer-Isolation, Mail-Workflow und Slack/WhatsApp sind implementiert und lokal mit Mock-Upstreams bzw. lokalen Testservern getestet.
- **Nicht** live gegen Google, Notion, Microsoft oder GMX verifiziert.
- Nicht deployed.

## Funktionen

- **Google Drive** (`drive.readonly`, je Konto ein eigener OAuth-Grant):
  - suchen und listen, optional über alle Konten
  - Metadaten
  - Text lesen, Base64-Download
  - Export von Docs, Sheets und Slides in validierte Formate
  - Größenlimit: Default 48 KiB wegen der Client-Ausgabelimits, explizit bis 10 MiB
  - nie ins Dateisystem
- **Notion** (je Workspace ein Personal Access Token):
  - Titelsuche über Seiten und Data Sources (keine Volltextsuche)
  - Seiten und paginierte, verschachtelte Blockinhalte
  - Databases, Data Sources und Data-Source-Abfragen
- **Mail** (`docs/EMAIL_MILESTONE.md`):
  - Gmail: eigener OAuth-Grant, Default `gmail.readonly`, Opt-in `gmail.send`/`gmail.compose`
  - Microsoft Graph: delegiert mit PKCE, Default `Mail.Read`, Opt-in `Mail.ReadWrite`/`Mail.Send`
  - IMAP/SMTP (GMX-Presets): Passwort nur maskiert, TLS ≥ 1.2 mit Zertifikatsprüfung
  - suchen, lesen, Anhänge; Entwürfe und Senden mit explizitem Absenderkonto
  - Threading-Header; Ergebnis `accepted`/`rejected`/`indeterminate`, kein Blind-Retry
- **Google Calendar/Contacts** (`docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`):
  - eigener OAuth-Grant, Dienste explizit per `--services calendar,contacts`, Default `calendar.readonly`/`contacts.readonly`, Opt-in `calendar.events.owned`
  - Kalender und Termine lesen; private Termine anlegen (idempotent per `requestId`) und ändern (`If-Match`), ohne Teilnehmer, Einladungen oder Benachrichtigungen
  - Kontakte seitenweise lesen (keine Suche)
- **Slack** (`docs/SLACK_WHATSAPP_MILESTONE.md`, je Workspace eine interne App mit User-Token, Manifest in `docs/slack-app-manifest.json`):
  - Kanäle, private Kanäle, DMs und Gruppen-DMs auflisten; Verlauf und Threads lesen; Slack-Suche über alle Workspaces
  - Posten als der verbundene Nutzer (auch in Threads), nur mit Client-Grant `slack_send`, idempotent per `requestId`
- **WhatsApp** über GOWA (inoffiziell, selbst gehostet, nur localhost):
  - Koppeln per Kopplungscode über die CLI, mehrere Konten in getrennten Geräte-Slots
  - Chats auflisten, Nachrichten lesen und durchsuchen (Suche über die jüngsten Chats); Medien nur als Metadaten
  - Textnachrichten senden nur mit Client-Grant `whatsapp_send`, idempotent per `requestId`
- **Client-Grants:** `perch client add --allow read,draft,send|calendar_read,calendar_write,contacts_read|slack_read,slack_send|whatsapp_read,whatsapp_send --account …`. Das globale HTTP-Token bleibt read-only.
- **Admin-angelegte Nutzer** (`docs/USER_ISOLATION_MILESTONE.md`, nur mit Mocks getestet): `perch user add|list|remove`. Jeder Nutzer bekommt einen eigenen verschlüsselten Store und Schlüssel, ein Read-only-Token und eigene Client-Grants (`PERCH_USER=<id> perch …`). Jedes Token gilt in genau einem Namespace; Mitgliedschaft und Grants prüft Perch vor jedem Tool-Aufruf neu. Keine öffentliche Registrierung, keine gehärtete Mandantenfähigkeit.
- **Transporte:** stdio und zustandsloses Streamable HTTP (`POST /mcp`)
- **Sicherheit:**
  - verschlüsselter Credential Store (AES-256-GCM, Schlüssel separat abgelegt)
  - Bearer-Auth, die bei Fehlern sperrt
  - Allowlists für Host und Origin
  - nur Loopback oder eine explizite Tailscale-IP
  - Read-only-Allowlist für alle Upstream-Endpunkte
  - feste Upstream-Origins, bereinigte Fehlermeldungen

## Schnellstart

```bash
git clone https://github.com/FritzKuermayr/perch.git perch && cd perch
npm ci && npm run build
node dist/cli.js init
node dist/cli.js notion add --label "Privat"          # PAT maskiert eingeben
PERCH_GOOGLE_CLIENT_FILE=~/.config/perch/google-client.json \
  node dist/cli.js google add --label "Privat" --port 8766
node dist/cli.js serve --http                          # 127.0.0.1:8765, Bearer-Token aus ~/.config/perch/http-token
```

Die vollständige Anleitung steht in [`docs/SETUP.md`](docs/SETUP.md): Google-Cloud-Einrichtung, Tailscale bzw. SSH, Claude-Code-Konfiguration, Widerruf und Grenzen.

## Entwicklung

```bash
npm run typecheck
npm test          # vitest; Google (Drive/Gmail/Calendar/People)/Notion/Graph/Slack/GOWA nur als klar markierte Mocks, IMAP/SMTP gegen lokale Testserver
npm run smoke     # baut und testet dist/cli.js über stdio und HTTP
```

| Datei | Zweck |
| --- | --- |
| `src/cli.ts`, `src/cli/` | CLI (`init`, `serve`, `google`, `notion`, `gmail`, `microsoft`, `imap`, `google-productivity`, `slack`, `whatsapp`, `client`, `accounts`, `token`) |
| `src/slack/` | Slack Web API (User-Token pro Workspace), App-Manifest |
| `src/whatsapp/` | GOWA-Bridge: Instanz, Koppeln, Chats, Nachrichten, Senden |
| `src/messaging/` | idempotenter Sende-Ablauf für Slack und WhatsApp (gemeinsamer Ledger mit Mail) |
| `src/auth/` | Client-Grants (read/draft/send pro Mail-Konto, calendar_read/calendar_write/contacts_read pro Calendar/Contacts-Konto), Principals |
| `src/oauth/` | PKCE-Loopback, Refresh mit Single-Flight und Rotation (fail closed) |
| `src/mail/` | MailService, MIME-Bau, Gmail-, Graph- und IMAP/SMTP-Adapter, GMX-Presets |
| `src/microsoft/` | Microsoft-OAuth und -Konten |
| `src/store/` | verschlüsselter Credential Store, Lock |
| `src/secureFs.ts` | Rechte, Symlinks, atomares Schreiben |
| `src/upstream.ts` | feste Origins, Allowlist mit Capability-Tags (read/draft/send/calendar_write), Timeouts und Größenlimits, bereinigte Fehler |
| `src/google/` | OAuth (Loopback und PKCE), Token-Refresh, Drive, Calendar, Contacts, Productivity-Grant |
| `src/notion/` | Notion (PAT, `Notion-Version: 2026-03-11`) |
| `src/fanout.ts` | Abfragen über mehrere Konten, zusammengesetzte Cursor, Teilergebnisse |
| `src/mcp/` | MCP-Tools, HTTP-Server |

## Dokumente

- [`docs/BRIEFING.md`](docs/BRIEFING.md): Briefing (freigegeben)
- [`docs/SPEC.md`](docs/SPEC.md): Spezifikation
- [`docs/SETUP.md`](docs/SETUP.md): Setup und Betrieb
- [`docs/EMAIL_MILESTONE.md`](docs/EMAIL_MILESTONE.md): E-Mail-Meilenstein (Spezifikation, TDD-Nachweise)
- [`docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`](docs/GOOGLE_PRODUCTIVITY_MILESTONE.md): Calendar/Contacts-Meilenstein (Spezifikation, TDD-Nachweise)
- [`docs/USER_ISOLATION_MILESTONE.md`](docs/USER_ISOLATION_MILESTONE.md): Nutzer-Isolations-Meilenstein (Spezifikation, TDD-Nachweise)
- [`docs/SLACK_WHATSAPP_MILESTONE.md`](docs/SLACK_WHATSAPP_MILESTONE.md): Slack/WhatsApp-Meilenstein (Entscheidungen, Allowlist, Grenzen)
- [`docs/PROJECT_SCOPE.md`](docs/PROJECT_SCOPE.md): erweiterte Projektrichtung
- [`docs/HANDOFF.md`](docs/HANDOFF.md): aktueller Stand
- [`AGENTS.md`](AGENTS.md): Arbeitsregeln

## Roadmap

- Body-freies Audit-Log und idempotenter Sende-Workflow; Docker/Compose, Backup, Migrationen
- Kalender-Einladungen, Serien, Löschen; Kontakte schreiben
- Live-Test Slack und WhatsApp; ältere WhatsApp-Historie nachladen
- LinkedIn ausgeschlossen
