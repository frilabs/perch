# Spezifikation (Entwurf): Öffentlicher Zugang über MCP-OAuth

Stand 2026-10-14. **Status: Entwurf, nicht freigegeben.** Briefing: `docs/PUBLIC_ACCESS_BRIEFING.md`. Werte in *kursiv* sind Vorschläge, die Fritz bestätigen oder ändern soll. Offene Entscheidungen stehen in §11.

## 0. Sicherheitsziel

Ein Angreifer aus dem Internet soll für **jede** Antwort von `/mcp` mindestens so viel überwinden müssen wie heute (Tailnet-Gerät plus Token). Konkret muss er alle drei Bedingungen erfüllen:

1. ein gültiges, an Perch gebundenes Access-Token,
2. das nur ein **von Fritz freigegebener** Client bekommt,
3. und nur nach einer Anmeldung mit **Google-Konto aus der Allowlist und Perch-Passkey** (zwei unabhängige Faktoren, einer davon phishing-resistent).

Verglichen mit heute ersetzen 2 und 3 die Tailnet-Schicht, und 1 ersetzt das statische Token. Neu ist eine Angriffsfläche **vor** der Anmeldung (OAuth-Endpunkte, Anmeldeseiten, HTTP-Parser), die öffentlich erreichbar ist. §8 begrenzt sie.

## 1. Architektur

```
claude.ai / Claude Code ──HTTPS──▶ Tailscale Funnel :443 (öffentlich)
                                        │
                         perch serve --http --public
                                        │
          ┌─────────────────────────────┴───────────────────────────┐
  öffentlicher Listener 127.0.0.1:8767             Tailnet-Listener 127.0.0.1:8765 (wie heute)
  nur: /mcp, /.well-known/*, /oauth/*              /mcp, /status, später Admin-Seiten
          │                                                  ▲
          └── gemeinsamer PerchContext ──────────────────────┘  Tailscale Serve :8443 (privat)
```

- **Zwei Listener in einem Prozess.** Der öffentliche Listener hat eine eigene, feste Routing-Tabelle. Unbekannte Pfade bekommen `404`, ohne Authentifizierung zu versuchen. `/status` und alles Administrative existieren dort nicht, unabhängig davon, wie Funnel konfiguriert ist (Verteidigung in der Tiefe).
- Der öffentliche Listener bindet nur auf Loopback (`validateBindHost` wie heute). Öffentlich wird er ausschließlich über Funnel.
- Der Tailnet-Listener bleibt unverändert, einschließlich der heutigen statischen Tokens.
- **Perch ist selbst der Authorization Server** (Issuer = öffentliche Basis-URL). Google dient nur als vorgeschalteter Identitätsnachweis. Google-Tokens gehen nie an MCP-Clients, und MCP-Tokens nie an Google (kein Token-Passthrough).
- Port-Zuordnung: *Funnel auf 443, Tailnet-Serve auf 8443.* Funnel gilt pro Port, und ein Port ist entweder ganz öffentlich oder ganz privat (§12). Alternative siehe §11.

## 2. Konfiguration (neue Umgebungsvariablen)

| Variable | Default | Zweck |
| --- | --- | --- |
| `PERCH_PUBLIC_BASE_URL` | – | z. B. `https://homeserver.tailnet-xyz.ts.net`. Ohne sie startet kein öffentlicher Listener. Muss `https://` sein und auf `.ts.net` enden. |
| `PERCH_PUBLIC_PORT` | *`8767`* | Loopback-Port des öffentlichen Listeners |
| `PERCH_GOOGLE_LOGIN_CLIENT_FILE` | – | JSON eines Google-OAuth-Clients vom Typ **Web application** (getrennt vom Desktop-Client für Konten). Redirect: `<BASE>/oauth/google/callback`. Nur die Scopes `openid email`. |
| `PERCH_OAUTH_ALLOWED_CLIENT_IDS` | *`https://claude.ai/oauth/claude-code-client-metadata`* plus die CIMD-URL der gehosteten Claude-Apps (vor der Umsetzung ermitteln) | Allowlist der CIMD-`client_id`-URLs |

Die Allowlist der Google-Konten liegt nicht in einer Umgebungsvariablen, sondern im verschlüsselten Store und wird per CLI gepflegt (§9).

## 3. Discovery und Endpunkte (öffentlicher Listener)

