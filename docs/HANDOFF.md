# Handoff: Perch

## Update 2026-10-14: Slack- und WhatsApp-Meilenstein (direkt auf `main`)

- **Freigabe:** Fritz im Chat am 2026-10-13/14: Ansatz A (eigene Anbindungen statt durchgereichter MCP-Server), Slack lesen und senden, WhatsApp über GOWA lesen und (mit Grant) senden, beides für das globale Token lesbar, GOWA als Binary + systemd. Ausdrücklich „Implementiere alles auf main“ (Abweichung von der Branch/PR-Regel in `AGENTS.md`, auf Fritz' Anweisung).
- **Implementiert:** siehe `docs/SLACK_WHATSAPP_MILESTONE.md` und `docs/SETUP.md` §4e/§4f (inkl. Codex-Konfiguration in §6).
  - 7 neue Lese-Tools (`slack_*`, `whatsapp_*`), 4 Schreib-Tools nur für Client-Grants (`slack_send_message`, `slack_send_status`, `whatsapp_send_message`, `whatsapp_send_status`).
  - Neue Capabilities `slack_read`, `slack_send`, `whatsapp_read`, `whatsapp_send`; Grants nach Konto-Familien geprüft.
  - Slack/WhatsApp-Sends nutzen denselben idempotenten Ledger wie Mail (`src/messaging/send.ts`).
- **Review:** unabhängiger Review ohne Security-Blocker; Fixes eingearbeitet (Lookup-Budget, Koppeln bei Poll-Fehlern, GOWA-Geräte-Routen nur `admin`, 100.100.100.100). Offen dokumentiert: gemeinsames Sende-Limit 1000 (blockiert dann auch Mail), kein Downgrade nach Slack/WhatsApp-Events.
- **Getestet (nur Mocks):** `npm run check` grün: 643 Tests (51 Dateien), Smoke 10/10, Lizenzprüfung OK, keine neuen Abhängigkeiten.
- **Live verifiziert:** nichts. Nächster Schritt: Deployment auf dem Heimserver und Live-Test (SETUP §4e/§4f).


## Integrationsstand 2026-10-05

Fritz hat ausdrücklich den Merge aller sechs veröffentlichten PRs nach `main` freigegeben. Dieser Integrationsstand kombiniert den Mail-/Nutzer-/Calendar-/E-Mail-/Drive-/Notion-Stack mit dem MIT-/Notices-Meilenstein. Die einzigen Merge-Konflikte betrafen diese Handoff-Dokumentation; beide Meilensteinbeschreibungen bleiben erhalten. Der Orchestrator prüft den kombinierten Stand vor der finalen Integration. Operations-/WhatsApp-Arbeiten sind hier nicht enthalten; Deployment und Live-Provider-Tests sind nicht freigegeben bzw. nicht durchgeführt.

Die folgenden Abschnitte sind historische Meilensteinprotokolle. Aussagen wie „uncommittet“, „nicht kombiniert“ und „Merge nicht autorisiert“ beschreiben den damaligen Stand und sind keine aktuellen Anweisungen. Aktuelle Publikations-/Merge-/CI-Zustände liefert GitHub; Einzelmeilenstein-Testzahlen ersetzen keine kombinierte Integrationsprüfung.

## Update 2026-10-05: Mail-Workflow- und Audit-Meilenstein (Arbeits-Branch `feat/perch-mail-workflow`, Basis `560c6ae`)

- **Abgrenzung:**
  - Basis ist PR #5 `feat/perch-user-isolation` (`560c6ae`): committet, gepusht, review-freigegeben, CI grün; verifiziert 468 Tests + 9 Smoke.
  - Dieser Meilenstein ist **uncommittet**, nicht gepusht und noch nicht unabhängig reviewt. Commit/Push/PR macht der Orchestrator; Merge und Deploy sind nicht autorisiert.
  - Nicht kombiniert: der Operations-Schwester-Branch (Container/Backup) und der Lizenz-Branch (PR #3).
- **Freigabe:** Fritz am 2026-10-05: erweiterte selbstgehostete Phase 1 („Continue implementing the remaining stuff“). Dieses Inkrement betrifft nur `PHASE1_REMAINING.md` §2.
- **Implementiert** (Details, Speichervertrag, TDD-Nachweise: `docs/MAIL_WORKFLOW_MILESTONE.md`; Setup: `docs/SETUP.md` §4d):
  - **Idempotenter Versand:**
    - `mail_send` verlangt eine `requestId` (bewusster Bruch vor dem Release, dokumentiert). Schlüssel: Namespace + Akteur (Client-ID) + Konto + `requestId`.
    - Ein atomarer Claim schreibt `pending` dauerhaft **vor** jedem Provider-Aufruf; danach gibt es genau einen Versuch und den Abschluss `accepted`/`rejected`/`indeterminate`.
    - Gleicher Schlüssel mit gleichem Inhalt: das gespeicherte Ergebnis wird wiederholt, ohne Reply-Abruf, neues Zusammensetzen oder erneuten Versand. Anderer Inhalt: `idempotency_conflict` vor jeder I/O.
    - `pending` nach Absturz, Kill oder Schreibfehler beim Abschluss bleibt für immer „unbekannt“ und wird nie erneut gesendet.
    - Lässt sich nach einer Annahme das Ergebnis nicht speichern, lautet die Antwort `indeterminate`.
    - Wechselt die Identität des Absenderkontos zwischen Claim und Versand (oder vor einer Wiederholung), schlägt das geschlossen fehl.
  - **Neues MCP-Tool `mail_send_status`:** nur für Send-Grants, nur eigene Anfragen; Grant, Konto und Bindung werden vor der Antwort neu geprüft.
  - **Ledger `mail-workflow.enc` pro Namespace:**
    - Lock `mail-workflow.lock`; verschlüsselt mit einem HKDF-Unterschlüssel des Store-Schlüssels und eigenem AAD, Envelope-Algorithmus unverändert.
    - Strikt validiert und begrenzt (1000 Send-Einträge, fail closed; Audit-Ring mit 2000 Einträgen).
    - Fehlend, beschädigt, fremd, verlinkt, mit fehlendem oder ersetztem Schlüssel, bei verwaistem Lock oder Schreibfehler: fail closed, nie zurückgesetzt.
    - Store-Schema v1 bleibt unverändert.
  - **Audit ohne Inhalte:**
    - Der gemeinsame Tool-Runner protokolliert jeden MCP-Tool-Aufruf mit erlaubten Feldern: Zeit, Namespace, Akteur, Operations-ID, Tool, Perch-Konto-ID/Provider, Ergebnis, Code.
    - Schreib-Tools werden **vor** dem Provider-Aufruf protokolliert (fail closed). Lese-Ergebnisse werden zurückgehalten, wenn das Audit nicht geschrieben werden kann.
    - `mail_send` protokolliert der Workflow selbst, atomar mit dem Eintrag. Alle übrigen Mail-Operationen protokolliert `MailService` selbst (auch direkte Aufrufe ohne MCP; Entwurf-`attempt` vor jedem Provider-Zugriff), ohne doppelte Runner-Einträge (Reparatur 2).
    - Genaue Abdeckung und Lücken: Meilenstein-Doku §5.
  - **Lokale CLI:** `perch audit list`, `perch mail-workflow list|resolve|init` (`prune` lehnt ab: benutzte `requestId`s werden nie vergessen), pro Namespace über `PERCH_USER`. `resolve` vermerkt nur ein menschlich geprüftes Ergebnis und sendet nie; es gibt keinen Retry-Knopf.
- **Lokal getestet (nur Mocks):**
  - `npm run check` auf Host-Node 26.7.0 **und** portablem Node **22.12.0**: typecheck/build fehlerfrei, `npm test` **539/539** (46 Dateien; vorher 468), smoke **10/10** (vorher 9). Stand nach Reparatur 2 (2026-10-05).
  - Die 10 unabhängigen Prüf-Proben des Orchestrators (`perch-audit-independent-probes.mjs`, unverändert) laufen kompiliert auf Node 22.12.0 mit Offline-Guard: 10/10 PASS, 0 Netzwerkversuche.
  - `npm audit --omit=dev`: 0 Befunde; `git diff HEAD --check`: sauber.
  - Fünf Mutationsproben (Lock, Replay, Audit vor dem Schreiben, Status-Revalidierung, Abschluss-Fehler) wurden alle erkannt; die Quellen sind byte-identisch wiederhergestellt.
- **Vorfall (Mutationsprobe M2):**
  - Der Offline-Guard der Smoke-Tests blockierte DNS nicht. Ein absichtlich mutiertes gebautes CLI hat deshalb DNS-Anfragen für den reservierten, nicht existierenden Namen `smtp.invalid.example` an den System-Resolver geschickt: nur DNS, keine Socket-Verbindung, keine Zugangsdaten, kein Inhalt.
  - Der Guard (nur Testcode) blockiert und protokolliert jetzt alle `node:dns`-APIs; die Probe beweist das.
  - Die erneute Probe wurde im Prozess blockiert, und der Null-Versuche-Test schlug wie beabsichtigt fehl.
- **Live verifiziert:** nichts.
- **Grenzen** (Meilenstein-Doku §9):
  - `pending` bleibt dauerhaft offen, bis ein Admin es auflöst;
  - kein `prune`: ab 1000 Sends pro Namespace scheitern neue Sends geschlossen, bis ein sicherer Rollover gebaut ist;
  - Upgrade-Schritt `perch mail-workflow init` nur für Namespaces, die nie einen Ledger hatten (Marker in `store.enc`); ein verlorener Ledger braucht ein Backup;
  - ein Widerruf, der erst während des laufenden Provider-Aufrufs eintrifft, kann diesen nicht mehr stoppen;
  - keine Provider-seitige Idempotenz und keine deterministische Message-ID.
- **Weiter offen:** `PHASE1_REMAINING.md` §3–§5: Container, Backup und Migrationen (Operations-Schwester), WhatsApp, Live-Tests, kombinierte Integration mit Lizenz- und Operations-Branch. Phase 1 ist **nicht** abgeschlossen.

---

## Update 2026-10-05: Nutzer-Isolations-Meilenstein (Delivery-Branch `feat/perch-user-isolation`, Basis `acc3eeb`)

- **Abgrenzung:**
  - Bereits auf `origin` liegen (laut lokalen Remote-Refs, ohne Fetch geprüft):
    - PR2 `feat/perch-email-connectors`;
    - PR3 `feat/perch-oss-license` (Schwester-Branch, hier nicht integriert);
    - PR4 `feat/perch-calendar-contacts` (`acc3eeb`).
  - Dieser Meilenstein wurde im Worktree `~/perch-users-work` unabhängig getestet und frisch review-freigegeben. Inzwischen ist er als PR #5 (`560c6ae`) committet und gepusht, CI grün; GitHub ist die Quelle für PR-/Merge-Status. Kein Merge oder Deploy ist autorisiert.
- **Freigabe:** Fritz hat am 2026-10-05 über den Orchestrator die erweiterte Phase 1 freigegeben, für dieses Inkrement nur admin-angelegte Nutzer-Isolation.
- **Implementiert** (Details, TDD-Nachweise: `docs/USER_ISOLATION_MILESTONE.md`; Setup: `docs/SETUP.md` §4c):
  - Lokale Registry im verschlüsselten Root-Store (`users`, Default `[]`):
    - CLI `perch user add|list|remove`;
    - IDs `user-<16 hex>`, nie wiederverwendet; höchstens 100 Einträge;
    - `remove` sperrt nur, Store und Schlüssel bleiben liegen.
  - Pro Nutzer ein physisch getrennter Store (`$PERCH_DATA_DIR/users/<id>/`) und Schlüssel (`<Verzeichnis von PERCH_KEY_FILE>/user-keys/<id>.key`). Dazu kommen ein eigener Kontext mit eigenen Token-Caches, ein Read-only-Token (nur der Hash wird gespeichert, die Datei ist neu und `0600`) und eigene Client-Grants.
  - Fehlende, verlinkte oder beschädigte Stores und Schlüssel schlagen geschlossen fehl, ohne Neuanlage.
  - HTTP: Das Token wählt genau einen Namespace (globales Token = Root, read-only wie bisher). Mehrdeutige Hashes ergeben `401`, ein beschädigter aktiver Namespace `503` für alle Bearer-Tokens, auch das globale (bewusster Verfügbarkeits-Tradeoff, weil die Eindeutigkeit des globalen Tokens gegen die Client-Grants dieses Namespace nicht beweisbar ist). Das globale Token wird auch abgewiesen (`401`), wenn sein Hash einem Client-Grant eines aktiven Nutzers gleicht. Es gibt keine Auswahl per Header, Query oder Pfad.
  - Mitgliedschaft und Grants prüft Perch bei jedem Request und vor jedem Tool-Aufruf neu, auch in stdio. Vor jedem Tool-Aufruf einer Nutzer-Session prüft Perch zusätzlich Verzeichnisse, Schlüsseldatei (fehlt/verlinkt/ersetzt) und Store (beschädigt) des Namespace; nichts wird neu angelegt.
  - Cursor sind per HMAC an Namespace, Abfrage und Parent gebunden.
  - `PERCH_USER` wählt lokal den Namespace für Onboarding, Konten, Client-Grants und stdio. Ein ungültiger Wert ist ein Fehler, es gibt keinen Rückfall auf Root. Admin-Befehle sind im Nutzer-Modus gesperrt.
- **Lokal getestet (nur Mocks):**
  - Orchestrator: `npm run check` nach Review-Fixes auf Host-Node und Mindest-Node 22.12: typecheck/build fehlerfrei, `npm test` **468/468** (39 Dateien; vor Fixes 461, vor Meilenstein 423), smoke **9/9** (vorher 8). Unabhängige Offline-Probe: beide zuerst reproduzierten Lücken geschlossen, null externe Calls.
  - Grün auf Host-Node 26.7.0 und portablem Node **22.12.0**; Host und `engines` unverändert.
  - `npm audit --omit=dev`: 0 Befunde; `git diff --check`: sauber.
  - Vier Mutationsproben (Guard, Cursor-MAC, Mehrdeutigkeit, HTTP-Routing) wurden jeweils erkannt; die Quellen sind byte-identisch wiederhergestellt.
  - In der Guard-Mutation hat der Offline-Guard einen IMAP-Connect auf den nicht auflösbaren Testhost blockiert und protokolliert. Kein Request hat den Rechner verlassen.
- **Live verifiziert:** nichts.
- **Grenzen** (Meilenstein-Doku §8):
  - keine gehärtete Mandantenfähigkeit: ein Prozess, keine Quoten, gemeinsame OAuth-App, der Host-Admin sieht alles;
  - keine Token-Rotation, keine Reaktivierung, kein Löschbefehl;
  - ein beschädigter aktiver Namespace blockiert alle HTTP-Bearer-Tokens, auch das globale, bis er repariert oder der Nutzer entfernt ist. Nur lokales Root-stdio ohne Nutzer- und Client-Token-Selektor bleibt davon unabhängig.
- **Weiter offen:** `docs/PHASE1_REMAINING.md` §2–§5:
  - Audit und idempotentes Senden (inzwischen auf `feat/perch-mail-workflow` umgesetzt, siehe oben);
  - Container, Backup und Migrationen;
  - WhatsApp;
  - Live-Tests;
  - kombinierte Integration mit dem Lizenz-Branch.
  Phase 1 ist **nicht** abgeschlossen.
- **Review-Gate:** frischer unabhängiger Review bestanden, keine Security-/Logic-Blocker; Commit/Push/PR durch den Orchestrator. Kein Merge ohne Fritz' OK.

---

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
## Update 2026-10-05: OSS-Lizenz-Meilenstein (Branch `feat/perch-oss-license`, Basis `ad12f1e`)

- **Entscheidung:** Perch steht unter **MIT** (`LICENSE`, „Copyright (c) 2026 Fritz Kuermayr“). Freigabe von Fritz galt nur nach Abhängigkeitsprüfung; die Prüfung ist dokumentiert in `docs/OSS_LICENSE_MILESTONE.md`. `package.json`/Lockfile-Root: `MIT` statt `UNLICENSED`; `private: true` bleibt (keine Veröffentlichung). Beschreibung auf den tatsächlichen E-Mail-Stand aktualisiert.
- **Inventar (Lockfile v3, sauberes `npm ci`):**
  - Produktion: 115 Paketversionen an 117 Orten (4 direkte Abhängigkeiten); MIT 103 (davon `@zone-eu/mailsplit` aus `MIT OR EUPL-1.1+` gewählt), ISC 8, BSD-3-Clause 2, BSD-2-Clause 1, MIT-0 1.
  - Entwicklung: 68 Versionen (nicht verteilt; u. a. MPL-2.0 `lightningcss`, Apache-2.0 `typescript`).
- **Befunde:** Die Texte von `imapflow` (MIT) und `nodemailer` (MIT-0) sind abgeschnitten, also weder MIT noch MIT-0; Perch behandelt sie konservativ und behält den Hinweis. `nodemailer` enthält `punycode.js` unter voller MIT. Weitere eingebettete Hinweise stehen in `hono`, `iconv-lite`, `encoding-japanese`, `fast-uri`, `negotiator` und `split2`. `pkce-challenge` nennt keinen Rechteinhaber. Alles ist in `THIRD_PARTY_NOTICES.md` wiedergegeben.
- **Review-Fix (2026-10-05, RED vor GREEN, §6 Zeile 7):**
  - `encoding-japanese` enthält Masanao Izumos Base64-Code (`src/util.js` 229–236, `encoding.js` 6124–6131) mit eigener Freigabe ohne SPDX-ID („This library is free.  You can redistribute it and/or modify it.“). In `encoding.min.js` fehlt der Kommentar.
  - Die Hinweise sind wiedergegeben, gepinnt und als „Non-SPDX grant“ getrennt vom SPDX-Inventar ausgewiesen. Die SPDX-Allowlist gilt nur für Paketlizenzen.
  - Der Scan erkennt jetzt auch reine Copyright-Zeilen. Zeilen mit dem Rechteinhaber aus der eigenen Lizenzdatei des Pakets gelten als Selbstverweis. Neu gefunden: `negotiator` (Blake Embrey), `hono` (type-fest), `split2`.
  - Der Textklassifikator vergleicht jetzt den ganzen Lizenztext mit den Vorlagen und lehnt Zusätze ab (JSON „Good, not Evil“, Commons Clause, BSD-Werbeklausel). Neue reviewte Overrides: `encoding-japanese` (MIT+extra), `fast-uri` (umformulierte Klausel 3).
  - Symlinks in Produktionspaketen und Policy-Pfade außerhalb des Pakets schlagen fehl.
  - Grenzen in §5: Beides ist eine Heuristik, keine exakte SPDX-Erkennung und keine Erkennung kopierten Codes.
- **Prüfung:** `npm run licenses:check` (`scripts/licenses.mjs`, nur Node-Bordmittel) schlägt fail-closed fehl, und zwar bei:
  - fehlenden oder nicht erlaubten Lizenzen;
  - ungeprüften SPDX-Ausdrücken;
  - Text/SPDX-Abweichungen;
  - ungeprüften eingebetteten Hinweisen;
  - veralteten Policy-Einträgen;
  - Drift gegenüber dem Lockfile.

  Die Prüfung ist Teil von `npm run check` und CI. `npm run licenses:generate` erzeugt die Dateien neu.
- **Lokal getestet:**
  - `npm run check`: Typecheck fehlerfrei, `npm test` **386/386** (27 Dateien; vor dem Review-Fix 373/373), Smoke **5/5**, `licenses:check` OK;
  - `npm audit --omit=dev` 0 Befunde;
  - `git diff --check` sauber;
  - zusätzlich `npm ci --omit=dev` + `licenses:check` OK;
  - TDD-Nachweise in `docs/OSS_LICENSE_MILESTONE.md` §6.
- **Offen:** Docker/Compose nicht umgesetzt (keine Container-Runtime auf dem Host); Akzeptanzkriterium für Image-Notices in §7. Keine Sichtbarkeitsänderung, kein Publish, keine Rechtsberatung.
- **Git:** Nichts committet. Commit, Push und PR macht der Orchestrator. Merge und Deployment sind nicht autorisiert.

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
