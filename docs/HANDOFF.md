# Handoff: Perch

## Update 2026-10-05: E-Mail-Meilenstein (Branch `feat/perch-email-connectors`, Basis `50db560`)

- **Implementiert:**
  - Gmail, Microsoft Graph (Outlook.com/M365) und GMX bzw. generisches IMAP/SMTP: suchen, lesen, Anhänge, Entwürfe, Senden mit Herkunftsangabe und explizitem Absenderkonto.
  - Lokale Client-Grants (`perch client add`), gebunden an Konto-IDs. Das globale Token und stdio bleiben read-only.
- **Review-Fixes (2026-10-05, jeweils RED vor GREEN, Nachweise in `docs/EMAIL_MILESTONE.md` §7, Zeilen 13a–13e):**
  - Client-Grants sind nur für Mail: keine Drive/Notion-Tools oder -Metadaten, nur die benannten Konten, Lese-Tools nur mit `read`.
  - Der Grant wird vor jedem Tool-Aufruf neu aus dem Store geprüft. Widerruf oder Einschränkung greifen sofort, auch in laufenden stdio-Sessions, ohne Provider-Aufruf.
  - `replyToMessageId` braucht zusätzlich `read`, geprüft vor jeder I/O. Ungültige Upstream-Message-IDs werden verworfen, Eingaben des Aufrufers bleiben streng.
  - HTML-zu-Text (Gmail, Graph, IMAP) läuft über einen gemeinsamen linearen, begrenzten Scanner statt quadratischer Regexe. Der Regressionstest läuft in einem Kindprozess mit hartem Timeout.
  - Microsoft Graph: MIME-Requests über 4 000 000 Byte Base64 werden lokal abgelehnt (Graph-Doku: „limited to 4 MB“).
  - Details, Freigabe und TDD-Nachweise: `docs/EMAIL_MILESTONE.md`. Setup: `docs/SETUP.md` §4a.
- **Neue MCP-Tools:**
  - immer registriert: `mail_search`, `mail_read_message`, `mail_get_attachment`;
  - nur für Client-Grants mit `draft` bzw. `send`: `mail_create_draft`, `mail_send`.
- **Lokal getestet:**
  - `npm run typecheck` fehlerfrei;
  - `npm test` **337/337** (26 Dateien; vor den Review-Fixes 314/314);
  - `npm run smoke` **5/5**;
  - `npm audit --omit=dev` 0 Befunde.
  - Upstreams nur als **Mocks**. TLS und SMTP liefen gegen lokale Testserver.
- **Live verifiziert:** **nichts.** Es gab keinen echten OAuth-Flow, kein echtes Konto und keine echte Mail.
- **Git:** Nichts committet. Commit, Push und PR macht der Orchestrator. Merge und Deployment sind nicht autorisiert.
- **Nutzeraufgaben für den Live-Test:**
  - Gmail API und Scopes im Consent Screen;
  - Entra-App-Registrierung (`http://localhost`, delegierte Mail-Rechte), `PERCH_MICROSOFT_CLIENT_ID`;
  - GMX: IMAP aktivieren, App-Passwort anlegen;
  - danach `perch client add` und ein Testversand an die eigene Adresse.
- **Offene Grenzen:** `docs/EMAIL_MILESTONE.md` §8. Keine Mehrbenutzer-Isolation.

---

Stand 2026-10-05 (Drive/Notion-Meilenstein), Branch `feat/perch-multi-account-mcp`.

**Git:** Nichts committet. Autorisiert ist nur ein Commit und Push auf diesen Feature-Branch plus ein PR, durch den Orchestrator. **Merge und Deployment sind nicht autorisiert.**

| Kategorie | Stand |
| --- | --- |
| Briefing | `docs/BRIEFING.md`. Fritz hat es am 2026-10-05 über den Orchestrator geliefert und freigegeben. Damit ist der Platzhalter-Stand aufgehoben. |
| Spezifikation | `docs/SPEC.md` (freigegeben, Revision mit Review-Fixes vom 2026-10-05) |
| Implementiert | Read-only-MCP-Server: Google Drive mit mehreren Konten, Notion mit mehreren Workspaces, verschlüsselter Credential Store, CLI, stdio und zustandsloses Streamable HTTP. Dazu die Review-Fixes 1–9 (siehe unten). |
| Lokal getestet (2026-10-05) | `npm run typecheck`: fehlerfrei. `npm test`: **139/139** grün (10 Dateien). `npm run build`: fehlerfrei. `npm run smoke`: **3/3** grün gegen `dist/cli.js`. Upstreams nur als **Mocks**; Store-Nebenläufigkeit mit echten Subprozessen |
| Dokumentation geprüft | Primärquellen (unten) hat der Orchestrator am 2026-10-05 abgerufen und bestätigt. Das ist eine Dokumentationsprüfung, **keine** Live-Validierung. |
| Live verifiziert | **nichts.** Es gab keinen echten Google-OAuth-Flow, keinen echten Notion-Aufruf und keinen Tailscale-Test. Mock-Tests belegen keine Live-Integration. |
| In Produktion | nichts (kein Deployment, keine Änderungen an Tailscale) |

## Review-Fixes vom 2026-10-05 (jeweils erst Regressionstest RED, dann GREEN)

1. **Lock:**
   - Atomares Lock-Verzeichnis (`mkdir`) mit Owner-Token. Freigegeben wird nur der eigene Lock.
   - **Keine automatische Übernahme verwaister Locks:** Ab 60 s Alter schlägt das Schreiben fehl (fail closed), mit manueller Wiederherstellung (`docs/SETUP.md` §2).
   - Getestet mit 4 parallelen Subprozess-Writern, einem per SIGKILL verwaisten Lock und einem fremden Lock.