| Pfad | Methode | Inhalt |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource` und `/.well-known/oauth-protected-resource/mcp` | GET | RFC 9728: `resource` = `<BASE>/mcp` (exakt), `authorization_servers` = `[<BASE>]`, `scopes_supported` = `["perch.read"]` (Schreibrechte werden nie über Scopes vergeben, §6) |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414: `issuer`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `response_types_supported: ["code"]`, `scopes_supported: ["perch.read","offline_access"]`. **Kein** `registration_endpoint`. |
| `/oauth/authorize` | GET | Start: Parameter prüfen, Client per CIMD auflösen, Anmeldung beginnen |
| `/oauth/google/callback` | GET | Rückkehr von Google |
| `/oauth/passkey` | GET/POST | WebAuthn-Abfrage (Seite und Antwort) |
| `/oauth/consent` | POST | Zustimmung; danach Redirect mit `code` |
| `/oauth/token` | POST | `application/x-www-form-urlencoded`; Code-Tausch und Refresh |
| `/oauth/revoke` | POST | RFC 7009 |
| `/mcp` | POST | wie heute, aber nur mit OAuth-Access-Token. Die statischen Tokens werden hier **abgelehnt**. |

- **Ohne oder mit ungültigem Token** antwortet `/mcp` mit `401` und `WWW-Authenticate: Bearer resource_metadata="<BASE>/.well-known/oauth-protected-resource", scope="perch.read"`. Bei abgelaufenem Token kommt zusätzlich `error="invalid_token"`.
- Tokens nur im `Authorization`-Header, nie in Query-Parametern.
- Die Endpunkte antworten schnell (claude.ai wartet höchstens 10 s, beim Refresh 30 s). Upstream-Aufrufe an Google nur im interaktiven Login, nie im Token-Endpunkt.

## 4. Client-Registrierung (CIMD, Allowlist)

- Nur **Client ID Metadata Documents**. `client_id` ist eine HTTPS-URL und muss **exakt** in `PERCH_OAUTH_ALLOWED_CLIENT_IDS` stehen. Andere `client_id`s scheitern vor jedem Netzwerkzugriff. Das schließt SSRF über beliebige Metadaten-URLs aus.
- Das Dokument wird mit festen Grenzen geholt: 64 KiB, 5 s Timeout, keine Redirects, nur `https`, Cache *1 h*. `client_id` im Dokument muss der URL entsprechen.
- **Redirect-URIs:** nur aus dem Dokument. Zusätzlich gilt eine feste Perch-Liste: `https://claude.ai/api/mcp/auth_callback` (bei Bedarf `https://claude.com/api/mcp/auth_callback`) und Loopback `http://127.0.0.1/callback` bzw. `http://localhost/callback` mit beliebigem Port (RFC 8252 §7.3). Alles andere wird abgelehnt.
- Die Zustimmungsseite zeigt den Hostnamen der Redirect-URI deutlich. Bei reinen Loopback-Redirects warnt sie zusätzlich („ein lokales Programm auf diesem Rechner erhält Zugriff“).
- Kein DCR. Ob weitere Clients (Codex, Cowork) DCR brauchen, ist offen (§11).

## 5. Anmeldung und Geräte-Freigabe

Ablauf von `/oauth/authorize` (alle Zwischenzustände serverseitig, signiert, Lebensdauer *10 min*, einmal verwendbar):

1. **Parameter prüfen:** `response_type=code`, `client_id` in der Allowlist, `redirect_uri` erlaubt, `code_challenge` mit `S256` (Pflicht), `resource` = `<BASE>/mcp` (RFC 8707, Pflicht), `state` wird unverändert durchgereicht. Fehler vor gültiger `redirect_uri` werden als Seite angezeigt, nie per Redirect.
2. **Google (OIDC Authorization Code + PKCE + `nonce`):** Das ID-Token wird über den Token-Endpunkt von Google bezogen und geprüft (Signatur über die JWKS, `iss`, `aud`, `exp`, `nonce`, `email_verified`). Zugelassen ist nur ein Paar `sub`+E-Mail aus der Allowlist im Store. Entscheidend ist `sub`; eine geänderte E-Mail bei gleichem `sub` führt zur Ablehnung mit Hinweis.
3. **Perch-Passkey (WebAuthn):** `userVerification: "required"`, RP-ID = Host von `<BASE>`, Origin = `<BASE>`. Signaturzähler und Credential-ID werden geprüft. *Pflicht* (§11, Frage 1). Passkeys werden **nur im Tailnet** registriert (Seite auf dem Tailnet-Listener oder CLI-Einmal-Link), nie über den öffentlichen Listener.
4. **Geräteliste:** Hat dieser `client_id` für diesen Namespace noch keinen *freigegebenen* Eintrag, entsteht ein Eintrag `pending` (ID `oc-<16 hex>`, Name aus dem CIMD-Dokument, Redirect-Host, Zeit, Herkunft laut §8). Die Anmeldung wartet höchstens *10 min* auf die Freigabe:
   - *Empfehlung:* Freigabe im Tailnet (`perch oauth approve <id>` oder Knopf auf einer Tailnet-Seite). Eine Telegram-Nachricht über friagent dient nur als **Hinweis** mit der ID.
   - Alternative (§11, Frage 2): Freigabe direkt per Telegram. Das macht das Telegram-Konto zu einem weiteren Faktor, der zur Freigabe reicht.
