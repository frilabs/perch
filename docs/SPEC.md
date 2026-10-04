# Spezifikation: Perch MVP (read-only Google Drive + Notion, Multi-Account)

Stand 2026-10-05.

**Status:** Freigegeben. Fritz hat die Vorgaben am 2026-10-05 über den Orchestrator geliefert und mit „Implement … actual work“ freigegeben (siehe `docs/BRIEFING.md`). Diese Spezifikation ersetzt den Platzhalter-Stand.

**Revision 2026-10-05 (Review-Fixes):** Fritz hat über den Orchestrator Korrekturen aus einem unabhängigen Review beauftragt. Sie betreffen:
- Lock, `init`, Krypto-Längen, Dateiprüfungen
- Fehlertoleranz der Abfragen über mehrere Konten
- Refresh-Fail-Closed
- Notion-Rate-Limits
- Ausgabegrößen, Timeout-Grenze

Der Funktionsumfang bleibt unverändert.

## 1. Architektur

```
Laptop (Claude Code) ──HTTPS (Tailscale Serve) oder SSH-Tunnel──▶ Heimserver
                                                                    │
                                     perch serve --http (127.0.0.1:8765)
                                                                    │
                     ┌───────────────────── Credential Store (AES-256-GCM) ─┐
                     │  Google-Konten (Refresh-Token je Konto)              │
                     │  Notion-Workspaces (PAT je Workspace)                │
                     └──────────────────────────────────────────────────────┘
                                         │ feste Upstream-Origins
               https://www.googleapis.com, https://oauth2.googleapis.com, https://api.notion.com
```

- **Sprache und Laufzeit:** TypeScript (ESM), Node.js ≥ 22.12 (Vorgabe der Test-Toolchain, siehe `package.json`), `@modelcontextprotocol/sdk` 1.x (stabil) und `zod`.
- **Ein Binary, `perch`:**
  - `serve`: MCP-Server über stdio oder HTTP
  - Kontenverwaltung: nur über die lokale CLI
- **Transporte:**
  - stdio
  - zustandsloses Streamable HTTP: `POST /mcp`, JSON-Antworten, pro Request ein neuer Server und ein neuer Transport

## 2. Konfiguration

Nur Umgebungsvariablen. Secrets sind nie CLI-Argumente.

| Variable | Default | Zweck |
| --- | --- | --- |
| `PERCH_DATA_DIR` | `$XDG_DATA_HOME/perch` bzw. `~/.local/share/perch` | verschlüsselte DB `store.enc`, Lock-Datei |
| `PERCH_KEY_FILE` | `$XDG_CONFIG_HOME/perch/store.key` bzw. `~/.config/perch/store.key` | 32-Byte-Schlüssel; darf **nicht** im Datenverzeichnis liegen |
| `PERCH_HTTP_TOKEN_FILE` | `$XDG_CONFIG_HOME/perch/http-token` | Bearer-Token für HTTP |
| `PERCH_HTTP_TOKEN` | – | Alternative zur Token-Datei (Env) |
| `PERCH_HTTP_HOST` | `127.0.0.1` | Bind-Adresse |
| `PERCH_HTTP_PORT` | `8765` | Port |
| `PERCH_ALLOWED_HOSTS` | Loopback-Varianten mit Port | zusätzliche erlaubte `Host`-Header, kommagetrennt |
| `PERCH_ALLOWED_ORIGINS` | leer | erlaubte `Origin`-Header. Ein vorhandener `Origin` außerhalb der Liste wird abgelehnt. |
| `PERCH_GOOGLE_CLIENT_FILE` | – | Pfad zur heruntergeladenen JSON des Google-Desktop-OAuth-Clients |

## 3. Credential Store

- **Datei:** `store.enc` als JSON-Umschlag `{v, alg:"AES-256-GCM", kid, iv, tag, ct}`.
  - Der Klartext ist zod-validiertes JSON.
  - AAD bindet Format und Version.
  - Pro Schreibvorgang wird ein neuer IV mit 12 zufälligen Bytes erzeugt.
  - Beim Lesen sind die Längen fest: IV 12 Byte, Tag 16 Byte (`authTagLength: 16`). Nur kanonisches Base64 wird akzeptiert. Gekürzte Tags oder IVs gelten als Formatfehler.
