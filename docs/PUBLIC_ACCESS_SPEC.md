# Spezifikation (Entwurf): Öffentlicher Zugang über MCP-OAuth

Stand 2026-10-14. **Status: Entwurf mit allen Entscheidungen von Fritz vom 2026-10-14 (inklusive Lebensdauern und Limits), Freigabe steht aus.** Briefing und Entscheidungstabelle: `docs/PUBLIC_ACCESS_BRIEFING.md`. Werte in *kursiv* sind bestätigte Startwerte. Vor der Umsetzung zu prüfende Quellen stehen in §13.

„Betreiber“ ist die Person, die Perch installiert hat (Root-Namespace). Es gibt genau einen Betreiber pro Installation.

## 0. Sicherheitsziel

Ein Angreifer aus dem Internet soll für **jede** Antwort von `/mcp` mindestens so viel überwinden müssen wie heute (Tailnet-Gerät plus Token). Konkret muss er alle diese Bedingungen erfüllen:

1. ein gültiges, an diese Perch-Installation gebundenes Access-Token,
2. das nur aus einer Kopplung stammt, die der Betreiber **lokal** auf dem Server geöffnet hat (Kopplungsfenster, *10 min*, genau ein Gerät),
3. mit dem **Kopplungscode** aus diesem Fenster,
4. nach einer Anmeldung mit **Google-Konto aus der Allowlist und gültigem Perch-Code (TOTP)**, beide von Perch selbst geprüft,
5. und nach der **abschließenden lokalen Bestätigung**, bei der der Betreiber die Details genau dieser Anmeldung sieht.

Verglichen mit heute ersetzen 2–5 die Tailnet-Schicht, und 1 ersetzt das statische Token. Neu ist eine Angriffsfläche **vor** der Anmeldung (OAuth-Endpunkte, Anmeldeseiten, HTTP-Parser). Außerhalb eines Kopplungsfensters ist sie auf einen fast leeren Rest geschrumpft: Anmeldung und Registrierung antworten dann sofort mit einer festen Seite, ohne Google-Weiterleitung, Code-Abfrage oder Speicherzugriff. §9 begrenzt den Rest.

### 0a. Echtzeit-Phishing (TOTP ist nicht phishing-resistent)

**Angriff:** Eine gefälschte Perch-Seite reicht Google-Login und Perch-Code in Echtzeit an die echte Perch-Seite weiter, etwa mit dem eigenen claude.ai-Konto des Angreifers als Client. Für Perch sieht das wie eine normale claude.ai-Anmeldung aus (gleiche `client_id`, gleiche Callback-URL). Eine reine Geräte-Freigabe „neuer Client: Claude“ würde der Betreiber deshalb leicht bestätigen.

**Maßnahmen, alle Pflicht:**

1. **Keine Anmeldung ohne lokal geöffnetes Fenster.** Neue Token-Familien entstehen nur in einem Kopplungsfenster, das der Betreiber per `perch oauth pair` auf dem Server öffnet. Ohne offenes Fenster ist eine weitergereichte Anmeldung wertlos, egal was der Angreifer abfischt. Ein Angriff muss also genau in die wenigen Minuten fallen, in denen der Betreiber selbst gerade ein Gerät koppelt.
2. **Kopplungscode:** Das Fenster gibt einen zufälligen Code aus (*8 Zeichen Base32, 40 Bit*), den nur der Betreiber im Terminal sieht. Er muss in der Anmeldung vor dem Google-Login eingegeben werden. Wer zufällig während eines Fensters anklopft, kommt ohne ihn nicht weiter. *3* Fehleingaben schließen das Fenster.
3. **Ein Gerät pro Fenster.** Die erste vollständige Anmeldung verbraucht das Fenster. Ein zweiter Anmeldeversuch im selben Fenster (etwa der echte Browser des Betreibers neben dem Angreifer) schließt das Fenster, verwirft **beide** und löst einen Alarm aus („zweiter Kopplungsversuch: möglicher Phishing-Angriff“).
4. **Abschließende lokale Bestätigung mit Details:** Der Autorisierungscode wird erst ausgegeben, nachdem der Betreiber im wartenden Terminal mit `y` bestätigt hat. Das Terminal zeigt dafür: Client-Name und Registrierungsweg, Redirect-Host, Google-Konto, User-Agent, die Zeit seit dem Öffnen und, falls vertrauenswürdig verfügbar (§9), die IP der Anmeldung. Der Betreiber koppelt in diesem Moment selbst ein Gerät und kann vergleichen.
5. **Jede neue Anmeldung ist eine neue Kopplung.** Ein Gerät wird **nicht** über die `client_id` wiedererkannt, weil alle claude.ai-Konten dieselbe `client_id` teilen. Läuft eine Token-Familie ab (*14 Tage* Leerlauf, *90 Tage* absolut), ist eine neue Kopplung mit Fenster nötig. Eine Abkürzung ohne Fenster für „bekannte“ Clients gibt es nicht.
6. **Gegenprobe nach der Kopplung:** Das Terminal wartet nach der Bestätigung bis zu *5 min* auf den ersten `/mcp`-Aufruf der neuen Familie und meldet ihn. Funktioniert der eigene Client danach trotzdem nicht, ist das ein Warnzeichen, und der Hinweis `perch oauth revoke <id>` steht direkt daneben.
7. **Perch verlangt nie von sich aus eine Anmeldung.** Es gibt keine Mail, keine Telegram-Nachricht und keinen Link mit „bitte neu anmelden“. Jede Anmeldung beginnt mit `perch oauth pair` am Server. Das steht auf jeder Anmeldeseite und in jedem Hinweis.
8. **Frische Google-Anmeldung:** Perch fordert Google mit `prompt=select_account` und `max_age=0` an und prüft `auth_time`, falls Google es liefert. Ein gestohlenes, länger bestehendes Google-Sitzungs-Cookie reicht dann nicht allein.

