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

## 4a. Mail-Konten verbinden (E-Mail-Meilenstein)

Spezifikation und Testnachweise: `docs/EMAIL_MILESTONE.md`. **Nichts davon ist live verifiziert.** Getestet wurde nur gegen Mocks und lokale Testserver.

Grundregel: **Standard ist Lesen.** Entwürfe und Senden brauchen zwei Freigaben:
1. beim Verbinden des Kontos, also Provider-Scope oder IMAP-Opt-in (`--allow-drafts`, `--allow-send`);
2. einen **Client-Grant** für genau diese Konto-IDs (Abschnitt 4a.4).

Das globale HTTP-Token und `serve --stdio` ohne Client-Token bleiben read-only.

### 4a.1 Gmail (eigener Grant pro Konto, getrennt von Drive)

1. Im selben Google-Cloud-Projekt wie für Drive die **Gmail API** aktivieren.
2. Im Consent Screen die Scopes eintragen:
   - `gmail.readonly` (restricted);
   - optional `gmail.send` (sensitive) und/oder `gmail.compose` (restricted: Entwürfe + Senden).
3. Testnutzer eintragen. Restricted Scopes verlangen für den Produktionsstatus eine Google-Verifizierung. Im Testing-Status laufen Refresh-Tokens nach 7 Tagen ab.
4. Konto verbinden. Der Desktop-Client aus `PERCH_GOOGLE_CLIENT_FILE` wird wiederverwendet.

```bash
perch gmail add --label "Privat-Gmail"                    # nur gmail.readonly
perch gmail add --label "Privat-Gmail" --allow-send       # + gmail.send
perch gmail add --label "Privat-Gmail" --allow-drafts     # + gmail.compose (Entwürfe und Senden)
perch gmail list
perch gmail remove gmail-1a2b3c4d [--revoke]
```

Fehlt nach dem Consent ein angefragter Scope, z. B. weil ein Häkchen entfernt wurde, bricht `add` ab.

### 4a.2 Outlook.com / Microsoft 365 (Microsoft Graph, delegiert)

