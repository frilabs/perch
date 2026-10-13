# Meilenstein: Slack und WhatsApp

Stand 2026-10-14. Freigabe: Fritz im Chat am 2026-10-13/14 (Ansatz A, „Implementiere alles auf main“). Implementiert und mit Nachbauten (Mocks) getestet. **Nicht** live gegen Slack, GOWA oder WhatsApp verifiziert.

## 1. Entscheidungen

| Frage | Entscheidung |
| --- | --- |
| Ansatz | Eigene Anbindungen in Perch (REST), kein Durchreichen fremder MCP-Server (GOWA-MCP, Slack-MCP) |
| Slack-Anmeldung | Pro Workspace eine **interne** Slack-App mit User-Token (`xoxp-…`), verdeckt eingefügt wie das Notion-PAT. Grund: verteilte Nicht-Marketplace-Apps sind bei `conversations.history`/`replies` seit 2025 stark gedrosselt, interne nicht. Manifest: `docs/slack-app-manifest.json` |
| WhatsApp | Selbst gehostetes GOWA (go-whatsapp-web-multidevice, MIT, API v9) als systemd-Dienst ohne Docker, nur auf localhost. Koppeln per **Kopplungscode** über die CLI |
| Lesen | Für beide wie Drive/Notion: globales Token und Clients mit `slack_read` bzw. `whatsapp_read` |
| Senden | Slack und WhatsApp: nur mit Client-Grant `slack_send` bzw. `whatsapp_send` pro Konto, idempotent per `requestId`, auditiert |

## 2. Architektur

- `src/slack/slack.ts`: Onboarding (`auth.test`, Scopes aus `x-oauth-scopes`), `SlackService` (Konversationen, Verlauf, Threads, Suche, Senden). Namen über `users.info`, pro Workspace gecacht, höchstens 50 Lookups pro Tool-Aufruf (über alle Seiten und Workspaces).
- `src/whatsapp/whatsapp.ts`: GOWA-Instanz (Origin, Basic-Auth verschlüsselt im Store), Koppeln, Status, Entfernen, `WhatsappService` (Chats, Nachrichten, Suche in den jüngsten Chats, Senden).
- `src/messaging/send.ts`: gemeinsamer idempotenter Sende-Ablauf auf dem bestehenden Mail-Workflow-Ledger (`mail-workflow.enc`): Claim vor dem Provider-Aufruf, genau ein Versuch, Abschluss `accepted`/`rejected`/`indeterminate`, Wiederholung mit gleicher `requestId` liefert das gespeicherte Ergebnis.
- `src/upstream.ts`: neue Dienste `slack` (feste Origin `https://slack.com`) und `gowa` (konfigurierte Origin, bei **jedem** Aufruf neu gegen `validateGowaOrigin` geprüft: Loopback oder Tailscale, mit Port, ohne Pfad/Credentials). Neue Routen-Tags `slack_send`, `whatsapp_send`, `admin`.
- `src/auth/grants.ts`: Konto-Familien (`mail`, `productivity`, `slack`, `whatsapp`) nach ID-Präfix; jede Capability gilt für genau eine Familie.
- Store-Schema v1 additiv erweitert: `slack[]`, `whatsappInstance?`, `whatsapp[]`. Ledger v1 additiv: Sende-Records und Audit für `slack-…`/`whatsapp-…`.

## 3. Allowlist

| Dienst | Route | Tag |
| --- | --- | --- |
| Slack | `GET /api/auth.test`, `conversations.list`, `conversations.info`, `conversations.history`, `conversations.replies`, `users.info`, `search.messages` | read |
| Slack | `POST /api/chat.postMessage` | `slack_send` |
| GOWA | `GET /chats`, `GET /chat/{jid}/messages` | read |
| GOWA | `POST /send/message` | `whatsapp_send` |
| GOWA | `GET/POST /devices`, `POST /devices/{perch-slot}/login/code`, `GET`/`DELETE /devices/{perch-slot}`, `GET …/status` | `admin` (nur CLI) |

Alles andere ist blockiert, u. a. Slack `chat.delete`/`chat.update`/`files.*`/`admin.*` und GOWA `/send/image|file|…`, `/message/*`, `/group*`, `/user/*`, `/app/*`. GOWA-Geräte-Slots haben das Format `perch-` + 16 Hex; fremde Slots sind nicht adressierbar. JIDs: nur `…@s.whatsapp.net`, `…@lid`, `…@g.us` (kein `status@broadcast`, keine Newsletter).

## 4. Sicherheit und Datenschutz