**Verbleibendes Restrisiko:** Ein Angreifer, der den Betreiber genau während dessen eigenem Kopplungsfenster auf eine gefälschte Seite lockt und dort auch den Kopplungscode, den Google-Login und den Perch-Code abfischt, wird bei der lokalen Bestätigung nur an den angezeigten Details erkannt (§9: User-Agent fälschbar, IP nur bei vertrauenswürdigem Proxy-Header). Er bekommt dann **genau ein** Gerät mit Leserechten, das in der Geräteliste steht und sofort widerrufbar ist. Ganz schließen würde diese Lücke nur ein an die Adresse gebundener Faktor (Passkey/WebAuthn), der auf Fritz' Entscheidung hin nicht im Umfang ist.

## 1. Architektur

```
claude.ai / Claude Code / Codex ──HTTPS──▶ TLS-Proxy (Standard: Tailscale Funnel :443)
                                                 │
                                  perch serve --http --public
                                                 │
            ┌────────────────────────────────────┴───────────────────────────┐
  öffentlicher Listener 127.0.0.1:8767                    lokaler Listener 127.0.0.1:8765 (wie heute)
  nur: /mcp, /.well-known/*, /oauth/*                     /mcp, /status, /local/* (Kopplung, TOTP-Einrichtung)
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
- **Ein Betreiber, ein Namespace.** Die Nutzer-Isolation (`perch user add`) wird entfernt (§11a). Der öffentliche Zugang bedient den einzigen Namespace der Installation.

## 2. Konfiguration (neue Umgebungsvariablen)

| Variable | Default | Zweck |
| --- | --- | --- |
| `PERCH_PUBLIC_BASE_URL` | – | z. B. `https://homeserver.tailnet-xyz.ts.net`. Ohne sie startet kein öffentlicher Listener. Muss `https://` sein, ohne Pfad, Query oder Fragment. |
| `PERCH_PUBLIC_PORT` | *`8767`* | Loopback-Port des öffentlichen Listeners |
| `PERCH_GOOGLE_LOGIN_CLIENT_FILE` | – | JSON eines Google-OAuth-Clients vom Typ **Web application**, den der Betreiber selbst anlegt (getrennt vom Desktop-Client für Konten). Redirect: `<BASE>/oauth/google/callback`. Nur die Scopes `openid email`. |
| `PERCH_OAUTH_DCR` | *`on`* | Dynamic Client Registration (§4), nur während eines Kopplungsfensters; `off` schaltet sie ganz ab |
| `PERCH_PUBLIC_TRUST_FORWARDED` | *`0`* | `1` wertet `X-Forwarded-For` des Proxys aus (§9); nur setzen, wenn der Proxy den Header verlässlich setzt und überschreibt |
| `PERCH_NOTIFY_TELEGRAM_FILE` | – | optional: Datei (`0600`) mit Bot-Token und Chat-ID für Hinweise (§8). Ohne sie gibt es keine Benachrichtigung. |

Die Google-Allowlist, das TOTP-Geheimnis und die Geräteliste liegen nicht in Umgebungsvariablen, sondern verschlüsselt und werden per CLI gepflegt (§10).

## 3. Discovery und Endpunkte (öffentlicher Listener)

