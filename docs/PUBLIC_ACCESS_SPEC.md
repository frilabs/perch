# Spezifikation (Entwurf): Öffentlicher Zugang über MCP-OAuth

Stand 2026-10-14. **Status: Entwurf mit Fritz' Entscheidungen vom 2026-10-14, Freigabe steht aus.** Briefing und Entscheidungstabelle: `docs/PUBLIC_ACCESS_BRIEFING.md`. Werte in *kursiv* sind Vorschläge, die mit der Freigabe bestätigt werden. Verbleibende offene Punkte stehen in §12.

„Betreiber“ ist die Person, die Perch installiert hat (Root-Namespace). Es gibt genau einen Betreiber pro Installation.

## 0. Sicherheitsziel

Ein Angreifer aus dem Internet soll für **jede** Antwort von `/mcp` mindestens so viel überwinden müssen wie heute (Tailnet-Gerät plus Token). Konkret muss er alle drei Bedingungen erfüllen:

1. ein gültiges, an diese Perch-Installation gebundenes Access-Token,
2. das nur ein **vom Betreiber lokal freigegebener** Client bekommt,
3. und nur nach einer Anmeldung mit **Google-Konto aus der Allowlist und gültigem Perch-Code (TOTP)**: zwei unabhängige Faktoren, beide von Perch selbst geprüft.

Verglichen mit heute ersetzen 2 und 3 die Tailnet-Schicht, und 1 ersetzt das statische Token. Neu ist eine Angriffsfläche **vor** der Anmeldung (OAuth-Endpunkte, Anmeldeseiten, HTTP-Parser), die öffentlich erreichbar ist. §9 begrenzt sie.

**Bekannte Restschwäche:** TOTP ist nicht phishing-resistent. Eine gefälschte Perch-Seite könnte Google-Login und Code in Echtzeit weiterreichen. Dagegen helfen: die Geräte-Freigabe lokal (eine solche Anmeldung erscheint als neues Gerät und muss bestätigt werden), der deutlich angezeigte Redirect-Host und die Benachrichtigung. Passkeys sind auf Fritz' Entscheidung hin nicht im Umfang.

## 1. Architektur

```
claude.ai / Claude Code / Codex ──HTTPS──▶ TLS-Proxy (Standard: Tailscale Funnel :443)
                                                 │
                                  perch serve --http --public
                                                 │
            ┌────────────────────────────────────┴───────────────────────────┐
  öffentlicher Listener 127.0.0.1:8767                    lokaler Listener 127.0.0.1:8765 (wie heute)
  nur: /mcp, /.well-known/*, /oauth/*                     /mcp, /status, /local/* (Freigabe, TOTP-Einrichtung)
            │                                                         ▲
            └── gemeinsamer PerchContext (nur Root) ──────────────────┘  erreichbar per SSH-Tunnel
                                                                        oder optional Tailscale Serve :8443
```

- **Zwei Listener in einem Prozess.** Der öffentliche Listener hat eine eigene, feste Routing-Tabelle. Unbekannte Pfade bekommen `404`, ohne Authentifizierung zu versuchen. `/status` und `/local/*` existieren dort nicht, unabhängig davon, wie der Proxy konfiguriert ist (Verteidigung in der Tiefe).
- Beide Listener binden nur auf Loopback bzw. eine Tailscale-Adresse (`validateBindHost` wie heute). Öffentlich wird der öffentliche Listener ausschließlich über den TLS-Proxy.
- **Öffentliche Adresse:**
  - *Standard (dokumentiert):* Tailscale Funnel auf Port 443 → `127.0.0.1:8767`. Die Connector-URL hat damit keinen Port.
  - Wer Tailscale zusätzlich privat nutzt, legt den lokalen Listener per Tailscale Serve auf 8443. Funnel gilt pro Port, ein Port ist entweder ganz öffentlich oder ganz privat.
  - Ohne Tailscale: ein beliebiger TLS-Reverse-Proxy mit eigener Domain (z. B. Caddy, Cloudflare Tunnel), der **nur** auf `127.0.0.1:8767` weiterleitet. Der lokale Listener ist dann nur per SSH-Tunnel erreichbar. Diese Varianten sind dokumentiert, aber nicht getestet.