- Jede GOWA-Anfrage setzt `X-Device-Id`, damit GOWA nie auf ein Standardgerät ausweicht. Nachrichtenzeilen eines anderen Chats werden verworfen. Medien-URLs gibt Perch nie aus.
- Ledger und Audit enthalten keine Texte, Kanal-IDs, JIDs oder Telefonnummern. Gespeichert werden nur die Slack-`ts` (als `<sek>_<mikro>`) bzw. die WhatsApp-Message-ID.
- Senden: Grant, Namespace und Konto-Bindung (Workspace/Team/Nutzer/Token-Hash bzw. Konto/Slot/JID/Bridge-Origin) werden unmittelbar vor dem Provider-Aufruf erneut geprüft. Slack `ok:false` und HTTP 4xx gelten als `rejected`, HTTP 5xx, Timeouts und Verbindungsabbrüche als `indeterminate`. Bei GOWA gilt eine 200-Antwort ohne `SUCCESS` ebenfalls als `indeterminate`.
- Slack-Tokens: nur `xoxp-`. Bot-, Rotations- und App-Tokens werden vor jeder Anfrage abgelehnt.

## 5. Tests (nur Mocks)

- `test/slack.test.ts` (18), `test/slackSend.test.ts` (10), `test/whatsapp.test.ts` (19), `test/slackWhatsappCli.test.ts` (8): Onboarding, Allowlist, Fan-out und Teilfehler, Cursor-Bindung, Rate-Limit-Retry, Grant-Grenzen, Idempotenz (Replay, Konflikt, Indeterminate ohne Neuversand), Widerruf während einer Sitzung, Audit ohne Inhalte, Origin-Regeln, Koppeln mit Timeout-Aufräumen, Entkoppeln, Fallback auf ein fremdes Standardgerät, CLI ohne Secrets in Argumenten oder Ausgaben.
- Nach dem Review (Lookup-Budget pro Aufruf, Koppeln übersteht kurze Bridge-Fehler, Geräte-Routen nur `admin`, 100.100.100.100 abgelehnt) mit Regressionstests. Gesamt: `npm run check` grün, 643 Tests in 51 Dateien, Smoke 10/10 (29 Read-only-Tools), Lizenzprüfung OK (keine neuen Abhängigkeiten).

## 6. Grenzen und offene Punkte

- **Live nicht verifiziert.** Erster Live-Test: ein Slack-Workspace (App aus Manifest, Lesen, eine Testnachricht in einen eigenen Kanal) und GOWA (Installation nach SETUP §4f, Koppeln, Lesen, eine Testnachricht an sich selbst).
- WhatsApp ist inoffiziell (Sperr-Risiko, besonders beim Senden). Verlauf erst ab dem Koppeln. GOWA speichert Nachrichten unverschlüsselt.
- GOWA-Presence-Puls (Default täglich 5 min online) beim Live-Test prüfen.
- `whatsapp_search` durchsucht nur die jüngsten Chats. Ältere Historie nachladen (`/chat/{jid}/history`) ist nicht angebunden.
- Slack: keine Dateidownloads, keine Reaktionen, kein Bearbeiten oder Löschen. Namensfilter in `slack_list_conversations` durchsucht höchstens 20 Seiten pro Ergebnis-Seite.
- WhatsApp: nur Textnachrichten; keine Medien, Umfragen, Reaktionen.
- **Gemeinsames Sende-Limit:** Slack-, WhatsApp- und Mail-Sends teilen sich die 1000 Sende-Records pro Namespace im Ledger. Records werden nie gelöscht (sonst könnte eine alte `requestId` erneut senden). Bei 1000 schlagen **alle** Sends des Namespace geschlossen fehl (`ledger_full`), auch Mail, bis ein Ledger-Rollover gebaut ist. Bei regem Chat-Senden ist das schnell erreicht: Rollover ist der nächste nötige Schritt, wenn Senden regelmäßig genutzt wird.
- Lese-Aufrufe von Slack und WhatsApp schreiben Audit-Events in denselben Ring (2000 Einträge); ältere Mail-Audit-Einträge rotieren dadurch schneller heraus.
- **Kein Downgrade:** Sobald ein Slack- oder WhatsApp-Event im Ledger steht, lehnt eine ältere Perch-Version den Ledger als beschädigt ab (strenges Schema, Ledger-Version unverändert). Zurückrollen nur mit Ledger-Backup von vor dem Update.
- Gefilterte `slack_list_conversations`-Seiten können mehr als `pageSize` (bis ca. 200) Einträge haben.
- Codex-Konfiguration (SETUP §6) ist nur aus der Codex-Dokumentation übernommen, nicht getestet.