| Pfad | Methode | Inhalt |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` und `/.well-known/oauth-protected-resource/mcp` | GET | RFC 9728: `resource` = `<BASE>/mcp` (exakt), `authorization_servers` = `[<BASE>]`, `scopes_supported` = `["perch.read"]`. Schreibrechte werden nie über Scopes vergeben (§7). |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `registration_endpoint` (nur wenn DCR an), `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `response_types_supported: ["code"]`, `scopes_supported: ["perch.read","offline_access"]`. Statisch, unabhängig vom Kopplungsfenster. |
| `/oauth/register` | POST | DCR nach RFC 7591; nur mit `PERCH_OAUTH_DCR=on` **und** offenem Kopplungsfenster, sonst `403` mit fester Fehlermeldung (§4) |
| `/oauth/authorize` | GET | Start. Ohne offenes Kopplungsfenster sofort eine feste Seite „keine Kopplung offen, starte `perch oauth pair` auf deinem Server“: kein Google-Redirect, kein CIMD-Abruf, kein Speicherzugriff außer dem Fenster-Status im Arbeitsspeicher. |
| `/oauth/pair` | GET/POST | Eingabe des Kopplungscodes |
| `/oauth/google/callback` | GET | Rückkehr von Google |
| `/oauth/totp` | GET/POST | Abfrage des Perch-Codes |
| `/oauth/wait` | GET | wartet auf die lokale Bestätigung (`<meta http-equiv="refresh">`), danach Redirect mit `code` |
| `/oauth/token` | POST | `application/x-www-form-urlencoded`; Code-Tausch und Refresh (unabhängig vom Fenster) |
| `/oauth/revoke` | POST | RFC 7009 |
| `/mcp` | POST | wie heute, aber nur mit OAuth-Access-Token. Die statischen Tokens werden hier **abgelehnt**. |

- **Ohne oder mit ungültigem Token** antwortet `/mcp` mit `401` und `WWW-Authenticate: Bearer resource_metadata="<BASE>/.well-known/oauth-protected-resource", scope="perch.read"`. Bei abgelaufenem Token kommt zusätzlich `error="invalid_token"`.
- Tokens nur im `Authorization`-Header, nie in Query-Parametern.
- Die Endpunkte antworten schnell (claude.ai wartet höchstens 10 s, beim Refresh 30 s). Upstream-Aufrufe an Google nur im interaktiven Login, nie im Token-Endpunkt.

## 4. Client-Registrierung

Drei Wege, wie ein Client eine `client_id` bekommt. Eine `client_id` allein bringt **nie** ein Token: Tokens entstehen nur über eine vollständige Kopplung (§6).

1. **Client ID Metadata Document (CIMD)** für Claude (claude.ai, Desktop, Mobile, Cowork, Claude Code):
   - `client_id` ist eine HTTPS-URL und muss **exakt** in einer festen, im Code hinterlegten Allowlist stehen: `https://claude.ai/oauth/claude-code-client-metadata` plus die CIMD-URL der gehosteten Claude-Apps (vor der Umsetzung ermitteln). Weitere URLs kann der Betreiber per CLI hinzufügen. Andere `client_id`-URLs scheitern vor jedem Netzwerkzugriff, damit es kein SSRF über beliebige Metadaten-URLs gibt.
   - Abruf nur während eines Kopplungsfensters, mit festen Grenzen: 64 KiB, 5 s Timeout, keine Redirects, nur `https`, Cache *1 h*. `client_id` im Dokument muss der URL entsprechen.
2. **Dynamic Client Registration (RFC 7591)** für Clients ohne Metadaten-Dokument (z. B. Codex), abschaltbar:
   - Nur während eines offenen Kopplungsfensters. Außerhalb antwortet der Endpunkt sofort mit `403`. Damit ist er die meiste Zeit geschlossen.
   - Sie erzeugt nur eine `client_id` (`dcr-<16 hex>`), ohne Secret (öffentlicher Client, `token_endpoint_auth_method: none`), gebunden an genau dieses Fenster. Wird das Fenster nicht mit diesem Client abgeschlossen, verfällt sie mit dem Fenster.
   - Strikte Prüfung: JSON höchstens *16 KiB*, höchstens *5* `redirect_uris`, jede entweder `https://…` ohne Fragment oder Loopback (`http://127.0.0.1`, `http://[::1]`, `http://localhost`, beliebiger Port). `client_name` gekürzt und für die Anzeige maskiert. Unbekannte Felder werden verworfen, `logo_uri`, `jwks_uri` und alle anderen URLs werden nie abgerufen.
   - Limits: höchstens *3* Registrierungen pro Fenster.
3. **Vorregistrierung per CLI**: `perch oauth client add --name … --redirect …` für Clients, die eine feste `client_id` erwarten.

**Redirect-URIs** gelten nur, wenn sie exakt registriert bzw. im CIMD-Dokument stehen. Loopback wird portunabhängig verglichen (RFC 8252 §7.3), auch für `localhost`, weil Claude Code es so deklariert. Für die gehosteten Claude-Apps gilt `https://claude.ai/api/mcp/auth_callback` (bei Bedarf zusätzlich `https://claude.com/api/mcp/auth_callback`).