1. Im Entra Admin Center (<https://entra.microsoft.com>) eine **App-Registrierung** anlegen:
   - unterstützte Kontotypen passend wählen (für Outlook.com: „persönliche Microsoft-Konten“ einschließen);
   - Plattform **„Mobile and desktop applications“**, Redirect-URI `http://localhost`;
   - kein Client-Secret (öffentlicher Client mit PKCE).
2. Unter „API permissions“ die delegierten Rechte `User.Read` und `Mail.Read` eintragen, optional `Mail.ReadWrite` (Entwürfe) und `Mail.Send` (Senden).
3. `PERCH_MICROSOFT_CLIENT_ID=<Application (client) ID>` setzen. Optional `PERCH_MICROSOFT_TENANT`:
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

- Der Browser muss `http://localhost:<port>` auf dem Server erreichen, sonst per `ssh -L <port>:127.0.0.1:<port>` weiterleiten (wie bei Google). Der Listener bindet nur `127.0.0.1`. Löst der Browser `localhost` nur auf `::1` auf, hilft `--redirect-host 127.0.0.1`. Dann muss `http://127.0.0.1` als Redirect-URI im Manifest der App-Registrierung stehen.
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
- **Gesendet-Ordner:** Perch legt nach dem SMTP-Versand **keine Kopie in „Gesendet“** ab. Ob GMX das serverseitig tut, ist nicht verifiziert.

### 4a.4 Client-Grants für Entwürfe und Senden

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
  - Andere Konten sind unsichtbar. Eine nicht gewährte und eine nicht existierende Konto-ID liefern dieselbe Ablehnung.
- **Widerruf und Einschränkung:** Vor **jedem** Tool-Aufruf liest Perch den Grant neu aus dem Store (Grant-ID und Token-Hash). `perch client remove` oder ein eingeschränkter Grant gilt damit sofort, auch für eine laufende stdio-Session. Der Aufruf scheitert mit `grant_revoked` bzw. `capability_denied`, bevor ein Provider kontaktiert wird. Über HTTP wird ein entferntes Token zusätzlich mit `401` abgewiesen. Die Tool-Liste einer laufenden stdio-Session wird nicht aktualisiert.
- **Betreiber:** Das globale HTTP-Token und `perch serve --stdio` ohne Client-Token behalten alle Read-only-Tools (Drive, Notion, Mail, seit dem Productivity-Meilenstein auch Calendar/Contacts lesend) für alle Konten. Schreib-Tools gibt es dort nie.
- **Grenze:** Client-Grants schränken einen Client innerhalb **eines** Namespace ein. Die Trennung zwischen Personen leisten erst die vom Admin angelegten Nutzer (Abschnitt 4c).

## 4b. Google Calendar und Contacts verbinden (Productivity-Meilenstein)

Spezifikation und Testnachweise: `docs/GOOGLE_PRODUCTIVITY_MILESTONE.md`. **Nichts davon ist live verifiziert.** Getestet wurde nur gegen Mocks.

1. Im selben Google-Cloud-Projekt die **Google Calendar API** und/oder die **People API** aktivieren.
2. Im Consent Screen die Scopes eintragen: `openid`, `email` (bzw. `.../auth/userinfo.email`), `.../auth/calendar.readonly`, `.../auth/contacts.readonly` und nur bei Bedarf `.../auth/calendar.events.owned`. Testnutzer eintragen; im Testing-Status laufen Refresh-Tokens nach 7 Tagen ab.
3. Konto verbinden. Das ist ein **eigener Grant**, getrennt von Drive und Gmail; dafür ist weder eine Drive- noch eine Gmail-Freigabe nötig. Der Desktop-Client aus `PERCH_GOOGLE_CLIENT_FILE` wird wiederverwendet. `--services` ist Pflicht und wählt die Dienste ausdrücklich:

```bash
perch google-productivity add --label "Privat" --services calendar            # calendar.readonly
perch google-productivity add --label "Privat" --services contacts            # contacts.readonly
perch google-productivity add --label "Privat" --services calendar,contacts --allow-calendar-write
                                                                               # + calendar.events.owned
perch google-productivity list
perch google-productivity remove gprod-1a2b3c4d [--revoke]
```

- Perch prüft nach dem Consent: Refresh-Token vorhanden, jeder angefragte Scope gewährt (ein entferntes Häkchen bricht `add` ab), E-Mail über den festen Endpunkt `https://openidconnect.googleapis.com/v1/userinfo` mit `email_verified: true`. Ein zweiter Grant für dasselbe Google-Konto (`sub`) wird abgelehnt.
- **Schreiben** braucht drei Freigaben: `--allow-calendar-write` beim Verbinden, den von Google tatsächlich gewährten Scope `calendar.events.owned` (zusätzlich beim Token-Refresh erneut geprüft) und einen Client-Grant mit `calendar_write`.
- **Client-Grants** für Calendar/Contacts gelten nur für `gprod-…`-Konten und geben keinen Mail-Zugriff:

```bash
perch client add --label "Laptop Kalender" --allow calendar_read,calendar_write --account gprod-1a2b3c4d \
  --token-file ~/.config/perch/clients/calendar.token
perch client add --label "Kontakte" --allow contacts_read --account gprod-1a2b3c4d
```

  `calendar_read` → `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`; `contacts_read` → `contacts_list`, `contacts_get`; `calendar_write` → `calendar_create_event`, und zusammen mit `calendar_read` auch `calendar_update_event`. Mail-Capabilities (`read`, `draft`, `send`) gelten weiterhin nur für Mail-Konten; ein Grant, dessen Capabilities nicht zu den Konten passen, wird abgelehnt.
- **Was Perch schreibt:** nur private Termine im eigenen Kalender. Keine Teilnehmer, Einladungen, Benachrichtigungen an andere (`sendUpdates=none`), Konferenzen, Anhänge oder Serien. Änderungen nur an Terminen ohne Gäste, die man selbst organisiert, mit `etag` (If-Match). Details: Meilenstein-Doku §5.
  - **Sichtbarkeit:** nur `private` oder `confidential`. Beim Anlegen sendet Perch immer ausdrücklich `private`, wenn nichts angegeben ist. `default` erbt die Freigabe des Kalenders, die öffentlich sein kann; Perch lehnt `default` und `public` ab.
  - **Erinnerungen:** nur Popup-Erinnerungen. Perch nutzt nie die Standard-Erinnerungen des Kalenders, weil diese E-Mails sein können: `useDefault: true` wird abgelehnt; ohne Angabe sendet Perch `{useDefault: false, overrides: []}`.
  - **Ändern:** Ist ein bestehender Termin öffentlich, hat er `default`-Sichtbarkeit oder Standard- bzw. E-Mail-Erinnerungen, setzt Perch im **selben** PATCH `visibility: "private"` und behält nur die Popup-Erinnerungen. Ein öffentlicher Termin wird beim Ändern also privat.
- **Wiederholen:** `calendar_create_event` braucht eine stabile `requestId`. Bei `indeterminate` (Ausgang unbekannt) dieselbe `requestId` und dieselbe `calendarId` erneut senden: Der Termin entsteht dann höchstens einmal, sonst kommt `conflict`. Perch wiederholt nie selbst.
- **Widerruf:** <https://myaccount.google.com/permissions> oder `remove --revoke`.

## 4c. Nutzer anlegen und trennen (Nutzer-Isolations-Meilenstein)

Spezifikation und Testnachweise: `docs/USER_ISOLATION_MILESTONE.md`. **Nur mit Mocks getestet, nicht live verifiziert.** Das ist **keine** gehärtete Mandantenfähigkeit für einen öffentlichen Dienst (Grenzen: Meilenstein-Doku §8).

### 4c.1 Modell

- **Root-Namespace:** der bisherige Store (`PERCH_DATA_DIR/store.enc`, `PERCH_KEY_FILE`).
  - Er gehört dem lokalen Betreiber. Bestehende Konten bleiben dort; Perch verschiebt nichts und migriert nichts automatisch.
  - Das globale HTTP-Token und `perch serve --stdio` ohne `PERCH_USER` sehen nur diesen Namespace.
- **Nutzer:** Nur der lokale Admin legt Nutzer per CLI an. Es gibt keine Registrierung.
  - Jeder Nutzer bekommt einen **eigenen** verschlüsselten Store unter `$PERCH_DATA_DIR/users/<id>/` und einen **eigenen** Schlüssel unter `<Verzeichnis von PERCH_KEY_FILE>/user-keys/<id>.key`, also außerhalb des Datenverzeichnisses.
  - Dazu kommen eigene Token-Caches im Server.
  - Die ID (`user-` plus 16 Hex-Zeichen) erzeugt Perch selbst. Sie wird nie wiederverwendet.
- **Zugangsdaten eines Nutzers:**
  - ein Read-only-Token: alle Lese-Tools, aber nur für die eigenen Konten;
  - optional Client-Grants im eigenen Namespace (Mail-Grants nur Mail, `gprod`-Grants nur Calendar/Contacts, wie bisher).
  - Jedes Token gehört zu genau einem Namespace. Passt ein Token-Hash mehrfach, lehnt Perch ab und wählt nie selbst aus.
- **Höchstens 100 Registry-Einträge.** Entfernte Nutzer zählen mit.
- **Macht des Admins:** Wer auf dem Host den Root-Schlüssel und `user-keys/` lesen kann, kann alle Namespaces lesen. Das ist die bewusste privilegierte Grenze. Perch schützt Nutzer **nicht** vor dem Host-Admin.

### 4c.2 Nutzer anlegen, auflisten, entfernen

```bash
perch user add --label "Alice"           # Token -> ~/.config/perch/users/<id>.token (0600), wird nie angezeigt
perch user add --label "Bob" --token-file ~/.config/perch/users/bob.token
perch user list
perch user remove user-0123456789abcdef  # sperrt die Mitgliedschaft; Store und Schlüssel bleiben liegen
```

- Das Token entsteht genau einmal in einer **neuen** `0600`-Datei. Eine vorhandene Datei wird nie überschrieben. In der Registry steht nur der SHA-256-Hash. Das Token sicher an den Nutzer übergeben.
- `remove` wirkt sofort:
  - Über HTTP liefern Read-only-Token und Client-Grants dieses Nutzers beim nächsten Request `401`.
  - Eine laufende stdio-Session scheitert beim nächsten Tool-Aufruf, bevor ein Provider kontaktiert wird.
  - Store und Schlüssel löscht Perch nicht. Archivieren oder löschen ist Sache des Admins.
  - Es gibt weder eine Reaktivierung noch eine Token-Rotation: Bei Bedarf einen neuen Nutzer anlegen und neu einrichten.

### 4c.3 Konten und Client-Grants eines Nutzers einrichten (lokal, Admin)

`PERCH_USER=<id>` wählt den Namespace für Konten-, Client- und stdio-Befehle. Die Onboarding-Schritte aus den Abschnitten 3, 4, 4a und 4b gelten unverändert. Das Konto landet nur im Store dieses Nutzers.

```bash
export PERCH_USER=user-0123456789abcdef
perch google add --label "Alice Drive" --port 8766
perch imap add --label "Alice GMX" --email alice@gmx.at --allow-send
perch google-productivity add --label "Alice Kalender" --services calendar --allow-calendar-write
perch accounts                                 # nur Alices Konten
perch client add --label "Alice Laptop" --allow read,send --account imap-1a2b3c4d
perch serve --stdio                            # Alices Read-only-Session
unset PERCH_USER                               # zurück zum Root-Namespace
```

- Ein leerer, falsch geformter, unbekannter oder entfernter `PERCH_USER` bricht ab. Es gibt **keinen** Rückfall auf den Root-Namespace.
- Mit `PERCH_USER` sind gesperrt: `perch init`, `perch token`, `perch user …` (keine verschachtelte Nutzerverwaltung) und `perch serve --http`.
- `PERCH_CLIENT_TOKEN_FILE` muss zu einem Grant **des gewählten Namespace** gehören, sonst startet stdio nicht.
- Konto-IDs gelten nur im eigenen Namespace. Dieselbe ID kann in zwei Namespaces verschiedene Konten bezeichnen. Ein Grant kann nur Konten des eigenen Namespace nennen.

### 4c.4 HTTP für mehrere Nutzer

`perch serve --http` (ohne `PERCH_USER`) bedient alle Nutzer. Welcher Namespace gilt, entscheidet allein das Bearer-Token. Es gibt keinen Header, Query-Parameter oder Pfad dafür.

```bash
# Laptop von Alice: ihr Read-only-Token oder ihr Client-Token statt des globalen Tokens
TOKEN="$(ssh homeserver 'cat ~/.config/perch/users/user-0123456789abcdef.token')"
claude mcp add --transport http perch https://homeserver.tailnet-name.ts.net/mcp --header "Authorization: Bearer ${TOKEN}"
```

- Host-, Origin- und Bearer-Prüfung, Loopback-Default und die Bind-Regeln gelten unverändert.
- Mitgliedschaft und Grants prüft Perch bei **jedem** Request und vor **jedem** Tool-Aufruf neu.
- Cursor (`nextCursor`) sind an Namespace, Abfrage und Konto gebunden. Fremde oder veränderte Cursor scheitern mit `bad_cursor`, bevor ein Provider kontaktiert wird. Cursor aus früheren Versionen gelten nicht mehr: die Abfrage neu beginnen.
- **Beschädigter Namespace:** Fehlt der Store oder Schlüssel eines **aktiven** Nutzers oder ist er beschädigt, antwortet der Server auf **alle** Bearer-Tokens mit `503` (fail closed), **auch auf das globale Token**: Perch kann sonst nicht beweisen, dass das globale Token keinem Client-Grant dieses Nutzers gleicht. Laufende Sitzungen dieses Nutzers (auch stdio) scheitern beim nächsten Tool-Aufruf. Perch legt nichts neu an. Abhilfe: Dateien aus dem Backup zurückspielen oder `perch user remove <id>`. Lokales Root-stdio ohne `PERCH_USER` **und ohne `PERCH_CLIENT_TOKEN_FILE`** bleibt nutzbar. Root-stdio mit Client-Token prüft die Namespace-Eindeutigkeit beim Start und sperrt bei einem beschädigten aktiven Nutzer-Namespace ebenfalls.
- **Fehlgeschlagenes `perch user add`:** Bricht der Befehl ab, können eine Token-Datei und `users/<id>/` bzw. `user-keys/<id>.key` ohne Registry-Eintrag liegen bleiben. Sie sind nie nutzbar; Dateien ohne passenden Eintrag in `perch user list` löschen.

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

- Der Server bedient den Root-Namespace (globales Token, Root-Client-Grants) und alle aktiven Nutzer (deren Tokens), siehe Abschnitt 4c.4.

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
| `perch_list_accounts` | IDs, Labels, E-Mail bzw. Token-Eigentümer, keine Secrets. Für Client-Grants nur die gewährten Konten der gewährten Dienstfamilien (`mail` und/oder `googleProductivity`), keine Drive/Notion-Einträge |
| `drive_search`, `drive_list_files` | `accountId` optional, ohne Angabe über alle Konten. `nextCursor`/`hasMore`, `partial`, `errors[]`, `incompleteSources` |
| `drive_get_file`, `drive_read_file`, `drive_download_file`, `drive_export_file` | `maxBytes`: Default 48 KiB, explizit bis 10 MiB. Nur Text oder Base64, kein Schreiben ins Dateisystem |
| `notion_search` | **Nur Titelsuche** über Seiten und Data Sources, keine Volltextsuche, eventuell unvollständig |
| `notion_get_page`, `notion_get_page_content`, `notion_get_block_children` | Blöcke paginiert. Verschachtelte Kinder bis `maxDepth` (Default 2) innerhalb von `maxBlocks` (Default 200). Nicht geladene Kinder sind mit `childrenNotLoaded` bzw. `childrenHasMore`/`childrenNextCursor` markiert. Bei Fehlern kommt das Geladene zurück, mit `partial`, `errors[]` und `childrenError` |
| `notion_get_database`, `notion_get_data_source`, `notion_query_data_source` | Die Database liefert `data_sources`. Abfragen laufen über `POST /v1/data_sources/{id}/query` (lesend) |
| `mail_search` | Über alle lesbaren Mail-Konten oder eines. Suchsyntax des Providers: Gmail-Operatoren, Graph `$search`, IMAP-Suche. Herkunft `accountId`/`accountLabel`/`provider`, Cursor, `partial`/`errors[]` |
| `mail_read_message` | Header, Thread-IDs, Text bis `maxBytes` (Default 48 KiB, `truncated`), Anhangsliste. HTML-only-Mails werden mit einem linearen, begrenzten Scanner zu Text (`truncated` auch, wenn der Scan vorzeitig endet) |
| `mail_get_attachment` | Base64, über `maxBytes` abgelehnt (nie gekürzt) |
| `mail_create_draft` | nur mit Client-Grant `draft` und Provider-Freigabe. Mit `replyToMessageId` zusätzlich `read`. Microsoft Graph: höchstens 4 000 000 Byte Base64-MIME pro Request (`message_too_large`) |
| `mail_send` | nur mit Client-Grant `send` und Provider-Freigabe. Absender ist immer das gewählte Konto. Ergebnis `accepted` (vom Provider angenommen, **keine Zustellbestätigung**), `rejected` (nicht gesendet) oder `indeterminate` (Ausgang unbekannt, kein automatischer Retry: vor erneutem Senden „Gesendet“ prüfen). Mit `replyToMessageId` zusätzlich `read`. Anhänge nur als Base64, max. 10 MiB gesamt. Über HTTP max. 16 MiB Request (nur für Schreib-Clients). Microsoft Graph: lokal abgelehnt über 4 000 000 Byte Base64-MIME (ca. 2,2 MB Anhänge), laut Graph-Doku „limited to 4 MB“ |

| `calendar_list_calendars` | Kalender aller lesbaren Calendar-Konten oder eines Kontos, mit Herkunft und Cursor |
| `calendar_list_events` | Primärkalender aller Konten oder eine `calendarId` eines Kontos. Serien als Einzeltermine, pro Konto nach Start sortiert, Default ab jetzt. Ganztägig: `start.date`/`end.date` (Ende exklusiv, `endExclusive`), sonst `dateTime` mit Offset und ggf. `timeZone`. Beschreibung bis 8192 Zeichen |
| `calendar_get_event` | Ein Termin inklusive `etag` |
| `contacts_list` | Alle Kontakte seitenweise (keine Suche), nur Kontaktquellen, `personFields` aus einer Allowlist |
| `contacts_get` | Ein Kontakt per `people/c…`. Profile fremder Google-Konten sind nicht abrufbar |
| `calendar_create_event` | Nur mit Client-Grant `calendar_write` und Provider-Freigabe. Private Termine (`private`/`confidential`, ohne Angabe `private`) ohne Gäste/Benachrichtigungen an andere, nur Popup-Erinnerungen; `requestId` macht Wiederholungen idempotent. Ergebnis `created`, `conflict`, `rejected` oder `indeterminate` |
| `calendar_update_event` | Nur mit `calendar_write` + `calendar_read`. PATCH mit `If-Match: etag`, `sendUpdates=none`, nur eigene Termine ohne Gäste und ohne Serie. Das Ergebnis ist immer privat und nur mit Popup-Erinnerungen (wird im selben PATCH gesetzt). Ergebnis `updated`, `precondition_failed`, `rejected` oder `indeterminate` |

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