2. **`init`:**
   - Alles läuft unter dem Lock. Schlüssel, DB und Token entstehen ohne Überschreiben (`link()` mit `EEXIST`).
   - Getestet: 4 Runden mit je 6 parallelen `init`-Subprozessen. Es entsteht genau ein Schlüssel, und die DB ist entschlüsselbar.
3. **Abfragen über mehrere Konten:**
   - Eine ausgefallene Quelle bleibt mit ihrem Cursor im nächsten Cursor und wird erneut versucht.
   - Nach 3 Fehlversuchen gibt Perch sie auf und meldet sie dann auf jeder Seite (`partial`).
4. **Krypto:** IV 12 Byte, Tag 16 Byte (`authTagLength`), nur kanonisches Base64. Gekürzte Tags werden abgelehnt.
5. **Dateiprüfungen:**
   - `readPrivateFile` prüft nach `open(O_NOFOLLOW|O_NONBLOCK)` per `fstat` (Typ, Rechte, Eigentümer).
   - `ensurePrivateDir` ändert nie die Rechte bestehender Verzeichnisse und bricht stattdessen mit einem `chmod 700`-Hinweis ab.
6. **Google-Refresh:**
   - Fail closed, wenn ein Konto während des Refresh entfernt oder neu autorisiert wurde. Es wird nichts gecacht oder zurückgegeben.
   - Lässt sich eine Rotation nicht speichern, kommt ein Fehler mit Reconnect-Hinweis, ohne Token.
7. **Notion:**
   - 429-Retry: pro Request 3-mal, pro Tool-Aufruf 6-mal, `Retry-After` nur als Zahl übernommen und auf 10 s begrenzt.
   - Seiteninhalt bleibt bei Fehlern in verschachtelten Abrufen erhalten (`partial`, `errors[]`, `childrenError`).
8. **Ausgabe:** Default `maxBytes` 48 KiB, kompaktes JSON. Client-Limits (`MAX_MCP_OUTPUT_TOKENS`) und explizites `maxBytes` sind in SETUP §7 dokumentiert. Keine Offset-Pagination.
9. **Kleinere Fixes:**
   - Re-Auth-Hinweis ohne nutzerdefiniertes Label im Shell-Befehl.
   - `--timeout` auf 1–3600 s begrenzt, auch in der Bibliothek.
   - `init` prüft die Stärke eines vorhandenen Tokens (Datei oder Env).

## Primärquellen (dokumentationsgeprüft am 2026-10-05, nicht live validiert)

- Notion PAT: <https://developers.notion.com/guides/get-started/personal-access-tokens>
  - Header `Notion-Version: 2026-03-11`.
  - Das Token erbt die Workspace-Rechte seines Erstellers. Ein „Add connections“ ist nicht nötig.
- Notion Search: <https://developers.notion.com/reference/post-search>. Der Filterwert ist `page` oder `data_source`.
- Google Export-Formate: <https://developers.google.com/workspace/drive/api/guides/ref-export-formats>. Docs lassen sich als Markdown (`text/markdown`) exportieren.
- Google Shared Drives: <https://developers.google.com/workspace/drive/api/guides/enable-shareddrives> (`corpora=allDrives`, `incompleteSearch`)
- Google Drive Scopes: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- Google OAuth für Native Apps: <https://developers.google.com/identity/protocols/oauth2/native-app>
- Tailscale Serve: <https://tailscale.com/kb/1242/tailscale-serve> (Stand Januar 2026). Der Befehl `tailscale serve --bg http://127.0.0.1:8765` liefert HTTPS auf dem Default-Port.
- MCP TypeScript SDK: <https://ts.sdk.modelcontextprotocol.io/server>

## Offene Aufgaben

1. Orchestrator: Review, dann Commit und Push auf `feat/perch-multi-account-mcp` und PR. **Kein Merge.**
2. Fritz: Google Cloud einrichten (`docs/SETUP.md` §3.1):
   - Drive API aktivieren
   - Consent Screen mit `drive.readonly` und Testnutzern
   - Desktop-OAuth-Client
3. Fritz: erster **Live-Test** auf dem Heimserver:
   - `perch init`
   - `perch google add`, `perch notion add`
   - `perch serve --http`
   - Tailscale Serve oder SSH-Tunnel
   - `claude mcp add …`
   - Ergebnisse hier eintragen
   - Dabei auch Apps-Script-Export und das Verhalten großer Dateien gegen das Claude-Code-Ausgabelimit prüfen.
4. Optional: systemd-User-Unit (Beispiel in `docs/SETUP.md`).

## Bekannte Grenzen und Risiken

- Im Google-Testing-Status laufen Refresh-Tokens nach 7 Tagen ab. Für Produktion mit restricted scope verlangt Google eine Verifizierung.
- Notion-Suche ist nur Titelsuche und eventuell unvollständig. Die Workspace-Identität ist nicht verifiziert (Label vom Nutzer). Seiten-Properties sind ab 25 Einträgen gekürzt.
- Drive-Verknüpfungen werden nicht aufgelöst. Sheets-Text-Export liefert nur das erste Blatt. Google begrenzt Exporte auf ca. 10 MB.
- Ein verwaister Lock nach einem Absturz blockiert Schreibzugriffe, bis er manuell entfernt wird (bewusst fail closed).
- Inhalte sind nicht vertrauenswürdig (Prompt Injection). Das Bearer-Token liegt auf dem Laptop in `~/.claude.json` (`0600` empfohlen).

## Roadmap

- Gmail, Calendar, Contacts (read-only)
- WhatsApp höchstens experimentell, später
- LinkedIn ausgeschlossen

## Nächster Schritt

Review durch den Orchestrator, Commit und Push auf den Feature-Branch und PR. Danach der Live-Test aus Aufgabe 3.