## 5. Perch-Code (TOTP) und Google-Prüfung

**TOTP (RFC 6238), selbst gebaut mit `node:crypto`:**

- Geheimnis 160 Bit zufällig, HMAC-SHA1, 6 Ziffern, 30 s. Das sind die Werte, die alle gängigen Authenticator-Apps unterstützen. Gespeichert verschlüsselt in `oauth.enc` (§7).
- Toleranz höchstens ±1 Zeitfenster. Jeder Zeitschritt wird nur **einmal** akzeptiert (der zuletzt benutzte Zähler wird gespeichert), damit ein mitgelesener Code nicht nochmal gilt.
- Vergleich in konstanter Zeit. Die RFC-6238-Testvektoren sind Teil der Tests.
- **Einrichtung nur lokal:** `perch oauth totp setup` erzeugt das Geheimnis, zeigt die `otpauth://`-URI als **QR-Code im Terminal** (eigener minimaler QR-Encoder: Byte-Modus, Fehlerkorrektur M, nur die nötigen Versionen, mit Referenz-Testvektoren) und zusätzlich das Base32-Geheimnis zum Abtippen. Aktiv wird es erst nach Eingabe eines gültigen Codes. Alternativ zeigt die Seite `/local/totp` auf dem lokalen Listener denselben QR-Code.
- **Notfall-Codes:** *10* Codes zu je *10* Zeichen (Base32), einmal anzeigen, nur als Hash speichern (SHA-256 mit Salt), jeder Code einmal verwendbar. Neu erzeugen macht die alten ungültig.
- Ein Wechsel des Geheimnisses (`setup` erneut) macht alle bestehenden OAuth-Token-Familien ungültig.
- Ein Notfall-Code ersetzt den TOTP-Code, aber nie den Kopplungscode oder die lokale Bestätigung. Seine Nutzung löst einen Hinweis aus.

**Google-ID-Token, ohne JWT-Bibliothek:**

