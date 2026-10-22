# Spezifikation: LinkedIn- und X-Connectoren (Posten aufs eigene Profil)

Stand 2026-10-21. **Von Fritz freigegeben** („hebe auf und baue, sowohl LI als auch x“). Damit ist der bisherige Ausschluss „LinkedIn is out of scope“ (README, `PHASE1_REMAINING.md`) **aufgehoben**. Auftrag ursprünglich aus friagent formuliert; Ziel: Clients (friagent, Claude Code, Codex) posten über Perch auf das eigene LinkedIn-Profil und den eigenen X-Account. Perch hält die Zugangsdaten verschlüsselt; Clients sehen sie nie.

## Gemeinsame Regeln (wie Slack/WhatsApp/Luma)

- Lesen standardmäßig, Posten nur per Client-Grant; Write-Tools für den globalen Read-only-Token **nicht gelistet**.
- **Nie doppelt posten:** gemeinsamer requestId-Ledger (`src/messaging/send.ts`, wie Mail/Slack). Nur eine eindeutige Ablehnung (HTTP 4xx) = `rejected` (nicht gepostet); Timeout, Netzfehler, 5xx = `indeterminate`, nie automatisch wiederholen. `linkedin_post_status` / `x_post_status { requestId }` zeigen den Stand.
- Fehler und Audit **ohne** Tokens oder Post-Texte (body-free).
- Login über die bestehende Loopback-/Paste-Adresse-Mechanik (`src/oauth/loopback.ts`, `src/cli/loginPrompt.ts`), `state` geprüft, PKCE wo der Anbieter es unterstützt. Client-Daten geführt und verdeckt abgefragt, gespeichert `0600` unter `~/.config/perch/` (wie Google/Notion/Microsoft), mit `perch <dienst> client setup|show`.
- Neue Hosts nur exakt (`api.linkedin.com`, `www.linkedin.com` für OAuth, `api.x.com`/`x.com`/`twitter.com`-OAuth-Endpunkte) mit eigenen Capability-Tags in der Upstream-Allowlist; nur die benötigten Endpunkte.
- `perch status` (Terminal/plain/json), `perch_list_accounts`, `perch setup` (beide als optionale Schritte mit Anleitung), README und `SETUP.md` (Schritt für Schritt: App anlegen, Werte, `perch … add`, Grant).
- Tests mit Mock-HTTP nach bestehendem Muster; Terminal-Texte im echten Pseudo-Terminal prüfen.

## LinkedIn

- `perch linkedin add --label NAME`: OAuth 2.0 (3-legged) mit der LinkedIn-App des Betreibers. Produkte „Sign In with LinkedIn using OpenID Connect“ und „Share on LinkedIn“; Scopes `openid profile w_member_social`. Die App braucht eine LinkedIn-Unternehmensseite als Zuordnung (Anleitung erwähnt das). Redirect-URL fest: `http://localhost:8770/linkedin/callback` (in der App einzutragen).
- Client-ID und Client-Secret (verdeckt) → `~/.config/perch/linkedin-client.json`.
- Person-URN über `GET https://api.linkedin.com/v2/userinfo` (`sub` → `urn:li:person:<sub>`), Name für Label/Status.
- Access Token gilt 60 Tage, normalerweise kein Refresh Token: Ablaufdatum speichern; `perch status` zeigt „verbunden bis …“ und ab 7 Tagen vorher einen gelben Hinweis mit `perch linkedin add --label …` (aktualisiert dasselbe Konto, gleiche Id, gleiche URN); abgelaufen → ✗. Tools liefern bei abgelaufenem Login (oder 401) einen klaren Fehler mit diesem Befehl. Liefert LinkedIn doch ein Refresh Token, wird es wie bei anderen Anbietern genutzt.
- Tool `linkedin_post { accountId, text, requestId }` → `POST https://api.linkedin.com/rest/posts` mit `Linkedin-Version` (konfigurierbar per `PERCH_LINKEDIN_VERSION`, Standard eine aktuelle Monatsversion im Format `YYYYMM`), `X-Restli-Protocol-Version: 2.0.0`, `author` = Person-URN, `visibility: PUBLIC`, `distribution: { feedDistribution: MAIN_FEED }`, `lifecycleState: PUBLISHED`. Text im „little text“-Format escapen (`\ | { } @ [ ] ( ) < > # * _ ~`), höchstens 3000 Zeichen (vor dem Escapen gezählt, klare Ablehnung darüber). Rückgabe: Post-ID aus `x-restli-id`, URL `https://www.linkedin.com/feed/update/<id>/`.
- Tool `linkedin_status { accountId }` (Name, verbunden bis) mit `linkedin_read`.
- Capabilities `linkedin_read`, `linkedin_post` (neue Familie `linkedin-…`); `--full` deckt sie ab; `perch client add --allow linkedin_read,linkedin_post --account linkedin-…`.

## X

- **Entscheidung: OAuth 2.0 Authorization Code mit PKCE** (Scopes `tweet.read tweet.write users.read offline.access`). Begründung: passt zum bestehenden Paste-URL-Login, liefert Refresh Tokens (Zugriff bleibt ohne Neu-Login bestehen), granulare Scopes, keine vier statischen Schlüssel im Store; OAuth 1.0a wird nicht gebaut.
- `perch x add --label NAME`: X-Developer-App des Betreibers (Typ „Native App“/öffentlicher Client, falls X ein Secret verlangt: „Web App“ mit Secret, beides unterstützen), Redirect fest `http://127.0.0.1:8771/x/callback`; Client-Daten → `~/.config/perch/x-client.json`. Nutzer über `GET /2/users/me` (Id, `@username`).
- Refresh wie bei anderen Anbietern (`RefreshingTokenProvider`, Rotation gespeichert, `invalid_grant` → Neu-Verbinden-Hinweis).
- Tool `x_post { accountId, text, requestId }` → `POST https://api.x.com/2/tweets` `{ text }`. Länge vorher prüfen: höchstens 280 gewichtete Zeichen, URLs zählen 23 (vereinfachte twitter-text-Gewichtung: CJK/Emoji doppelt; dokumentieren, dass Grenzfälle X entscheidet). Rückgabe: Id und `https://x.com/i/status/<id>`.
- Tool `x_status { accountId }` mit `x_read`. Capabilities `x_read`, `x_post` (Familie `x-…`).
- Doku-Hinweis: Die X-API ist kostenpflichtig (pay-per-use, ca. 1,5 ct pro Post, mit Link ca. 20 ct laut Stand des Auftrags; aktuelle Preise bei X prüfen) und braucht Guthaben im Developer-Konto.

## Nicht Teil dieser Spec

Lesen fremder Feeds/Timelines, Bilder/Videos, Kommentare, Löschen von Posts, Unternehmensseiten-Posts.