- **Schlüssel:** 32 zufällige Bytes, Base64, in einer eigenen Datei außerhalb des Datenverzeichnisses. `kid` ist ein Fingerprint aus `SHA-256("perch-kid"‖key)` und lässt keine Rückschlüsse auf den Schlüssel zu.
- **`perch init`:**
  - Legt Schlüssel, leere DB und HTTP-Token an, aber nur, was fehlt.
  - Prüfen und Anlegen laufen unter dem Store-Lock. Schlüssel, DB und Token entstehen ohne Überschreiben (Temp-Datei plus `link()`, das bei Existenz mit `EEXIST` scheitert). Parallele `init`-Aufrufe einigen sich so auf genau einen Schlüssel.
  - Ein vorhandenes HTTP-Token (Datei oder `PERCH_HTTP_TOKEN`) muss die Mindeststärke erfüllen, sonst endet `init` mit einem Fehler.
  - Existiert die DB, fehlt aber der Schlüssel, endet `init` mit einem **Fehler**. Es gibt keinen stillen Rekey.
  - Andere Befehle legen nie einen Schlüssel an.
- **Fehlerfälle:**
  - Falscher Schlüssel (`kid` passt nicht) → Fehler „wrong key“.
  - Manipulierte Datei (GCM-Tag) → Fehler „integrity check failed“. Es wird nie mit Teildaten weitergearbeitet.
- **Dateirechte:**
  - Verzeichnisse, die Perch selbst anlegt, bekommen `0700` (jede neu angelegte Ebene). Dateien bekommen `0600`.
  - **Bestehende Verzeichnisse werden nie per `chmod` verändert.** Ist ein vorhandenes Verzeichnis ein Symlink, gehört es einem anderen Nutzer oder ist es für Gruppe oder andere zugänglich, bricht Perch mit einem `chmod 700`-Hinweis ab. Beispiel: `PERCH_KEY_FILE=~/store.key` mit `$HOME` auf `0755`.
  - Dateien werden mit `O_NOFOLLOW | O_NONBLOCK` geöffnet. Typ (reguläre Datei), Rechte (keine für Gruppe oder andere) und Eigentümer prüft Perch per `fstat` **auf dem geöffneten Handle**. Symlinks, Verzeichnisse und FIFOs werden abgelehnt.
- **Atomares Schreiben:** Temporärdatei im selben Verzeichnis (`O_EXCL`, `0600`), dann `fsync`, `rename`, `fsync` des Verzeichnisses.
- **Nebenläufigkeit:**
  - Schreibzugriffe laufen als Read-Modify-Write auf frisch gelesenen Daten unter einem prozessübergreifenden Lock.
  - Der Lock ist das atomar per `mkdir` angelegte Verzeichnis `store.lock` mit einer `owner`-Datei, die ein zufälliges Token enthält.
  - Freigegeben wird nur, wenn das Token das eigene ist. Ein fremder Lock wird nie entfernt.
  - **Es gibt keine automatische Übernahme verwaister Locks.** Mit reinen Dateisystem-Operationen lässt sie sich nicht race-frei umsetzen.
  - Ist ein Lock älter als 60 s, schlagen Schreibzugriffe sofort fehl (fail closed). Die Meldung nennt den manuellen Ausweg: `rm -r '<data>/store.lock'`, aber nur, wenn kein Perch-Prozess läuft. Ein jüngerer Lock wird bis zu 15 s abgewartet.
  - Lesende prüfen bei jedem Zugriff `mtime`, Größe und Inode und entschlüsseln bei Änderung neu. So sieht ein laufender MCP-Server neu hinzugefügte oder getrennte Konten sofort.
