# Spezifikation: Mail antworten/weiterleiten, Kalender-Einladungen und Serien, Slack DMs und geplante Nachrichten

Stand 2026-10-20. **Umgesetzt (mock-getestet, nicht live)** auf `feat/mail-calendar-slack`. **Von Fritz freigegeben** („implementiere mail, kalender ist dann halt löschen und nicht nur papierkorb, einzelne Termine einer serie ändern hat keine Prio. Kontakte braucht der MCP nicht anfassen. slack soll er können. wa ignorieren wir. Implementiere“). Ergänzt `FULL_ACCESS_SPEC.md` §3.3, §3.4 und §3.6. Das Rechtemodell bleibt: Lesen standardmäßig, Schreiben nur mit Client-Grant (`perch client add --full` deckt alles ab, auch die neue Fähigkeit).

## Entscheidungen

| Frage | Entscheidung |
| --- | --- |
| Mail | antworten, allen antworten, weiterleiten (mit Originalanhängen); IMAP legt gesendete Mails in „Gesendet“ ab |
| Kalender löschen | **endgültiges Löschen ist erlaubt** (Ausnahme von „nur Papierkorb“) |
| Kalender-Serien | Serien anlegen und als Ganzes ändern/löschen; **einzelne Vorkommen ändern: nicht umgesetzt** (keine Prio) |
| Kontakte | bleiben **nur lesend** (§3.5 entfällt) |
| Slack | DM/Gruppen-DM öffnen, Nachrichten planen (inkl. auflisten und geplante zurückziehen) |
| WhatsApp | keine Änderung (§3.7-Rest entfällt) |

## 1. Mail

Neue Tools (Gmail, Microsoft Graph, IMAP/SMTP):

- `mail_reply` mit `replyAll: boolean` und `mail_forward`.
  - Eingabe: `accountId`, `messageId` des Originals, `text` (optional `html`), bei Weiterleiten `to` (Pflicht), optional zusätzliche `to`/`cc`/`bcc`, `includeAttachments` (Weiterleiten, Standard true).
  - Standard ist **Entwurf** (`send: false`, braucht `draft`). Mit `send: true` wird direkt gesendet (braucht `send` und `requestId`, läuft über den bestehenden idempotenten Versand-Ledger, Ergebnis accepted/rejected/indeterminate wie `mail_send`).
  - Empfänger leitet Perch serverseitig aus den Original-Headern ab: Antworten an `Reply-To`, sonst `From`; Allen antworten zusätzlich `To` und `Cc` ohne die eigene Adresse, ohne Duplikate, höchstens `MAX_RECIPIENTS`. Die Originalinhalte sind nicht vertrauenswürdig; die Tool-Beschreibung verlangt, die Empfängerliste vor `send: true` dem Nutzer zu zeigen.
  - Threading: `In-Reply-To` = Message-ID des Originals, `References` = Original-References + Message-ID (gekürzt), Betreff `Re: `/`Fwd: ` ohne Verdopplung, Gmail mit `threadId`.
  - Zitat: Klartext-Zitat des Originals (`> `) bzw. Weiterleitungsblock mit Von/Datum/Betreff/An; begrenzt auf `MAX_BODY_BYTES`.
  - Weiterleiten übernimmt Originalanhänge bis zur bestehenden Grenze (10 Anhänge, 10 MiB gesamt); darüber Fehler mit klarer Meldung statt stillem Weglassen.
- IMAP: nach von SMTP akzeptiertem Versand (normal, Antwort, Weiterleitung, Entwurf senden) APPEND in den `\Sent`-Ordner (Special-Use, sonst bekannte Namen). Scheitert die Ablage, bleibt das Ergebnis `accepted` mit `sentCopy: false`; nie ein erneuter SMTP-Versand. Konfigurierbar pro Konto (`--no-sent-copy`), Standard an; Anbieter, die selbst ablegen (Gmail-SMTP), werden nicht doppelt beliefert.

## 2. Google Kalender

- Termine anlegen und ändern dürfen zusätzlich:
  - `attendees` (höchstens 50 E-Mail-Adressen, optional `optional: true`), Gast-Rechte (`guestsCanModify`, `guestsCanInviteOthers`, `guestsCanSeeOtherGuests`);
  - `sendUpdates`: `all` | `externalOnly` | `none` (Standard `all`, wenn Gäste beteiligt sind);
  - `recurrence`: höchstens 5 Zeilen `RRULE:`/`EXDATE:`/`RDATE:`, streng validiert (keine Steuerzeichen, kein `RRULE` ohne `FREQ`);
  - beliebige `visibility` (`default`, `public`, `private`, `confidential`);
  - Google-Meet-Link (`addMeet: true` → `conferenceData.createRequest`, `conferenceDataVersion=1`, Request-Id aus `requestId` abgeleitet).
- **Neue Fähigkeit `calendar_invite`** (Familie productivity): nötig, sobald ein Write Gäste hinzufügt/ändert oder Benachrichtigungen verschickt (`sendUpdates` ≠ `none` mit Gästen). Private Termine ohne Gäste brauchen weiterhin nur `calendar_write`.
- `calendar_delete_event`: **endgültig löschen** (Serie als Ganzes, wenn die Serien-Id übergeben wird), `sendUpdates` wählbar; mit Gästen braucht es `calendar_invite`. Optional `etag` als Schutz gegen gleichzeitige Änderung.
- `calendar_respond_event`: Einladung annehmen, ablehnen, vorläufig (eigener Teilnehmer-Eintrag, `sendUpdates` Standard `all`); braucht `calendar_invite`.
- Nicht umgesetzt: einzelne Vorkommen einer Serie ändern/löschen (Instance-Ids werden abgelehnt), Kalender löschen, Kalender-Freigaben, Frei/Belegt.
- Scope: `calendar.events.owned` reicht laut Google für insert/patch/delete auf eigenen Kalendern; Antworten auf fremde Einladungen ist live zu prüfen.

## 3. Slack

- `slack_open_conversation`: DM (1 Nutzer) oder Gruppen-DM (2–8 Nutzer) über `conversations.open`, gibt die Konversations-Id zurück; Schreiben danach mit `slack_send_message`. Braucht `slack_send`.
- `slack_schedule_message`: `channelId`, `text`, `postAt` (Unix-Sekunden oder ISO, mindestens 60 s, höchstens 120 Tage in der Zukunft), optional `threadTs`; Pflicht-`requestId` über den gemeinsamen Versand-Ledger (`chat.scheduleMessage`). Braucht `slack_send`.
- `slack_list_scheduled_messages` (lesen, `slack_read`) und `slack_cancel_scheduled_message` (`chat.deleteScheduledMessage`, nur noch nicht gesendete; `slack_send`).
- Manifest: zusätzlich `im:write`, `mpim:write`; Workspaces müssen die App neu installieren (`SETUP.md`, `perch status` meldet fehlende Scopes, soweit Slack sie liefert).
- Weiterhin nie: gesendete Nachrichten löschen, Kanäle anlegen/archivieren, Mitglieder entfernen.

## 4. Umsetzung und Prüfung

- Jede neue Provider-Route kommt mit eigenem Capability-Tag in die Upstream-Allowlist; Tests gegen die vorhandenen Mocks; pro Bereich ein Test, dass nicht freigegebene Routen blockiert bleiben.
- Doku: README (Fähigkeiten), `SETUP.md` (Slack-Manifest, IMAP Gesendet), `PHASE1_REMAINING.md`.
- `npm run check` grün, unabhängiges Review, ein Push am Ende. Merge nur mit Fritz' OK.