- Perch holt das ID-Token im Authorization-Code-Flow mit PKCE **direkt** vom festen Google-Token-Endpunkt (`https://oauth2.googleapis.com/token`, TLS-geprüft). Nach OpenID Connect Core §3.1.3.7 darf der Client in diesem Fall die TLS-Prüfung des Servers statt der Token-Signatur zur Prüfung des Ausstellers verwenden.
- Die Anfrage an Google enthält `prompt=select_account` und `max_age=0`. Liefert Google `auth_time`, muss es jünger als *10 min* sein (§0a, Punkt 8). Perch prüft die Signatur deshalb **nicht** und braucht keinen JWKS-Abruf.
- Das ID-Token wird nur aus genau dieser Antwort akzeptiert, nie aus einem Redirect, Query-Parameter oder Formular.
- Geprüft werden: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud` = eigene Client-ID (bei mehreren Werten zusätzlich `azp`), `exp` in der Zukunft, `iat` nicht älter als *10 min*, `nonce` = gespeicherte Nonce, `email_verified` = true, und `sub`+E-Mail aus der Allowlist.
- Ob Googles aktuelle Doku diese Abkürzung ebenfalls zulässt, wird vor der Umsetzung an der Primärquelle geprüft (§13).

## 6. Kopplung (Anmeldung eines Geräts)

**Kopplungsfenster:** `perch oauth pair` (lokal, nur auf dem Server) öffnet ein Fenster für *10 min*, gibt den Kopplungscode aus und bleibt im Vordergrund, bis die Kopplung bestätigt, abgelehnt, abgebrochen (Strg-C schließt das Fenster) oder abgelaufen ist. Es gibt höchstens ein offenes Fenster. Der Fenster-Status liegt im Arbeitsspeicher des laufenden Servers; das CLI spricht ihn über einen lokalen Kontrollkanal an (Unix-Socket im Datenverzeichnis, `0600`, nur Eigentümer). Alternativ dient die Seite `/local/pair` auf dem lokalen Listener (per SSH-Tunnel oder Tailnet), etwa vom Handy aus.

Ablauf im Browser. Alle Zwischenzustände liegen serverseitig, sind an ein zufälliges `__Host-`-Cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) gebunden, gehören zu genau einem Fenster und sind einmal verwendbar.

1. **Fenster offen?** Sonst feste Seite (§3), Ende.
2. **Parameter prüfen:** `response_type=code`, `client_id` bekannt (§4), `redirect_uri` erlaubt, `code_challenge` mit `S256` (Pflicht), `resource` = `<BASE>/mcp` (RFC 8707). Fehlt `resource`, wird es so behandelt; ein abweichender Wert wird abgelehnt. `state` wird unverändert durchgereicht. Fehler vor einer gültigen `redirect_uri` erscheinen als Seite, nie als Redirect.
3. **Ein Gerät pro Fenster:** Hat in diesem Fenster schon eine andere Browser-Sitzung Schritt 4 bestanden, wird das Fenster geschlossen, alle seine Sitzungen werden verworfen, und es gibt einen Alarm (§0a, Punkt 3).
4. **Kopplungscode:** Vergleich in konstanter Zeit. *3* Fehleingaben schließen das Fenster.
5. **Google (OIDC Authorization Code + PKCE + `nonce` + `state`):** Prüfung wie in §5. Zugelassen ist nur ein Paar `sub`+E-Mail aus der Allowlist. Beim ersten erfolgreichen Login wird der `sub` angeheftet; danach zählt `sub`. Eine geänderte E-Mail bei gleichem `sub` führt zur Ablehnung mit Hinweis.
6. **Perch-Code:** TOTP-Code oder Notfall-Code (§5). Ohne eingerichtetes TOTP lässt sich kein Fenster öffnen.
7. **Lokale Bestätigung:** Das wartende Terminal (bzw. `/local/pair`) zeigt die Details aus §0a, Punkt 4, und die Rechte (alles lesen; Schreib-Grants gibt es für ein neues Gerät nie sofort) und fragt `Dieses Gerät koppeln? [y/N]`. Die Browser-Seite zeigt währenddessen Client, Redirect-Host und den Satz „Bestätige diese Anmeldung in deinem Terminal auf dem Server“.
8. **Abschluss:** Nach `y` entsteht ein Geräte-Eintrag (`oc-<16 hex>`) mit einer Token-Familie, und der Browser wird mit `code` weitergeleitet (*60 s*, einmal verwendbar, an `client_id`, `redirect_uri`, PKCE, `resource` und das Gerät gebunden). Das Fenster ist damit verbraucht. Danach folgt die Gegenprobe (§0a, Punkt 6).

Jeder Zweig, der nicht ausdrücklich erfolgreich ist, endet ohne Code (fail closed) und schließt bei Verdacht (Schritte 3, 4, Sperre in Schritt 6) das Fenster.

**Unterwegs koppeln:** Am Uni-Laptop braucht es Zugang zum Server, etwa per SSH- oder Tailscale-App auf dem Handy (`perch oauth pair` oder `/local/pair`). Ein claude.ai-Connector gilt für das ganze claude.ai-Konto (Web, Desktop, Handy); er muss also nur einmal gekoppelt werden und danach alle *90 Tage* neu.

## 7. Tokens, Rechte und Speicherung

- **Gerät = eine Kopplung.** Ein Geräte-Eintrag entspricht genau einer bestätigten Kopplung und hat genau eine Token-Familie. Geräte werden **nie** über die `client_id` wiedererkannt (§0a, Punkt 5).
- **Access-Token:** opak, 256 Bit, *1 h*. Gespeichert wird nur der SHA-256-Hash. Gebunden an Gerät, `resource` und Familie.
- **Refresh-Token:** opak, 256 Bit, rotiert bei **jeder** Nutzung. Die Antwort enthält das neue Token und entwertet das alte. Leerlauf-Ablauf *14 Tage*, absolute Grenze *90 Tage*; danach ist das Gerät abgelaufen, und es braucht eine neue Kopplung.
- **Wiederverwendung erkannt** (ein bereits rotiertes Refresh-Token taucht erneut auf): Das Gerät wird gesperrt, Antwort `invalid_grant`, Audit-Eintrag und Alarm „mögliches kopiertes Token“.
- **Widerruf** eines Geräts wirkt sofort. Jeder `/mcp`-Request prüft Token, Familie und Gerät neu, so wie heute die Grant-Revalidierung vor jedem Tool-Aufruf.
- **Speicher:** eigene verschlüsselte Datei `oauth.enc` mit HKDF-Unterschlüssel des Store-Schlüssels, eigenem AAD und eigenem Lock `oauth.lock`, nach dem Muster von `mail-workflow.enc`. Inhalt: Google-Allowlist samt `sub`, TOTP-Geheimnis und letzter Zähler, Notfall-Code-Hashes, vorregistrierte Clients, Geräte mit Familie, Sperrzustand. Kopplungsfenster und DCR-Registrierungen liegen nur im Arbeitsspeicher. Häufige Refreshes konkurrieren so nicht mit dem Store-Lock, und das Store-Schema bleibt v1. Feste Obergrenze *50 aktive Geräte*, fail closed bei Beschädigung, nie automatisch zurückgesetzt.
- **Rechte (Principal):** neue Art `oauth_client`.
  - Standard: dieselben Leserechte wie `READONLY_PRINCIPAL` (Drive, Notion, Mail, Kalender, Kontakte, Slack, WhatsApp; alle Konten).
  - Schreiben nur über einen ausdrücklichen, nachträglichen Grant pro Gerät und Konto: `perch oauth grant <oc-id> --capabilities send,calendar_write --accounts …`. Es gelten dieselben Familien- und Capability-Regeln wie bei `perch client add` (`src/auth/grants.ts`), mit Revalidierung vor jedem Tool-Aufruf.
  - Scopes vergeben **nie** Schreibrechte. Ein Client kann sich Schreiben also nicht „erbitten“.

## 8. Audit und Benachrichtigung

- Protokolliert werden ohne Inhalte im bestehenden Audit-Ledger: jedes geöffnete, abgelaufene, abgebrochene oder verbrauchte Fenster, jeder Schritt der Kopplung mit Ergebnis und Grund, jede Registrierung, Bestätigung, Ablehnung und jeder Widerruf, jede Gegenprobe, jede erkannte Wiederverwendung, jede TOTP-Änderung und Notfall-Code-Nutzung und jeder Notschalter. Neue Felder: Geräte-ID, Fenster-ID, Ereignis, Herkunft (§9). Tokens, Codes, TOTP-Geheimnis und Google-Tokens nie.
- `perch audit list` zeigt die Ereignisse.
- **Benachrichtigung, optional:** Kanal-Schnittstelle in Perch mit genau einer ersten Umsetzung, dem **Telegram-Bot direkt** (`https://api.telegram.org`, neue feste Upstream-Origin, Bot-Token aus `PERCH_NOTIFY_TELEGRAM_FILE`). Nur Hinweise, keine Knöpfe und keine Befehle zurück; kein Link und keine Aufforderung zur Anmeldung (§0a, Punkt 7).
  - Hinweise: Fenster geöffnet, Gerät gekoppelt, Notfall-Code benutzt, TOTP geändert, Notschalter.
  - Alarme: zweiter Kopplungsversuch im selben Fenster, Kopplungscode falsch, Sperre nach Fehlversuchen, erkannte Wiederverwendung eines Refresh-Tokens.
  - Die Nachrichten enthalten keine Tokens, Codes oder Inhalte. Fällt der Kanal aus, läuft die Kopplung trotzdem (die lokale Bestätigung bleibt ja Pflicht), und der Fehler wird protokolliert.

