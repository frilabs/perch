# Setup und Betrieb

Stand 2026-10-05. Alle Befehle laufen auf dem Heimserver, sofern nicht „Laptop“ dabeisteht.

> Perch ist lokal mit Mock-Upstreams getestet, aber **nicht live gegen Google oder Notion verifiziert** (siehe `docs/HANDOFF.md`).

## 1. Voraussetzungen und Build

- Node.js ≥ 22.12 und npm

```bash
git clone https://github.com/frilabs/perch.git perch && cd perch
npm ci
npm run build
npm test                  # Unit- und Integrationstests (Mocks)
npm run smoke             # baut und testet dist/cli.js über stdio und HTTP
```

CLI-Aufruf: `node dist/cli.js …`. Optional global per `npm link`, dann heißt der Befehl `perch …`. Unten steht der Kürze halber `perch`.

## 1a. Schnellster Weg: `perch setup`

```bash
perch setup
```

Der Assistent legt Schlüssel, Speicher und Token an (wie `perch init`), fragt dann Dienst für Dienst „verbinden?“ (Google ist **ein** Schritt für Drive, Gmail, Kalender und Kontakte, siehe Abschnitt 3), zeigt die nötigen Vorbereitungen und Links und ruft die normalen `perch <dienst> add`-Befehle auf. Fehlt der Google-OAuth-Client, führt Perch **im Terminal** Schritt für Schritt durch die Google-Cloud-Vorbereitung (Abschnitt 3.1); kein `scp`/`install` nötig. Browser-Logins (Google, Outlook, Luma) brauchen **keinen Tunnel** mehr: nach der Zustimmung zeigt der Browser „Seite nicht erreichbar“, die komplette Adresse aus der Adresszeile wird ins Terminal eingefügt (Abschnitt 3.2). Jedes `add` fragt **„nur lesen oder lesen + schreiben?“** und fordert die passenden Rechte beim Anbieter an (`--read-only` / `--write` überspringen die Frage; die `--allow-…`-Flags gehen weiter). Zum Schluss legt er auf Wunsch einen Client mit **vollem Zugriff** an (`perch client add --full`: alle Fähigkeiten, alle Konten, auch später verbundene) und zeigt den fertigen `claude mcp add`-Befehl für den Laptop.

Jeder weitere Claude- oder Codex-Account braucht nur noch einen Befehl auf dem Server: `perch client add --label NAME --full` (im Tailnet) oder `perch oauth pair` und bei der Frage „lesen oder voll“ `f` (claude.ai übers Internet).

## 2. Initialisieren

```bash
perch init
```

Der Befehl legt vier Dinge an, aber nur, was noch fehlt. Rechte: Verzeichnisse `0700`, Dateien `0600`.

| Was | Default-Pfad | Variable |
| --- | --- | --- |
| Schlüssel (32 Byte) | `~/.config/perch/store.key` | `PERCH_KEY_FILE` |
| Verschlüsselte DB | `~/.local/share/perch/store.enc` | `PERCH_DATA_DIR` |
| Mail-Workflow-/Audit-Ledger (verschlüsselt, nur mit einer **neuen** DB) | `~/.local/share/perch/mail-workflow.enc` | `PERCH_DATA_DIR` |
| HTTP-Bearer-Token | `~/.config/perch/http-token` | `PERCH_HTTP_TOKEN_FILE` |

- **Upgrade von einer älteren Version:** Eine bestehende DB bekommt den Ledger **nicht** automatisch. Bis er existiert, scheitern alle MCP-Tool-Aufrufe und Sends dieses Namespace geschlossen (`ledger_missing`). Einmalig `perch mail-workflow init` ausführen. Ist ein Ledger verloren gegangen, hilft nur ein Backup: `init` lehnt für Namespaces ab, die schon einen Ledger hatten. Details in Abschnitt 4d.

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

Dasselbe gilt für den Mail-Workflow-Ledger: Lock-Verzeichnis `mail-workflow.lock` im selben Datenverzeichnis (pro Nutzer unter `users/<id>/`). Ein verwaister Ledger-Lock blockiert ab 60 s alle auditierten Tool-Aufrufe und Sends dieses Namespace (fail closed). Abhilfe wie oben, nur wenn kein Perch-Prozess läuft: `rm -r ~/.local/share/perch/mail-workflow.lock`.

Weitere Variablen stehen in `.env.example`. Laden geht zum Beispiel so: `node --env-file=.env dist/cli.js …`.

## 3. Google-Konten verbinden (Nutzeraufgabe: App-Credentials)

Ein Google-Konto wird mit **einem** Befehl und **einem** Browser-Login für Drive, Gmail, Kalender und Kontakte verbunden (Spezifikation: `docs/GOOGLE_UNIFIED_SPEC.md`). **Nicht live verifiziert**; getestet nur gegen Mocks.

### 3.1 Google Cloud einmalig einrichten

**Geführt im Terminal (Standard):** `perch google client setup` – oder einfach `perch google add` / `perch gmail add` / `perch google-productivity add` / `perch setup`: Fehlt die Client-Datei, ist sie leer oder ungültig, fragt Perch „Set it up now, guided step by step? [Y/n]“ und führt durch:

1. Projekt anlegen (Direktlink `console.cloud.google.com/projectcreate`), optional die Projekt-ID eingeben: dann enthalten alle folgenden Links `?project=ID`.
2. APIs aktivieren: Direktlinks nur auf die Library-Seiten der gewählten Dienste (Drive, Gmail, Calendar, People).
3. Google Auth Platform: Branding, Audience („External“, „Testing“, Testnutzer = die eigenen Konten), Data Access mit der **fertig ausgegebenen Scope-Liste** (genau die gewählten Dienste und Lesen bzw. Lesen + Schreiben).
4. Client anlegen: Typ **„Desktop app“**, JSON herunterladen.
5. Den **Inhalt** der JSON-Datei einfügen (verdeckt; mehrzeilig geht auch, bis zur schließenden Klammer, höchstens 16 KiB). Perch prüft: gültiges JSON, Schlüssel `installed` (ein „Web application“-Client wird mit Hinweis abgelehnt), `client_id` endet auf `.apps.googleusercontent.com`, `client_secret` vorhanden, `redirect_uris` enthält `http://localhost`. Drei Versuche.

Gespeichert wird atomar mit `0600` unter `PERCH_GOOGLE_CLIENT_FILE`, ohne die Variable unter `~/.config/perch/google-client.json` (Perch liest diesen Standardpfad von selbst; `.env` wird nie geändert). `perch google client setup` ersetzt einen vorhandenen Client nur nach Rückfrage; `perch google client show` zeigt Pfad und gekürzte Client-ID (nie das Secret). Ohne Terminal endet jedes Google-`add` ohne Client mit einer Fehlermeldung, die auf `perch google client setup` verweist. Eine Datei mit unsicheren Rechten bleibt ein Fehler (`chmod 600`), der Assistent überschreibt sie nicht.

**Von Hand (Alternative):**

1. In der Google Cloud Console ein Projekt anlegen und die APIs der gewünschten Dienste aktivieren: **Google Drive API**, **Gmail API**, **Google Calendar API**, **People API**.
2. Auth-Plattform bzw. OAuth-Zustimmungsbildschirm einrichten:
   - Scopes eintragen: `openid`, `email` (bzw. `.../auth/userinfo.email`), `.../auth/drive.readonly`, `.../auth/gmail.readonly`, `.../auth/calendar.readonly`, `.../auth/contacts.readonly`; für Schreiben zusätzlich `.../auth/drive`, `.../auth/gmail.compose`, `.../auth/gmail.send`, `.../auth/gmail.modify`, `.../auth/calendar.events.owned`.
   - Im Status „Testing“ jedes Google-Konto als Testnutzer hinzufügen.
3. Einen OAuth-Client vom Typ **„Desktop app“** erstellen und die JSON-Datei herunterladen, dann:

```bash
install -m 600 ~/Downloads/client_secret_XXXX.json ~/.config/perch/google-client.json
# PERCH_GOOGLE_CLIENT_FILE nur nötig für einen anderen Pfad als diesen Standardpfad
```

**Hinweise zu Google** (Stand der Google-Dokumentation, bitte dort prüfen):

- `drive.readonly`, `gmail.readonly`, `gmail.compose` und `gmail.modify` sind *restricted scopes*.
- Im Status „Testing“ laufen Refresh-Tokens nach 7 Tagen ab. Danach das Konto mit demselben Befehl neu hinzufügen (aktualisiert die Gruppe, gleiche IDs).
- Für eine veröffentlichte App mit restricted scope verlangt Google eine Verifizierung. Ohne sie erscheint ein Warnhinweis „unverified app“.

### 3.2 Ein Konto hinzufügen (einmal pro Google-Konto)

```bash
perch google add --label "Privat" --port 8766
```

1. Perch fragt, welche Dienste verbunden werden (Standard: alle; ohne Terminal alle) und dann einmal **„[r]ead only, or read + [w]rite?“**. Ohne Fragen: `--services drive,gmail,calendar,contacts` und `--read-only` bzw. `--write`. Die bisherigen Feinschalter gelten weiter: `--allow-write` (Drive), `--allow-drafts`, `--allow-send`, `--allow-modify` (Gmail), `--allow-calendar-write`.
2. Perch gibt **eine** Google-Auth-URL mit allen Scopes der gewählten Dienste aus (`include_granted_scopes=true`). Die URL im Browser öffnen und das gewünschte Konto wählen.
3. Google leitet auf `http://127.0.0.1:8766/oauth2/callback` um. **Ohne Tunnel:** Läuft der Browser auf dem Laptop, zeigt er danach „Seite nicht erreichbar“. Die komplette Adresse aus der Adresszeile kopieren und ins Terminal einfügen (verdeckte Eingabe). Perch wartet gleichzeitig auf den Callback und auf die eingefügte Adresse; was zuerst kommt, gewinnt, das andere wird beendet. Die Adresse wird so streng geprüft wie der Callback: Host `127.0.0.1`/`localhost`/`[::1]`, genau der erwartete Port und Pfad, `state` (konstante Zeit), dann wird `code` übernommen; `error=` bricht ab. Eine abgelehnte Adresse (z. B. alter Login-Versuch) wird gemeldet, Perch wartet weiter. PKCE, `state` und Redirect-URI bleiben unverändert. Das gilt für alle Browser-Logins (Google, Gmail, Calendar/Contacts, Outlook, Luma).

   **Oder mit Tunnel** (Login schließt sich dann von selbst ab), vorher auf dem Laptop:

```bash
ssh -N -L 8766:127.0.0.1:8766 homeserver
```

**Ergebnis:** eine **Google-Konto-Gruppe** (`ggroup-…`) mit den gewohnten Konten darunter: `google-…` (Drive), `gmail-…` (Gmail), `gprod-…` (Kalender und Kontakte). Grants, Tools und `perch client add --account` arbeiten wie bisher mit diesen IDs (eine `ggroup-…`-ID bei `--account` wird abgelehnt; die Meldung nennt die Mitglieds-IDs). Die Gruppe hält **ein** Refresh-Token (einmal gespeichert); Token-Refresh und Fehler wie ein widerrufener Grant (`invalid_grant`) gelten für alle Dienste der Gruppe gleich, ein Refresh läuft nie doppelt.

**Granulare Zustimmung:** Google lässt einzelne Häkchen abwählen. Perch verbindet nur, was Google tatsächlich gewährt hat, und sagt, was fehlt und mit welchem Befehl es sich nachholen lässt. Fehlt ein Lese-Scope, wird der Dienst nicht verbunden; fehlt ein Schreib-Scope, ist der Dienst nur lesend verbunden. Ohne einen einzigen gewährten Dienst wird nichts gespeichert.

**Was Perch prüft:**
- Pfad, `state` (zufällig, wird vor dem Code-Tausch geprüft), PKCE S256 und Timeout (Default 300 s, `--timeout` 1–3600 s)
- Ob ein Refresh-Token vorhanden ist
- Identität über `https://openidconnect.googleapis.com/v1/userinfo` (`sub`, `email_verified: true`)
- Welche Scopes gewährt wurden (pro Dienst)

**Neu verbinden / Rechte ändern:** Derselbe Befehl für ein schon verbundenes Konto fragt, ob die bestehende Gruppe aktualisiert werden soll (`--yes` ohne Frage; ohne Terminal ist `--yes` Pflicht, sonst ändert sich nichts). Dann ersetzt Perch das Refresh-Token, ergänzt neue Dienste und behält alle Konto-IDs, Client-Grants bleiben gültig. Es entstehen keine Dubletten. Für die Dienste im Befehl gelten genau die jetzt angefragten Rechte: `--read-only` nimmt diesen Diensten Schreibrechte (Gmail Entwürfe/Senden/Organisieren, Kalender-Schreiben); nicht genannte Dienste behalten ihre Rechte. Das alte Refresh-Token wird nicht widerrufen (es gehört zum selben Grant wie das neue).

Wiedererkannt wird das Konto an seiner Google-ID (`sub`), nicht an der E-Mail. Gehört dieselbe Adresse inzwischen zu einem anderen Google-Konto, lehnt Perch ab; erst die alte Gruppe entfernen (`perch google remove ggroup-…`), dann neu hinzufügen.

```bash
perch google add --label "Privat" --services gmail --allow-send --port 8766   # Gmail senden nachrüsten
```