5. **Zustimmung:** Die Seite zeigt Client, Redirect-Host und Rechte (nur lesen; vorhandene Schreib-Grants dieses Clients einzeln). Danach Redirect mit `code` (*60 s*, einmal verwendbar, an `client_id`, `redirect_uri`, PKCE und `resource` gebunden).

Jeder Zweig, der nicht ausdrücklich erfolgreich ist, endet ohne Code (fail closed).

## 6. Tokens, Rechte und Speicherung

- **Access-Token:** opak, 256 Bit, *1 h*. Gespeichert wird nur der SHA-256-Hash. Gebunden an Namespace, OAuth-Client-Eintrag, `resource` und eine Token-Familie.
- **Refresh-Token:** opak, 256 Bit, rotiert bei **jeder** Nutzung; die Antwort enthält das neue Token und entwertet das alte. Leerlauf-Ablauf *14 Tage*, absolute Grenze *90 Tage*, danach neue Anmeldung.
- **Wiederverwendung erkannt** (ein bereits rotiertes Refresh-Token taucht erneut auf): Die ganze Familie wird gesperrt, Antwort `invalid_grant`, Audit-Eintrag und Benachrichtigung „mögliches kopiertes Token“.
- **Widerruf** eines Geräts sperrt alle seine Familien sofort. Jeder `/mcp`-Request prüft Token, Familie und Geräte-Eintrag neu (wie heute die Grant-Revalidierung vor jedem Tool-Aufruf).
- **Speicher:** eigene verschlüsselte Datei `oauth.enc` pro Namespace mit HKDF-Unterschlüssel des Store-Schlüssels, eigenem AAD und eigenem Lock `oauth.lock`, nach dem Muster von `mail-workflow.enc`. Damit konkurrieren häufige Refreshes nicht mit dem Store-Lock, und das Store-Schema bleibt v1. Feste Obergrenzen (*50 Geräte, 500 aktive Familien*), fail closed bei Beschädigung, nie automatisch zurückgesetzt.
- **Rechte (Principal):** neue Art `oauth_client`.
  - Standard: Lesen im Umfang von §11, Frage 3. Vorschlag: wie `READONLY_PRINCIPAL`.
  - Schreiben nur über einen ausdrücklichen Grant pro Gerät und Konto: `perch oauth grant <oc-id> --capabilities send,calendar_write --accounts …`. Dieselben Familien- und Capability-Regeln wie `perch client add` (`src/auth/grants.ts`), Revalidierung vor jedem Tool-Aufruf.
  - Scopes vergeben **nie** Schreibrechte. Ein Client kann sich Schreiben also nicht „erbitten“.
- **Namespaces:** erste Version nur Root (§11, Frage 5).

## 7. Audit und Benachrichtigung

- Jede Anmeldung (Erfolg und Fehlschlag mit Grund), jede Freigabe, Ablehnung und jeder Widerruf, jede erkannte Wiederverwendung und jeder Notschalter wird ohne Inhalte im bestehenden Audit-Ledger protokolliert. Neue Felder: OAuth-Geräte-ID, Ereignis, Herkunft (§8). Tokens, Codes und Google-Tokens nie.
- `perch audit list` zeigt die Ereignisse.
- **Benachrichtigung** (Kanal: §11, Frage 2): neues Gerät angefragt, Anmeldung von neuer Herkunft, erkannte Wiederverwendung, Sperre nach Fehlversuchen, Notschalter. Fällt der Kanal aus, läuft die Anmeldung trotzdem (die Freigabe bleibt ja Pflicht), aber der Fehler wird protokolliert.

## 8. Härtung des öffentlichen Listeners