- Der lokale Listener bleibt unverändert, einschließlich der heutigen statischen Tokens. Neu sind die Seiten unter `/local/*`, die nur dort existieren.
- **Perch ist selbst der Authorization Server** (Issuer = öffentliche Basis-URL). Google dient nur als vorgeschalteter Identitätsnachweis. Google-Tokens gehen nie an MCP-Clients, und MCP-Tokens nie an Google (kein Token-Passthrough).
- **Nur Root.** Der öffentliche Zugang bedient ausschließlich den Root-Namespace. Tokens admin-angelegter Nutzer werden am öffentlichen Listener abgelehnt.

## 2. Konfiguration (neue Umgebungsvariablen)

| Variable | Default | Zweck |
| --- | --- | --- |
| `PERCH_PUBLIC_BASE_URL` | – | z. B. `https://homeserver.tailnet-xyz.ts.net`. Ohne sie startet kein öffentlicher Listener. Muss `https://` sein, ohne Pfad, Query oder Fragment. |
| `PERCH_PUBLIC_PORT` | *`8767`* | Loopback-Port des öffentlichen Listeners |
| `PERCH_GOOGLE_LOGIN_CLIENT_FILE` | – | JSON eines Google-OAuth-Clients vom Typ **Web application**, den der Betreiber selbst anlegt (getrennt vom Desktop-Client für Konten). Redirect: `<BASE>/oauth/google/callback`. Nur die Scopes `openid email`. |
| `PERCH_OAUTH_DCR` | *`on`* | Dynamic Client Registration (§4); `off` schaltet sie ab |
| `PERCH_NOTIFY_TELEGRAM_FILE` | – | optional: Datei (`0600`) mit Bot-Token und Chat-ID für Hinweise (§8). Ohne sie gibt es keine Benachrichtigung. |

Die Google-Allowlist, das TOTP-Geheimnis und die Geräteliste liegen nicht in Umgebungsvariablen, sondern verschlüsselt und werden per CLI gepflegt (§10).

## 3. Discovery und Endpunkte (öffentlicher Listener)

| Pfad | Methode | Inhalt |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` und `/.well-known/oauth-protected-resource/mcp` | GET | RFC 9728: `resource` = `<BASE>/mcp` (exakt), `authorization_servers` = `[<BASE>]`, `scopes_supported` = `["perch.read"]`. Schreibrechte werden nie über Scopes vergeben (§7). |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `registration_endpoint` (nur wenn DCR an), `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `response_types_supported: ["code"]`, `scopes_supported: ["perch.read","offline_access"]` |
| `/oauth/register` | POST | DCR nach RFC 7591, nur wenn `PERCH_OAUTH_DCR=on` (§4) |
| `/oauth/authorize` | GET | Start: Parameter prüfen, Client auflösen, Anmeldung beginnen |
| `/oauth/google/callback` | GET | Rückkehr von Google |
| `/oauth/totp` | GET/POST | Abfrage des Perch-Codes |
| `/oauth/consent` | POST | Zustimmung; danach Redirect mit `code` |
| `/oauth/token` | POST | `application/x-www-form-urlencoded`; Code-Tausch und Refresh |
| `/oauth/revoke` | POST | RFC 7009 |
| `/mcp` | POST | wie heute, aber nur mit OAuth-Access-Token. Die statischen Tokens werden hier **abgelehnt**. |

- **Ohne oder mit ungültigem Token** antwortet `/mcp` mit `401` und `WWW-Authenticate: Bearer resource_metadata="<BASE>/.well-known/oauth-protected-resource", scope="perch.read"`. Bei abgelaufenem Token kommt zusätzlich `error="invalid_token"`.
- Tokens nur im `Authorization`-Header, nie in Query-Parametern.
- Die Endpunkte antworten schnell (claude.ai wartet höchstens 10 s, beim Refresh 30 s). Upstream-Aufrufe an Google nur im interaktiven Login, nie im Token-Endpunkt.

