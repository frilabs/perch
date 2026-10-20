# Spezifikation: Volle Funktionen, standardmäßig freigeschaltet

Stand 2026-10-20. **Entwurf, wartet auf Fritz' Freigabe.** Kein Code geändert.

## 0. Auftrag und Entscheidungen

Fritz, 2026-10-20: „Baue es so, dass es standardmäßig alles in den Programmen kann“, und zwar **beides**: deutlich mehr Funktionen in jedem Dienst **und** standardmäßig freigeschaltet. Dazu entschieden:

| Frage | Entscheidung |
| --- | --- |
| Löschen | **nur Papierkorb/Archiv** (wiederherstellbar). Endgültiges Löschen gibt es in Perch nicht. |
| Teilen | **alles, auch öffentlich** (Drive „jeder mit dem Link“), soweit die API es erlaubt |
| Reihenfolge | **alle Dienste in einem Meilenstein** |
| Öffentlich gekoppelte Geräte (claude.ai über Internet) | **dürfen ebenfalls standardmäßig alles** |

## 1. Rechtemodell neu: „alles erlaubt, bei Bedarf einschränken“

Heute: lesen standardmäßig, schreiben nur mit Client-Grant (Opt-in). Neu (Opt-out):

- **Globales Token, `serve --stdio`, öffentlich gekoppelte Geräte:** haben standardmäßig **alle** Fähigkeiten in allen Konten.
- **Client-Grants** bleiben, werden aber zu **Einschränkungen**: Ein Client mit Grant darf nur, was der Grant nennt (wie heute). So lässt sich z. B. ein Uni-Laptop auf `read` begrenzen.
- **Neue Fähigkeiten-Namen** pro Dienst (Lesen, Schreiben, Senden/Teilen, Papierkorb), z. B. `drive_read`, `drive_write`, `drive_share`, `drive_trash`. Die bisherigen (`read`, `send`, `calendar_write`, `slack_send`, …) bleiben als Aliase gültig, bestehende Grants funktionieren unverändert.
- **Schalter für den Notfall:**
  - `perch policy read-only` macht die ganze Installation sofort lesend (alle Tokens, alle Geräte), `perch policy full` hebt das wieder auf. Gespeichert im verschlüsselten Store, wirkt beim nächsten Tool-Aufruf.
  - `PERCH_POLICY=read-only` in der `.env` erzwingt das beim Start.
- **Anbieter-Scopes:** Neue Konten fordern beim Verbinden standardmäßig die vollen Scopes an (Abschnitt 3). `--read-only` beim `add` fordert nur Lesen an. Bestehende Konten behalten ihre Scopes; `perch status` zeigt „beim Anbieter nur lesend, neu verbinden für Schreiben“.
- **Sicherheitsgeländer, die bleiben:**
  - Schreibaufrufe, die etwas erzeugen oder versenden, brauchen eine `requestId`; dieselbe ID sendet nie doppelt. Ergebnis `accepted`/`rejected`/`indeterminate`, kein automatischer Neuversuch.
  - Jeder Aufruf kommt ins Audit-Log, ohne Inhalte.
  - Feste Upstream-Allowlist: Routen für endgültiges Löschen werden nie aufgenommen.
  - Die MCP-Tool-Beschreibungen weisen bei Senden, Teilen und Papierkorb darauf hin, nur nach ausdrücklicher Bestätigung des Nutzers zu handeln.
  - Inhalte aus Mails, Chats, Seiten usw. bleiben als nicht vertrauenswürdig markiert.

**Restrisiko (bewusst akzeptiert):** Ein Client mit dem globalen Token kann nach einer Prompt-Injection in deinem Namen senden, teilen (auch öffentlich) und in den Papierkorb verschieben. Gegenmittel sind Client-Grants für weniger vertrauenswürdige Clients, das Audit-Log und `perch policy read-only`.

## 2. Send-Ledger: Rollover wird Pflicht

Heute teilen sich alle Schreibaufrufe 1000 Einträge, danach schlägt alles fehl. Mit vollen Schreibrechten wäre das in Tagen erreicht. Neu:

- Abgeschlossene Einträge (`accepted`, `rejected`, mit Auflösung) werden nach **90 Tagen** in eine verschlüsselte Archivdatei pro Quartal verschoben. Die aktive Datei enthält nur offene und junge Einträge.
- Eine `requestId` ist damit 90 Tage garantiert eindeutig. Clients erzeugen ohnehin zufällige IDs, deshalb ist das ausreichend; dokumentiert.
- `pending`/`indeterminate` werden nie archiviert.
- Grenze der aktiven Datei: 20 000 Einträge, darüber weiterhin fail closed mit klarer Meldung.
- Ledger-Version wird auf 2 erhöht, mit Migration (Backup der alten Datei, Rückweg dokumentiert).

## 3. Funktionen pro Dienst

Legende: **neu** = kommt dazu, sonst schon vorhanden. „Papierkorb“ = wiederherstellbar.

### 3.1 Google Drive (Scope neu: `drive` statt `drive.readonly`)
- vorhanden: suchen, auflisten, Metadaten, lesen, herunterladen, exportieren
- **neu:** Datei hochladen (bis 10 MiB, Base64), Ordner anlegen, Google Doc/Sheet/Slides leer oder aus Text/CSV anlegen, Inhalt ersetzen, umbenennen, verschieben, kopieren, **Papierkorb** und Wiederherstellen, Freigaben auflisten, **teilen** (Nutzer, Gruppe, Domain, „jeder mit dem Link“, Rollen Leser/Kommentator/Bearbeiter), Freigabe entfernen, Kommentare lesen und schreiben
- nie: endgültig löschen, Papierkorb leeren, Eigentümer übertragen

### 3.2 Notion (Integration-Token braucht die Fähigkeiten „Read/Update/Insert content“ und „Read/Insert comments“)
- vorhanden: Titelsuche, Seiten, Blöcke, Datenbanken, Abfragen
- **neu:** Seite anlegen (unter Seite oder als Datenbankzeile), Eigenschaften ändern, Blöcke anhängen, ändern und archivieren, Seite **in den Papierkorb** und zurück, Kommentare lesen und schreiben
- nicht möglich (Notion-API): Freigaben und öffentliche Links ändern, endgültig löschen

### 3.3 Mail
- **Gmail** (Scope neu: `gmail.modify`; deckt Lesen, Entwürfe, Senden, Labels, Papierkorb ab, aber kein endgültiges Löschen; live zu prüfen)
- **Microsoft Graph** (neu standardmäßig `Mail.ReadWrite` und `Mail.Send`)
- **IMAP/SMTP** (neu standardmäßig Entwürfe und Senden)
- vorhanden: suchen, lesen, Anhänge, Entwurf, senden
- **neu:**
  - antworten, allen antworten, weiterleiten (mit Originalanhängen)
  - vorhandenen Entwurf senden oder ändern
  - als gelesen/ungelesen markieren, markieren (Stern/Flag)
  - archivieren, verschieben (Ordner/Label), **Papierkorb** und zurück
  - Labels/Ordner auflisten und anlegen
  - Threads lesen
  - IMAP: Kopie in „Gesendet“ ablegen
- nie: endgültig löschen, Papierkorb leeren, Filter oder Weiterleitungsregeln ändern

### 3.4 Google Kalender (Scope neu: `calendar`)
- vorhanden: Kalender, Termine, private Termine anlegen und ändern
- **neu:**
  - Termine **mit Gästen und Einladungen** (`sendUpdates` wählbar, Standard „alle“)
  - Serientermine (RRULE), einzelne Vorkommen ändern
  - beliebige Sichtbarkeit, Google-Meet-Link
  - Einladungen annehmen, ablehnen, vorläufig zusagen
  - Termin **absagen** (landet im Kalender-Papierkorb, 30 Tage wiederherstellbar)
  - Frei/Belegt abfragen (auch über mehrere Konten)
  - Termin in anderen Kalender verschieben
- nie: Kalender löschen, Kalender-Freigaben ändern

