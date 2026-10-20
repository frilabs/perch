# Spezifikation: GOWA automatisch mitinstallieren (`perch whatsapp install`)

Stand 2026-10-20. **Von Fritz freigegeben** („ich möchte das es in zukunft automatisch mitinstalliert wird“), nach der manuellen Installation aus `SETUP.md` §4f.1 beim ersten Live-Onboarding.

## Ziel

WhatsApp soll so einfach sein wie die anderen Dienste: Wer in `perch setup` WhatsApp wählt (oder `perch whatsapp install` aufruft), bekommt die GOWA-Bridge heruntergeladen, geprüft, konfiguriert, als Dienst gestartet und in Perch eingetragen, ohne Passwort-Kopieren. Die Entscheidung bleibt bewusst (Warnung + Bestätigung), weil die Anbindung inoffiziell ist.

## Verhalten

- `perch whatsapp install [--yes] [--dir PATH] [--port N]`
  1. Warnt: inoffizielle Anbindung, Konto kann eingeschränkt werden, GOWA speichert Nachrichten unverschlüsselt auf dieser Platte. Fragt `[y/N]` (ohne Terminal und ohne `--yes`: Abbruch).
  2. Nur Linux mit systemd (`x64` → `linux_amd64`, `arm64` → `linux_arm64`); sonst klare Meldung mit Verweis auf `SETUP.md` §4f.1.
  3. Lädt **die in Perch festgelegte Version** (zunächst v9.6.0) von `https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/download/v9.6.0/whatsapp_9.6.0_linux_<arch>.zip` (Redirects nur zu GitHub-Release-Hosts, Größenlimit) und prüft sie gegen die **im Perch-Code hinterlegte SHA-256** (nicht gegen eine heruntergeladene Prüfsummendatei):
     - linux_amd64: `96173e28d963f591a13907d6abfee7a83b18c15c6bad25c193cdbc6fab088154`
     - linux_arm64: `4999212cdc7fe39753ea85a18cb52a0477ae694cf7a8966d5cb182b621d4e035`
     Abweichung → Abbruch, nichts wird entpackt.
  4. Entpackt nur die Programmdatei `whatsapp` (eigener minimaler ZIP-Leser mit `zlib.inflateRaw`, keine neue Abhängigkeit, kein `unzip`), Pfad-Traversal ausgeschlossen, Größenlimit. Ziel: `~/gowa` (Standard, wie `SETUP.md`), Ordner `0700`, Programm `0700`.
  5. Erzeugt ein zufälliges Passwort (32 Byte), schreibt `~/gowa/.env` (`0600`, Inhalt wie `SETUP.md` §4f.1: nur `127.0.0.1`, keine UI, kein MCP, kein Auto-Read, Presence `unavailable`) und `~/.config/systemd/user/gowa.service` (wie §4f.1, `UMask=0077`).
  6. `systemctl --user daemon-reload` und `enable --now gowa`; wartet, bis `GET /devices` mit Basic Auth antwortet (Timeout mit klarer Meldung inkl. `journalctl --user -u gowa`).
  7. Trägt die Instanz in Perch ein wie `perch whatsapp instance set` (URL `http://127.0.0.1:<port>`, Nutzer/Passwort direkt in den verschlüsselten Store, nie auf der Konsole).
  8. Schlusszeile: nächster Schritt `perch whatsapp add --label … --phone +…`.
- Wiederholter Aufruf: Ist GOWA in der festgelegten Version schon installiert und konfiguriert, nichts überschreiben, nur prüfen und melden. Andere Version oder fremde Dateien im Zielordner → Abbruch mit Hinweis (`--dir` oder manuell entfernen). Ein späteres `--upgrade` ist nicht Teil dieser Spec.
- `perch setup`: Wählt man WhatsApp und ist noch keine Instanz eingetragen, bietet Setup die Installation an (gleiche Warnung/Bestätigung), danach direkt das Koppeln.
- Kein Lauf als root (Abbruch, wenn `uid 0`).

## Sicherheit

- Download nur über HTTPS von GitHub; Hash im Code festgelegt; Versions-Update ist eine Code-Änderung mit neuem Hash.
- Das Passwort erscheint nie auf der Konsole, in Logs oder im Audit.
- Port nie öffentlich; die bestehende Prüfung (`validateGowaOrigin`: Loopback/Tailscale) bleibt.
- Tests mit gemocktem Download und gemocktem `systemctl`: Hash-Abweichung, kaputtes/feindliches ZIP (Traversal, zu groß), Dateirechte, Inhalt von `.env`/Unit, Wiederholung, kein Terminal ohne `--yes`, falsche Plattform, root.

## Doku

`SETUP.md` §4f: `perch whatsapp install` als Standardweg, manueller Weg bleibt als Alternative. README: Provider-Tabelle (WhatsApp: „`perch whatsapp install`“), Onboarding. `THIRD_PARTY_NOTICES.md`: GOWA (MIT) wird zur Laufzeit heruntergeladen, nicht mitgeliefert.
