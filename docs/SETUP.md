# Setup und Betrieb

Stand 2026-10-05. Alle Befehle laufen auf dem Heimserver, sofern nicht „Laptop“ dabeisteht.

> Perch ist lokal mit Mock-Upstreams getestet, aber **nicht live gegen Google oder Notion verifiziert** (siehe `docs/HANDOFF.md`).

## 1. Voraussetzungen und Build

- Node.js ≥ 22.12 und npm

```bash
git clone https://github.com/FritzKuermayr/perch.git perch && cd perch
npm ci
npm run build
npm test                  # Unit- und Integrationstests (Mocks)
npm run smoke             # baut und testet dist/cli.js über stdio und HTTP
```

CLI-Aufruf: `node dist/cli.js …`. Optional global per `npm link`, dann heißt der Befehl `perch …`. Unten steht der Kürze halber `perch`.

## 2. Initialisieren

```bash
perch init
```

Der Befehl legt drei Dinge an, aber nur, was noch fehlt. Rechte: Verzeichnisse `0700`, Dateien `0600`.

| Was | Default-Pfad | Variable |
| --- | --- | --- |
| Schlüssel (32 Byte) | `~/.config/perch/store.key` | `PERCH_KEY_FILE` |
| Verschlüsselte DB | `~/.local/share/perch/store.enc` | `PERCH_DATA_DIR` |
| HTTP-Bearer-Token | `~/.config/perch/http-token` | `PERCH_HTTP_TOKEN_FILE` |

- **Schlüssel separat sichern.** Ohne ihn lässt sich die DB nicht mehr entschlüsseln.
- Fehlt der Schlüssel, die DB existiert aber, bricht `perch init` ab. Perch erzeugt dann bewusst keinen neuen Schlüssel. Den alten aus dem Backup zurückspielen.
- Der Schlüssel muss außerhalb von `PERCH_DATA_DIR` liegen, sonst bricht Perch ab.
- Bestehende Verzeichnisse ändert Perch nie per `chmod`. Ist ein vorhandenes Zielverzeichnis für Gruppe oder andere zugänglich, bricht Perch mit einem Hinweis ab, z. B. bei `PERCH_KEY_FILE=~/store.key`. Ist das Verzeichnis für Perch gedacht: `chmod 700 <dir>`, sonst einen anderen Pfad wählen.
- Ein vorhandenes Token (Datei oder `PERCH_HTTP_TOKEN`) muss mindestens 43 Zeichen haben, sonst bricht `init` ab.

### Verwaister Lock (manuelle Wiederherstellung)

Schreibzugriffe auf die DB laufen unter dem Lock-Verzeichnis `$PERCH_DATA_DIR/store.lock`. Stirbt ein Prozess genau in diesem kurzen Moment (z. B. `kill -9`), bleibt der Lock liegen. Perch übernimmt ihn bewusst **nicht** automatisch, weil sich das nicht race-frei umsetzen lässt.

Ab 60 s Alter schlagen Schreibzugriffe mit einer Meldung fehl, die diesen Befehl nennt:

```bash
pgrep -af 'perch|dist/cli.js'           # sicherstellen, dass kein Perch-Prozess mehr läuft
rm -r ~/.local/share/perch/store.lock    # dann den verwaisten Lock entfernen
```

Betroffen sind Kontenänderungen und das Speichern rotierter Google-Refresh-Tokens. Lesen funktioniert weiter.

Weitere Variablen stehen in `.env.example`. Laden geht zum Beispiel so: `node --env-file=.env dist/cli.js …`.

## 3. Google-Konten verbinden (Nutzeraufgabe: App-Credentials)

### 3.1 Google Cloud einmalig einrichten

Diese Einrichtung macht Fritz selbst. Perch kann sie nicht übernehmen.

1. In der Google Cloud Console ein Projekt anlegen und die **Google Drive API** aktivieren.
2. Auth-Plattform bzw. OAuth-Zustimmungsbildschirm einrichten:
   - Den Scope `https://www.googleapis.com/auth/drive.readonly` eintragen.
   - Im Status „Testing“ jedes Google-Konto als Testnutzer hinzufügen.
3. Einen OAuth-Client vom Typ **„Desktop app“** erstellen und die JSON-Datei herunterladen, dann:

```bash
install -m 600 ~/Downloads/client_secret_XXXX.json ~/.config/perch/google-client.json
export PERCH_GOOGLE_CLIENT_FILE=~/.config/perch/google-client.json
```

**Hinweise zu Google** (Stand der Google-Dokumentation, bitte dort prüfen):