## 9. Härtung des öffentlichen Listeners

- **Herkunft:** Ob Funnel bzw. der Proxy die Client-IP verlässlich weitergibt (etwa als `X-Forwarded-For`), ist **nicht verifiziert**. Der Header wird nur ausgewertet, wenn `PERCH_PUBLIC_TRUST_FORWARDED=1` gesetzt ist und der Request von Loopback kommt. Sonst gelten die Limits global, und die lokale Bestätigung zeigt „IP unbekannt“.
- **Rate-Limits** (*Token-Bucket*): Anmeldeseiten und `/oauth/authorize` *10/min*, `/oauth/register` *5/min*, `/oauth/token` *30/min*, `/mcp` *120/min* pro Gerät, alles zusammen *300/min*. Bei Überschreitung `429` mit `Retry-After`.
- **Sperren:** *5* falsche Perch-Codes in *15 min* schließen das Fenster und sperren das Öffnen neuer Fenster für *15 min* (bei Wiederholung verdoppelt), mit Alarm. *20* ungültige Bearer-Tokens pro Minute schalten `/mcp` für *5 min* auf `401`, ohne Zugriff auf den Speicher.
- **Anfragegrößen:** OAuth-Endpunkte *16 KiB*, `/mcp` wie heute. `headersTimeout` und `requestTimeout` kurz setzen.
- **Seiten:** serverseitig gerendert, ohne JavaScript (Warten per `<meta http-equiv="refresh">`). CSP `default-src 'none'; style-src` per Hash, `form-action 'self'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Strict-Transport-Security: max-age=31536000`. Formulare per `POST` mit CSRF-Token, das an den Zwischenzustand gebunden ist. Jede Seite zeigt die echte Perch-Adresse (`<BASE>`) und den Satz „Perch fordert dich nie per Nachricht zur Anmeldung auf“. Gestaltung nach frilabs-Brand-Standard (`AGENTS.md`).
- **Host/Origin:** Nur der Host aus `<BASE>` wird angenommen. Für `/mcp` gilt die bestehende Origin-Regel.

## 10. CLI