- **Inhalt:**
  - Google: `id`, `label`, `email`, `displayName`, `clientId`, `clientSecret`, `refreshToken`, `scopes`, Zeitstempel
  - Notion: `id`, `label`, `token`, `tokenOwner` (von `/users/me` berichtet, rein informativ), Zeitstempel
  - IDs sind stabil, zufällig und tragen ein Präfix (`google-xxxxxxxx`, `notion-xxxxxxxx`).

## 4. Google OAuth (Desktop, Loopback, PKCE)

`perch google add --label <Label> [--port <n>] [--timeout <s>]`

1. Die Client-JSON wird aus `PERCH_GOOGLE_CLIENT_FILE` gelesen (`installed.client_id/client_secret`).
2. Perch erzeugt `state` (32 zufällige Bytes) und einen PKCE-`code_verifier` (32 Bytes, base64url) und bildet daraus `code_challenge` mit S256.
3. Ein Loopback-Server lauscht auf `127.0.0.1:<port>`, Pfad `/oauth2/callback`.
4. Die Auth-URL wird **ausgegeben** (kein Auto-Open). Parameter:
   - `scope=https://www.googleapis.com/auth/drive.readonly`
   - `access_type=offline`
   - `prompt=consent`
   - `include_granted_scopes=false`
5. Prüfung des Callbacks:
   - Falscher Pfad → 404.
   - Falscher oder fehlender `state` (Vergleich in konstanter Zeit) → 400. Der Flow wartet weiter, bis zum Timeout.
   - Erst nach gültigem `state` wird der Code getauscht. Ein `error`-Parameter mit gültigem `state` bricht ab.
   - Nach Ablauf (Default 300 s) wird abgebrochen.
6. Beim Token-Tausch wird `code_verifier` mitgeschickt. Danach prüft Perch:
   - Ein `refresh_token` muss vorhanden sein.
   - Die gewährten `scope` müssen `drive.readonly` enthalten. `drive.file` allein reicht nicht.
7. Die Identität kommt aus `GET drive/v3/about?fields=user(emailAddress,displayName)`. Dafür ist kein zusätzlicher Scope nötig.
8. Existiert dieselbe E-Mail schon, wird abgelehnt (erst `remove`).

**Refresh:**
- Im Speicher läuft ein Access-Token-Cache mit 60 s Puffer. Gleichzeitige Refreshes pro Konto werden zusammengelegt (single-flight).
- Liefert Google ein neues `refresh_token`, wird es unter Lock persistiert. Fehlt es, bleibt das alte erhalten.
- **Fail closed bei Änderungen während des Refresh:** Wurde das Konto entfernt oder neu autorisiert (anderer Refresh-Token), gibt Perch einen Fehler zurück. Das neue Access-Token wird dann weder gecacht noch ausgegeben.
- Lässt sich ein rotierter Refresh-Token nicht speichern (z. B. bei verwaistem Lock), gibt Perch einen Fehler mit Reconnect-Hinweis zurück. Der Token erscheint dabei nie in der Meldung, und nichts wird gecacht.
- `invalid_grant` führt zu einer klaren Meldung mit `perch google remove <id>` und `perch google add --label <label>`. Das nutzerdefinierte Label wird nie in einen Shell-Befehl eingesetzt.
- `--timeout`: ganze Sekunden zwischen 1 und 3600.

**Remove:**
- `perch google remove <id> [--revoke]` löscht das Konto lokal.
- Mit `--revoke` widerruft Perch zusätzlich den Refresh-Token per `POST https://oauth2.googleapis.com/revoke`.

**Nutzeraufgabe:** Google-Cloud-Projekt, Desktop-OAuth-Client und Consent Screen einrichten. Bei externen Apps im Testing-Status verfallen Refresh-Tokens nach 7 Tagen.

## 5. Notion (PAT pro Workspace)

- `perch notion add --label <Label>`:
  - Das PAT wird maskiert über das TTY eingelesen. Ohne TTY bricht der Befehl ab.
  - Perch validiert das PAT per `GET /v1/users/me` und speichert den Token-Eigentümer als Information.
  - Das Label vergibt der Nutzer. Perch behauptet keine verifizierte Workspace-Identität.