- `drive.readonly` ist ein *restricted scope*.
- Im Status „Testing“ laufen Refresh-Tokens nach 7 Tagen ab. Danach das Konto entfernen und neu hinzufügen.
- Für eine veröffentlichte App mit restricted scope verlangt Google eine Verifizierung. Ohne sie erscheint ein Warnhinweis „unverified app“.

### 3.2 Ein Konto hinzufügen (einmal pro Google-Konto)

```bash
perch google add --label "Privat" --port 8766
```

1. Perch gibt eine Google-Auth-URL aus.
2. Die URL im Browser öffnen, das gewünschte Konto wählen und **den Drive-Haken setzen**.
3. Google leitet auf `http://127.0.0.1:8766/oauth2/callback` um. Läuft der Browser auf dem Laptop und nicht auf dem Server, vorher auf dem Laptop den Port weiterleiten:

```bash
ssh -N -L 8766:127.0.0.1:8766 homeserver
```

**Was Perch prüft:**
- Pfad, `state` (zufällig, wird vor dem Code-Tausch geprüft), PKCE S256 und Timeout (Default 300 s, `--timeout` 1–3600 s)
- Ob ein Refresh-Token vorhanden ist
- Ob `drive.readonly` tatsächlich gewährt wurde

**Weitere Konten:** Jedes Konto ist ein eigener Grant mit eigenem Label.

```bash
perch google add --label "Arbeit" --port 8766
```

Die Identität (E-Mail) liest Perch über die Drive-API aus. Ein zweiter Grant für dieselbe E-Mail wird abgelehnt.

## 4. Notion-Workspaces verbinden (PAT pro Workspace)

1. In Notion pro Workspace ein **Personal Access Token** erstellen. Anleitung: <https://developers.notion.com/guides/get-started/personal-access-tokens>
   - Das Token gilt für genau einen Workspace und erbt die Seitenrechte seines Erstellers.
   - Admins können PATs einschränken. Gäste und eingeschränkte Mitglieder können keine erstellen.
   - Das Token läuft nach höchstens einem Jahr ab.
2. Das Token eintragen. Die Eingabe ist maskiert und funktioniert nur in einem interaktiven Terminal. Als Argument, über eine Pipe oder im Log nimmt Perch es nie entgegen.

```bash
perch notion add --label "Privat-Notion"
```

Perch prüft das Token mit `GET /v1/users/me` und speichert den gemeldeten Token-Eigentümer als Information. Das Label vergibt der Nutzer. Perch kann nicht verifizieren, welcher Workspace dahintersteht.

Obwohl das PAT laut Notion auch schreiben könnte, ruft Perch nur Lese-Endpunkte auf (Allowlist).

## 5. Konten anzeigen, trennen, widerrufen

```bash
perch accounts
perch google remove google-1a2b3c4d            # nur lokal löschen
perch google remove google-1a2b3c4d --revoke   # zusätzlich Grant bei Google widerrufen
perch notion remove notion-1a2b3c4d            # nur lokal trennen
```

| Aktion | Wirkung |
| --- | --- |
| `google remove` | Refresh-Token und Client-Daten werden aus der DB gelöscht. Der Grant bei Google bleibt bestehen, bis er unter <https://myaccount.google.com/permissions> widerrufen wird. |
| `google remove --revoke` | Wie oben, zusätzlich `POST https://oauth2.googleapis.com/revoke`. Damit ist der Grant ungültig. |
| `notion remove` | Das PAT wird aus der DB gelöscht. Das Token selbst bleibt gültig, bis es in Notion widerrufen wird. Nach dem Widerruf ist der Zugriff weg. |
| Grant extern widerrufen oder abgelaufen | Tool-Aufrufe für dieses Konto liefern eine klare Fehlermeldung, die anderen Konten laufen weiter (`partial`). |

Ein laufender Server sieht Änderungen sofort: Er prüft die DB-Datei bei jedem Aufruf und entschlüsselt sie bei Änderung neu. Ein Neustart ist nicht nötig.

## 6. Server starten

### stdio (lokal)

```bash
perch serve --stdio
```

### HTTP (Heimserver, Default `127.0.0.1:8765`)

```bash
perch serve --http
```

- Ohne gültiges Token (≥ 43 Zeichen) startet der Server nicht.
- Erlaubte Bind-Adressen: Loopback oder eine **explizite Tailscale-IP**, z. B. `--host 100.x.y.z`. `0.0.0.0` und `::` werden abgelehnt.
- Requests mit einem fremden `Host`- oder `Origin`-Header lehnt der Server mit 403 ab. Die Prüfung schützt gegen DNS-Rebinding.

