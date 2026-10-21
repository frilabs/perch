# Spezifikation: Slack-Session-Modus (ohne Admin) und Notion-Anleitung

Stand 2026-10-21. **Von Fritz freigegeben** („ja, baue den slack session-modus. Baue bei notion add auch eine Erklärung ein, wie man das bekommt“). Anlass: In den meisten Slack-Workspaces ist Fritz nicht Admin; Installationen brauchen dort eine Admin-Freigabe.

## 1. Slack-Session-Modus

- **Zweck:** Ein Workspace lässt sich ohne App-Installation verbinden, mit der Browser-Sitzung des Nutzers (Token `xoxc-…` + Cookie `d` = `xoxd-…`). Gleiche Slack-Web-API, gleiche Tools, gleiche Rechte wie die App (Lesen mit `slack_read`, Schreiben mit `slack_send`, Client-Grants unverändert).
- **Bewusstes Opt-in** wie bei WhatsApp: `perch slack add --label X --session` oder interaktiv vor der Token-Abfrage: „[a]pp (offiziell, braucht Installation/Admin-Freigabe) oder [s]ession (inoffiziell, ohne Admin)?“. Bei `s`: Warnung (inoffiziell, vermutlich gegen Slacks Bedingungen und ggf. Richtlinien der Organisation; Firmen-Workspaces können das erkennen und das Konto abmelden oder sperren; Token+Cookie sind so mächtig wie das Passwort; läuft ab beim Abmelden) und `[y/N]`; ohne Terminal nur mit `--yes`.
- **Geführte Schritte** (mit `--skip-guide` überspringbar): Workspace im Browser öffnen (`https://app.slack.com/client`), Entwicklerwerkzeuge öffnen (Chrome/Edge/Brave: Cmd+Opt+I, Safari: Entwickler-Menü vorher aktivieren, Firefox), **Cookie** `d` unter Application/Storage → Cookies → `https://app.slack.com` kopieren (Wert beginnt mit `xoxd-`), **Token** per Konsolen-Einzeiler ausgeben, der nur das `xoxc-`-Token des gerade offenen Workspaces druckt (aus `localStorage.localConfig_v2`; der Einzeiler wird von Perch angezeigt und ist kurz und lesbar). Beide Werte verdeckt einfügen.
- **Prüfung:** `auth.test` mit `Authorization: Bearer xoxc-…` und `Cookie: d=<Wert, URL-kodiert wie im Browser>`; ermittelt Team-Id, Team-Name, User. Unbekanntes Format/Fehler → klare Meldung, nichts gespeichert.
- **Speicherung:** im verschlüsselten Store am Slack-Workspace-Datensatz: `authMode: 'session'`, `token` (xoxc) und `sessionCookie` (xoxd); Schema abwärtskompatibel (`authMode` fehlt = `app`). Gleiche Team-Id erneut → Datensatz aktualisieren (gleiche Id, Grants bleiben), keine Dublette. Ein Workspace kann entweder App oder Session sein; Wechsel per erneutem `add`.
- **Upstream:** Für Session-Workspaces sendet Perch zusätzlich den Cookie-Header, nur an `slack.com` und `files.slack.com`, nur für die bestehende Endpunkt-Allowlist (keine neuen Endpunkte, keine Admin-/Lösch-Endpunkte). Cookie und Token erscheinen nie in Logs, Fehlern, Audit oder Status.
- **Scopes:** Session-Tokens melden keine `x-oauth-scopes`; Scope-Prüfungen (`provider_scope_missing`, Status-Hinweise auf Neuinstallation) gelten für Session-Workspaces nicht.
- **Ablauf/Fehler:** `invalid_auth`/`not_authed`/`token_revoked` bei Session → Meldung „Slack-Sitzung abgelaufen: `perch slack add --label X --session` erneut (aktualisiert denselben Workspace)“; Status zeigt den Workspace mit ✗ und diesem Befehl.
- **Status/Accounts:** Session-Workspaces tragen den Hinweis „session (unofficial)“; im Terminal-Status gelb.
- **Doku:** `SETUP.md` §4e (beide Wege, Risiken, Anleitung), README (Provider-Tabelle/Fähigkeiten), `PHASE1_REMAINING.md` (live zu prüfen: Bearer+Cookie bei allen genutzten Endpunkten inkl. `search.messages`, `files.slack.com`-Downloads mit Cookie, Enterprise-Grid, Lebensdauer der Sitzung, Rate-Limits).
- **Tests:** Mock-Slack um Session-Auth erweitern (Cookie Pflicht), Opt-in/Warnung/`--yes`, Validierung, Update gleicher Team-Id, Cookie nur an Slack-Hosts, nie in Ausgaben, abgelaufene Sitzung, Status-Hinweis, Grants unverändert.