- `perch notion list` / `perch notion remove <id>`:
  - `remove` trennt nur lokal.
  - Das PAT selbst widerruft der Nutzer in den Notion-Einstellungen.
- Jeder Request sendet `Authorization: Bearer`, `Notion-Version: 2026-03-11`.
- **Read-only-Allowlist** auf Transportebene (alles andere wird vor dem Netzwerkzugriff abgelehnt):
  - `GET /v1/users/me`
  - `POST /v1/search`
  - `GET /v1/pages/{id}`
  - `GET /v1/blocks/{id}/children`
  - `GET /v1/databases/{id}`
  - `GET /v1/data_sources/{id}`
  - `POST /v1/data_sources/{id}/query`

## 6. MCP-Tools (alle read-only)

Jedes Ergebnis trägt `accountId`/`workspaceId` und das Label als Herkunftsangabe.

| Tool | Zweck |
| --- | --- |
| `perch_list_accounts` | Google-Konten und Notion-Workspaces ohne Secrets |
| `drive_search` | Volltext- oder Namenssuche. `accountId` optional, ohne Angabe über alle Konten. Zusammengesetzter Cursor, `hasMore`, `partial` und `errors[]` |
| `drive_list_files` | Dateien listen (optional Ordner). `accountId` optional, außer wenn `folderId` gesetzt ist |
| `drive_get_file` | Metadaten |
| `drive_read_file` | Inhalt als Text. Native Docs → `text/markdown`, Sheets → `text/csv` (erstes Blatt), Slides → `text/plain`. Binärdateien → Fehler mit Hinweis auf Download |
| `drive_download_file` | Nicht-native Datei als Base64 |
| `drive_export_file` | Native Datei in einem validierten Zielformat. Text-Formate als Text, sonst Base64 |
| `notion_search` | Titelsuche nach Seiten und Data Sources (`workspaceId` optional, Filter `page`/`data_source`). Ausdrücklich keine Volltextsuche |
| `notion_get_page` | Seitenobjekt mit Properties |
| `notion_get_page_content` | Blöcke paginiert. Kinder werden verschachtelt bis `maxDepth` geladen, insgesamt höchstens `maxBlocks`. Nicht geladene Kinder sind markiert und haben einen Cursor |
| `notion_get_block_children` | Eine Ebene Kinder mit Cursor |
| `notion_get_database` | Database inklusive `data_sources` |
| `notion_get_data_source` | Data Source (Schema) |
| `notion_query_data_source` | Abfrage mit optionalem `filter`/`sorts` und Cursor |

**Größengrenzen:**
- `maxBytes`: Default 48 KiB, explizit bis 10 MiB.
  - Der Default ist klein, weil MCP-Clients die Tool-Ausgabe begrenzen (Claude Code: `MAX_MCP_OUTPUT_TOKENS`).
  - Base64 vergrößert die Daten um etwa 33 %.
  - Es gibt keine Offset-Pagination für Dateiinhalte.
- Tool-Antworten sind kompaktes JSON ohne Einrückung.
- Ist die bekannte Dateigröße größer als `maxBytes`, lehnt Perch ab, bevor geladen wird.
- Beim Streaming bricht Perch beim Überschreiten ab.
- Es wird nie ins Dateisystem geschrieben.

**Seitengrößen:** Default 25, Maximum 100 (pro Konto).

## 7. HTTP-Sicherheit

- **Bind-Adresse:**
  - Default `127.0.0.1`.
  - Erlaubt sind nur Loopback, Tailscale-IPv4 (`100.64.0.0/10`) und Tailscale-IPv6 (`fd7a:115c:a1e0::/48`).
  - `0.0.0.0`, `::` und andere Adressen werden abgelehnt.
- **Bearer-Token:**
  - Ohne Token startet der HTTP-Modus nicht (fail closed).
  - Mindestens 43 Zeichen, also ≥ 32 Byte Entropie.
  - Verglichen wird in konstanter Zeit (SHA-256 beider Werte, dann `timingSafeEqual`).