## 4. Client-Registrierung

Drei Wege. Alle führen zu einem Eintrag in der Geräteliste, und **keiner** bringt ohne lokale Freigabe (§6, Schritt 5) ein Token.

1. **Client ID Metadata Document (CIMD)** für Claude (claude.ai, Desktop, Mobile, Cowork, Claude Code):
   - `client_id` ist eine HTTPS-URL und muss **exakt** in einer festen, im Code hinterlegten Allowlist stehen: `https://claude.ai/oauth/claude-code-client-metadata` plus die CIMD-URL der gehosteten Claude-Apps (vor der Umsetzung ermitteln). Weitere URLs kann der Betreiber per CLI hinzufügen. Andere `client_id`-URLs scheitern vor jedem Netzwerkzugriff, damit es kein SSRF über beliebige Metadaten-URLs gibt.
   - Abruf mit festen Grenzen: 64 KiB, 5 s Timeout, keine Redirects, nur `https`, Cache *1 h*. `client_id` im Dokument muss der URL entsprechen.
2. **Dynamic Client Registration (RFC 7591)** für Clients ohne Metadaten-Dokument (z. B. Codex), abschaltbar:
   - Die Registrierung ist **wirkungslos**, bis der Betreiber das Gerät lokal freigibt. Sie erzeugt nur einen Eintrag `registered` mit Perch-generierter `client_id` (`dcr-<16 hex>`), ohne Secret (öffentlicher Client, `token_endpoint_auth_method: none`).
   - Strikte Prüfung: JSON höchstens *16 KiB*, höchstens *5* `redirect_uris`, jede entweder `https://…` ohne Fragment oder Loopback (`http://127.0.0.1`, `http://[::1]`, `http://localhost`, beliebiger Port). `client_name` gekürzt und für die Anzeige maskiert. Unbekannte Felder werden verworfen, `logo_uri`, `jwks_uri` und alle anderen URLs werden nie abgerufen.
   - Limits: höchstens *10* nicht freigegebene Registrierungen gleichzeitig (darüber `429`), Verfall nach *1 h* ohne Freigabe, *5* Registrierungen pro Minute insgesamt.
3. **Vorregistrierung per CLI**: `perch oauth client add --name … --redirect …` für Clients, die eine feste `client_id` erwarten.

**Redirect-URIs** gelten nur, wenn sie exakt registriert bzw. im CIMD-Dokument stehen. Loopback wird portunabhängig verglichen (RFC 8252 §7.3), auch für `localhost`, weil Claude Code es so deklariert. Für die gehosteten Claude-Apps gilt `https://claude.ai/api/mcp/auth_callback` (bei Bedarf zusätzlich `https://claude.com/api/mcp/auth_callback`).

Die Zustimmungsseite zeigt Client-Name, **Registrierungsweg** (CIMD-URL bzw. „selbst registriert“) und den Hostnamen der Redirect-URI deutlich. Bei reinen Loopback-Redirects warnt sie zusätzlich („ein lokales Programm auf diesem Rechner erhält Zugriff“).

## 5. Perch-Code (TOTP) und Google-Prüfung

**TOTP (RFC 6238), selbst gebaut mit `node:crypto`:**

