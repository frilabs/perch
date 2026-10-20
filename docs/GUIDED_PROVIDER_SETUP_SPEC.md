# Spezifikation: Perch führt durch die Anbieter-Vorbereitung (Google, Outlook, Slack) und Login ohne Tunnel

Stand 2026-10-21. **Von Fritz freigegeben** („eigentlich sollte mich doch die onboarding journey … durch B im terminal durchführen“ → „ja, baue das genau so“).

## Ziel

Niemand muss die Anbieter-Vorbereitung aus einer Anleitung abarbeiten oder Dateien per `scp`/`sudo install` auf den Server bringen. `perch setup` und die einzelnen `add`-Befehle erkennen, was fehlt, und führen im Terminal Schritt für Schritt durch.

## 1. Google (`perch google add`, `perch gmail add`, `perch google-productivity add`, `perch setup`)

Wenn `PERCH_GOOGLE_CLIENT_FILE` fehlt/leer/ungültig ist (interaktiv; ohne Terminal: klare Fehlermeldung mit Verweis auf `perch google client setup`):

1. Kurze Erklärung (selbst gehostet → eigenes Google-Cloud-Projekt, einmal pro Installation, ca. 10 Min, kostenlos).
2. Geführte Schritte mit **direkten Links**, jeweils „Enter, wenn erledigt“:
   - Projekt anlegen (`https://console.cloud.google.com/projectcreate`), Projekt-ID abfragen (optional, dann enthalten folgende Links `?project=ID`).
   - APIs aktivieren: Direktlinks auf die Library-Seiten von Drive, Gmail, Calendar, People (nur die für die gewählten Dienste).
   - Google Auth Platform: Branding, Audience (External, Testing, Testnutzer = eigene Konten), Data Access mit der **fertig ausgegebenen Scope-Liste** (nur für die gewählten Dienste + Lesen/Schreiben).
   - Client anlegen: Typ **Desktop app**, JSON herunterladen.
3. **JSON einfügen:** verdeckte Eingabe; der Inhalt der heruntergeladenen Datei (eine Zeile) wird eingefügt. Perch prüft: gültiges JSON, Schlüssel `installed`, `client_id` endet auf `.apps.googleusercontent.com`, `client_secret` vorhanden, `redirect_uris` enthält `http://localhost`. Falls die Eingabe mehrzeilig ankommt, bis zur schließenden Klammer weiterlesen (Größenlimit).
4. Speichern an `PERCH_GOOGLE_CLIENT_FILE` (Standard `~/.config/perch/google-client.json`), `0600`, atomar. Ist die Variable in `.env` nicht gesetzt, den Pfad nennen und `.env` (falls Perch sie findet, `--env-file`-Pfad bzw. `~/perch/.env`) **nicht** automatisch ändern, sondern die Zeile zum Ergänzen ausgeben — es sei denn der Standardpfad wird ohnehin verwendet.
5. Eigener Befehl `perch google client setup` (gleicher Ablauf, auch zum Ersetzen mit Rückfrage) und `perch google client show` (nur client_id gekürzt, Pfad).
6. Hinweis auf die 7-Tage-Grenze im Status „Testing“.

## 2. Login ohne Tunnel (alle Loopback-OAuth-Flows: Google, Microsoft, Luma)

- Perch gibt den Login-Link aus und wartet **gleichzeitig** auf
  a) den Loopback-Callback (wie heute, für Tunnel oder Browser auf dem Server) und
  b) eine eingefügte Adresse: „Nach der Zustimmung zeigt der Browser ‚Seite nicht erreichbar‘ – die komplette Adresse aus der Adresszeile hier einfügen:“.
- Die eingefügte URL wird streng geprüft: Host `127.0.0.1`/`localhost`/`[::1]` mit dem erwarteten Port und Pfad, `state` muss passen (gleiche Prüfung wie der Callback), `code` wird übernommen; `error=` wird als Abbruch gemeldet. Was zuerst kommt, gewinnt; das andere wird beendet.
- PKCE, `state` und Redirect-URI bleiben unverändert; kein neuer Redirect-Typ bei den Anbietern nötig.
- Die SSH-Tunnel-Zeile in den Hinweisen wird zur Alternative („oder: Tunnel …“).

## 3. Outlook / Microsoft 365 (`perch microsoft add`, `perch setup`)

Wenn `PERCH_MICROSOFT_CLIENT_ID` fehlt: geführte Schritte mit Direktlinks (Entra admin center → App registrations → New registration; Kontotypen inkl. persönliche Microsoft-Konten; Plattform „Mobile and desktop applications“ mit Redirect `http://localhost`; keine Secrets; API permissions delegated `User.Read`, `Mail.Read`, und bei Schreiben `Mail.ReadWrite`, `Mail.Send`), dann **Client-ID einfügen** (GUID-Format geprüft). Gespeichert in einer Datei `~/.config/perch/microsoft-client-id` (`0600`); `PERCH_MICROSOFT_CLIENT_ID` hat weiter Vorrang, die Datei ist der neue Fallback (Config-Lesen entsprechend erweitern, `.env.example` dokumentieren). Befehl `perch microsoft client setup|show`.

## 4. Slack (`perch slack add`, `perch setup`)

Vor der Token-Abfrage geführt: Manifest ausgeben (wie `perch slack manifest`), Link `https://api.slack.com/apps?new_app=1`, Schritte „From a manifest → Workspace wählen → Manifest einfügen → Create → Install to Workspace → User OAuth Token kopieren“, Enter, dann wie heute verdeckte Token-Eingabe. Mit `--skip-guide` (oder wenn bereits ein Workspace verbunden ist: Rückfrage „Anleitung anzeigen? [y/N]“) überspringbar.

## 5. Allgemein

- Alles nur interaktiv; ohne Terminal klare Fehler wie bisher. Keine Secrets auf der Konsole, in Logs oder im Audit (Client-Secret der Desktop-App wird wie ein Secret behandelt).
- Tests: geführte Abläufe mit gescripteten Antworten, JSON-Validierung (falscher Typ „web“, kaputt, mehrzeilig, zu groß), Speichern/Rechte, Paste-URL (richtig, falscher state, falscher Host/Port, error=), Wettlauf Callback vs. Paste, Microsoft-Client-ID-Datei + Vorrang der Variable, Slack-Anleitung/Skip.
- Doku: README-Onboarding (Vorbereitung passiert jetzt im Terminal; Tabelle bleibt als Überblick), `SETUP.md` §1a/§3/§4a/§4e, `PHASE1_REMAINING.md` Live-Punkte (Google zeigt nach Redirect „nicht erreichbar“ mit vollständiger URL; Entra-Links).