**Weitere Konten:** Jedes Google-Konto ist eine eigene Gruppe mit eigenem Label.

```bash
perch google add --label "Arbeit" --port 8766
perch google list
```

**Entfernen:**

```bash
perch google remove ggroup-1a2b3c4d                    # ganze Gruppe lokal löschen (nur mit der ggroup-ID)
perch google remove ggroup-1a2b3c4d --revoke           # zusätzlich EINMAL bei Google widerrufen: trifft alle Dienste
perch google remove ggroup-1a2b3c4d --service gmail    # nur einen Dienst entfernen, ohne Widerruf (auch per Konto-ID)
```

- Die ganze Gruppe wird nur über ihre `ggroup-…`-ID entfernt. Eine Konto-ID eines Mitglieds ohne `--service` wird abgelehnt; die Meldung nennt die Gruppen-ID und den passenden `--service`-Befehl.
- Ein Widerruf trifft immer alle Dienste der Gruppe, weil sie sich die Anmeldung teilen. `--service` mit `--revoke` wird deshalb abgelehnt; `perch gmail remove gmail-… --revoke` für ein Gruppenmitglied ebenso.
- Google widerruft dabei den **ganzen Grant des OAuth-Clients für dieses Google-Konto**. Gibt es dafür noch einen anderen gespeicherten Eintrag (eine weitere Gruppe oder ein einzeln verbundenes Konto mit derselben Google-ID bzw. E-Mail und derselben Client-ID), lehnt Perch `--revoke` ab und nennt die Konten, die sonst mit den Zugriff verlören. `--force` widerruft trotzdem und nennt sie danach. Das gilt auch für `perch gmail remove … --revoke` und `perch google-productivity remove … --revoke`.
- Wird der letzte Dienst einer Gruppe entfernt (auch über `perch gmail remove` / `perch google-productivity remove`), verschwindet die Gruppe samt gespeicherter Anmeldung. Der Grant bleibt bei Google gültig; Perch weist darauf hin (Widerruf unter <https://myaccount.google.com/permissions>; in einem Schritt geht es mit `perch google remove ggroup-… --revoke`).

**Einzeln verbundene Konten** (vor diesem Stand oder mit `perch gmail add` / `perch google-productivity add`) bleiben gültig und unverändert; es gibt keine automatische Migration. Sie erscheinen in `perch status` als eigene Einträge. Für dieselbe E-Mail lässt `perch google add` einen schon einzeln verbundenen Dienst unverändert und meldet ihn; zum Zusammenführen das einzelne Konto entfernen und `perch google add … --services <dienst>` ausführen. `--services drive` ergibt das frühere `perch google add` (nur Drive).

### 3.3 Schreiben (Drive)

Standardmäßig ist Drive nur lesend verbunden (`drive.readonly`). Für Schreiben das Konto mit vollem Drive-Zugriff verbinden (Scope `drive`; im Consent-Screen der Google-Cloud-App muss dieser Scope eingetragen sein). Für ein Gruppenkonto genügt erneutes Hinzufügen (gleiche IDs):

```bash
perch google add --label "Privat" --services drive --allow-write --port 8766
perch client add --label "Laptop" --allow drive_read,drive_write --account google-1a2b3c4d
```

Ein einzeln verbundenes Drive-Konto (ohne Gruppe) vorher mit `perch google remove google-1a2b3c4d` entfernen.

- Schreiben dürfen **nur Client-Grants mit `drive_write`** für genau dieses Konto. Das globale Token und `serve --stdio` bleiben lesend.
- Fehlt beim Anbieter der Scope `drive`, scheitert jeder Schreibaufruf mit `provider_scope_missing` (Hinweis: neu verbinden mit `--allow-write`), bevor etwas an Google geht.
- Werkzeuge: hochladen (bis 10 MiB, Base64), Ordner, Google Doc/Sheet/Slides (leer oder aus Text/CSV), Inhalt ersetzen, umbenennen/verschieben, kopieren, teilen (Nutzer, Gruppe, Domain, „jeder mit dem Link“; Leser/Kommentator/Bearbeiter), Freigabe entfernen, kommentieren, Papierkorb und wiederherstellen.
- Anlegen, Kopieren, Teilen und Kommentieren brauchen eine `requestId` (wie beim Senden, Abschnitt 4d): dieselbe ID läuft nie doppelt.
- **Nie:** endgültig löschen, Papierkorb leeren, Eigentümer übertragen oder Rolle „owner“ vergeben. Diese Routen stehen nicht in der Allowlist.
- Alle Schreibaufrufe stehen im Audit-Log (`perch audit list`), ohne Dateinamen, Inhalte oder E-Mail-Adressen.

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

Lesen dürfen das globale Token (nur lesend) und Client-Grants mit `notion_read`, diese nur in ihren Workspaces.

### 4.1 Schreiben (Notion)

Schreiben geht nur über einen Client-Grant mit `notion_write` für den Workspace, nie über das globale Token:

```bash
perch client add --label "Codex Notion" --allow notion_read,notion_write --account notion-1a2b3c4d
```

- Tools: `notion_create_page` (unter einer Seite oder als Zeile einer Data Source), `notion_update_page`, `notion_append_blocks`, `notion_update_block`, `notion_trash_page`/`notion_restore_page`, `notion_trash_block`, `notion_add_comment`; lesend dazu `notion_list_comments`.
- Löschen heißt nur **Papierkorb** (`in_trash`, in Notion wiederherstellbar). Endgültiges Löschen und Änderungen am Datenbank-Schema sind nicht in der Allowlist.
- Anlegen, Blöcke anhängen und Kommentieren brauchen eine `requestId` (wie beim Senden, Abschnitt 4d): dieselbe ID schreibt nie doppelt, kein automatischer Neuversuch.
- Grenzen pro Aufruf: höchstens 100 Blöcke (verschachtelte mitgezählt), 512 KiB JSON, 2000 Zeichen pro Rich-Text-Element.
- **Im Token freischalten (Nutzeraufgabe):** In den Einstellungen des Tokens bzw. der Integration die Fähigkeiten **„Update content“**, **„Insert content“** und für Kommentare **„Read comments“** und **„Insert comments“** aktivieren und die Seiten mit dem Token teilen. Perch kann das vorab nicht prüfen; fehlt eine Fähigkeit, meldet Notion `restricted_resource` und Perch zeigt einen Hinweis darauf.

## 4a. Mail-Konten verbinden (E-Mail-Meilenstein)

Spezifikation und Testnachweise: `docs/EMAIL_MILESTONE.md`. **Nichts davon ist live verifiziert.** Getestet wurde nur gegen Mocks und lokale Testserver.

Grundregel: **Standard ist Lesen.** Entwürfe und Senden brauchen zwei Freigaben:
1. beim Verbinden des Kontos, also Provider-Scope oder IMAP-Opt-in (`--allow-drafts`, `--allow-send`);
2. einen **Client-Grant** für genau diese Konto-IDs (Abschnitt 4a.4).

Das globale HTTP-Token und `serve --stdio` ohne Client-Token bleiben read-only.

### 4a.1 Gmail

**Standardweg:** `perch google add --label "Privat"` (Abschnitt 3.2) verbindet Gmail zusammen mit Drive, Kalender und Kontakten über eine Anmeldung; nur Gmail: `perch google add --label "Privat" --services gmail [--allow-drafts] [--allow-send] [--allow-modify]`.

Der bisherige Befehl `perch gmail add` funktioniert weiter und legt ein Gmail-Konto mit **eigenem Grant** an (getrennt von Drive):

1. Im selben Google-Cloud-Projekt wie für Drive die **Gmail API** aktivieren.
2. Im Consent Screen die Scopes eintragen:
   - `gmail.readonly` (restricted);
   - optional `gmail.send` (sensitive) und/oder `gmail.compose` (restricted: Entwürfe + Senden).
3. Testnutzer eintragen. Restricted Scopes verlangen für den Produktionsstatus eine Google-Verifizierung. Im Testing-Status laufen Refresh-Tokens nach 7 Tagen ab.
4. Konto verbinden. Der Desktop-Client aus `PERCH_GOOGLE_CLIENT_FILE` (bzw. dem Standardpfad) wird wiederverwendet; fehlt er, startet die geführte Einrichtung (Abschnitt 3.1).

```bash
perch gmail add --label "Privat-Gmail"                    # nur gmail.readonly
perch gmail add --label "Privat-Gmail" --allow-send       # + gmail.send
perch gmail add --label "Privat-Gmail" --allow-drafts     # + gmail.compose (Entwürfe und Senden)
perch gmail list
perch gmail remove gmail-1a2b3c4d [--revoke]
```

Fehlt nach dem Consent ein angefragter Scope, z. B. weil ein Häkchen entfernt wurde, bricht `perch gmail add` ab. (`perch google add` verbindet stattdessen, was gewährt wurde, und meldet den Rest.)

### 4a.2 Outlook.com / Microsoft 365 (Microsoft Graph, delegiert)

**Geführt (Standard):** `perch microsoft add` (oder Outlook in `perch setup`) erkennt, dass noch keine Client-ID da ist, und führt im Terminal durch die App-Registrierung, jeweils mit „Enter, wenn erledigt“:

1. Direktlink auf die neue App-Registrierung im Entra Admin Center
   (<https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false>,
   Liste: <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>):
   Name „Perch“, Kontotypen **einschließlich persönlicher Microsoft-Konten**, Redirect-URI Plattform
   „Public client/native (mobile & desktop)“ mit `http://localhost`.
2. Authentication prüfen: Plattform **„Mobile and desktop applications“** mit `http://localhost`; **kein** Client-Secret (öffentlicher Client mit PKCE).
3. API permissions → Microsoft Graph → delegiert: `User.Read`, `Mail.Read`; bei Lesen + Schreiben zusätzlich `Mail.ReadWrite` und `Mail.Send`. `offline_access` fordert Perch beim Login selbst an.
4. **Application (client) ID einfügen.** Perch prüft das GUID-Format (drei Versuche) und speichert sie atomar mit `0600` in `~/.config/perch/microsoft-client-id` (bzw. `$XDG_CONFIG_HOME/perch/microsoft-client-id`). Danach läuft der Login wie gewohnt weiter.

`PERCH_MICROSOFT_CLIENT_ID` in `.env` hat weiter **Vorrang**; die Datei ist nur der Fallback. Eine Datei mit unsicheren Rechten, Symlink oder ohne GUID wird nicht verwendet (`perch microsoft add` nennt den Grund). Ohne Terminal bricht `perch microsoft add` wie bisher mit einem klaren Fehler ab.

```bash
perch microsoft client setup     # nur die Registrierung (ersetzt eine vorhandene Datei nach Rückfrage)
perch microsoft client show      # Quelle (Variable oder Datei), gekürzte Client-ID, Pfad, Tenant
```

**Manuell (Alternative):** die App-Registrierung wie oben anlegen und `PERCH_MICROSOFT_CLIENT_ID=<Application (client) ID>` in `.env` setzen.

Optional `PERCH_MICROSOFT_TENANT`:

- `common` (Default)
- `consumers` (nur persönliche Konten)
- `organizations`
- Tenant-GUID oder -Domain

```bash
perch microsoft add --label "Outlook"                                  # offline_access User.Read Mail.Read
perch microsoft add --label "Firma" --allow-drafts --allow-send         # + Mail.ReadWrite, Mail.Send
perch microsoft list
perch microsoft remove microsoft-1a2b3c4d
```

- Ohne Tunnel: nach der Zustimmung die Adresse `http://localhost:<port>/?code=…` aus der Adresszeile ins Terminal einfügen (wie bei Google, Abschnitt 3.2). Oder der Browser erreicht `http://localhost:<port>` auf dem Server per `ssh -N -L <port>:127.0.0.1:<port>`. Der Listener bindet nur `127.0.0.1`. Löst der Browser `localhost` nur auf `::1` auf, hilft `--redirect-host 127.0.0.1`. Dann muss `http://127.0.0.1` als Redirect-URI im Manifest der App-Registrierung stehen.
- **Firmen-Tenants** können User-Consent für `Mail.*` verbieten oder Admin-Consent verlangen. `add` scheitert dann mit einem klaren Fehler.
- Microsoft rotiert Refresh-Tokens. Perch speichert sie unter Lock. Lässt sich ein neuer Token nicht speichern, oder wurde das Konto währenddessen entfernt bzw. geändert, schlägt der Aufruf fehl (fail closed).
- **Widerruf:** <https://account.live.com/consent/Manage> (persönlich) bzw. <https://myapplications.microsoft.com> (Firma). `remove` löscht nur lokal.

### 4a.3 GMX und andere IMAP/SMTP-Konten

1. In GMX (Webmail → Einstellungen → POP3/IMAP Abruf) **„POP3 und IMAP Zugriff erlauben“** aktivieren. Mit Zwei-Faktor-Authentifizierung ein **anwendungsspezifisches Passwort** erzeugen und dieses verwenden.
2. Presets anzeigen und Konto hinzufügen. Das Passwort wird **nur** maskiert im Terminal abgefragt (TTY), nie als Argument.

```bash
perch imap presets
perch imap add --label "GMX" --email name@gmx.at                     # Preset gmx: imap.gmx.net:993, mail.gmx.net:465
perch imap add --label "GMX" --email name@gmx.at --allow-send --allow-drafts
perch imap add --label "GMX intl" --email name@gmx.com               # Preset gmx-com: imap.gmx.com / mail.gmx.com
perch imap add --label "Andere" --email ich@example.org --imap-host imap.example.org --imap-port 993 \
  --smtp-host smtp.example.org --smtp-port 587 --smtp-security starttls
perch imap list
perch imap remove imap-1a2b3c4d
```

- **Transport:** IMAP nur mit implizitem TLS. SMTP mit implizitem TLS (465) oder STARTTLS mit Pflicht-TLS (587). TLS ≥ 1.2 mit Zertifikatsprüfung ist nicht abschaltbar. Nur Hostnamen, keine IP-Adressen.
- **Prüfung beim Hinzufügen:** `add` meldet sich vor dem Speichern bei IMAP an (bei `--allow-send` zusätzlich SMTP-`verify`). Bei einem Fehler wird nichts gespeichert.
- **Gesendet-Ordner:** Nachdem SMTP eine Mail angenommen hat (`mail_send`, `mail_reply`/`mail_forward` mit `send: true`), legt Perch per IMAP-APPEND eine Kopie (mit Bcc, `\Seen`) in den `\Sent`-Ordner, sonst in einen Ordner mit üblichem Namen („Sent“, „Gesendet“, „Gesendete Objekte“ …). `mail_send_draft` verschiebt den Entwurf dorthin (ohne MOVE/UIDPLUS: Kopie, der Entwurf bleibt). Scheitert die Ablage, bleibt das Ergebnis `accepted` mit `sentCopy: false`; Perch sendet **nie** erneut über SMTP. Abschalten pro Konto: `perch imap add … --no-sent-copy`. Für SMTP-Server, die selbst ablegen (`smtp.gmail.com`, `smtp.office365.com`, `smtp-mail.outlook.com`), ist die Kopie automatisch aus (sonst läge jede Mail doppelt da). `perch imap list` zeigt „sent copy on/off“. Ob GMX bei SMTP-Versand selbst ablegt, ist nicht live geprüft; falls ja, das Konto mit `--no-sent-copy` neu hinzufügen.

### 4a.4 Client-Grants für Entwürfe und Senden

Einfachster Weg: `perch client add --label "Claude Code" --full` gibt einem Client Lesen und Schreiben auf allen Konten (auch später verbundenen). Die feine Variante unten bleibt für Clients, die nur einen Teil dürfen sollen.

```bash
perch client add --label "Laptop Claude" --allow read,send --account imap-1a2b3c4d --account microsoft-1a2b3c4d \
  --token-file ~/.config/perch/clients/laptop.token
perch client list
perch client remove client-1a2b3c4d     # wirkt ab dem nächsten Tool-Aufruf, auch in laufenden Sessions
```

- **Token:** 256 Bit, landet nur in der neuen `0600`-Datei und wird nie ausgegeben. Die DB speichert nur den SHA-256-Hash.
- **HTTP:** das Client-Token statt des globalen Tokens als Bearer verwenden. Beispiel: `TOKEN="$(ssh homeserver 'cat ~/.config/perch/clients/laptop.token')"`, dann `claude mcp add ... --header "Authorization: Bearer ${TOKEN}"`, wie in Abschnitt 6.
- **stdio:** `PERCH_CLIENT_TOKEN_FILE=~/.config/perch/clients/laptop.token perch serve --stdio`.
- **Wirkung:** Client-Grants mit Mail-Capabilities gelten **nur für Mail** und nur für die gelisteten Konto-IDs (Calendar/Contacts-Grants: Abschnitt 4b).
  - Keine Drive- oder Notion-Tools und keine Drive/Notion-Metadaten. `perch_list_accounts` zeigt nur `mail` (die gewährten Konten) und `connection`.
  - Lese-Tools (`mail_search`, `mail_read_message`, `mail_get_attachment`) gibt es nur mit `read`, `mail_create_draft` nur mit `draft`, `mail_send` nur mit `send`.
  - Antworten mit `replyToMessageId` lesen die Originalmail und brauchen deshalb zusätzlich `read`.
  - `mail_send` verlangt eine `requestId` (idempotenter Versand, Abschnitt 4d). `mail_send_status` (nur mit `send`) zeigt den Stand eigener Sends.
  - Andere Konten sind unsichtbar. Eine nicht gewährte und eine nicht existierende Konto-ID liefern dieselbe Ablehnung.
- **Widerruf und Einschränkung:** Vor **jedem** Tool-Aufruf liest Perch den Grant neu aus dem Store (Grant-ID und Token-Hash). `perch client remove` oder ein eingeschränkter Grant gilt damit sofort, auch für eine laufende stdio-Session. Der Aufruf scheitert mit `grant_revoked` bzw. `capability_denied`, bevor ein Provider kontaktiert wird. Über HTTP wird ein entferntes Token zusätzlich mit `401` abgewiesen. Die Tool-Liste einer laufenden stdio-Session wird nicht aktualisiert.
- **Betreiber:** Das globale HTTP-Token und `perch serve --stdio` ohne Client-Token behalten alle Read-only-Tools (Drive, Notion, Mail, seit dem Productivity-Meilenstein auch Calendar/Contacts lesend) für alle Konten. Schreib-Tools gibt es dort nie.
- **Grenze:** Client-Grants schränken einen Client innerhalb **eines** Namespace ein. Die Trennung zwischen Personen leisten erst die vom Admin angelegten Nutzer (Abschnitt 4c).

### 4a.5 Ordnen und Entwürfe senden

Mails ordnen (gelesen/ungelesen, Stern/Flag, verschieben, archivieren, Papierkorb und zurück) und vorhandene Entwürfe senden. Löschen heißt immer **Papierkorb** (wiederherstellbar). Endgültiges Löschen, Papierkorb leeren, Filter und Weiterleitungsregeln bietet Perch nicht an; die Upstream-Allowlist enthält diese Routen nicht.

- **Beim Anbieter freischalten** (`--allow-modify`, sonst `provider_scope_missing` mit Hinweis zum Neu-Verbinden):
  - Gmail: `perch gmail add --label "Gmail" --allow-modify` fordert zusätzlich `gmail.modify` an (Labels, gelesen, Archiv, Papierkorb; kein endgültiges Löschen). Für die Google-Cloud-Einwilligung den Scope `.../auth/gmail.modify` ergänzen.
  - Microsoft: `perch microsoft add --label "Outlook" --allow-modify` fordert `Mail.ReadWrite` an (dasselbe Recht wie `--allow-drafts`).
  - IMAP: `perch imap add ... --allow-modify` speichert `allowModify: true`. Bestehende Konten bleiben ohne (Standard `false`).
  - Bestehende Konten: entfernen und mit der Option neu hinzufügen.
- **Client-Grant:** Ordnen braucht die Capability `modify` für das Konto, Entwurf senden braucht `send`:
  `perch client add --label "Laptop" --allow read,modify,send --account gmail-1a2b3c4d`
- **Tools:**
  - `mail_list_folders`, `mail_list_drafts` (lesend, mit `read` und für das globale Token)
  - `mail_mark_message` (`read`, `starred`), `mail_move_message` (`folderId` aus `mail_list_folders` oder `archive: true`), `mail_trash_message`, `mail_restore_message` (alle mit `modify`)
  - `mail_send_draft` (mit `send` und `requestId`, idempotent wie `mail_send`; Stand über `mail_send_status`)
- **Pro Anbieter:**
  - Gmail: Verschieben setzt das Ziel-Label und entfernt `INBOX`, Archivieren entfernt nur `INBOX`, Papierkorb über `messages/{id}/trash`/`untrash`. Entwurf senden über `drafts/send` braucht `gmail.compose` oder `gmail.modify` (`gmail.send` allein reicht nicht).
  - Microsoft: Papierkorb ist „Gelöschte Elemente“, Archivieren verschiebt nach „Archiv“, Wiederherstellen nur aus „Gelöschte Elemente“ zurück in den Posteingang. Nach jedem Verschieben hat die Mail eine **neue** `messageId` (steht in der Antwort). Entwurf senden braucht `Mail.Send`.
  - IMAP: Papierkorb ist der Ordner mit Special-Use `\Trash`, Archiv `\Archive` (sonst `folderId` angeben). Verschoben wird nur mit `MOVE` oder `UIDPLUS`; ohne beides lehnt Perch ab, weil ein einfaches `EXPUNGE` andere als gelöscht markierte Mails endgültig entfernen könnte. Entwurf senden liest den Entwurf aus dem Entwurfsordner, verschickt ihn per SMTP **ohne Bcc-Kopfzeile** (Bcc nur im Envelope) und verschiebt ihn danach nach `\Sent`. Der `From` des Entwurfs muss die Kontoadresse sein.
- **Audit:** Jeder Aufruf landet ohne Inhalte im Audit-Log; Schreibaufrufe mit `attempt` vor dem Anbieter-Aufruf.

## 4b. Google Calendar und Contacts verbinden (Productivity-Meilenstein)

Spezifikation und Testnachweise: `docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`. **Nichts davon ist live verifiziert.** Getestet wurde nur gegen Mocks.

1. Im selben Google-Cloud-Projekt die **Google Calendar API** und/oder die **People API** aktivieren.
2. Im Consent Screen die Scopes eintragen: `openid`, `email` (bzw. `.../auth/userinfo.email`), `.../auth/calendar.readonly`, `.../auth/contacts.readonly` und nur bei Bedarf `.../auth/calendar.events.owned`. Testnutzer eintragen; im Testing-Status laufen Refresh-Tokens nach 7 Tagen ab.
3. Konto verbinden. **Standardweg:** `perch google add --label "Privat" --services calendar,contacts [--allow-calendar-write]` (Abschnitt 3.2, eine Anmeldung mit Drive und Gmail; die Konten heißen wie bisher `gprod-…`). Der bisherige Befehl legt einen **eigenen Grant** an, getrennt von Drive und Gmail; dafür ist weder eine Drive- noch eine Gmail-Freigabe nötig. Der Desktop-Client aus `PERCH_GOOGLE_CLIENT_FILE` wird wiederverwendet. `--services` ist Pflicht und wählt die Dienste ausdrücklich:

```bash
perch google-productivity add --label "Privat" --services calendar            # calendar.readonly
perch google-productivity add --label "Privat" --services contacts            # contacts.readonly
perch google-productivity add --label "Privat" --services calendar,contacts --allow-calendar-write
                                                                               # + calendar.events.owned
perch google-productivity list
perch google-productivity remove gprod-1a2b3c4d [--revoke]
```

- `perch google-productivity add` prüft nach dem Consent: Refresh-Token vorhanden, jeder angefragte Scope gewährt (ein entferntes Häkchen bricht `add` ab), E-Mail über den festen Endpunkt `https://openidconnect.googleapis.com/v1/userinfo` mit `email_verified: true`. Ein zweiter Grant für dasselbe Google-Konto (`sub`) wird abgelehnt.
- **Schreiben** braucht drei Freigaben: `--allow-calendar-write` beim Verbinden, den von Google tatsächlich gewährten Scope `calendar.events.owned` (zusätzlich beim Token-Refresh erneut geprüft) und einen Client-Grant mit `calendar_write`. Termine mit Gästen (jede Änderung daran), Einladungen und Antworten brauchen zusätzlich `calendar_invite` (gleicher Google-Scope; `--full` enthält es).
- **Client-Grants** für Calendar/Contacts gelten nur für `gprod-…`-Konten und geben keinen Mail-Zugriff:

```bash
perch client add --label "Laptop Kalender" --allow calendar_read,calendar_write,calendar_invite --account gprod-1a2b3c4d \
  --token-file ~/.config/perch/clients/calendar.token
perch client add --label "Kontakte" --allow contacts_read --account gprod-1a2b3c4d
```

  `calendar_read` → `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`; `contacts_read` → `contacts_list`, `contacts_get`; `calendar_write` → `calendar_create_event`, und zusammen mit `calendar_read` auch `calendar_update_event` und `calendar_delete_event`; `calendar_invite` + `calendar_read` → `calendar_respond_event`. Mail-Capabilities (`read`, `draft`, `send`) gelten weiterhin nur für Mail-Konten; ein Grant, dessen Capabilities nicht zu den Konten passen, wird abgelehnt.
- **Was Perch schreibt** (Spec `MAIL_CALENDAR_SLACK_SPEC.md` §2): Termine im eigenen Kalender, optional mit Gästen (`attendees`, höchstens 50 Adressen, `optional`), Gast-Rechten (`guestsCanModify`, `guestsCanInviteOthers`, `guestsCanSeeOtherGuests`), Serie (`recurrence`: genau eine `RRULE` mit `FREQ` DAILY/WEEKLY/MONTHLY/YEARLY, dazu `EXDATE`/`RDATE`, höchstens 5 Zeilen; Zeittermine brauchen `timeZone`) und Google-Meet-Link (`addMeet: true`). Ändern und Löschen nur bei Terminen, die man selbst organisiert, mit `etag` (If-Match). Nie: Organisator, Anhänge, Kalender löschen/leeren, Freigaben, **einzelne Vorkommen einer Serie** (Instanz-IDs `…_20261012T090000Z` werden abgelehnt; Serien nur als Ganzes über die Serien-ID = `recurringEventId`).
  - **Ohne Gäste** bleibt alles wie bisher privat und still: `sendUpdates=none`, ohne Angabe `visibility: "private"`; beim Ändern eines gästelosen Termins mit `default`/ohne Sichtbarkeit setzt Perch im selben PATCH `private`. Ausdrücklich gesetzte Sichtbarkeit (`default`, `public`, `private`, `confidential`) wird übernommen; ein öffentlicher Termin bleibt beim Ändern öffentlich.
  - **Mit Gästen** braucht **jeder** Write `calendar_invite`, sobald der Termin vor oder nach der Änderung Gäste hat: Gäste hinzufügen/ändern/entfernen, aber auch Zeit, Serie, Meet-Link, Gast-Rechte oder Titel ändern, und zwar auch mit `sendUpdates: "none"` (Gäste sehen die Änderung trotzdem). `calendar_write` allein deckt nur Termine ohne Gäste ab. `sendUpdates` ist mit Gästen standardmäßig `all` (`externalOnly`, `none` wählbar). Ohne Angabe ist die Sichtbarkeit `default`. Bleibende Gäste behalten Antwort, Kommentar, `additionalGuests` und Anzeigenamen, der eigene Eintrag bleibt erhalten.
  - **Erinnerungen:** nur Popup-Erinnerungen. Perch nutzt nie die Standard-Erinnerungen des Kalenders, weil diese E-Mails sein können: `useDefault: true` wird abgelehnt; ohne Angabe sendet Perch `{useDefault: false, overrides: []}`, beim Ändern behält Perch nur Popup-Erinnerungen.
  - **Löschen** (`calendar_delete_event`) ist **endgültig** (kein Papierkorb), bei Serien-ID die ganze Serie. Mit Gästen braucht es `calendar_invite` und Google verschickt Absagen (`sendUpdates` Standard `all`). Perch sendet immer das aktuelle `etag` als If-Match; ein übergebenes `etag` muss passen. Ein bereits abgesagter Termin (`status: "cancelled"`) ergibt `not_found`.
  - **Antworten** (`calendar_respond_event`): `accepted`/`declined`/`tentative` für den eigenen Teilnehmer-Eintrag, PATCH nur mit diesem Eintrag und `attendeesOmitted: true`, `sendUpdates` Standard `all`. Eigene Termine (man ist Organisator) werden abgelehnt; die ändert man mit `calendar_update_event`. Ob `calendar.events.owned` das Antworten auf fremde Einladungen erlaubt, ist noch live zu prüfen.
- **Wiederholen:** `calendar_create_event` braucht eine stabile `requestId`. Bei `indeterminate` (Ausgang unbekannt) dieselbe `requestId` und dieselbe `calendarId` erneut senden: Der Termin entsteht dann höchstens einmal, sonst kommt `conflict`. Perch wiederholt nie selbst.
- **Widerruf:** <https://myaccount.google.com/permissions> oder `remove --revoke` (abgelehnt, solange ein anderer Eintrag desselben Google-Kontos denselben OAuth-Client nutzt; `--force` erzwingt, Abschnitt 3.2).

## 4c. Nutzer-Isolation (entfernt)

Perch bedient genau **einen Betreiber pro Installation**. Die frühere Nutzer-Isolation (`perch user add|list|remove`, `PERCH_USER`) wurde am 2026-10-14 auf Fritz' Entscheidung entfernt (`docs/PUBLIC_ACCESS_SPEC.md` §11a).

- `PERCH_USER` ist kein gültiger Schalter mehr: Ist er gesetzt, bricht jeder Befehl ab. Er fällt nie still auf den eigenen Store zurück.
- **Bestehende Installationen mit angelegten Nutzern:** Der Store öffnet unverändert. `perch serve` warnt beim Start, dass noch Nutzer eingetragen sind. Deren Read-only-Tokens und Client-Grants werden abgelehnt (`401`).
- Perch öffnet, verschiebt und löscht die alten Nutzer-Dateien nicht. Wer sie nicht mehr braucht, löscht sie von Hand (vorher sichern):

```bash
rm -r "$PERCH_DATA_DIR/users"                  # Stores der früheren Nutzer
rm -r "$(dirname "$PERCH_KEY_FILE")/user-keys" # deren Schlüssel
rm -r ~/.config/perch/users                    # deren Token-Dateien
```

## 4d. Idempotenter Versand und Audit (Mail-Workflow-Meilenstein)

Spezifikation, Speichervertrag und Testnachweise: `docs/MAIL_WORKFLOW_MILESTONE.md`. **Nur mit Mocks getestet, nicht live verifiziert.**

### 4d.1 `requestId` im MCP-Client

- `mail_send` verlangt `requestId`: pro neuer Nachricht eine neue Zufalls-ID (8–128 Zeichen `A-Z a-z 0-9 . _ : -`, z. B. eine UUID). Sie darf nichts aus dem Inhalt oder den Adressen enthalten.
- **Wiederholen** (Timeout, Verbindungsabbruch) nur mit derselben `requestId` und **identischen** Argumenten. Perch sendet dann nie ein zweites Mal und liefert das gespeicherte Ergebnis (`replayed: true`).
- Dieselbe `requestId` mit anderem Inhalt scheitert mit `idempotency_conflict`, ohne Provider-Aufruf.
- `mail_send_status {accountId, requestId}` zeigt den Stand eines eigenen Sends, ohne etwas zu senden.
- Bedeutung der Ergebnisse:
  - `accepted`: vom Provider angenommen, **kein** Zustellnachweis;
  - `rejected`: nicht gesendet;
  - `indeterminate`: unbekannt. Mit `requestState: "pending"` heißt das: unterbrochen, das Ergebnis wurde nie gespeichert.
- Perch wiederholt nichts automatisch und sendet eine `requestId` nie erneut. Ein neuer Versuch braucht eine **neue** `requestId`, nach `indeterminate` erst nach Prüfung des Gesendet-Ordners.

### 4d.2 Lokale Einsicht und Auflösung (Admin)

```bash
perch audit list [--limit 50] [--client client-1a2b3c4d] [--account imap-1a2b3c4d]
perch mail-workflow list [--state pending]
perch mail-workflow resolve op-0123456789abcdef01234567 --outcome sent     # oder not-sent, nach Prüfung des Gesendet-Ordners
```

- **Audit:**
  - Enthält Zeit, Namespace, Akteur (Client-ID bzw. Betreiber), Operations-ID, Tool, Perch-Konto-ID/Provider, Ergebnis und Fehlercode.
  - Enthält **keine** Inhalte, Betreffzeilen, Empfänger, Adressen, Labels, Anhänge, Suchbegriffe, IDs von Mails/Dateien, Tokens oder `requestId`s.
  - Alle Mail-Operationen (Lesen, Anhänge, Suche, Kontoliste, Entwürfe, Senden, Status) protokolliert `MailService` selbst, also auch bei direkten Aufrufen außerhalb von MCP; Entwürfe **vor** jedem Provider-Zugriff (fail closed).
  - Einsicht gibt es nur lokal; es gibt kein MCP-Audit-Tool.
  - Höchstens 2000 Einträge pro Namespace; ältere werden verworfen und gezählt.
- **`resolve`** vermerkt nur das von einem Menschen geprüfte Ergebnis eines `pending`/`indeterminate`-Sends. Es sendet nie und gibt die `requestId` nicht frei.
- **Kein `prune`:**
  - Eine benutzte `requestId` wird nie vergessen; sonst könnte ein erneuter Aufruf doppelt senden. `perch mail-workflow prune` lehnt deshalb ab (`prune_unsupported`) und ändert nichts.
  - Ab 1000 Send-Einträgen pro Namespace scheitern neue Sends geschlossen (`ledger_full`). Lesen, Entwürfe und Status bleiben möglich. Eine sichere Ablösung (Rollover) ist noch nicht gebaut.

### 4d.3 Backup und Störungen

- **Backup:** `mail-workflow.enc` liegt neben `store.enc` (Root: `$PERCH_DATA_DIR/`, Nutzer: `$PERCH_DATA_DIR/users/<id>/`) und gehört ins Backup. Einen eigenen Schlüssel gibt es nicht: Er wird aus dem Store-Schlüssel abgeleitet, also den Store-Schlüssel wie bisher getrennt sichern.
- **Älteres Backup:** Das Zurückspielen eines älteren Ledgers vergisst neuere Send-Einträge. Ein wiederholter alter `requestId` könnte dann erneut senden.
- **Beschädigter oder fehlender Ledger:** Alle auditierten Tool-Aufrufe und Sends dieses Namespace scheitern geschlossen. Lese-Ergebnisse werden zurückgehalten, Schreib-Tools laufen nicht. Perch setzt den Ledger nie zurück und überschreibt ihn nie.
- **Abhilfe:** den Ledger aus dem Backup zurückspielen. `perch mail-workflow init` ist nur für Namespaces gedacht, die nie einen Ledger hatten. `store.enc` merkt sich, dass ein Ledger angelegt wurde (Feld `mailWorkflowLedger`). Hatte der Namespace je einen, lehnt `init` ab (`ledger_missing`) und setzt nie zurück; eine vorhandene Datei wird nie überschrieben. Vor jedem Ledger-Schreibzugriff muss dieses Feld dauerhaft in `store.enc` stehen; lässt es sich nicht schreiben, wird nichts gesendet.
- **Kein Downgrade, Backups zusammen zurückspielen:** Eine ältere Perch-Version oder ein `store.enc`-Backup von vor diesem Feld entfernt die Markierung. Geht danach auch der Ledger verloren, kann `init` das nicht erkennen und legt einen leeren an; benutzte `requestId`s wären vergessen. `store.enc` und `mail-workflow.enc` deshalb immer aus demselben Backup zurückspielen und keine ältere Perch-Version starten.

## 4e. Slack-Workspaces verbinden (Slack/WhatsApp-Meilenstein)

Pro Workspace gibt es eine eigene **interne Slack-App** mit einem **User-Token** (`xoxp-…`). Perch liest damit, was du in dem Workspace sehen kannst, und postet (nur mit Client-Grant `slack_send`) **als du**.

Warum keine gemeinsame App für alle Workspaces: Slack drosselt seit 2025 verteilte Apps außerhalb des Marketplace bei `conversations.history`/`conversations.replies` stark (etwa 1 Anfrage pro Minute). Interne Apps, die nur im eigenen Workspace installiert sind, behalten die normalen Limits.

### 4e.1 App anlegen (einmal pro Workspace, Nutzeraufgabe)

`perch slack add` (und Slack in `perch setup`) zeigt vor der verdeckten Token-Abfrage das Manifest, den Link <https://api.slack.com/apps?new_app=1> und die Schritte unten und wartet auf Enter. `--skip-guide` überspringt die Anleitung; ist schon ein Workspace verbunden, fragt Perch „Show the steps …? [y/N]“. Ohne Terminal gibt es keine Anleitung, die Token-Abfrage scheitert wie bisher.

1. Manifest ausgeben: `perch slack manifest`. Es ist identisch mit [`slack-app-manifest.json`](slack-app-manifest.json).
2. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → den Workspace wählen → Manifest einfügen → **Create**.
3. **Install to Workspace** → Berechtigungen bestätigen.
   - Verlangt der Workspace eine Admin-Freigabe für Apps, erscheint stattdessen **Request to Install**. Dann muss ein Workspace-Admin die App freigeben. Ohne Freigabe geht es in diesem Workspace nicht.
4. Unter **OAuth & Permissions** das **User OAuth Token** (`xoxp-…`) kopieren. Bot-Tokens (`xoxb-`) lehnt Perch ab.

Die App hat nur User-Scopes:

| Scope | Wofür |
| --- | --- |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | Kanäle, private Kanäle, DMs und Gruppen-DMs auflisten |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Nachrichten und Threads lesen |
| `users:read` | Namen zu Nutzer-IDs |
| `search:read` | `slack_search` |
| `chat:write` | `slack_send_message`, `slack_edit_message` (nur mit Client-Grant) |
| `reactions:read`, `reactions:write` | `slack_add_reaction`, `slack_remove_reaction` (nur mit Client-Grant) |
| `files:read` | `slack_get_file` (Metadaten und Inhalt einer Datei) |
| `files:write` | `slack_upload_file` (nur mit Client-Grant) |
| `im:write`, `mpim:write` | `slack_open_conversation`: DM bzw. Gruppen-DM öffnen (nur mit Client-Grant) |

**Bestehende Workspaces (Manifest vor dem 20. Oktober 2026):** Die Scopes `reactions:*`, `files:*` und zuletzt `im:write`, `mpim:write` sind neu. Im Workspace die App-Seite öffnen → **App Manifest** → durch `perch slack manifest` ersetzen → **Reinstall to Workspace** → neues User OAuth Token kopieren. Dann in Perch `perch slack remove ID` und `perch slack add --label …` (Perch liest die Scopes nur beim Verbinden). Ohne Neuinstallation lehnen die neuen Tools mit `provider_scope_missing` ab, bevor sie Slack aufrufen. `perch status` zeigt fehlende Scopes eines Workspaces als Hinweis (`hint: token lacks …`), nicht als Fehler; Grundlage sind die Scopes, die Slack beim Verbinden im Header `x-oauth-scopes` gemeldet hat.

Token-Rotation ist im Manifest aus, das Token läuft also nicht ab.

### 4e.2 In Perch verbinden

```bash
perch slack add --label "Firma"     # Anleitung, dann Token verdeckt eingeben
perch slack add --label "Zweit" --skip-guide
perch slack list
```

Perch prüft das Token mit `auth.test` und speichert Workspace, Nutzer und die tatsächlich gewährten Scopes. Fehlen Scopes des aktuellen Manifests (etwa `search:read`, `chat:write`, `files:write`, `im:write`, `mpim:write`), warnt `slack add`. Das gleiche Workspace-Konto zweimal zu verbinden wird abgelehnt.

### 4e.3 Lesen und Senden

- **Lesen** (`slack_list_conversations`, `slack_get_history`, `slack_get_thread`, `slack_search`): globales Token und jeder Client mit `slack_read`.
- **Senden** (`slack_send_message`, `slack_send_status`): nur ein Client-Grant mit `slack_send` für genau diese Workspaces:

  ```bash
  perch client add --label "Claude Code" --allow slack_read,slack_send --account slack-1a2b3c4d
  ```

  Pflichtfeld `requestId` wie bei `mail_send` (Abschnitt 4d): gleiche ID + gleicher Inhalt postet nie zweimal.

- **Dateien und Reaktionen:**
  - `slack_get_file` (lesen, wie oben): Metadaten per `files.info`, Inhalt als Base64 bis `maxBytes` (Standard 48 KiB, höchstens 10 MiB). Größere Dateien werden abgelehnt, nie abgeschnitten. Geladen wird nur von `https://files.slack.com/files-pri/<Team>-<Datei>/…`.
  - `slack_add_reaction`, `slack_remove_reaction`, `slack_edit_message` (nur eigene Nachrichten; Slack lehnt fremde ab): nur mit `slack_send`.
  - `slack_upload_file` (bis 10 MiB, optional in einen Thread mit Kommentar): nur mit `slack_send`, idempotent per `requestId` wie `slack_send_message`. Die Bytes gehen nur an `https://files.slack.com/upload/v1/…`; jede andere Upload-Adresse wird abgelehnt, bevor Daten fließen.
  - Löschen (Nachrichten, Dateien) und öffentliche Datei-Links gibt es nicht: Löschen ist bei Slack endgültig.

- **DMs und geplante Nachrichten:**
  - `slack_open_conversation` (nur mit `slack_send`): öffnet per `conversations.open` eine DM mit einem Nutzer (`im:write`) oder eine Gruppen-DM mit 2–8 Nutzern (`mpim:write`) und gibt die `channelId` zurück. Es wird nichts gepostet; geschrieben wird danach mit `slack_send_message` oder `slack_schedule_message`. Kanäle anlegen, archivieren oder Mitglieder einladen/entfernen gibt es nicht.
  - `slack_schedule_message` (nur mit `slack_send`, `chat:write`): plant eine Nachricht per `chat.scheduleMessage`. `postAt` als Unix-Sekunden oder RFC 3339 mit Offset, mindestens 60 s und höchstens 120 Tage in der Zukunft (sonst Ablehnung vor jedem Slack-Aufruf), optional `threadTs`. Pflichtfeld `requestId` über denselben Versand-Ledger wie `slack_send_message`; das Ergebnis enthält die `scheduledMessageId`. Eine Wiederholung mit gleicher `requestId` liefert das gespeicherte Ergebnis, auch wenn der Zeitpunkt inzwischen vorbei ist. `slack_send_status` zeigt für diese `requestId` die `scheduledMessageId` (`Q…`); im Audit-Log erscheint das Planen als `slack_send_message`.
  - `slack_list_scheduled_messages` (lesen, globales Token und `slack_read`): noch nicht gesendete geplante Nachrichten eines Workspaces, optional eines Kanals, seitenweise (höchstens 100 pro Seite).
  - `slack_cancel_scheduled_message` (nur mit `slack_send`): zieht eine noch nicht gesendete geplante Nachricht per `chat.deleteScheduledMessage` zurück. Bereits gesendete Nachrichten löscht Perch nie (`chat.delete` bleibt gesperrt). Der Ledger hält nur das Planen fest: Nach dem Zurückziehen liefert die ursprüngliche `requestId` von `slack_schedule_message` weiterhin `accepted` (ohne erneut zu planen), und `slack_send_status` zeigt weiterhin die geplante Nachricht. Ob sie noch aussteht, zeigt `slack_list_scheduled_messages`; neu planen nur mit neuer `requestId`.

  **Achtung Limit:** Slack-, WhatsApp- und Mail-Sends teilen sich 1000 Sende-Einträge pro Namespace. Danach schlagen alle Sends fehl, auch Mail (`ledger_full`), bis es einen Ledger-Rollover gibt (`docs/SLACK_WHATSAPP_MILESTONE.md` §6).

Trennen: `perch slack remove ID` entfernt nur lokal. Das Token bleibt gültig, bis du die App im Workspace deinstallierst (App-Seite → **Remove app**).

## 4f. WhatsApp über GOWA verbinden (Slack/WhatsApp-Meilenstein)

**Inoffiziell.** WhatsApp bietet für private Konten keine API. Perch spricht mit [GOWA](https://github.com/aldinokemal/go-whatsapp-web-multidevice) (MIT), einem selbst gehosteten Dienst, der sich wie WhatsApp Web als **verknüpftes Gerät** anmeldet. Das verstößt potenziell gegen die WhatsApp-Nutzungsbedingungen; WhatsApp kann solche Konten einschränken oder sperren. Senden erhöht das Risiko.

Weitere Grenzen:

- **Verlauf:** GOWA kennt nur Nachrichten ab dem Koppeln plus das, was das Handy beim Koppeln synchronisiert. Ältere Nachrichten fehlen.
- **Daten im Klartext:** GOWA speichert alle Nachrichten **unverschlüsselt** in SQLite (`storages/` im GOWA-Verzeichnis). Verzeichnis nur für den GOWA-Nutzer lesbar halten und wie den Perch-Store sichern.
- **Keine globale Suche:** `whatsapp_search` durchsucht die zuletzt aktiven Chats (Default 30), nicht alle.
- GOWA kann selbst senden, löschen, Gruppen verwalten usw. Perch erlaubt nur Leserouten und `POST /send/message`. GOWA darf deshalb **nur auf localhost** lauschen und muss Basic-Auth haben.

### 4f.1 GOWA installieren: `perch whatsapp install` (Standardweg)

Getestet wurde Perch nur gegen einen nachgebauten GOWA (API v9); die Installation selbst nur mit gemocktem Download und gemocktem `systemctl`. Festgelegt ist Release **v9.6.0** (2026-10-03).

```bash
perch whatsapp install                 # fragt nach der Warnung [y/N]; ohne Terminal nur mit --yes
perch whatsapp install --port 3001     # anderer Port (Standard 3000); --dir PATH statt ~/gowa
```

Was der Befehl tut (Spezifikation: `docs/WHATSAPP_INSTALL_SPEC.md`):

1. Warnt (inoffiziell, Konto kann eingeschränkt werden, Nachrichten unverschlüsselt auf der Platte) und fragt `[y/N]`. Ohne Terminal und ohne `--yes` bricht er ab. Nur Linux mit systemd, `x64` oder `arm64`, nicht als root.
2. Lädt `whatsapp_9.6.0_linux_amd64.zip` (bzw. `linux_arm64`) per HTTPS von GitHub (Weiterleitung nur zu GitHubs Release-Hosts, höchstens 64 MiB) und prüft es gegen die **im Perch-Code festgelegte SHA-256**. Abweichung: Abbruch, nichts wird entpackt.
3. Entpackt nur das Programm (im ZIP `linux-amd64` bzw. `linux-arm64`) als `~/gowa/whatsapp` (Ordner und Programm `0700`), mit eigenem ZIP-Leser ohne `unzip`.
4. Schreibt `~/gowa/.env` (`0600`, Inhalt wie unten, zufälliges Passwort für den Nutzer `perch`) und `~/.config/systemd/user/gowa.service` (wie unten). Die Unit enthält `LogFilterPatterns=~app_basic_auth`: GOWA schreibt beim Start seine Konfiguration samt `app_basic_auth:perch:<Passwort>` ins Log, diese Zeile landet so nicht im Journal. Das braucht **systemd ≥ 253** (Ubuntu 24.04: 255, Debian 12: 252). Bei älterem systemd (oder unbekannter Version, ermittelt per `systemctl --version`) warnt der Befehl; die Zeile wird dann ignoriert und das Passwort steht im Journal.
5. `systemctl --user daemon-reload` und `systemctl --user enable --now gowa`, wartet bis `GET /devices` mit Basic Auth antwortet (sonst Meldung mit `journalctl --user -u gowa -n 50`).
6. Trägt die Bridge in Perch ein wie `perch whatsapp instance set` (Passwort direkt in den verschlüsselten Store, nie auf der Konsole); schlägt das direkt nach dem Start fehl, wiederholt er es bis zur selben Frist wie die Prüfung in Schritt 5. Weiter mit §4f.2 (`perch whatsapp add`).

Unerwartete Fehler meldet der Befehl mit dem Schritt, in dem sie auftraten (z. B. „Storing the bridge in Perch failed (step: store)“), ohne Passwörter oder Details. (Der erste Live-Lauf endete nach „waiting for …/devices“ mit „Internal error“: Die Warteschleife hatte im echten Betrieb keine Sleep-Funktion, sobald GOWA nicht schon bei der ersten Prüfung antwortete. Behoben; GOWA lief trotzdem, ein erneuter Aufruf von `perch whatsapp install` trägt die Bridge nach.)

Erneuter Aufruf: Ist GOWA 9.6.0 dort schon vollständig installiert, ändert der Befehl nichts, prüft nur die Bridge und trägt sie (falls noch nicht geschehen) in Perch ein. Ausnahme: Ist die `gowa.service` noch die einer **älteren Perch-Version** (exakt der frühere Inhalt, ohne Log-Filter), ersetzt er sie durch die neue, macht `systemctl --user daemon-reload` und `systemctl --user restart gowa` und wartet wieder auf `/devices`. Danach `perch whatsapp rotate-password` (§4f.1b), weil das alte Passwort schon im Journal steht. Eine andere Version oder fremde Dateien im Zielordner, eine andere `gowa.service` oder ein anderer `--port` führen zum Abbruch (anderes `--dir` wählen oder von Hand aufräumen). Ein Update von GOWA ist eine Code-Änderung in Perch (neue Version, neuer Hash), kein automatischer Schritt.

Damit GOWA nach dem Abmelden weiterläuft (Server ohne Login-Sitzung): `sudo loginctl enable-linger $USER`. Meldet `systemctl --user` „Failed to connect to bus“, als dieser Nutzer direkt anmelden (nicht über `su`/`sudo`) oder `XDG_RUNTIME_DIR=/run/user/$(id -u)` setzen.

`perch setup` bietet die Installation an, wenn man WhatsApp wählt und noch keine Bridge eingetragen ist (gleiche Warnung und Rückfrage), und koppelt danach direkt.

### 4f.1a Manuell installieren (Alternative)

Für andere Systeme (ohne systemd, macOS, Container) oder wenn du jeden Schritt selbst machen willst:

```bash
mkdir -p ~/gowa && cd ~/gowa
V=9.6.0
curl -LO https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v$V/whatsapp_${V}_linux_amd64.zip
curl -LO https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v$V/checksums.txt
grep "whatsapp_${V}_linux_amd64.zip" checksums.txt | sha256sum -c -
unzip whatsapp_${V}_linux_amd64.zip linux-amd64 && mv linux-amd64 whatsapp
chmod 700 ~/gowa ~/gowa/whatsapp
```

(`linux_arm64` bzw. `linux-arm64` für ARM-Server. Das Programm heißt im ZIP `linux-amd64`/`linux-arm64`, die Unit erwartet `~/gowa/whatsapp`.) Die Datei `~/gowa/.env` (Rechte `0600`):

```ini
APP_HOST=127.0.0.1
APP_PORT=3000
# eigener langer Nutzer und ein zufälliges Passwort, z. B. openssl rand -base64 32
APP_BASIC_AUTH=perch:HIER-EIN-ZUFAELLIGES-PASSWORT
APP_OS=Perch
# keine Web-Oberfläche (sie lädt sonst laufend HTML von GitHub nach)
APP_UI_ENABLED=false
APP_UI_AUTO_UPDATE=false
# GOWAs eigener MCP-Server bietet Sende- und Lösch-Tools: aus
MCP_ENABLED=false
WHATSAPP_CHAT_STORAGE=true
WHATSAPP_AUTO_REPLY=
WHATSAPP_AUTO_MARK_READ=false
WHATSAPP_AUTO_REJECT_CALL=false
WHATSAPP_AUTO_DOWNLOAD_MEDIA=false
WHATSAPP_WEBHOOK=
WHATSAPP_PRESENCE_ON_CONNECT=unavailable
```

Mit `WHATSAPP_PRESENCE_ON_CONNECT=unavailable` erscheint das verknüpfte Gerät offline, sodass die Benachrichtigungen auf dem Handy normal bleiben. GOWAs „Presence-Puls“ (`WHATSAPP_PRESENCE_PULSE_*`, Default: einmal täglich 5 Minuten „online“) ist hier bewusst nicht abgeschaltet, weil nicht geprüft ist, ob die Sitzung ohne ihn stabil bleibt. Das beim Live-Test prüfen.

systemd-User-Unit `~/.config/systemd/user/gowa.service` (dieselbe, die `perch whatsapp install` schreibt):

```ini
[Unit]
Description=GOWA WhatsApp bridge (localhost only)

[Service]
WorkingDirectory=%h/gowa
ExecStart=%h/gowa/whatsapp rest
Restart=on-failure
UMask=0077
# GOWA logs its configuration incl. the basic-auth password at startup; keep that line out of the journal (systemd >= 253)
LogFilterPatterns=~app_basic_auth

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now gowa
curl -s -u "perch:PASSWORT" http://127.0.0.1:3000/devices   # Test: {"code":"SUCCESS",...}
```

GOWA liest die `.env` im Arbeitsverzeichnis. Den Port 3000 **nicht** per Tailscale Serve oder Firewall freigeben.

### 4f.1b Neues GOWA-Passwort: `perch whatsapp rotate-password`

```bash
perch whatsapp rotate-password            # bzw. --dir PATH, wenn mit --dir installiert
```

Nur für ein von `perch whatsapp install` eingerichtetes GOWA (erkennt es an `~/gowa/.perch-gowa.json` und an der von Perch geschriebenen `gowa.service`); sonst bricht der Befehl mit einer Meldung ab (manuell installiert: `APP_BASIC_AUTH` in der `.env` ändern, GOWA neu starten, `perch whatsapp instance set`). Ablauf:

1. Neues Zufallspasswort in `~/gowa/.env` (`0600`, atomar ersetzt; alle anderen Zeilen bleiben). Eine Unit einer älteren Perch-Version wird dabei gleich durch die mit Log-Filter ersetzt (mit `daemon-reload`).
2. `systemctl --user restart gowa`, warten bis `GET /devices` das neue Passwort annimmt.
3. Bridge mit dem neuen Passwort in Perch speichern. Gekoppelte Geräte (`storages/`) bleiben unverändert verbunden. Das Passwort erscheint nie auf der Konsole.

Scheitert Schritt 2, steht das neue Passwort schon in der `.env`: GOWA reparieren (`journalctl --user -u gowa -n 50`) und den Befehl erneut ausführen.

Alte Journal-Einträge mit dem früheren Passwort kann nur root löschen. Achtung, das löscht **alle** archivierten Journal-Einträge des Rechners:

```bash
sudo journalctl --rotate && sudo journalctl --vacuum-time=1s
```

Prüfen, ob der Filter greift (nach einem Neustart von GOWA, sollte nichts ausgeben): `journalctl --user -u gowa --since "10 min ago" | grep -c app_basic_auth`. Live noch nicht geprüft: ob journald `LogFilterPatterns=` bei **User**-Units auf diesem System anwendet.

### 4f.2 In Perch verbinden und koppeln

Nach `perch whatsapp install` ist die Bridge schon eingetragen; `instance set` braucht es nur nach der manuellen Installation.

```bash
perch whatsapp instance set --url http://127.0.0.1:3000    # nur manuell: Nutzer und Passwort verdeckt eingeben
perch whatsapp add --label "Privat" --phone +4366012345678
```

`whatsapp add` legt in GOWA einen eigenen Geräte-Slot an (`perch-…`) und zeigt einen **Kopplungscode**. Am Handy: WhatsApp → Einstellungen → **Verknüpfte Geräte** → **Gerät hinzufügen** → **Stattdessen mit Telefonnummer verknüpfen** → Code eingeben. Perch wartet bis zu 180 s (`--timeout`); läuft die Zeit ab, wird der Slot wieder gelöscht.

Erlaubt sind nur Bridge-Adressen auf Loopback (`127.0.0.1`, `::1`, `localhost`) oder einer Tailscale-Adresse (100.64.0.0/10), mit Port. Mehrere WhatsApp-Konten (z. B. privat und geschäftlich) laufen über dieselbe GOWA-Instanz in getrennten Slots; jede Anfrage nennt ihren Slot ausdrücklich (`X-Device-Id`).

```bash
perch whatsapp list
perch whatsapp status              # eingeloggt? verbunden?
perch whatsapp remove ID           # löscht den Slot in GOWA: entkoppelt das Gerät, löscht die gespeicherten Chats
perch whatsapp remove ID --keep-device   # nur lokal entfernen
```

### 4f.3 Lesen und Senden

- **Lesen** (`whatsapp_list_chats`, `whatsapp_get_messages`, `whatsapp_search`): globales Token und jeder Client mit `whatsapp_read`. Medien erscheinen dort nur als Metadaten (Typ, Dateiname, Größe).
- **Medien herunterladen** (`whatsapp_download_media`): globales Token und jeder Client mit `whatsapp_read`. Liefert die Datei einer Nachricht als Base64 mit MIME-Typ und Dateiname. Standardgrenze 48 KiB (`maxBytes`, höchstens 16 MiB); größere Dateien lehnt Perch ab, statt sie abzuschneiden. GOWA legt dabei eine Kopie unter `statics/media/…` auf seiner Platte ab; Perch liest nur diese Datei und nur von der konfigurierten GOWA-Adresse.
- **Text senden** (`whatsapp_send_message`, `whatsapp_send_status`): nur Text, optional als Antwort, nur mit Client-Grant `whatsapp_send` und Pflichtfeld `requestId`:

  ```bash
  perch client add --label "Claude Code" --allow whatsapp_read,whatsapp_send --account whatsapp-1a2b3c4d
  ```

  Ergebnis `accepted` (von GOWA an WhatsApp übergeben), `rejected` (GOWA hat abgelehnt, nicht gesendet) oder `indeterminate` (Antwort verloren; nie automatisch wiederholt).
- **Medien senden** (`whatsapp_send_media`): Bild, Video, Audio oder Datei (Dokument) als Base64, höchstens 16 MiB, optional mit Bildunterschrift (nicht bei Audio) oder als Antwort. Gleiche Regeln wie beim Text: nur mit `whatsapp_send` für das Konto, Pflichtfeld `requestId`, Status über `whatsapp_send_status`. Perch schickt nur die Datei selbst, nie eine URL (GOWA lädt also nichts aus dem Netz), und keine Zeitplanung oder Einmal-Ansicht.

  **Achtung:** Medien zu senden erhöht das Risiko, dass WhatsApp das Konto einschränkt oder sperrt, noch stärker als Textnachrichten. Sparsam und nur an bekannte Kontakte verwenden.

## 4g. Luma über den offiziellen Luma-MCP (Luma-Meilenstein)

Spezifikation: `docs/LUMA_SPEC.md`. **Nur mit Mocks getestet, nicht live verifiziert.** Perch verbindet sich als MCP-Client mit `https://mcp.luma.com` und meldet sich per OAuth mit dem Luma-Konto an. Es braucht kein Luma Plus und keinen API-Schlüssel.

### 4g.1 Client-Dokument (einmalig, schon erledigt)

Luma vergibt keine Client-IDs. Perch weist sich mit seinem Client ID Metadata Document aus: `https://frilabs.dev/perch/luma-client.json` (Quelle `pages/luma-client.json`, ausgeliefert als statische Datei von frilabs.dev, Repo `frilabs-home`, Datei `public/perch/luma-client.json`). Beide Dateien müssen gleich bleiben.

Prüfen: `curl -s https://frilabs.dev/perch/luma-client.json` muss genau den Inhalt von `pages/luma-client.json` zeigen.

Bietet Luma Dynamic Client Registration an, registriert sich Perch dort selbst (bevorzugt, Spec §3); dann wird das Dokument nicht gebraucht. Andere Betreiber können mit `PERCH_LUMA_CLIENT_ID` ein eigenes Dokument angeben.

### 4g.2 Konto verbinden

```bash
perch luma add --label "frilabs" [--port 8768]
```

- Der Befehl zeigt eine Login-URL. Läuft der Browser nicht auf dem Server, nach dem Login die Adresse aus der Adresszeile ins Terminal einfügen (Abschnitt 3.2), oder vorher den Port weiterleiten (`ssh -N -L 8768:127.0.0.1:8768 homeserver`, dann `--port 8768`).
- Nach dem Login merkt sich Perch die **Schemas der erlaubten Luma-Tools** (Trust on first use). Die Ausgabe nennt, wie viele Tools freigegeben sind, welche Luma nicht anbietet und welche wegen unbekannter Felder gesperrt bleiben.
- Mehrere Luma-Konten sind möglich; jedes Ergebnis trägt `accountId` und `accountLabel`.

```bash
perch luma list
perch luma tools luma-1a2b3c4d             # freigegebene vs. aktuelle Tool-Schemas
perch luma tools luma-1a2b3c4d --accept    # Änderungen von Luma nach Prüfung übernehmen
perch luma remove luma-1a2b3c4d [--revoke]
```

### 4g.3 Rechte

| Gruppe | Tools (MCP-Name `luma_<tool>`) | Wer |
| --- | --- | --- |
| Lesen | Kalender, Events, Gäste, Blasts ansehen, Event-Suche, Coupons, Mitgliedschaftsstufen, Kontakte, Tags, Organisationen, `lookup_entity`, `get_self` | globales Token, gekoppelte Geräte, Grant `luma_read` |
| Events | `create_event`, `update_event`, Tickettypen, Anmeldefragen, Kalender-Einreichungen, Event-Tags | Grant `luma_events` |
| Gäste | `invite_guests` (höchstens 50 pro Aufruf), `update_guest_status` (nie mit Rückerstattung), `update_guest_tickets` | Grant `luma_guests` |
| Blasts | `create_blast` mit Pflichtfeld `confirmRecipientCount` | Grant `luma_blast` |
| Nie | Löschen/Entfernen, Admins, Co-Hosts, Mitgliedschaften, Kontakt-Import, Kalender anlegen/ändern, Coupons ändern, Personensuche, Profil, Feedback | niemand |

```bash
perch client add --label "Claude Events" --allow luma_read,luma_events --account luma-1a2b3c4d
perch client add --label "Claude Gäste" --allow luma_read,luma_guests,luma_blast --account luma-1a2b3c4d
perch oauth grant oc-0123456789abcdef --allow luma_read,luma_events --account luma-1a2b3c4d   # öffentliches Gerät
```

- E-Mails an Dritte brauchen zusätzlich `luma_guests`: `update_event` mit `email_guests: true`, `approve_calendar_events` (benachrichtigt immer die Einreichenden) und `reject_calendar_events` mit Benachrichtigung.
- **Blasts:** nur sofort (kein `scheduled_for`) und nur mit ausdrücklichem `recipient_groups`, z. B. `[{"status": "approved"}]`. Der Client nennt in `confirmRecipientCount`, wie viele Gäste die Rundmail erreichen soll. Perch zählt die Gäste dieser Status unmittelbar vor dem Senden über `list_guests` und sendet nur bei Übereinstimmung. Ticket-Filter und `checked_in` kann Perch nicht nachzählen; solche Blasts gehen nur in Luma selbst.
- **Schreiben ist idempotent** pro `requestId` (wie Mail, Slack, WhatsApp). Ergebnis `accepted`, `rejected` oder `indeterminate`; Perch wiederholt nie selbst. `luma_write_status` zeigt den Ausgang.

### 4g.4 Grenzen

- Perch hängt an Lumas Toolnamen und Schemas. Ändert Luma ein erlaubtes Tool, sperrt Perch es, bis `perch luma tools <id> --accept` die neue Fassung übernimmt. Tools mit neuen, Perch unbekannten Feldern bleiben gesperrt, bis Perch aktualisiert ist. Die Prüfung erkennt Änderungen an der Struktur, nicht an Beschreibungen.
- Felder, die das freigegebene Schema nicht nennt, lehnt Perch ab, auch verschachtelt.
- Luma-Tools haben keine eigene Idempotenz. Bricht ein Aufruf mittendrin ab, ist der Ausgang unklar; dann in Luma nachsehen.
- Zwischen Zählen und Senden eines Blasts können sich Gäste an- oder abmelden.

## 4h. Papierkorb statt Löschen (alle Dienste)

Perch löscht nie endgültig: Drive, Notion und Mail verschieben nur in den Papierkorb, Slack- und WhatsApp-Nachrichten lassen sich gar nicht löschen. Achtung: Die Anbieter leeren ihre Papierkörbe selbst nach einer Frist (Google Drive und Gmail etwa 30 Tage, Notion 30 Tage, Outlook je nach Einstellung, GMX laut Ordner-Einstellung). Wiederherstellen also zeitnah.

## 5a. Status: `perch status` und die Statusseite

**Auf dem Server:**

```bash
perch status              # alle Konten mit Live-Check, Clients, Sende-Speicher, Audit
perch status --no-check   # ohne Anfragen an die Anbieter
perch status --json       # maschinenlesbar
perch status --plain      # bisherige schlichte Ausgabe (eine Zeile pro Konto)
```

- **Darstellung:** Abschnitte pro Dienst mit Checkboxen. Verbundene Konten stehen als `☑` (oder `✗` bei fehlgeschlagenem Check) mit Label, Adresse und Ergebnis da. Darunter die **Fähigkeiten** des Kontos: aktivierte als `☑` (z. B. lesen, Entwürfe, senden), mögliche, aber nicht aktivierte als `☐` mit dem genauen Befehl, der sie freischaltet (Mail/Drive/Kalender: Konto entfernen und mit der zusätzlichen Option neu verbinden, bestehende Optionen bleiben im Befehl; Slack: App mit aktuellem Manifest neu installieren). Neu verbinden vergibt eine neue Konto-ID; Clients mit Kontoliste bekommen sie nicht automatisch (Hinweis in der Ausgabe). Nicht verbundene Dienste stehen als `☐` mit `perch … add`-Befehl. Danach Zugänge (Clients, öffentlicher Zugang, WhatsApp-Bridge), Sende-Speicher als Balken, Audit-Zähler, die Onboarding-Checkliste (`Onboarding N/4`) und das Gesamtergebnis.
- **Farbe** nur für Status (grün ok, rot Fehler, gelb Hinweis) und nur im Terminal; mit `NO_COLOR=1` oder umgeleiteter Ausgabe ohne Farbe, die Checkboxen bleiben. Die Breite folgt dem Terminal (mindestens 60 Zeichen), lange Werte werden gekürzt, Befehle nie.

- Pro Konto prüft Perch **nur lesend**, ob der Zugang noch funktioniert: Drive `about`, Gmail-Profil, Graph `/me`, Google `userinfo`, Notion `users/me`, Slack `auth.test`, IMAP-/SMTP-Login, GOWA-Gerätestatus.
- Der Exit-Code ist 1, sobald ein Check fehlschlägt. Damit eignet sich der Befehl auch für Monitoring, z. B. per Cron.

**Im Browser:** Läuft `perch serve --http`, zeigt `GET /status` dieselbe Übersicht als nur lesende Seite, z. B. `https://homeserver.tailnet-xyz.ts.net/status` (Tailscale Serve) oder `http://127.0.0.1:8765/status` (SSH-Tunnel).

- **Anmeldung:** Der Browser fragt nach Benutzername und Passwort. Benutzername egal, Passwort = das **globale Token** (`~/.config/perch/http-token`).
- **Client-Grants** werden abgelehnt (403), weil sie nur einen Teil des Namespace sehen dürfen.
- **Absicherung:** Die Seite enthält keine Secrets, kein JavaScript, keine Formulare und lädt nichts von außen. Es gelten strikte Content-Security-Policy, `no-store`, `frame-ancestors 'none'` und dieselbe Host-Prüfung wie bei MCP. Anfragen von fremden Seiten (`Sec-Fetch-Site: cross-site`) werden abgewiesen.
- **Cache:** Die Live-Checks werden 60 s wiederverwendet. Neuladen fragt die Anbieter also höchstens einmal pro Minute ab.
- **Hinweis:** Der Browser merkt sich das Token für diese Adresse, solange er offen ist. Auf fremden oder geteilten Rechnern daher ein privates Fenster verwenden.

## 5. Konten anzeigen, trennen, widerrufen

```bash
perch accounts
perch google remove ggroup-1a2b3c4d            # Google-Konto-Gruppe nur lokal löschen (alle Dienste)
perch google remove ggroup-1a2b3c4d --revoke   # zusätzlich Grant bei Google widerrufen (einmal, alle Dienste)
perch google remove ggroup-1a2b3c4d --service calendar   # nur einen Dienst der Gruppe entfernen
perch google remove google-1a2b3c4d            # einzeln verbundenes Drive-Konto
perch notion remove notion-1a2b3c4d            # nur lokal trennen
```

| Aktion | Wirkung |
| --- | --- |
| `google remove` | Refresh-Token und Client-Daten werden aus der DB gelöscht (bei einer Gruppe samt allen Mitgliedskonten). Der Grant bei Google bleibt bestehen, bis er unter <https://myaccount.google.com/permissions> widerrufen wird. |
| `google remove --revoke` | Wie oben, zusätzlich `POST https://oauth2.googleapis.com/revoke`. Damit ist der Grant ungültig, bei einer Gruppe für Drive, Gmail, Kalender und Kontakte zugleich. |
| `google remove ID --service X` | Nur dieser Dienst verlässt die Gruppe; nie widerrufen, weil die Anmeldung geteilt ist. Der letzte Dienst nimmt die Gruppe mit. |
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

- Der Server akzeptiert das globale Token (read-only) und die Tokens der Client-Grants.

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

### Codex einmalig konfigurieren (Laptop)

Codex bindet Streamable-HTTP-MCP-Server über `~/.codex/config.toml` ein; das Token kommt aus einer Umgebungsvariable. Laut Codex-Dokumentation, mit Perch **nicht getestet**:

```toml
[mcp_servers.perch]
url = "https://homeserver.tailnet-xyz.ts.net/mcp"   # oder http://127.0.0.1:8765/mcp (SSH-Tunnel)
bearer_token_env_var = "PERCH_TOKEN"
```

`PERCH_TOKEN` in der Shell setzen, aus der Codex startet. Für Codex am besten ein **eigener Client-Grant** (`perch client add --label Codex …`): Dann lassen sich Claude Code und Codex getrennt freigeben und widerrufen, und das Audit-Log unterscheidet sie. Ein Client-Grant sieht allerdings weder Drive noch Notion; dafür bleibt das globale Read-only-Token.

## 6a. Öffentlicher Zugang über OAuth (claude.ai, Uni-Laptop)

Spezifikation: `docs/PUBLIC_ACCESS_SPEC.md`. **Nur mit Mocks getestet, nicht live verifiziert.** Perch ändert weder Tailscale noch einen Proxy; die Befehle unten führt der Betreiber selbst aus.

### 6a.1 Modell in Kürze

- `perch serve --http --public` startet zusätzlich einen **öffentlichen Listener** auf `127.0.0.1:8767` (`PERCH_PUBLIC_PORT`). Er kennt nur `/mcp`, `/.well-known/oauth-*` und `/oauth/*`; die Statusseite, `/local/pair` und alles andere gibt es dort nicht (`404`).
- Am öffentlichen `/mcp` gelten **nur OAuth-Tokens**. Das globale Token und Client-Grant-Tokens werden dort abgelehnt; am lokalen Listener (`8765`) gilt alles wie bisher.
- Neue Geräte entstehen **nur in einem Kopplungsfenster**, das der Betreiber auf dem Server öffnet (`perch oauth pair`, 10 Minuten, genau ein Gerät). Im Browser gibt man den Kopplungscode aus dem Terminal ein, meldet sich mit Google an (nur Konten aus der Allowlist), gibt den Perch-Code (TOTP) ein und bestätigt danach **im Terminal** mit `y`. Erst dann gibt es Tokens.
- Ein gekoppeltes Gerät liest alles, was das globale Token liest. Schreiben nur über `perch oauth grant` (wie `perch client add`; das Gerät sieht dann nur, was der Grant abdeckt).
- Access-Token 1 Stunde, Refresh-Token rotiert bei jeder Nutzung; nach 14 Tagen ohne Nutzung oder spätestens nach 90 Tagen ist eine neue Kopplung nötig. Ein wiederverwendetes altes Refresh-Token sperrt das Gerät sofort.
- **Perch fordert nie per Nachricht zur Anmeldung auf.** Jede Kopplung beginnt mit `perch oauth pair` auf dem eigenen Server.

### 6a.2 Einmalig einrichten (Nutzeraufgaben)

1. **Öffentliche Adresse:** Tailscale Funnel aktivieren (Node-Attribut `funnel` in der Tailnet-Policy, MagicDNS und HTTPS-Zertifikate; laut Tailscale-Doku, nicht live getestet). Funnel gilt pro Port und kennt nur 443, 8443 und 10000. In `.env`:
   ```bash
   PERCH_PUBLIC_BASE_URL=https://homeserver.tailnet-xyz.ts.net
   ```
2. **Google-Client für die Anmeldung:** In der Google Cloud Console einen OAuth-Client vom Typ **„Web application“** anlegen (getrennt vom Desktop-Client für Konten), Redirect-URI `https://homeserver.tailnet-xyz.ts.net/oauth/google/callback`, Scopes nur `openid` und `email`. JSON herunterladen, `chmod 600`, in `.env`:
   ```bash
   PERCH_GOOGLE_LOGIN_CLIENT_FILE=/home/USER/.config/perch/google-web-client.json
   ```
   Den zweiten Faktor für dieses Google-Konto in Google selbst einschalten; Perch kann ihn nicht prüfen, verlangt aber zusätzlich den Perch-Code.
3. **Geführte Einrichtung** auf dem Server (fragt die erlaubte Google-Adresse ab und richtet den Perch-Code per QR-Code im Terminal ein; dazu 10 Notfall-Codes, einmal angezeigt, offline aufbewahren):
   ```bash
   perch public setup
   ```
4. **Optional, Telegram-Hinweise:** Bot über @BotFather anlegen, eigene Chat-ID ermitteln, Datei `0600` anlegen und in `.env` eintragen:
   ```json
   {"botToken": "123456789:AA…", "chatId": 123456789}
   ```
   ```bash
   PERCH_NOTIFY_TELEGRAM_FILE=/home/USER/.config/perch/telegram.json
   ```
   Die Nachrichten sind nur Hinweise (Fenster geöffnet, Gerät gekoppelt, Alarme). Sie enthalten keine Links, keine Codes und keine Tokens, und man kann darüber nichts freigeben.
5. **Proxy und Server starten:**
   ```bash
   sudo tailscale funnel --bg --https=443 http://127.0.0.1:8767     # öffentlich: NUR der öffentliche Listener
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8765     # optional, privat: der lokale Listener
   perch serve --http --public
   ```
   Ohne Tailscale geht jeder TLS-Reverse-Proxy mit eigener Domain (z. B. Caddy, Cloudflare Tunnel), der **nur** auf `127.0.0.1:8767` weiterleitet (dokumentiert, nicht getestet). Der lokale Listener bleibt dann per SSH-Tunnel erreichbar. In der systemd-Unit `serve --http --public` eintragen.

### 6a.3 Ein Gerät koppeln

1. Auf dem Server (z. B. per SSH, auch vom Handy aus):
   ```bash
   perch oauth pair
   ```
   Der Befehl zeigt den Kopplungscode und wartet.
2. Auf dem Gerät die Verbindung starten, z. B. in claude.ai unter **Customize → Connectors → Add custom connector** die Adresse `https://homeserver.tailnet-xyz.ts.net/mcp` eintragen. Claude Code: `claude mcp add --transport http perch https://homeserver.tailnet-xyz.ts.net/mcp`, dann `/mcp` zum Anmelden.
3. Im Browser: Kopplungscode, Google-Anmeldung, Perch-Code.
4. Im Terminal erscheinen Client, Rücksprungadresse, Google-Konto, Browser und (falls verfügbar) IP. Nur mit `y` bestätigen, wenn das genau das Gerät ist, das gerade gekoppelt wird. Danach meldet das Terminal den ersten Zugriff des neuen Geräts.

Alternativ zeigt `http://127.0.0.1:8765/local/pair` (nur am lokalen Listener) dieselbe Kopplung als Seite mit Knöpfen, etwa vom Handy über das Tailnet oder einen SSH-Tunnel. Die Seite ist standardmäßig aus und hat ein **eigenes Passwort** (nicht das globale Token, das MCP-Clients kennen): `perch oauth local-page enable` zeigt es einmal an, `disable` schaltet die Seite wieder ab.

Ein claude.ai-Connector gilt für das ganze claude.ai-Konto (Web, Desktop, Handy) und muss also nur einmal gekoppelt werden.

### 6a.4 Verwalten

```bash
perch oauth devices                                   # Geräteliste (Status, gekoppelt, zuletzt gesehen, läuft ab)
perch oauth revoke oc-0123456789abcdef                # ein Gerät abmelden (wirkt beim nächsten Request)
perch oauth revoke --all
perch oauth grant oc-0123456789abcdef --allow read,send --account imap-1a2b3c4d   # Schreibrechte (wie perch client add)
perch oauth ungrant oc-0123456789abcdef --read-all   # Achtung: ohne Grant liest das Gerät ALLE Konten; zum Wegnehmen: revoke
perch oauth login-allow add|remove EMAIL | list
perch oauth totp setup | status | recovery-codes      # setup erneut = neuer Code, alle Geräte werden abgemeldet
perch oauth client add --name Codex --redirect http://127.0.0.1/callback   # Client ohne Metadaten-Dokument, fest registriert
perch oauth client add --cimd https://example.com/oauth/client.json         # zusätzliches Metadaten-Dokument
perch public status
perch audit list                                      # alle Kopplungsschritte, ohne Geheimnisse
```

- **Clients ohne Metadaten-Dokument** (z. B. Codex) können sich per Dynamic Client Registration selbst eintragen, aber nur während eines offenen Kopplungsfensters (höchstens 3 pro Fenster). `PERCH_OAUTH_DCR=off` schaltet das ab.
- **Sperren:** 3 falsche Kopplungscodes schließen das Fenster; ein Neustart der Anmeldung nach bestandenem Kopplungscode ebenfalls; 5 falsche Perch-Codes in 15 Minuten sperren das Koppeln für 15 Minuten (bei Wiederholung länger). Ein zweiter Anmeldeversuch im selben Fenster schließt es sofort für beide (Alarm).

### 6a.5 Notschalter

```bash
perch public off     # öffentlicher Listener antwortet 503 (auch nach Neustart), offenes Fenster zu, alle Geräte abgemeldet
sudo tailscale funnel --https=443 off
perch public on      # wieder an; Geräte müssen neu gekoppelt werden
```

### 6a.6 Grenzen

- Der Perch-Code (TOTP) ist nicht phishing-resistent. Ein Angreifer, der den Betreiber genau im eigenen Kopplungsfenster auf eine gefälschte Seite lockt und dort Kopplungscode, Google-Login und Perch-Code abfischt, wird nur an den Details im Terminal erkannt. Er bekäme genau ein Gerät mit Leserechten, das in `perch oauth devices` steht und sofort widerrufbar ist (Spec §0a).
- Ob Funnel die Client-IP weitergibt, ist nicht geprüft. Erst wenn das live bestätigt ist, `PERCH_PUBLIC_TRUST_FORWARDED=on` setzen; sonst zeigt das Terminal „IP unknown“, und die Rate-Limits gelten global.
- Die CIMD-Adresse der gehosteten Claude-Apps ist nicht dokumentiert. Perch erlaubt deshalb Metadaten-Dokumente unter `https://claude.ai/oauth/…` und `https://claude.com/oauth/…` und holt nur von diesen beiden Hosts.
- Den Perch-Code richtet man nur per CLI ein; eine Seite `/local/totp` gibt es nicht.

## 7. Tools und Grenzen

| Tool | Hinweise |
| --- | --- |
| `perch_list_accounts` | IDs, Labels, E-Mail bzw. Token-Eigentümer, keine Secrets. Für Client-Grants nur die gewährten Konten der gewährten Dienstfamilien (`mail`, `googleProductivity`, `slack`, `whatsapp`), keine Drive/Notion-Einträge |
| `drive_search`, `drive_list_files` | `accountId` optional, ohne Angabe über alle Konten. `nextCursor`/`hasMore`, `partial`, `errors[]`, `incompleteSources` |
| `drive_get_file`, `drive_read_file`, `drive_download_file`, `drive_export_file` | `maxBytes`: Default 48 KiB, explizit bis 10 MiB. Nur Text oder Base64, kein Schreiben ins Dateisystem |
| `notion_search` | **Nur Titelsuche** über Seiten und Data Sources, keine Volltextsuche, eventuell unvollständig |
| `notion_get_page`, `notion_get_page_content`, `notion_get_block_children` | Blöcke paginiert. Verschachtelte Kinder bis `maxDepth` (Default 2) innerhalb von `maxBlocks` (Default 200). Nicht geladene Kinder sind mit `childrenNotLoaded` bzw. `childrenHasMore`/`childrenNextCursor` markiert. Bei Fehlern kommt das Geladene zurück, mit `partial`, `errors[]` und `childrenError` |
| `notion_get_database`, `notion_get_data_source`, `notion_query_data_source` | Die Database liefert `data_sources`. Abfragen laufen über `POST /v1/data_sources/{id}/query` (lesend) |
| `mail_search` | Über alle lesbaren Mail-Konten oder eines. Suchsyntax des Providers: Gmail-Operatoren, Graph `$search`, IMAP-Suche. Herkunft `accountId`/`accountLabel`/`provider`, Cursor, `partial`/`errors[]` |
| `mail_read_message` | Header, Thread-IDs, Text bis `maxBytes` (Default 48 KiB, `truncated`), Anhangsliste. HTML-only-Mails werden mit einem linearen, begrenzten Scanner zu Text (`truncated` auch, wenn der Scan vorzeitig endet) |
| `mail_get_attachment` | Base64, über `maxBytes` abgelehnt (nie gekürzt) |
| `mail_create_draft` | nur mit Client-Grant `draft` und Provider-Freigabe. Mit `replyToMessageId` zusätzlich `read`. Microsoft Graph: höchstens 4 000 000 Byte Base64-MIME pro Request (`message_too_large`) |
| `mail_send` | nur mit Client-Grant `send` und Provider-Freigabe. **Pflichtfeld `requestId`** (idempotent: gleiche ID + gleicher Inhalt sendet nie zweimal, anderer Inhalt → `idempotency_conflict`; Abschnitt 4d). Absender ist immer das gewählte Konto. Ergebnis `accepted` (vom Provider angenommen, **keine Zustellbestätigung**), `rejected` (nicht gesendet) oder `indeterminate` (Ausgang unbekannt, kein automatischer Retry: vor erneutem Senden „Gesendet“ prüfen). Mit `replyToMessageId` zusätzlich `read`. Anhänge nur als Base64, max. 10 MiB gesamt. Über HTTP max. 16 MiB Request (nur für Schreib-Clients). Microsoft Graph: lokal abgelehnt über 4 000 000 Byte Base64-MIME (ca. 2,2 MB Anhänge), laut Graph-Doku „limited to 4 MB“ |

| `calendar_list_calendars` | Kalender aller lesbaren Calendar-Konten oder eines Kontos, mit Herkunft und Cursor |
| `calendar_list_events` | Primärkalender aller Konten oder eine `calendarId` eines Kontos. Serien als Einzeltermine, pro Konto nach Start sortiert, Default ab jetzt. Ganztägig: `start.date`/`end.date` (Ende exklusiv, `endExclusive`), sonst `dateTime` mit Offset und ggf. `timeZone`. Beschreibung bis 8192 Zeichen |
| `calendar_get_event` | Ein Termin inklusive `etag` |
| `contacts_list` | Alle Kontakte seitenweise (keine Suche), nur Kontaktquellen, `personFields` aus einer Allowlist |
| `contacts_get` | Ein Kontakt per `people/c…`. Profile fremder Google-Konten sind nicht abrufbar |
| `mail_send_status` | nur mit Client-Grant `send` für das Konto: Stand eines **eigenen** früheren `mail_send` (gleicher Client, gleiches Konto, gleiche `requestId`), ohne zu senden. Andere Clients, Nutzer oder Konten finden ihn nicht |
| `calendar_create_event` | Nur mit Client-Grant `calendar_write` und Provider-Freigabe; mit `attendees` zusätzlich `calendar_invite`. Ohne Gäste privat und still, mit Gästen `sendUpdates` Standard `all`; Serien, Meet-Link, nur Popup-Erinnerungen (Abschnitt 4b); `requestId` macht Wiederholungen idempotent (auch die Meet-Anfrage). Ergebnis `created`, `conflict`, `rejected` oder `indeterminate` |
| `calendar_update_event` | Nur mit `calendar_write` + `calendar_read`; jede Änderung an einem Termin mit Gästen (vorher oder nachher, auch mit `sendUpdates: "none"`) zusätzlich `calendar_invite`. PATCH mit `If-Match: etag`, nur selbst organisierte Termine oder ganze Serien, keine einzelnen Vorkommen. Ergebnis `updated`, `precondition_failed`, `rejected` oder `indeterminate` |
| `calendar_delete_event` | Nur mit `calendar_write` + `calendar_read` (mit Gästen zusätzlich `calendar_invite`). **Endgültiges** Löschen eines Termins oder einer ganzen Serie, If-Match auf das aktuelle `etag`. Ergebnis `deleted`, `not_found`, `precondition_failed`, `rejected` oder `indeterminate` |
| `calendar_respond_event` | Nur mit `calendar_invite` + `calendar_read`. Einladung annehmen/ablehnen/vorläufig für den eigenen Eintrag. Ergebnis `responded`, `precondition_failed`, `rejected` oder `indeterminate` |

| `slack_list_conversations` | Kanäle, private Kanäle, Gruppen-DMs und DMs aller lesbaren Workspaces oder eines. `query` filtert nach Kanal- oder Personenname. Herkunft `workspaceId`/`workspaceLabel` |
| `slack_get_history`, `slack_get_thread` | Nachrichten mit Namen (`userName`), Thread-Hinweisen (`threadTs`, `replyCount`) und Datei-Metadaten. Zeitfenster `oldest`/`latest` (RFC 3339). Cursor an Workspace und Kanal gebunden |
| `slack_search` | Slacks Suche (`in:#kanal`, `from:@person`, `before:`/`after:`) über alle Workspaces, neueste zuerst, mit Permalink. Workspaces ohne `search:read` erscheinen in `errors[]` |
| `slack_send_message`, `slack_send_status` | nur mit Client-Grant `slack_send`. Postet als der verbundene Nutzer, optional im Thread (`threadTs`, `replyBroadcast`). Pflichtfeld `requestId`; Ergebnis `accepted`/`rejected`/`indeterminate` wie bei Mail |
| `slack_open_conversation`, `slack_schedule_message`, `slack_cancel_scheduled_message` | nur mit Client-Grant `slack_send`. DM/Gruppen-DM öffnen (1–8 Nutzer), Nachricht planen (60 s bis 120 Tage, Pflichtfeld `requestId`), geplante Nachricht zurückziehen (Abschnitt 4e.3) |
| `slack_list_scheduled_messages` | geplante, noch nicht gesendete Nachrichten eines Workspaces |
| `whatsapp_list_chats` | Chats (Personen, Gruppen) aller lesbaren Konten oder eines, `query` nach Chatname, `archived` |
| `whatsapp_get_messages` | Nachrichten eines Chats, Textsuche `query`, Zeitfenster `after`/`before`, `fromMe`, `mediaOnly`. Medien nur als Metadaten, keine Medien-URLs |
| `whatsapp_search` | Textsuche in den zuletzt aktiven `chatLimit` Chats pro Konto (Default 30, max. 100), **keine** Suche über alle Chats |
| `whatsapp_send_message`, `whatsapp_send_status` | nur mit Client-Grant `whatsapp_send`. Nur Text, optional als Antwort (`replyToMessageId`). Pflichtfeld `requestId` |

### Ausgabegröße und Client-Limits

- MCP-Clients begrenzen die Tool-Ausgabe. Claude Code warnt bei großen Ausgaben und kürzt bzw. verwirft sie ab `MAX_MCP_OUTPUT_TOKENS`, Default etwa 25 000 Tokens (Wert in der Claude-Code-Dokumentation prüfen).
- Perch liefert deshalb standardmäßig höchstens **48 KiB** Dateiinhalt, als kompaktes JSON.
- Größere Dateien: `maxBytes` explizit setzen, maximal 10 MiB. Gegebenenfalls in Claude Code das Limit anheben, z. B. `MAX_MCP_OUTPUT_TOKENS=100000 claude`. Base64 (Download/Export binärer Formate) vergrößert um etwa 33 %.
- Ist eine Datei größer als `maxBytes`, kommt ein klarer Fehler. Perch kürzt nicht stillschweigend. Offset-Pagination für Dateiinhalte gibt es (noch) nicht.

### Fehlertoleranz

- Fällt bei einer Suche über mehrere Konten eines aus, kommen die übrigen Ergebnisse mit `partial: true` und `errors[]`. Die nächste Seite versucht das ausgefallene Konto erneut.
- Nach 3 Fehlversuchen gibt Perch es auf und meldet es auf jeder weiteren Seite.
- Notion- und Slack-Rate-Limits (HTTP 429) wiederholt Perch beim Lesen begrenzt, gemäß `Retry-After` und mit höchstens 10 s Wartezeit. Beim Senden nie.

### Sicherheitshinweise zur Nutzung

- **Inhalte sind nicht vertrauenswürdig (Prompt Injection).** Dateien und Notion-Seiten können Anweisungen an das Modell enthalten, z. B. geteilte Dokumente Dritter. Perch ist read-only und kann upstream nichts ändern. Die Claude-Code-Sitzung hat aber eventuell andere Tools (Shell, Web, weitere MCP-Server), über die Daten abfließen könnten. Tool-Freigaben in Claude Code bewusst setzen und Ergebnisse aus fremden Dokumenten kritisch lesen.
- **Slack und WhatsApp senden:** dasselbe gilt für `slack_send_message` und `whatsapp_send_message`. Slack-Nachrichten und WhatsApp-Chats sind ebenso nicht vertrauenswürdige Eingaben.
- **Mail-Versand:** Ein Modell mit `mail_send` kann im Namen des Kontos schreiben. Send-Grants nur gezielt vergeben, Tool-Freigaben in Claude Code nicht pauschal erlauben, und Empfänger und Inhalt vor dem Senden bestätigen. Eingehende Mails können Prompt-Injection enthalten.
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
- Gmail Scopes: <https://developers.google.com/workspace/gmail/api/auth/scopes> (`gmail.readonly` restricted, `gmail.send` sensitive, `gmail.compose` restricted)
- Gmail Senden (RFC-MIME, base64url): <https://developers.google.com/workspace/gmail/api/guides/sending>. Entwürfe: <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create>
- Graph sendMail (MIME base64 als `text/plain`, 202 = angenommen, nicht zugestellt): <https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0>
- Graph Berechtigungen: <https://learn.microsoft.com/en-us/graph/permissions-reference>
- Microsoft Auth-Code-Flow mit PKCE: <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>
- GMX IMAP/SMTP: <https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html>, <https://support.gmx.com/pop-imap/imap/server.html>
- Google Calendar Scopes: <https://developers.google.com/workspace/calendar/api/auth>; Events insert/list/get/patch: <https://developers.google.com/workspace/calendar/api/v3/reference/events/insert> (bzw. `/list`, `/get`, `/patch`); ETags: <https://developers.google.com/workspace/calendar/api/guides/version-resources>; Fehler: <https://developers.google.com/workspace/calendar/api/guides/errors>; calendarList: <https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list>
- People API: <https://developers.google.com/people/api/rest/v1/people.connections/list>, <https://developers.google.com/people/api/rest/v1/people/get>
- OpenID Connect (Scopes `openid email`, `sub`, `email_verified`, userinfo): <https://developers.google.com/identity/openid-connect/openid-connect>
- imapflow (`download` mit `maxBytes`): <https://imapflow.com/docs/api/imapflow-client/>. nodemailer SMTP/TLS: <https://nodemailer.com/smtp>