- **Prüfreihenfolge:**
  1. `Host`-Allowlist → 403
  2. `Origin` vorhanden und nicht in der Allowlist → 403
  3. Auth fehlt oder falsch → 401
  4. nur `POST /mcp` (sonst 404/405)
  5. Body höchstens 1 MiB
- Zusätzlich ist der DNS-Rebinding-Schutz des SDK-Transports aktiv.
- **Remote-Zugriff:**
  - Empfohlen: `tailscale serve` (HTTPS) auf `127.0.0.1:8765` oder `ssh -L`.
  - Perch selbst ändert nichts an Tailscale.

## 8. Upstream-Zugriff

- Die Origins sind fest:
  - `https://www.googleapis.com`
  - `https://oauth2.googleapis.com`
  - `https://api.notion.com`
- Es gibt keine nutzerdefinierten URLs. IDs werden per Regex geprüft und URL-kodiert.
- Den Transport kann man nur im Testcode injizieren (Fake-Upstreams, als MOCK gekennzeichnet).
- **Begrenzungen:**
  - Timeout 30 s
  - Größenlimit pro Antwort (JSON 5 MiB, Inhalte nach `maxBytes`)
  - `redirect: "error"`
- **Notion-Rate-Limits:**
  - HTTP 429 wird pro Request höchstens 3-mal wiederholt, pro Tool-Aufruf insgesamt höchstens 6-mal.
  - Gewartet wird gemäß `Retry-After`. Der Wert wird nur in Sekundenform übernommen (sonst 1 s) und auf 10 s begrenzt.
  - `notion_get_page_content` gibt bei Fehlern in verschachtelten Abrufen das bereits Geladene zurück: `partial: true`, `errors[]`, `childrenError` am Block, `truncated: true`. Nach einem 429-Fehler folgen keine weiteren verschachtelten Requests.
- **Abfragen über mehrere Konten:**
  - Fällt eine Quelle aus, bleibt ihr Cursor erhalten, und die nächste Seite versucht sie erneut.
  - Nach 3 Fehlversuchen in Folge gibt Perch die Quelle auf. Danach meldet jede weitere Seite sie in `errors[]` mit `partial: true`. Unvollständigkeit verschwindet also nie still.
- **Fehlermeldungen** sind generisch und bereinigt: HTTP-Status plus höchstens ein Fehlercode aus `[A-Za-z_]{1,64}` (z. B. `object_not_found`, `invalid_grant`, `notFound`). Antwort-Bodies, Tokens und OAuth-Codes landen nie in Fehlern oder Logs.

## 9. Tests (vitest)

- Crypto: Roundtrip, Manipulation, falscher oder fehlender Schlüssel, Dateirechte, Symlinks
- Atomares Schreiben, Lock und Nebenläufigkeit, auch mit echten Subprozessen: parallele Writer, verwaister Lock nach SIGKILL, parallele `init`-Aufrufe
- Mehrere Konten mit Herkunftsangaben, zusammengesetzte Cursor, Teilergebnisse
- OAuth: falscher `state`, PKCE-Prüfung, Ablauf, gewährte Scopes, fehlender Refresh-Token, Refresh mit Erhalt des alten Tokens, Single-Flight
- Notion: Pagination, `Notion-Version`, Read-only-Allowlist
- Größengrenzen beim Download, kein Schreiben ins Dateisystem
- HTTP: Auth fehlt, falsch oder korrekt; falscher Host, falscher Origin
- Echter SDK-Client: `initialize`, `listTools`, `callTool` mit leerer Konfiguration über lokales HTTP
- Smoke-Test des gebauten Artefakts über stdio und HTTP
- **Kennzeichnung:** Alle Upstream-Fakes sind als MOCK markiert. Alle Secrets in Tests sind generierte Dummy-Werte. Es gibt keine Live-Integrationstests.

## 10. Nicht im Umfang

- UI
- Schreibzugriff
- Deployment
- Änderungen an Tailscale
- Gmail, Calendar, Contacts (Roadmap)
- WhatsApp (höchstens experimentell, später)
- LinkedIn (ausgeschlossen)