- **Herkunft:** Funnel-Requests erreichen Perch über `tailscaled` auf Loopback. Ob Funnel die Client-IP verlässlich weitergibt (etwa als `X-Forwarded-For`), ist **nicht verifiziert** und muss live geprüft werden. Bis dahin gelten die Limits global, und „neue Herkunft“ wird über den User-Agent und das Gerät erkannt, nicht über die IP.
- **Rate-Limits** (*Token-Bucket*): Anmeldeseiten und `/oauth/authorize` *10/min*, `/oauth/token` *30/min*, `/mcp` *120/min* pro Gerät, alles zusammen *300/min*. Bei Überschreitung `429` mit `Retry-After`.
- **Sperren:** *5* fehlgeschlagene Anmeldungen in *15 min* sperren den Login *15 min* (exponentiell steigend) und lösen eine Benachrichtigung aus. *20* ungültige Bearer-Tokens pro Minute schalten `/mcp` *5 min* auf `401` ohne Store-Zugriff.
- **Anfragegrößen:** OAuth-Endpunkte *16 KiB*, `/mcp` wie heute. Header- und Request-Timeouts (`headersTimeout`, `requestTimeout`) kurz setzen.
- **Seiten:** kein JavaScript außer dem minimalen WebAuthn-Aufruf (per CSP-Hash), CSP `default-src 'none'`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Formulare per `POST` mit CSRF-Bindung an den Zwischenzustand. Gestaltung nach frilabs-Brand-Standard (`AGENTS.md`).
- **Host/Origin:** Nur der Host aus `<BASE>` wird angenommen. Für `/mcp` gilt die bestehende Origin-Regel.

## 9. CLI

| Befehl | Wirkung |
| --- | --- |
| `perch oauth login-allow add <email>` / `list` / `remove` | Allowlist der Google-Konten. Beim ersten Login wird der `sub` angeheftet. |
| `perch oauth passkey add` / `list` / `remove` | Passkey registrieren; gibt einen einmaligen Link auf dem **Tailnet-Listener** aus (*10 min*) |
| `perch oauth devices` | Geräteliste: ID, Name, Redirect-Host, Status, erstellt, zuletzt gesehen, Grants |
| `perch oauth approve <id>` / `reject <id>` / `revoke <id>` | Freigabe bzw. Widerruf |
| `perch oauth grant <id> --capabilities … --accounts …` / `ungrant` | Schreibrechte pro Gerät |
| `perch public off` | **Notschalter:** setzt einen Sperr-Marker (der öffentliche Listener beantwortet danach alles mit `503`, auch nach einem Neustart), widerruft alle OAuth-Familien und Geräte-Freigaben und protokolliert das. Gibt den Befehl `tailscale funnel … off` zum Abschalten von Funnel aus; Perch ändert Tailscale nicht selbst. |
| `perch public on` | hebt den Marker auf; Geräte müssen danach neu freigegeben werden |

`perch status` und die Statusseite zeigen zusätzlich: öffentlicher Zugang an/aus/gesperrt, Anzahl freigegebener Geräte, letzte Anmeldung.

## 10. Akzeptanzkriterien (Tests nur mit Mocks)

1. Der öffentliche Listener beantwortet `/status`, `/` und jeden unbekannten Pfad mit `404`, auch mit gültigem Token.
2. Das globale Token, Nutzer-Tokens und Client-Grant-Tokens werden am öffentlichen `/mcp` mit `401` abgelehnt.
3. Discovery-Dokumente entsprechen §3; ein `401` trägt `resource_metadata`.
4. Ohne PKCE-S256, mit falschem `resource`, fremder `client_id` oder nicht erlaubter `redirect_uri` gibt es keinen Code. Eine fremde `client_id` löst keinen Netzwerkzugriff aus.
5. Google-Konto außerhalb der Allowlist, falscher `sub`, ungültiges oder abgelaufenes ID-Token, falsche `nonce`: kein Code.
6. Ohne gültigen Passkey (wenn Pflicht) und ohne Geräte-Freigabe: kein Code.
7. Code nur einmal verwendbar; nach *60 s* ungültig.
8. Ein Refresh rotiert; das alte Refresh-Token sperrt bei Wiederverwendung die Familie samt aktuellem Access-Token.
9. Widerruf eines Geräts und `perch public off` wirken sofort auf laufende Tokens (nächster Request `401` bzw. `503`), auch nach einem Neustart.
10. Ein OAuth-Client ohne Grant sieht keine Schreib-Tools. Mit Grant gelten dieselben Konto-Familien-Regeln wie bei `perch client add`.
11. Rate-Limits und Sperren greifen wie in §8. Jede Anmeldung erzeugt einen Audit-Eintrag ohne Geheimnisse.
12. `oauth.enc` beschädigt, fremd oder verlinkt: öffentlicher Zugang fail closed (`503`), Tailnet-Listener unverändert.
13. `npm run check` grün, Offline-Guard: null externe Aufrufe. Neue Abhängigkeiten nur nach Lizenzprüfung (`licenses:check`).