Beispiel für eine systemd-User-Unit (`~/.config/systemd/user/perch.service`). Sie wird nicht mitgeliefert und auch nicht automatisch installiert.

```ini
[Unit]
Description=Perch MCP server

[Service]
WorkingDirectory=%h/perch
EnvironmentFile=%h/perch/.env
ExecStart=/usr/bin/node %h/perch/dist/cli.js serve --http
Restart=on-failure

[Install]
WantedBy=default.target
```

### Zugriff vom Laptop

Perch ändert nichts an Tailscale. Die folgenden Befehle führt Fritz selbst aus. Die Syntax entspricht der Tailscale-Dokumentation (<https://tailscale.com/kb/1242/tailscale-serve>, Stand Januar 2026, vom Orchestrator am 2026-10-05 geprüft). Live getestet ist sie nicht.

**Variante A: Tailscale Serve (HTTPS, Default-Port 443)**, auf dem Server:

```bash
tailscale serve --bg http://127.0.0.1:8765
# MagicDNS-Namen als erlaubten Host eintragen, z. B. in .env:
PERCH_ALLOWED_HOSTS=homeserver.tailnet-xyz.ts.net
```

Lehnt Perch Requests mit 403 ab, steht der empfangene `Host`-Wert im Server-Log (stderr).

**Variante B: SSH-Tunnel**, auf dem Laptop:

```bash
ssh -N -L 8765:127.0.0.1:8765 homeserver
```

Der lokale Port muss 8765 sein. Bei einem anderen lokalen Port schickt der Client einen anderen `Host`-Header, und Perch antwortet mit 403. In dem Fall den Wert `127.0.0.1:<port>` in `PERCH_ALLOWED_HOSTS` eintragen.

### Claude Code einmalig konfigurieren (Laptop)

Das Token geht direkt per SSH in eine Shell-Variable. Es landet weder im Chat noch bei Claude noch in der Shell-History (dort steht nur `${TOKEN}`).

```bash
TOKEN="$(ssh homeserver 'cat ~/.config/perch/http-token')"
# Variante A:
claude mcp add --scope user --transport http perch https://homeserver.tailnet-xyz.ts.net/mcp \
  --header "Authorization: Bearer ${TOKEN}"
# Variante B (SSH-Tunnel):
claude mcp add --scope user --transport http perch http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer ${TOKEN}"
unset TOKEN
chmod 600 ~/.claude.json
```

**Hinweise zum Token auf dem Laptop:**
- Solange `claude mcp add` läuft, steht das Token in dessen Argumenten. Andere lokale Nutzer könnten es in diesem kurzen Moment per `ps` sehen. Auf einem Einzelnutzer-Laptop ist das unkritisch.
- Claude Code speichert den Header dauerhaft im Klartext in seiner Konfiguration (`--scope user`: `~/.claude.json`). Die Datei sollte `0600` sein und nicht in Backups oder Repos landen, die andere lesen können.

Token wechseln:

1. `perch token rotate`
2. Server neu starten
3. `claude mcp remove perch` und den Befehl oben erneut ausführen

## 7. Tools und Grenzen

| Tool | Hinweise |
| --- | --- |
| `perch_list_accounts` | IDs, Labels, E-Mail bzw. Token-Eigentümer, keine Secrets |
| `drive_search`, `drive_list_files` | `accountId` optional, ohne Angabe über alle Konten. `nextCursor`/`hasMore`, `partial`, `errors[]`, `incompleteSources` |
| `drive_get_file`, `drive_read_file`, `drive_download_file`, `drive_export_file` | `maxBytes`: Default 48 KiB, explizit bis 10 MiB. Nur Text oder Base64, kein Schreiben ins Dateisystem |
| `notion_search` | **Nur Titelsuche** über Seiten und Data Sources, keine Volltextsuche, eventuell unvollständig |
| `notion_get_page`, `notion_get_page_content`, `notion_get_block_children` | Blöcke paginiert. Verschachtelte Kinder bis `maxDepth` (Default 2) innerhalb von `maxBlocks` (Default 200). Nicht geladene Kinder sind mit `childrenNotLoaded` bzw. `childrenHasMore`/`childrenNextCursor` markiert. Bei Fehlern kommt das Geladene zurück, mit `partial`, `errors[]` und `childrenError` |
| `notion_get_database`, `notion_get_data_source`, `notion_query_data_source` | Die Database liefert `data_sources`. Abfragen laufen über `POST /v1/data_sources/{id}/query` (lesend) |

### Ausgabegröße und Client-Limits

- MCP-Clients begrenzen die Tool-Ausgabe. Claude Code warnt bei großen Ausgaben und kürzt bzw. verwirft sie ab `MAX_MCP_OUTPUT_TOKENS`, Default etwa 25 000 Tokens (Wert in der Claude-Code-Dokumentation prüfen).
- Perch liefert deshalb standardmäßig höchstens **48 KiB** Dateiinhalt, als kompaktes JSON.
- Größere Dateien: `maxBytes` explizit setzen, maximal 10 MiB. Gegebenenfalls in Claude Code das Limit anheben, z. B. `MAX_MCP_OUTPUT_TOKENS=100000 claude`. Base64 (Download/Export binärer Formate) vergrößert um etwa 33 %.
- Ist eine Datei größer als `maxBytes`, kommt ein klarer Fehler. Perch kürzt nicht stillschweigend. Offset-Pagination für Dateiinhalte gibt es (noch) nicht.

### Fehlertoleranz

- Fällt bei einer Suche über mehrere Konten eines aus, kommen die übrigen Ergebnisse mit `partial: true` und `errors[]`. Die nächste Seite versucht das ausgefallene Konto erneut.
- Nach 3 Fehlversuchen gibt Perch es auf und meldet es auf jeder weiteren Seite.
- Notion-Rate-Limits (HTTP 429) wiederholt Perch begrenzt, gemäß `Retry-After` und mit höchstens 10 s Wartezeit.

### Sicherheitshinweise zur Nutzung

- **Inhalte sind nicht vertrauenswürdig (Prompt Injection).** Dateien und Notion-Seiten können Anweisungen an das Modell enthalten, z. B. geteilte Dokumente Dritter. Perch ist read-only und kann upstream nichts ändern. Die Claude-Code-Sitzung hat aber eventuell andere Tools (Shell, Web, weitere MCP-Server), über die Daten abfließen könnten. Tool-Freigaben in Claude Code bewusst setzen und Ergebnisse aus fremden Dokumenten kritisch lesen.
- Das Notion-PAT könnte laut Notion auch schreiben. Perch blockiert das per Allowlist, das Token selbst bleibt aber mächtig. Deshalb geschützt aufbewahren (verschlüsselte DB) und bei Verdacht in Notion widerrufen.

### Bekannte Grenzen

- Sheets werden als CSV exportiert, dabei nur das erste Blatt.
- Google begrenzt Exporte auf ungefähr 10 MB.
- **Drive-Verknüpfungen** (`application/vnd.google-apps.shortcut`) folgt Perch nicht. Die Ziel-ID steht in Drive unter `shortcutDetails.targetId`, die Datei dann direkt lesen.
- Apps-Script-Export mit nur `drive.readonly` ist ungeprüft (beim Live-Test testen).
- **Notion-Properties:** Das Seitenobjekt (`notion_get_page`) kürzt Relation-, People-, Rollup- und Rich-Text-Properties nach 25 Einträgen. Der Endpunkt für einzelne Property-Werte ist nicht freigegeben, längere Werte sind also unvollständig.
- Konten, die nach dem Ausstellen eines Cursors hinzukommen, sind in dessen Fortsetzung nicht enthalten.
- Mehrere parallele stdio-Server, z. B. mehrere Claude-Sitzungen, erneuern Google-Tokens unabhängig voneinander. Empfohlen ist ein zentraler HTTP-Server.

## 8. Primärquellen

Vom Orchestrator am 2026-10-05 abgerufen und bestätigt. Das ist **dokumentationsgeprüft, nicht live validiert**.

- Notion PAT: <https://developers.notion.com/guides/get-started/personal-access-tokens>
  - Das Token erbt die Workspace-Rechte seines Erstellers. Ein „Add connections“ ist nicht nötig.
  - Header `Notion-Version: 2026-03-11`.
- Notion Search: <https://developers.notion.com/reference/post-search>. Der Filterwert ist `page` oder `data_source`.
- Google Drive Export-Formate: <https://developers.google.com/workspace/drive/api/guides/ref-export-formats>. Docs lassen sich als Markdown (`text/markdown`) exportieren.
- Google Shared Drives: <https://developers.google.com/workspace/drive/api/guides/enable-shareddrives>. Dort sind `corpora=allDrives` und `incompleteSearch` beschrieben.
- Google Drive Scopes: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- Google OAuth für Native Apps: <https://developers.google.com/identity/protocols/oauth2/native-app>
- Tailscale Serve: <https://tailscale.com/kb/1242/tailscale-serve>. Der Befehl `tailscale serve --bg http://127.0.0.1:8765` stellt den Dienst per HTTPS auf dem Default-Port bereit.
- MCP TypeScript SDK (Server): <https://ts.sdk.modelcontextprotocol.io/server>
