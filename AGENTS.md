# Arbeitsregeln (Perch)

- Zuerst `docs/HANDOFF.md` lesen.
- Ohne Briefing und von Fritz freigegebene Spezifikation keinen Code schreiben.
- Keine Secrets, `.env`-Dateien oder personenbezogenen Daten committen. Variablen nur als Namen in `.env.example` dokumentieren.
- Auf Branches arbeiten, Änderungen per PR einbringen. Kein Merge, kein Deployment ohne Fritz' OK.
- Neue UI folgt dem frilabs-Brand-Standard (Repo `FritzKuermayr/frilabs-brand`).
- **Erst fertig, dann pushen (GitHub-Actions-Minuten):** Lokal so oft committen wie nötig, aber erst pushen, wenn eine Änderung fertig ist und lokal geprüft wurde (`npm run check`). Kein Push pro Zwischenstand und kein „Push, um zu sehen, ob die CI grün wird“. Jeder Push startet CI-Läufe; das Repo ist privat und hat nur 2.000 Gratis-Minuten pro Monat (am 2026-10-15 aufgebraucht). Startet die CI wegen Billing nicht, gilt der lokale `npm run check` als Nachweis; das im PR vermerken.
