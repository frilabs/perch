# Handoff: Perch

## Update 2026-10-05: Google-Productivity-Meilenstein (Branch `feat/perch-calendar-contacts`, Basis `ad12f1e`)

- **Freigabe:** Fritz hat am 2026-10-05 über den Orchestrator die erweiterte Phase 1 und diesen Meilenstein freigegeben.
- **Implementiert** (Details, Quellen, TDD-Nachweise: `docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`; Setup: `docs/SETUP.md` §4b):
  - **Eigener Google-Grant** pro Konto (`perch google-productivity add --services calendar,contacts [--allow-calendar-write]`), getrennt von Drive und Gmail. Default `calendar.readonly`/`contacts.readonly`, Opt-in `calendar.events.owned`, dazu `openid email`.
  - Die gewährten Scopes werden geprüft. Die E-Mail kommt verifiziert über den festen Userinfo-Endpunkt; Duplikate werden per `sub` erkannt.
  - Verschlüsselte Store-Sektion `googleProductivity`; alte Stores öffnen unverändert.
  - Refresh single-flight; Rotation, Widerruf und Konto-Änderungen schlagen geschlossen fehl. Zusätzlich gilt der beim Refresh gemeldete Scope.
  - **Neue Tools:**
    - lesend für Betreiber und Clients mit `calendar_read`/`contacts_read`: `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`, `contacts_list`, `contacts_get`;
    - nur für Client-Grants mit `calendar_write`: `calendar_create_event`, außerdem `calendar_update_event` (zusätzlich mit `calendar_read`).
  - **Schreib-Subset:** nur private Termine ohne Teilnehmer, Einladungen oder Gast-Updates (`sendUpdates=none`); explizite private Sichtbarkeit und ausschließlich Popup-Erinnerungen.
    - Anlegen idempotent per `requestId`: daraus wird eine deterministische Event-ID.
    - Ändern per PATCH mit `If-Match`.
    - Ergebnisse `created`/`updated`/`conflict`/`precondition_failed`/`rejected`/`indeterminate`, kein Blind-Retry.
  - **Grants:** Mail-Capabilities gelten nur für Mail-Konten, Calendar/Contacts-Capabilities nur für `gprod-…`-Konten. Der Betreiber bleibt read-only. Mail-only-Clients aus PR2 sehen nichts Neues. Revalidierung vor jedem Tool-Aufruf, auch in stdio.
- **Lokal getestet:**
  - `npm run check`: typecheck fehlerfrei, `npm test` **423/423** (35 Dateien; vor den Review-Fixes 409, vor dem Meilenstein 337), smoke **8/8** (vorher 7 bzw. 5). Grün auf Node **22.12.0, 22.23.3, 24.21.0 und 26.7.0**: portable, per SHASUMS256 geprüfte Binaries im Scratch, Host und `engines` unverändert;
  - `npm audit --omit=dev`: 0 Befunde; `git diff --check`: sauber.
  - Upstreams nur als **Mocks**.
- **Live verifiziert:** **nichts.**
- **Vorfall:** Bei einer Mutationsprobe (Revalidierung absichtlich deaktiviert) hat das gebaute CLI einmal einen Token-Refresh mit *Dummy*-Zugangsdaten an `oauth2.googleapis.com` geschickt. Google hat ihn abgelehnt; echte Zugangsdaten gibt es hier nicht. Danach wurden die Smoke-Kindprozesse über einen Proxy (`NODE_USE_ENV_PROXY`) auf einen geschlossenen Loopback-Port umgeleitet. Das Review hat gezeigt, dass das auf Node 22.12–22.20 wirkungslos ist.
  - **Ersetzt** durch einen reinen Test-Preload (`test/smoke/offlineGuard.mjs`, `--import`). Er blockiert `fetch` und Socket-Connects in jedem Kindprozess und protokolliert jeden Versuch.
  - Ein Probe-Kindprozess beweist vorab, dass der Guard aktiv ist; der letzte Smoke-Test verlangt null Versuche.
  - Die erneute Mutationsprobe lief erst danach. Der Token-Refresh wurde im Prozess geblockt, es gab keine externe Anfrage (Meilenstein-Doku §7, Zeile 16).
  - Produktionscode und sein `fetch` sind unverändert.
- **Git:** nichts committet. Commit, Push und PR macht der Orchestrator; Merge und Deployment sind nicht autorisiert.
- **Review-Fixes (2026-10-05, RED vor GREEN, Meilenstein-Doku §5 und §7, Zeilen 11–16):**
  - **Anlegen:** immer ausdrücklich `visibility: "private"` (oder `confidential`); `default` und `public` werden abgelehnt. Erinnerungen immer `{useDefault: false, overrides: [Popup…]}`; `useDefault: true` wird abgelehnt.
  - **Ändern:** öffentliche, `default`- oder nicht gesetzte Sichtbarkeit sowie Standard- oder E-Mail-Erinnerungen werden im selben PATCH auf privat und Popup-only gesetzt.
  - Ein fehlender `organizer` schlägt geschlossen fehl.
  - Jahre 0001–0099 werden korrekt berechnet (`utcMs` statt `Date.UTC`).
  - Text im Ergebnis: „No invitations or updates were sent to anyone".
- **Offen** (exakt: `docs/PHASE1_REMAINING.md` und Meilenstein-Doku §8; Lizenz/Notices separat in Schwester-PR #3, noch nicht in diesem Branch kombiniert):
  - **Mehrbenutzer-Isolation** (nicht Teil dieses Inkrements);
  - Einladungen, Serien, Löschen; Kontakte schreiben;
  - Live-Test durch Fritz: Calendar API und People API aktivieren, Scopes im Consent Screen eintragen, Konto verbinden, Client-Grant anlegen, ein privater Testtermin.

---

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
