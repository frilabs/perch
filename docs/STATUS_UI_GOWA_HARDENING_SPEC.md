# Spezifikation: schöner `perch status` und GOWA-Härtung

Stand 2026-10-20. **Von Fritz freigegeben** (Status: „grafisch ansprechender … fancy im Terminal mit Checkboxen, was erledigt ist und was man theoretisch noch machen könnte“; GOWA-Fix als Folge des ersten Live-Laufs).

## 1. `perch status` im Terminal

- Neue Darstellung, wenn stdout ein Terminal ist: Kopfzeile (Perch-Version, Server, Zeit), dann Abschnitte mit Box-Zeichen/Trennlinien, Checkboxen und dezenter Farbe (frilabs-Brand: monochrom; Farbe nur für Status: grün ok, rot Fehler, gelb Hinweis; `NO_COLOR` und Nicht-TTY → ohne Farbe, Checkboxen bleiben als Unicode `☑`/`☐`/`✗`; `--plain` erzwingt die bisherige schlichte Ausgabe). `--json` bleibt unverändert.
- **Pro Dienst** (Drive, Notion, Gmail, Outlook, IMAP/GMX, Kalender/Kontakte, Slack, WhatsApp, Luma):
  - verbundene Konten als `☑` mit Label, Adresse, Live-Check (ok/ms oder Fehler);
  - darunter die **Fähigkeiten** des Kontos: aktivierte als `☑` (z. B. lesen, Entwürfe, senden), mögliche aber nicht aktivierte als `☐` mit dem Befehl, der sie freischaltet (z. B. „organisieren: neu verbinden mit `--allow-modify`“, Slack „DMs öffnen: App neu installieren“);
  - nicht verbundene Dienste als `☐` mit dem passenden `perch … add`-Befehl und einer Zeile, was der Dienst kann.
- **Zugänge:** Clients (Vollzugriff oder Liste der Rechte), öffentlicher Zugang (☑/☐ mit `perch public setup`), WhatsApp-Bridge.
- **Fortschritt/Checkliste** am Ende, z. B. „Onboarding 4/7“: Server läuft (bei `status` per HTTP-Selbstprüfung nur, wenn ohne Aufwand möglich, sonst weglassen), Client angelegt, mindestens ein Konto, Schreibrechte gesetzt, `store.key` gesichert (nur als Erinnerung, ☐, nicht prüfbar), öffentlicher Zugang (optional).
- Ledger-Füllstand als kleiner Balken, Audit-Zähler, Gesamtergebnis („Alle Prüfungen bestanden“ / Anzahl Fehler). Exit-Code wie bisher.
- Breite: passt sich an `process.stdout.columns` an (min. 60), lange Werte werden gekürzt.
- Keine Secrets in der Ausgabe (wie bisher). Die `/status`-Webseite bleibt in dieser Spec unverändert.

## 2. GOWA-Härtung (`perch whatsapp install`)

- **Passwort im Log:** GOWA schreibt beim Start seine Konfiguration inkl. `app_basic_auth` ins Journal. Die von Perch erzeugte Unit bekommt `LogFilterPatterns=~app_basic_auth` (systemd ≥ 253; ältere systemd: `StandardOutput=null`-Fallback nicht automatisch, aber Warnung). Ein erneutes `perch whatsapp install` erkennt eine **von Perch erzeugte ältere Unit** (bekannter Inhalt) und ersetzt sie durch die neue; fremde Units weiter nicht.
- **Neues Passwort:** `perch whatsapp rotate-password`: neues Zufallspasswort in `~/gowa/.env` (0600), `systemctl --user restart gowa`, warten bis `/devices` antwortet, Instanz in Perch neu speichern. Gekoppelte Geräte bleiben erhalten. Passwort nie auf der Konsole. Hinweis, dass alte Journal-Einträge nur root löschen kann (`sudo journalctl --rotate && sudo journalctl --vacuum-time=1s`).
- **Fehler beim ersten Lauf:** Im ersten Live-Lauf endete die Installation nach „waiting for …/devices“ mit „Internal error“, obwohl GOWA lief und Prüfen/Speichern danach einzeln funktionierte. Ursache finden (nicht-`PerchError` im Pfad nach dem Health-Check) und beheben; Speichern bekommt dieselbe Wiederholung wie der Health-Check. Unbekannte Fehler im Installer werden als `PerchError` mit Schritt-Angabe gemeldet (welcher Schritt, ohne Secrets).