### 3.5 Google Kontakte (Scope neu: `contacts`)
- vorhanden: auflisten, lesen
- **neu:** suchen, anlegen, ändern (mit `etag`), **Papierkorb** (Google Kontakte bewahrt gelöschte 30 Tage auf), Kontaktgruppen lesen und Mitgliedschaft ändern

### 3.6 Slack (Manifest neu: `reactions:read/write`, `files:read/write`, `im:write`, `mpim:write`, `channels:write`, `groups:write`; Workspace muss die App neu installieren)
- vorhanden: Kanäle, Verlauf, Threads, Suche, posten
- **neu:**
  - eigene Nachrichten bearbeiten, Reaktionen setzen und entfernen
  - Dateien hochladen (bis 10 MiB) und herunterladen
  - DM oder Gruppen-DM öffnen und schreiben
  - Nachricht planen, Kanal beitreten, als gelesen markieren
- nie: Nachrichten löschen (bei Slack endgültig), Kanäle archivieren oder anlegen, Mitglieder entfernen

### 3.7 WhatsApp (GOWA)
- vorhanden: Chats, Nachrichten, Suche, Text senden
- **neu:**
  - Bild, Datei, Audio, Video senden (bis 16 MiB), Reaktion setzen
  - eigene Nachricht bearbeiten, Medien herunterladen
  - als gelesen markieren (sendet Lesebestätigung), älteren Verlauf vom Handy nachladen
  - Gruppen-Infos und -Teilnehmer lesen
- nie: Nachrichten für alle löschen (endgültig), Gruppen verwalten, Kontakte blockieren
- Hinweis: Mehr Senden erhöht das Risiko, dass WhatsApp das Konto einschränkt (inoffizielle Anbindung).

### 3.8 Luma
- vorhanden: Lesen; Events, Gäste, Blasts mit Grants
- **neu:**
  - standardmäßig frei
  - zusätzlich freigegeben: Kalender anlegen und ändern, Co-Hosts, Coupons, Mitgliedschaften, Kontakt-Import, `update_blast`
  - Blast-Gegenprobe (`confirmRecipientCount`) bleibt als Sicherheitsgeländer
- nie: alle `delete_*`/`remove_*` (bei Luma endgültig), Admins ändern

## 4. Umsetzung

- Alle Dienste in einem Meilenstein (Entscheidung), intern in dieser Reihenfolge, damit jederzeit ein lauffähiger Stand existiert: Rechtemodell und Policy-Schalter → Ledger-Rollover → Mail → Kalender → Drive → Notion → Kontakte → Slack → WhatsApp → Luma.
- Jede neue Route kommt in die Upstream-Allowlist mit eigenem Capability-Tag. Tests gegen die vorhandenen Mocks werden erweitert. Pro Dienst gibt es einen Test, dass Routen für endgültiges Löschen nicht erreichbar sind.
- Doku: `SETUP.md` (Scopes, Neu-Verbinden, Slack-Manifest), README (Rechtemodell), Migrationshinweis.
- Nur ein Push am Ende (Regel in `AGENTS.md`), nach `npm run check` und einem unabhängigen Review.

## 5. Migration für bestehende Installationen

- Bestehende Konten bleiben, wie sie sind. Schreiben in einem Konto geht erst, wenn es mit vollen Scopes neu verbunden wurde (`perch <dienst> add` erneut, altes Konto entfernen). `perch status` listet betroffene Konten.
- Bestehende Client-Grants schränken weiter ein. Das globale Token darf nach dem Update sofort alles, soweit die Konten es erlauben. Wer das nicht will: `perch policy read-only`.
- Slack-Workspaces: App mit neuem Manifest neu installieren und das Token mit `perch slack add` neu eintragen.

## 6. Offen, live zu prüfen

- Ob `gmail.modify` Senden ohne zusätzliches `gmail.send` erlaubt.
- Google verlangt für `drive`, `gmail.modify` und `contacts` im Status „Testing“ nichts weiter, für eine veröffentlichte App aber eine Verifizierung (Warnhinweis „unverified app“).
- GOWA-Routen für Medien, Bearbeiten und Lesebestätigungen gegen die echte Version.
- Slack: neue Upload-API (`files.getUploadURLExternal` + `files.completeUploadExternal`).
