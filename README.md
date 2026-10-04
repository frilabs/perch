# Perch

Perch ist ein read-only MCP-Server. Er bündelt **mehrere Google-Drive-Konten** und **mehrere Notion-Workspaces** hinter **einem** Connector.

- Läuft auf dem Heimserver.
- Claude Code auf dem Laptop bindet ihn einmal ein, per Tailscale Serve (HTTPS) oder SSH-Tunnel.
- Kein Kontowechsel, kein Teilen einzelner Dateien.
- Jedes Ergebnis trägt Konto- bzw. Workspace-ID und Label als Herkunftsangabe.

Stand 2026-10-05:
- Das MVP ist implementiert und lokal mit Mock-Upstreams getestet.
- **Nicht** live gegen Google oder Notion verifiziert.
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
npm test          # vitest; Google/Notion nur als klar markierte Mocks
npm run smoke     # baut und testet dist/cli.js über stdio und HTTP
```

| Datei | Zweck |
| --- | --- |
| `src/cli.ts`, `src/cli/` | CLI (`init`, `serve`, `google`, `notion`, `accounts`, `token`) |
| `src/store/` | verschlüsselter Credential Store, Lock |
| `src/secureFs.ts` | Rechte, Symlinks, atomares Schreiben |
| `src/upstream.ts` | feste Origins, Read-only-Allowlist, Timeouts und Größenlimits, bereinigte Fehler |
| `src/google/` | OAuth (Loopback und PKCE), Token-Refresh, Drive |
| `src/notion/` | Notion (PAT, `Notion-Version: 2026-03-11`) |
| `src/fanout.ts` | Abfragen über mehrere Konten, zusammengesetzte Cursor, Teilergebnisse |
| `src/mcp/` | MCP-Tools, HTTP-Server |

## Dokumente

- [`docs/BRIEFING.md`](docs/BRIEFING.md): Briefing (freigegeben)
- [`docs/SPEC.md`](docs/SPEC.md): Spezifikation
- [`docs/SETUP.md`](docs/SETUP.md): Setup und Betrieb
- [`docs/HANDOFF.md`](docs/HANDOFF.md): aktueller Stand
- [`AGENTS.md`](AGENTS.md): Arbeitsregeln

## Roadmap

- Gmail, Calendar, Contacts (read-only, gleiche Kontenverwaltung)
- WhatsApp höchstens experimentell, später
- LinkedIn ausgeschlossen