**Live-Abnahme durch Fritz** (nicht automatisierbar): Funnel einrichten, Google-Web-Client anlegen, Passkey registrieren, claude.ai-Custom-Connector verbinden, Claude Code am Uni-Laptop verbinden, Gerät widerrufen, Notschalter testen, prüfen, ob Funnel die Client-IP liefert.

## 11. Offene Entscheidungen

1. **Passkey Pflicht oder optional?** *Empfehlung: Pflicht.* Google lässt Perch den zweiten Faktor bei privaten Konten weder erzwingen noch verlässlich nachweisen. Ohne Perch-Passkey hinge die Sicherheit allein an Fritz' Google-Einstellungen und einer funktionierenden Phishing-Abwehr dort.
2. **Freigabe neuer Geräte und Benachrichtigungskanal:** Freigabe im Tailnet/CLI mit Telegram nur als Hinweis (*Empfehlung*) oder Freigabe direkt per Telegram? Wie spricht Perch friagent an (Schnittstelle, Authentifizierung)? friagent ist nicht Teil dieses Repos.
3. **Standard-Leseumfang eines OAuth-Clients:** alles wie das globale Token (Drive, Notion, Mail, Kalender, Kontakte, Slack, WhatsApp) oder ohne WhatsApp/Slack, mit Freischaltung pro Gerät?
4. **Ports:** Funnel auf 443 und Tailnet-Serve auf 8443 (*Empfehlung*: die Connector-URL hat keinen Port) oder Funnel auf 8443 und Serve bleibt auf 443?
5. **Nutzer-Namespaces:** in der ersten Version nur Root (*Empfehlung*) oder gleich für admin-angelegte Nutzer mit eigener Allowlist?
6. **Weitere Clients:** Sollen Codex oder andere MCP-Clients ohne CIMD unterstützt werden? Das bräuchte DCR oder vorregistrierte Clients.
7. **Neue Abhängigkeiten:** WebAuthn- und JWT-Prüfung selbst mit `node:crypto` bauen (keine Abhängigkeit, mehr eigener Krypto-Code) oder etablierte Bibliotheken (z. B. `@simplewebauthn/server`, `jose`; Lizenzprüfung nötig)? *Empfehlung: Bibliotheken.*
8. **Lebensdauern** aus §6 und Limits aus §8 bestätigen.

## 12. Primärquellen (dokumentationsgeprüft am 2026-10-14, nicht live validiert)

- Claude, Authentifizierung für Connectors: <https://claude.com/docs/connectors/building/authentication>. Belegt: `401` + `resource_metadata` nötig; nur der erste Eintrag in `authorization_servers` zählt; CIMD nur bei `client_id_metadata_document_supported: true` und `none` in `token_endpoint_auth_methods_supported`, sonst DCR; PKCE S256 immer; Callback `https://claude.ai/api/mcp/auth_callback`; Claude Code mit Loopback-Redirect auf beliebigem Port und eigenem CIMD (`https://claude.ai/oauth/claude-code-client-metadata`); Refresh-Rotation für öffentliche Clients, `invalid_grant` bei ungültigem Refresh; Token-Endpunkt `application/x-www-form-urlencoded`; Zeitlimits 10 s / 30 s; Anthropic-Egress `160.79.104.0/21`.
- Anthropic-Hilfe zu Custom Connectors: <https://support.claude.com/en/articles/11503834>. Hinweis, dass die Callback-URL künftig unter `claude.com` liegen kann.
- MCP Authorization 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>. RFC 9728 Pflicht, CIMD SHOULD, DCR MAY. **Aus der Prüfumgebung nicht abrufbar** (DNS), nur über Suchergebnisse bestätigt. Eine Sekundärquelle (<https://ssojet.com/blog/mcp-authorization-spec-2026-07-28-what-changed>) nennt eine neuere Revision 2026-07-28; vor der Umsetzung gegen die Primärquelle prüfen.
- Tailscale Funnel: <https://tailscale.com/kb/1223/funnel>. Ports nur 443, 8443, 10000; ein Port ist ganz Serve (privat) oder ganz Funnel (öffentlich); braucht MagicDNS, HTTPS-Zertifikate und das Node-Attribut `funnel` in der Policy. Nur über Suchergebnisse bestätigt (DNS), Header-Verhalten (Client-IP) **nicht** belegt.
- RFC 9728 (Protected Resource Metadata), RFC 8414 (AS Metadata), RFC 8707 (Resource Indicators), RFC 7636 (PKCE), RFC 7009 (Revocation), RFC 8252 (Native Apps), OAuth 2.1 Draft (Refresh-Rotation).
