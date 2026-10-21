# Spezifikation: Microsoft/Outlook ohne eigene App-Registrierung (frilabs-App als Standard)

Stand 2026-10-21. **Von Fritz freigegeben** („mit google, slack und notion bin ich zufrieden. Nur microsoft gehört gefixed“). Anlass (Live-Onboarding): Mit einem privaten Microsoft-Konto lässt das Entra-Portal keine App-Registrierung zu (kein Mandant); im Firmenmandanten (projectaccess.org) dürfen Nutzer das Portal nicht öffnen. Damit war Outlook für Fritz nicht verbindbar.

## Ziel

`perch microsoft add` funktioniert ohne eigene Registrierung: Perch liefert die Client-ID einer von frilabs registrierten Multi-Tenant-App (öffentlicher Client, **kein Secret**) als Standard mit. Wo eine Organisation den Mailzugriff fremder Apps sperrt, hilft Perch mit einem Admin-Freigabe-Link.

## Einmalig durch Fritz (nicht automatisierbar)

1. Microsoft-Mandant für frilabs anlegen (kostenloses Azure-Konto mit einem frilabs-Microsoft-Konto, z. B. fritz@frilabs.dev); optional Domain `frilabs.dev` per DNS-TXT verifizieren.
2. App-Registrierung „Perch“: Kontotypen „beliebiges Organisationsverzeichnis und persönliche Microsoft-Konten“; Plattform „Mobile und Desktop“ mit Redirect `http://localhost`; „Öffentliche Clientflows zulassen“ = Ja; keine Secrets/Zertifikate; delegierte Berechtigungen `User.Read`, `Mail.Read`, `Mail.ReadWrite`, `Mail.Send` (`offline_access` implizit); Branding: Name „Perch“, Startseite `https://frilabs.dev`, Datenschutz/Nutzungsbedingungen-URLs von frilabs.dev.
3. Client-ID an Claude geben (nicht geheim).
4. Später optional: Herausgeberverifizierung (Microsoft AI Cloud Partner Program + verifizierte Domain), damit „verifiziert“ statt „nicht verifiziert“ erscheint und mehr Organisationen die Nutzerzustimmung erlauben.

## Perch

- **Client-ID-Reihenfolge:** `PERCH_MICROSOFT_CLIENT_ID` > `~/.config/perch/microsoft-client-id` > **eingebaute frilabs-ID** (Konstante im Code; solange leer, verhält sich Perch wie heute mit geführter Registrierung). `perch microsoft client show` nennt die Quelle („frilabs default“). `perch microsoft client setup` bleibt für eigene Apps.
- **Ohne eigene App keine Anleitung:** Mit der eingebauten ID startet `perch microsoft add` direkt den Login (Lesen/Schreiben-Frage bleibt). Der Login-Text erklärt, dass die App „Perch (frilabs)“ heißt.
- **Fehler verständlich machen:** Microsoft-Fehlercodes aus Callback/Token-Antwort (`error_description` mit `AADSTS…`) werden auf klare Meldungen abgebildet, mindestens:
  - `AADSTS65001`, `AADSTS90094`, `AADSTS90095`, `consent_required`/„admin approval“: Die Organisation verlangt eine Admin-Freigabe → Perch gibt den **Admin-Freigabe-Link** aus und einen kurzen Text zum Weiterleiten.
  - `AADSTS50020`: Konto gehört nicht zum gewählten Mandanten → Hinweis auf `PERCH_MICROSOFT_TENANT=common` bzw. anderes Konto.
  - `AADSTS700016`: App-ID im Mandanten unbekannt (falsche/gelöschte eigene ID) → `perch microsoft client show/setup`.
  - `AADSTS50011`: Redirect passt nicht → Hinweis auf `http://localhost` als Plattform „Mobile und Desktop“.
  - `AADSTS53003` (Conditional Access): Organisation blockiert den Zugriff; nur Admin kann helfen.
- **Admin-Freigabe-Link:** `perch microsoft admin-consent-link [--tenant DOMAIN|GUID]` erzeugt `https://login.microsoftonline.com/<tenant>/v2.0/adminconsent?client_id=<id>&scope=<Graph-Scopes>&redirect_uri=http://localhost` (Standard-Tenant `organizations`; mit `--tenant` der Mandant der Firma, z. B. aus der E-Mail-Domain) plus einen Textbaustein (Was ist Perch, welche Rechte, selbst gehostet, frilabs sieht keine Daten). Derselbe Link wird bei den Freigabe-Fehlern automatisch angezeigt.
- **Doku:** README-Provider-Tabelle (Outlook: „nichts vorab, außer die Organisation verlangt Admin-Freigabe“), `SETUP.md` §4a, `PHASE1_REMAINING.md` (live zu prüfen: Login mit privatem Konto und mit projectaccess.org über die frilabs-App, Verhalten bei gesperrter Nutzerzustimmung, Admin-Freigabe-Link).
- **Tests:** Reihenfolge der Quellen, eingebaute ID ohne Anleitung, Fehlerabbildung pro Code (ohne Code/Token im Text), Admin-Link-Format (URL-Kodierung, Tenant), keine Secrets.