- Geheimnis 160 Bit zufällig, HMAC-SHA1, 6 Ziffern, 30 s. Das sind die Werte, die alle gängigen Authenticator-Apps unterstützen. Gespeichert verschlüsselt in `oauth.enc` (§7).
- Toleranz höchstens ±1 Zeitfenster. Jeder Zeitschritt wird nur **einmal** akzeptiert (der zuletzt benutzte Zähler wird gespeichert), damit ein mitgelesener Code nicht nochmal gilt.
- Vergleich in konstanter Zeit. Die RFC-6238-Testvektoren sind Teil der Tests.
- **Einrichtung nur lokal:** `perch oauth totp setup` erzeugt das Geheimnis, zeigt die `otpauth://`-URI als **QR-Code im Terminal** (eigener minimaler QR-Encoder: Byte-Modus, Fehlerkorrektur M, nur die nötigen Versionen, mit Referenz-Testvektoren) und zusätzlich das Base32-Geheimnis zum Abtippen. Aktiv wird es erst nach Eingabe eines gültigen Codes. Alternativ zeigt die Seite `/local/totp` auf dem lokalen Listener denselben QR-Code.
- **Notfall-Codes:** *10* Codes zu je *10* Zeichen (Base32), einmal anzeigen, nur als Hash speichern (SHA-256 mit Salt), jeder Code einmal verwendbar. Neu erzeugen macht die alten ungültig.
- Ein Wechsel des Geheimnisses (`setup` erneut) macht alle bestehenden OAuth-Token-Familien ungültig.

**Google-ID-Token, ohne JWT-Bibliothek:**