| Befehl | Wirkung |
| --- | --- |
| `perch public setup` | geführte Einrichtung: Basis-URL prüfen, Google-Web-Client einlesen, Allowlist, TOTP mit QR, Notfall-Codes, optional Telegram. Gibt den passenden Funnel- bzw. Proxy-Befehl aus, ohne ihn auszuführen. |
| `perch oauth pair` | Kopplungsfenster öffnen, Kopplungscode ausgeben, auf die Anmeldung warten, Details anzeigen, `[y/N]` fragen, Gegenprobe melden (§6) |
| `perch oauth login-allow add <email>` / `list` / `remove` | Google-Allowlist; beim ersten Login wird der `sub` angeheftet |
| `perch oauth totp setup` / `status` / `recovery-codes` | Perch-Code einrichten bzw. wechseln, Status, Notfall-Codes neu erzeugen |
| `perch oauth client add` / `list` / `remove` | vorregistrierte Clients und zusätzliche CIMD-URLs (§4) |
| `perch oauth devices` | Geräteliste: ID, Name, Registrierungsweg, Redirect-Host, Google-Konto, gekoppelt am, zuletzt gesehen, läuft ab am, Grants |
| `perch oauth revoke <id>` / `revoke --all` | Widerruf |
| `perch oauth grant <id> --capabilities … --accounts …` / `ungrant` | Schreibrechte pro Gerät |
| `perch public off` | **Notschalter:** setzt einen dauerhaften Sperr-Marker (der öffentliche Listener beantwortet danach alles mit `503`, auch nach einem Neustart), schließt ein offenes Fenster, widerruft alle Geräte und protokolliert das. Gibt den Befehl zum Abschalten von Funnel bzw. Proxy aus; Perch ändert Tailscale nicht selbst. |
| `perch public on` | hebt den Marker auf; Geräte müssen danach neu gekoppelt werden |

Alle Befehle laufen nur lokal. `perch status` und die Statusseite zeigen zusätzlich: öffentlicher Zugang an/aus/gesperrt, TOTP eingerichtet, Anzahl aktiver Geräte, letzte Kopplung, ob gerade ein Fenster offen ist.

## 11. Keine neuen Abhängigkeiten

Auf Fritz' Entscheidung wird alles mit Node-Bordmitteln gebaut: TOTP, Base32, QR-Encoder, Cookie- und Formular-Verarbeitung, Prüfung des Google-ID-Tokens (§5, ohne Signaturprüfung, daher ohne JWT-Bibliothek). `package.json` und Lockfile bekommen keine neuen Produktionsabhängigkeiten. Für jeden selbst gebauten Baustein gibt es Tests gegen Referenzwerte: RFC-6238-Vektoren, RFC-4648-Base32-Vektoren und QR-Referenzmatrizen.

## 11a. Rückbau der Nutzer-Isolation (`perch user add`)

Fritz' Entscheidung vom 2026-10-14: Perch hat genau einen Betreiber pro Installation. Die Nutzer-Isolation aus `docs/USER_ISOLATION_MILESTONE.md` wird entfernt. Das ist ein **eigener, erster Arbeitsschritt** vor dem öffentlichen Zugang, mit eigenem PR, damit beide Änderungen getrennt prüfbar bleiben.

- **Entfernt:** `perch user add|list|remove`, `PERCH_USER`, `src/users/namespaces.ts` und `src/users/registry.ts`, das Routing von Nutzer-Tokens in `src/mcp/http.ts` und `serve --stdio`, die Prüfungen „nicht mit `PERCH_USER`“ in der CLI, die zugehörigen Tests (`test/userCli.test.ts`, `test/userIsolation.test.ts`, `test/userRegistry.test.ts`, `test/support/namespaceFixtures.ts`, betroffene Teile weiterer Tests) und die Doku (SETUP §4c, README-Abschnitt).
- **Bleibt:** der bisherige Root-Store mit Konten, globalem Token und Client-Grants, unverändert. Cursor bleiben per HMAC versiegelt.
- **Bestehende Installationen mit angelegten Nutzern:** Das Feld `users` im Store bleibt lesbar (Store-Schema v1 unverändert), wird aber ignoriert. Stehen dort aktive Nutzer, schreibt `perch serve` beim Start eine Warnung. Deren Tokens werden ab dann mit `401` abgelehnt (fail closed). Ihre Stores und Schlüssel bleiben unangetastet auf der Platte; SETUP beschreibt, wie man sie von Hand löscht. Perch löscht nichts selbst.
- **Akzeptanz:** `npm run check` grün; ein ehemaliges Nutzer-Token bekommt `401`; ein Store mit `users`-Einträgen öffnet weiter; keine Datei unter `users/` oder `user-keys/` wird angelegt, gelesen oder gelöscht.

## 12. Akzeptanzkriterien (Tests nur mit Mocks)