## 2. Notion-Anleitung

- `perch notion add` zeigt vor der verdeckten Token-Abfrage die Schritte: `https://www.notion.so/profile/integrations` → *New integration* (Name `Perch`, Workspace, Typ *Internal*) → *Capabilities*: Read/Update/Insert content, Read/Insert comments → *Internal Integration Secret* (`ntn_…`) kopieren; Hinweis, dass Perch nur freigegebene Seiten sieht (••• → *Connections* → *Perch*, Unterseiten erben) und dass in Team-Workspaces oft nur Owner Integrationen anlegen dürfen.
- `--skip-guide`; ist schon ein Workspace verbunden, Rückfrage „Anleitung anzeigen? [y/N]“; ohne Terminal keine Anleitung (wie Slack).
- Nach erfolgreichem Verbinden: Anzahl sichtbarer Seiten (falls billig über die Suche ermittelbar) bzw. Hinweis „noch keine Seite freigegeben“.

## 3. Nebenbei

- Dev-Abhängigkeit `vite` (über vitest) auf eine Version ohne die gemeldete Lücke aktualisieren (`npm audit` muss danach 0 melden); Lizenzprüfung grün.
- Terminal-Ausgaben der neuen Anleitungen vor dem Abschluss in einem echten Pseudo-Terminal ansehen (z. B. `script`), auf saubere Einrückung und Umbrüche prüfen.

## 4. Nachtrag: Notion per OAuth (ohne Owner-Rechte)

Live gesehen: In Team-Workspaces dürfen Mitglieder oft keine *internen* Verbindungen (API-Token) anlegen, eine **OAuth-Verbindung** aber schon (Notion: „Du bist nicht berechtigt, interne Verbindungen zu erstellen“, OAuth wählbar). Daher:

- `perch notion add` fragt (oder Flag): „[t]oken (interne Verbindung) oder [o]auth (öffentliche Verbindung, auch ohne Owner-Rechte)?“.
- OAuth-Client einmal pro Installation, geführt wie bei Microsoft: `https://www.notion.so/profile/integrations` → Neue Verbindung → OAuth, „Installierbar in: Beliebigem Workspace“, **Umleitungs-URI `http://localhost:8769/notion/callback`** → Client-ID und Client-Secret kopieren → verdeckt einfügen; gespeichert `0600` in `~/.config/perch/notion-client.json` (`perch notion client setup|show`).
- Login über die bestehende Loopback-/Paste-Adresse-Mechanik (fester Port 8769, Pfad `/notion/callback`, `state`, `owner=user`), Token-Tausch `POST https://api.notion.com/v1/oauth/token` mit Basic-Auth (client_id:client_secret). Antwort liefert `access_token`, `workspace_id`, `workspace_name`, `bot_id`, ggf. `refresh_token`/`expires_in`: falls vorhanden, Refresh über denselben Endpunkt (`grant_type=refresh_token`) mit den bestehenden Garantien (Lock, Persistenz); sonst gilt der Token unbefristet.
- Ergebnis ist ein normaler Notion-Workspace-Datensatz (gleiche Tools, gleiche REST-Aufrufe), zusätzlich `authMode: 'oauth'`; gleiche `workspace_id` erneut → aktualisieren statt Dublette. Seiten wählt der Nutzer im Notion-Zustimmungsdialog aus.
- Upstream: nur der Token-Endpunkt kommt neu in die Allowlist (Tag `admin`/CLI-only).
- Live zu prüfen: akzeptiert Notion `http://localhost` als Umleitungs-URI; liefert der Token-Endpunkt einen Refresh-Token.