- Perch holt das ID-Token im Authorization-Code-Flow mit PKCE **direkt** vom festen Google-Token-Endpunkt (`https://oauth2.googleapis.com/token`, TLS-geprüft). Nach OpenID Connect Core §3.1.3.7 darf der Client in diesem Fall die TLS-Prüfung des Servers statt der Token-Signatur zur Prüfung des Ausstellers verwenden. Perch prüft die Signatur deshalb **nicht** und braucht keinen JWKS-Abruf.
- Das ID-Token wird nur aus genau dieser Antwort akzeptiert, nie aus einem Redirect, Query-Parameter oder Formular.
- Geprüft werden: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud` = eigene Client-ID (bei mehreren Werten zusätzlich `azp`), `exp` in der Zukunft, `iat` nicht älter als *10 min*, `nonce` = gespeicherte Nonce, `email_verified` = true, und `sub`+E-Mail aus der Allowlist.
- Ob Googles aktuelle Doku diese Abkürzung ebenfalls zulässt, wird vor der Umsetzung an der Primärquelle geprüft (§12).

## 6. Anmeldung und Geräte-Freigabe

Ablauf von `/oauth/authorize`. Alle Zwischenzustände liegen serverseitig, sind an ein zufälliges, `HttpOnly`/`Secure`/`SameSite=Lax`-Cookie gebunden, leben *10 min* und sind einmal verwendbar.

1. **Parameter prüfen:** `response_type=code`, `client_id` bekannt (§4), `redirect_uri` erlaubt, `code_challenge` mit `S256` (Pflicht), `resource` = `<BASE>/mcp` (RFC 8707). Fehlt `resource`, wird es so behandelt; ein abweichender Wert wird abgelehnt. `state` wird unverändert durchgereicht. Fehler vor einer gültigen `redirect_uri` erscheinen als Seite, nie als Redirect.
2. **Google (OIDC Authorization Code + PKCE + `nonce` + `state`):** Prüfung wie in §5. Zugelassen ist nur ein Paar `sub`+E-Mail aus der Allowlist. Beim ersten erfolgreichen Login wird der `sub` angeheftet; danach zählt `sub`. Eine geänderte E-Mail bei gleichem `sub` führt zur Ablehnung mit Hinweis.
3. **Perch-Code:** Eingabe eines TOTP-Codes oder Notfall-Codes (§5). Ohne eingerichtetes TOTP ist der öffentliche Zugang gesperrt (`503` mit Hinweis auf `perch oauth totp setup`).
4. **Geräteliste:** Hat der Client noch keinen freigegebenen Eintrag, entsteht ein Eintrag `pending` (ID `oc-<16 hex>`, Name, Registrierungsweg, Redirect-Host, Zeit, User-Agent). Ist ein Telegram-Kanal eingerichtet, kommt ein Hinweis mit der ID (§8).
5. **Lokale Freigabe:** Die Seite wartet höchstens *10 min* und fragt dabei den Status ab. Freigegeben wird nur lokal: `perch oauth approve <id>` oder der Knopf auf `/local/devices`. Telegram kann **nicht** freigeben.
6. **Zustimmung:** Die Seite zeigt Client, Registrierungsweg, Redirect-Host und Rechte (alles lesen; vorhandene Schreib-Grants dieses Geräts einzeln). Danach Redirect mit `code` (*60 s*, einmal verwendbar, an `client_id`, `redirect_uri`, PKCE und `resource` gebunden).

Freigegebene Geräte durchlaufen bei einer neuen Anmeldung (z. B. nach Ablauf) die Schritte 1–3 und 6, nicht 4–5. Jeder Zweig, der nicht ausdrücklich erfolgreich ist, endet ohne Code (fail closed).

## 7. Tokens, Rechte und Speicherung

- **Access-Token:** opak, 256 Bit, *1 h*. Gespeichert wird nur der SHA-256-Hash. Gebunden an das Gerät, `resource` und eine Token-Familie.
- **Refresh-Token:** opak, 256 Bit, rotiert bei **jeder** Nutzung. Die Antwort enthält das neue Token und entwertet das alte. Leerlauf-Ablauf *14 Tage*, absolute Grenze *90 Tage*, danach neue Anmeldung (mit Perch-Code).
- **Wiederverwendung erkannt** (ein bereits rotiertes Refresh-Token taucht erneut auf): Die ganze Familie wird gesperrt, Antwort `invalid_grant`, Audit-Eintrag und Hinweis „mögliches kopiertes Token“.
- **Widerruf** eines Geräts sperrt alle seine Familien sofort. Jeder `/mcp`-Request prüft Token, Familie und Gerät neu, so wie heute die Grant-Revalidierung vor jedem Tool-Aufruf.
- **Speicher:** eigene verschlüsselte Datei `oauth.enc` im Root-Namespace, mit HKDF-Unterschlüssel des Store-Schlüssels, eigenem AAD und eigenem Lock `oauth.lock`, nach dem Muster von `mail-workflow.enc`. Inhalt: Google-Allowlist samt `sub`, TOTP-Geheimnis und letzter Zähler, Notfall-Code-Hashes, Geräte, Token-Familien, Sperrzustand. Häufige Refreshes konkurrieren so nicht mit dem Store-Lock, und das Store-Schema bleibt v1. Feste Obergrenzen (*50 Geräte, 500 aktive Familien*), fail closed bei Beschädigung, nie automatisch zurückgesetzt.
- **Rechte (Principal):** neue Art `oauth_client`.
  - Standard: dieselben Leserechte wie `READONLY_PRINCIPAL` (Drive, Notion, Mail, Kalender, Kontakte, Slack, WhatsApp; alle Konten).
  - Schreiben nur über einen ausdrücklichen Grant pro Gerät und Konto: `perch oauth grant <oc-id> --capabilities send,calendar_write --accounts …`. Es gelten dieselben Familien- und Capability-Regeln wie bei `perch client add` (`src/auth/grants.ts`), mit Revalidierung vor jedem Tool-Aufruf.
  - Scopes vergeben **nie** Schreibrechte. Ein Client kann sich Schreiben also nicht „erbitten“.

## 8. Audit und Benachrichtigung

- Jede Anmeldung (Erfolg und Fehlschlag mit Grund), jede Registrierung, Freigabe, Ablehnung und jeder Widerruf, jede erkannte Wiederverwendung, jede TOTP-Änderung und jeder Notschalter wird ohne Inhalte im bestehenden Audit-Ledger protokolliert. Neue Felder: Geräte-ID, Ereignis, Herkunft (§9). Tokens, Codes, TOTP-Geheimnis und Google-Tokens nie.
- `perch audit list` zeigt die Ereignisse.
- **Benachrichtigung, optional:** Kanal-Schnittstelle in Perch mit genau einer ersten Umsetzung, dem **Telegram-Bot direkt** (`https://api.telegram.org`, neue feste Upstream-Origin, Bot-Token aus `PERCH_NOTIFY_TELEGRAM_FILE`). Nur Hinweise, keine Knöpfe und keine Befehle zurück. Anlässe: neues Gerät wartet auf Freigabe, Anmeldung eines neuen Geräts oder User-Agents, erkannte Wiederverwendung, Sperre nach Fehlversuchen, TOTP-Änderung, Notschalter. Die Nachrichten enthalten keine Tokens, Codes oder Inhalte. Fällt der Kanal aus, läuft die Anmeldung trotzdem (die lokale Freigabe bleibt ja Pflicht), und der Fehler wird protokolliert.