1. Der öffentliche Listener beantwortet `/status`, `/local/*`, `/` und jeden unbekannten Pfad mit `404`, auch mit gültigem Token.
2. Das globale Token und Client-Grant-Tokens werden am öffentlichen `/mcp` mit `401` abgelehnt.
3. Discovery-Dokumente entsprechen §3; jeder `401` trägt `resource_metadata`.
4. **Ohne offenes Fenster:** `/oauth/authorize` liefert die feste Seite ohne Google-Redirect, ohne CIMD-Abruf und ohne Speicherzugriff; `/oauth/register` liefert `403`.
5. Ohne PKCE-S256, mit falschem `resource`, unbekannter `client_id` oder nicht erlaubter `redirect_uri` gibt es keinen Code. Eine nicht gelistete CIMD-URL löst keinen Netzwerkzugriff aus.
6. Falscher Kopplungscode: kein Fortschritt; nach *3* Fehlern ist das Fenster zu.
7. Zweite Browser-Sitzung im selben Fenster: Fenster zu, beide Sitzungen verworfen, Alarm, kein Code für irgendwen.
8. Google-Konto außerhalb der Allowlist, falscher `sub`, falsches `iss`/`aud`/`nonce`, abgelaufenes Token, `email_verified=false`, zu altes `auth_time`: kein Code.
9. Ohne gültigen Perch-Code kein Fortschritt. Ein bereits benutzter Code und ein Code außerhalb von ±1 Fenster werden abgelehnt. Ein Notfall-Code gilt genau einmal und ersetzt nie den Kopplungscode.
10. **Ohne lokales `y` gibt es keinen Code**, auch wenn alle anderen Schritte bestanden sind; `N`, Strg-C und Ablauf enden ohne Code.
11. Ein Fenster koppelt höchstens ein Gerät; eine DCR-`client_id` aus einem abgelaufenen Fenster ist wertlos.
12. Ein abgelaufenes Gerät (14 Tage Leerlauf bzw. 90 Tage) lässt sich nur über ein neues Fenster ersetzen; es gibt keinen Weg ohne Fenster.
13. Der Autorisierungscode ist nur einmal verwendbar und nach *60 s* ungültig.
14. Ein Refresh rotiert; ein altes Refresh-Token sperrt bei Wiederverwendung das Gerät samt aktuellem Access-Token.
15. Widerruf eines Geräts, TOTP-Wechsel und `perch public off` wirken sofort auf laufende Tokens (nächster Request `401` bzw. `503`), auch nach einem Neustart.
16. Ein OAuth-Client ohne Grant liest alles wie das globale Token und sieht keine Schreib-Tools. Mit Grant gelten dieselben Konto-Familien-Regeln wie bei `perch client add`.
17. Rate-Limits und Sperren greifen wie in §9. Jeder Kopplungsschritt erzeugt einen Audit-Eintrag ohne Geheimnisse. Telegram-Nachrichten enthalten keine Geheimnisse und keine Links; ein Ausfall des Kanals blockiert nichts.
18. Der Kontroll-Socket akzeptiert nur Verbindungen des Eigentümers; falsche Rechte oder ein Symlink lassen `perch oauth pair` geschlossen fehlschlagen.
19. `oauth.enc` beschädigt, fremd oder verlinkt: öffentlicher Zugang fail closed (`503`), lokaler Listener unverändert.
20. TOTP, Base32 und QR bestehen ihre Referenzvektoren.
21. `npm run check` grün, Offline-Guard: null externe Aufrufe, keine neuen Produktionsabhängigkeiten.

**Live-Abnahme durch den Betreiber** (nicht automatisierbar): Funnel einrichten, Google-Web-Client anlegen, TOTP per QR einrichten, claude.ai-Custom-Connector koppeln, Claude Code am Uni-Laptop koppeln (vom Handy aus bestätigt), einen DCR-Client koppeln (z. B. Codex), Gerät widerrufen, Notschalter testen, prüfen, ob Funnel die Client-IP liefert.

## 13. Vor der Umsetzung zu prüfen

1. **Primärquellen:**
   - MCP-Autorisierung, aktuelle Revision (möglicherweise 2026-07-28 statt 2025-11-25), insbesondere der Status von DCR;
   - CIMD-URL der gehosteten Claude-Apps;
   - ob Codex DCR, CIMD oder eine feste Client-ID nutzt;
   - Googles OIDC-Doku zur Abkürzung nach OIDC Core §3.1.3.7 sowie zu `max_age` und `auth_time` (§5);
   - Funnel: Weitergabe der Client-IP.
2. **Verhalten von claude.ai beim Warten:** Die Kopplung kann bis zu *10 min* im Browser dauern (lokale Bestätigung). Zu prüfen ist, ob claude.ai den Ablauf so lange offenhält. Das 10-s-Limit gilt laut Doku nur für Discovery-, Registrierungs- und Token-Endpunkte, nicht für die Browser-Seiten.

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
