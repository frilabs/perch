# Briefing: Perch

Stand 2026-10-05. Dieses Briefing ersetzt den Platzhalter-Stand aus `docs/HANDOFF.md`.

**Herkunft und Freigabe:** Fritz hat das folgende Briefing samt Spezifikationsvorgaben am 2026-10-05 über den Orchestrator geliefert. Mit dem Auftrag „Implement … actual work“ hat er es ausdrücklich freigegeben. Die daraus abgeleitete Spezifikation steht in `docs/SPEC.md`.

## Problem

Fritz arbeitet mit mehreren Google-Konten (Drive) und mehreren Notion-Workspaces. Claude Code auf dem Laptop soll alle davon lesen können. Dabei soll es keinen Kontowechsel, kein manuelles Teilen einzelner Dateien und keine eigene Connector-Konfiguration pro Konto geben.

## Zielbild

- **Ein** zentraler MCP-Connector („Perch“). Er läuft auf dem Heimserver und wird auf dem Claude-Code-Laptop **einmal** konfiguriert. Der Zugriff läuft über Tailscale: per HTTPS mit Tailscale Serve oder per SSH-Tunnel.
- Perch stellt alle separat autorisierten Google-Konten und Notion-Workspaces gleichzeitig bereit. Jedes Ergebnis trägt eine Herkunftsangabe (Konto-ID und Label).
- **Nur Lesezugriff.** Es gibt keine UI.
- Konten werden ausschließlich lokal per CLI auf dem Server verwaltet.

## Kernfunktionen (MVP)

1. **Google Drive** (mehrere Konten, je eigener OAuth-Grant mit `drive.readonly`):
   - Konten auflisten
   - Dateien listen und suchen, optional über alle Konten
   - Metadaten abrufen
   - Inhalte lesen, herunterladen und exportieren (native Docs/Sheets/Slides)
   - Antworten sind größenbegrenzt und kommen als Text oder Base64, nie als Dateipfad
2. **Notion** (mehrere Workspaces, je ein Personal Access Token, kein internes Bot-Integration-Token):
   - Workspaces hinzufügen, auflisten und trennen
   - Titelsuche über Seiten und Data Sources
   - Database abrufen, Data Source abfragen
   - Seiteninhalt blockweise und paginiert lesen, auch verschachtelt
   - Cursor, `has_more` und Teilergebnisse werden klar ausgewiesen. Perch verspricht **keine** Volltextsuche.
3. **Sicherheit:**
   - Verschlüsselte zentrale Token-Datenbank (AES-256-GCM), Schlüssel getrennt abgelegt
   - Bearer-Auth, die bei Fehlern sperrt (fail closed)
   - Allowlists für Host und Origin
   - Standardmäßig nur Loopback. Remote-Zugriff nur über eine explizit angegebene Tailscale-IP.

## Plattform

- TypeScript und Node.js mit dem offiziellen `@modelcontextprotocol/sdk` (stabile v1) und `zod`
- Transporte: stdio und zustandsloses Streamable HTTP
- Betrieb auf dem Heimserver

## Nicht im Umfang

- UI
- Schreibzugriff
- Deployment und Änderungen an Tailscale
- Echte Secrets oder Live-Integrationstests
- Commits, Pushes und Merges (macht der Orchestrator)

## Roadmap (später, nicht Teil dieses MVP)

- Gmail, Calendar, Contacts (read-only, gleiche Kontenverwaltung)
- WhatsApp: höchstens experimentell, später
- LinkedIn: ausdrücklich **ausgeschlossen**

## Vom Orchestrator am 2026-10-05 verifizierte Primärquellen

- Notion Personal Access Tokens: <https://developers.notion.com/guides/get-started/personal-access-tokens>
  - Ein PAT gehört zu **einem** Workspace und erbt die Seitenrechte seines Erstellers.
  - Es ist kein „Add connections“-Sharing nötig.
  - Die API-Fähigkeit des Tokens umfasst Lesen und Schreiben. Perch nutzt davon nur Lesen.
  - Admins können PATs einschränken. Gäste und eingeschränkte Mitglieder können keine erstellen.
  - Ein PAT gilt höchstens ein Jahr. Nach einem Widerruf ist der Zugriff weg.
  - Header: `Authorization: Bearer`, `Notion-Version: 2026-03-11`.
  - `GET /v1/users/me` liefert den autorisierten Nutzer, aber keine garantierte Workspace-Identität. Deshalb vergibt der Nutzer das Label selbst.
- Notion Search: <https://developers.notion.com/reference/post-search>
  - Durchsucht Titel von Seiten und Data Sources mit Cursor. Volltext ist nicht garantiert.
  - `GET /v1/databases/{id}` liefert `data_sources`.
  - `POST /v1/data_sources/{id}/query` ist eine Leseoperation.
- Google Drive Scopes: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
  - `drive.readonly` ist ein Restricted Scope. Das hat Folgen für die App-Verifizierung.
  - `drive.file` ist nicht gewünscht.
- Google OAuth für Native Apps: <https://developers.google.com/identity/protocols/oauth2/native-app> (Desktop-Client, Loopback-Redirect, PKCE)
- MCP TypeScript SDK (Server): <https://ts.sdk.modelcontextprotocol.io/server> (zustandsloses Streamable HTTP und stdio)