## 9. Härtung des öffentlichen Listeners

- **Herkunft:** Ob Funnel bzw. der Proxy die Client-IP verlässlich weitergibt (etwa als `X-Forwarded-For`), ist **nicht verifiziert**. Der Header wird nur ausgewertet, wenn `PERCH_PUBLIC_TRUST_FORWARDED=1` gesetzt ist und der Request von Loopback kommt. Sonst gelten die Limits global, und „neues Gerät“ wird über Gerät und User-Agent erkannt.
- **Rate-Limits** (*Token-Bucket*): Anmeldeseiten und `/oauth/authorize` *10/min*, `/oauth/register` *5/min*, `/oauth/token` *30/min*, `/mcp` *120/min* pro Gerät, alles zusammen *300/min*. Bei Überschreitung `429` mit `Retry-After`.
- **Sperren:** *5* falsche Perch-Codes in *15 min* sperren die Code-Abfrage für *15 min* (bei Wiederholung verdoppelt) und lösen einen Hinweis aus. *20* ungültige Bearer-Tokens pro Minute schalten `/mcp` für *5 min* auf `401`, ohne Zugriff auf den Speicher.
- **Anfragegrößen:** OAuth-Endpunkte *16 KiB*, `/mcp` wie heute. `headersTimeout` und `requestTimeout` kurz setzen.
- **Seiten:** serverseitig gerendert, ohne JavaScript (die Statusabfrage in Schritt 5 per `<meta http-equiv="refresh">`). CSP `default-src 'none'; style-src` per Hash, `form-action 'self'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Formulare per `POST` mit CSRF-Token, das an den Zwischenzustand gebunden ist. Gestaltung nach frilabs-Brand-Standard (`AGENTS.md`).
- **Host/Origin:** Nur der Host aus `<BASE>` wird angenommen. Für `/mcp` gilt die bestehende Origin-Regel.

## 10. CLI

| Befehl | Wirkung |
| --- | --- |
| `perch public setup` | geführte Einrichtung: Basis-URL prüfen, Google-Web-Client einlesen, Allowlist, TOTP mit QR, Notfall-Codes, optional Telegram. Gibt den passenden Funnel- bzw. Proxy-Befehl aus, ohne ihn auszuführen. |
| `perch oauth login-allow add <email>` / `list` / `remove` | Google-Allowlist; beim ersten Login wird der `sub` angeheftet |
| `perch oauth totp setup` / `status` / `recovery-codes` | Perch-Code einrichten bzw. wechseln, Status, Notfall-Codes neu erzeugen |
| `perch oauth client add` / `list` / `remove` | vorregistrierte Clients und zusätzliche CIMD-URLs (§4) |
| `perch oauth devices` | Geräteliste: ID, Name, Registrierungsweg, Redirect-Host, Status, erstellt, zuletzt gesehen, Grants |
| `perch oauth approve <id>` / `reject <id>` / `revoke <id>` | Freigabe bzw. Widerruf |
| `perch oauth grant <id> --capabilities … --accounts …` / `ungrant` | Schreibrechte pro Gerät |
| `perch public off` | **Notschalter:** setzt einen dauerhaften Sperr-Marker (der öffentliche Listener beantwortet danach alles mit `503`, auch nach einem Neustart), widerruft alle Token-Familien und Geräte-Freigaben und protokolliert das. Gibt den Befehl zum Abschalten von Funnel bzw. Proxy aus; Perch ändert Tailscale nicht selbst. |
| `perch public on` | hebt den Marker auf; Geräte müssen danach neu freigegeben werden |

Alle Befehle laufen nur lokal und nur im Root-Modus (nicht mit `PERCH_USER`). `perch status` und die Statusseite zeigen zusätzlich: öffentlicher Zugang an/aus/gesperrt, TOTP eingerichtet, Anzahl freigegebener Geräte, letzte Anmeldung.

## 11. Keine neuen Abhängigkeiten

Auf Fritz' Entscheidung wird alles mit Node-Bordmitteln gebaut: TOTP, Base32, QR-Encoder, Cookie- und Formular-Verarbeitung, Prüfung des Google-ID-Tokens (§5, ohne Signaturprüfung, daher ohne JWT-Bibliothek). `package.json` und Lockfile bekommen keine neuen Produktionsabhängigkeiten. Für jeden selbst gebauten Baustein gibt es Tests gegen Referenzwerte: RFC-6238-Vektoren, RFC-4648-Base32-Vektoren und QR-Referenzmatrizen.

## 12. Akzeptanzkriterien (Tests nur mit Mocks)

1. Der öffentliche Listener beantwortet `/status`, `/local/*`, `/` und jeden unbekannten Pfad mit `404`, auch mit gültigem Token.
2. Das globale Token, Nutzer-Tokens und Client-Grant-Tokens werden am öffentlichen `/mcp` mit `401` abgelehnt.
3. Discovery-Dokumente entsprechen §3; jeder `401` trägt `resource_metadata`.
4. Ohne PKCE-S256, mit falschem `resource`, unbekannter `client_id` oder nicht erlaubter `redirect_uri` gibt es keinen Code. Eine nicht gelistete CIMD-URL löst keinen Netzwerkzugriff aus.
5. DCR: Eine Registrierung allein bringt nie ein Token. Limits und Verfall wie in §4. Mit `PERCH_OAUTH_DCR=off` gibt es `404`, und das Feld fehlt in den Metadaten.
6. Google-Konto außerhalb der Allowlist, falscher `sub`, falsches `iss`/`aud`/`nonce`, abgelaufenes Token, `email_verified=false`: kein Code.
7. Ohne gültigen Perch-Code und ohne lokale Freigabe: kein Code. Ein bereits benutzter Code und ein Code außerhalb von ±1 Fenster werden abgelehnt. Ein Notfall-Code gilt genau einmal.
8. Ein Code ist nur einmal verwendbar und nach *60 s* ungültig.
9. Ein Refresh rotiert; ein altes Refresh-Token sperrt bei Wiederverwendung die Familie samt aktuellem Access-Token.
10. Widerruf eines Geräts, TOTP-Wechsel und `perch public off` wirken sofort auf laufende Tokens (nächster Request `401` bzw. `503`), auch nach einem Neustart.
11. Ein OAuth-Client ohne Grant liest alles wie das globale Token und sieht keine Schreib-Tools. Mit Grant gelten dieselben Konto-Familien-Regeln wie bei `perch client add`.
12. Rate-Limits und Sperren greifen wie in §9. Jede Anmeldung erzeugt einen Audit-Eintrag ohne Geheimnisse. Telegram-Nachrichten enthalten keine Geheimnisse; ein Ausfall des Kanals blockiert nichts.
13. `oauth.enc` beschädigt, fremd oder verlinkt: öffentlicher Zugang fail closed (`503`), lokaler Listener unverändert.
14. TOTP, Base32 und QR bestehen ihre Referenzvektoren.
15. `npm run check` grün, Offline-Guard: null externe Aufrufe, keine neuen Produktionsabhängigkeiten.

**Live-Abnahme durch den Betreiber** (nicht automatisierbar): Funnel einrichten, Google-Web-Client anlegen, TOTP per QR einrichten, claude.ai-Custom-Connector verbinden, Claude Code am Uni-Laptop verbinden, einen DCR-Client verbinden (z. B. Codex), Gerät widerrufen, Notschalter testen, prüfen, ob Funnel die Client-IP liefert.

## 13. Verbleibende offene Punkte

1. **Lebensdauern und Limits** (§6, §7, §9): Vorschläge, mit der Freigabe zu bestätigen.
2. **Vor der Umsetzung zu prüfen (Primärquellen):**
   - MCP-Autorisierung, aktuelle Revision (möglicherweise 2026-07-28 statt 2025-11-25), insbesondere der Status von DCR;
   - CIMD-URL der gehosteten Claude-Apps;
   - ob Codex DCR, CIMD oder eine feste Client-ID nutzt;
   - Googles OIDC-Doku zur Abkürzung nach OIDC Core §3.1.3.7 (§5);
   - Funnel: Weitergabe der Client-IP.
3. **Getrennte Produktentscheidung (nicht Teil dieses Plans):** Bleibt `perch user add` im Produkt, wenn grundsätzlich eine Person pro Installation vorgesehen ist?

## 14. Primärquellen (dokumentationsgeprüft am 2026-10-14, nicht live validiert)

- Claude, Authentifizierung für Connectors: <https://claude.com/docs/connectors/building/authentication>. Belegt:
  - `401` mit `resource_metadata` nötig; nur der erste Eintrag in `authorization_servers` zählt;
  - CIMD nur bei `client_id_metadata_document_supported: true` und `none` in `token_endpoint_auth_methods_supported`, sonst DCR;
  - PKCE S256 immer;
  - Callback `https://claude.ai/api/mcp/auth_callback`; Claude Code mit Loopback-Redirect auf beliebigem Port und eigenem CIMD (`https://claude.ai/oauth/claude-code-client-metadata`);
  - Refresh-Rotation für öffentliche Clients, `invalid_grant` bei ungültigem Refresh;
  - Token-Endpunkt `application/x-www-form-urlencoded`; Zeitlimits 10 s / 30 s;
  - Anthropic-Egress `160.79.104.0/21`.
- Anthropic-Hilfe zu Custom Connectors: <https://support.claude.com/en/articles/11503834>. Hinweis, dass die Callback-URL künftig unter `claude.com` liegen kann.
- MCP Authorization 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>. RFC 9728 Pflicht, CIMD SHOULD, DCR MAY. **Aus der Prüfumgebung nicht abrufbar** (DNS), nur über Suchergebnisse bestätigt. Eine Sekundärquelle (<https://ssojet.com/blog/mcp-authorization-spec-2026-07-28-what-changed>) nennt eine neuere Revision 2026-07-28, die DCR zugunsten von CIMD abkündigt.
- Tailscale Funnel: <https://tailscale.com/kb/1223/funnel>. Ports nur 443, 8443, 10000; ein Port ist ganz Serve (privat) oder ganz Funnel (öffentlich); braucht MagicDNS, HTTPS-Zertifikate und das Node-Attribut `funnel` in der Policy. Nur über Suchergebnisse bestätigt (DNS); das Header-Verhalten (Client-IP) ist **nicht** belegt.
- OpenID Connect Core 1.0, §3.1.3.7 (ID-Token-Prüfung, TLS statt Signatur bei direktem Token-Endpunkt-Abruf): <https://openid.net/specs/openid-connect-core-1_0.html>. Aus dem Gedächtnis zitiert, vor der Umsetzung nachlesen.
- RFC 6238 (TOTP), RFC 4648 (Base32), RFC 7591 (DCR), RFC 9728 (Protected Resource Metadata), RFC 8414 (AS Metadata), RFC 8707 (Resource Indicators), RFC 7636 (PKCE), RFC 7009 (Revocation), RFC 8252 (Native Apps), OAuth 2.1 Draft (Refresh-Rotation), ISO/IEC 18004 (QR-Code).
