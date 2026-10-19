# Briefing und Spezifikation (Entwurf): Luma über den offiziellen Luma-MCP

Stand 2026-10-15. **Status: Freigegeben** (Fritz am 2026-10-15: „perch repo, mit gegenprobe, ja, passt. Implementiere“). **Umgesetzt**, nur mit Mocks getestet; Abweichungen in §10. Grundlage: Fritz' Wunsch „Perch soll auch den Luma MCP connecten“ und der Designvorschlag vom 2026-10-15 (Lesen, Events anlegen/ändern, Gäste einladen/freigeben, Blasts senden; kein Luma Plus vorhanden). Laut `AGENTS.md` wird erst nach Fritz' Freigabe Code geschrieben.

## 1. Ziel

- Perch bindet ein oder mehrere Luma-Konten an, indem es sich als **MCP-Client** mit dem offiziellen Luma-MCP-Server (`https://mcp.luma.com`) verbindet. Die Anmeldung läuft per OAuth mit dem Luma-Konto, ohne API-Schlüssel und ohne Luma Plus.
- Perch reicht eine **feste Auswahl** von Luma-Tools mit seinen eigenen Schutzmechanismen weiter: Herkunftsangabe, Grants, Idempotenz, Audit, Prüfung vor jedem Tool-Aufruf.
- Zugriff wie bei den anderen Diensten: lesen über das globale Token bzw. gekoppelte Geräte, Schreiben nur mit Grant pro Konto.

## 2. Nicht verifiziert (vor der Umsetzung live prüfen)

Aus der Entwicklungsumgebung waren `mcp.luma.com` und die Luma-Hilfe nicht erreichbar. Zu prüfen:

1. Welche Client-Registrierung Lumas Authorization Server anbietet: CIMD, DCR oder beides (`/.well-known/oauth-authorization-server`).
2. Ob Refresh-Tokens ausgegeben und rotiert werden, und wie lange sie gelten.
3. Die tatsächliche Tool-Liste mit Eingabe-Schemas. Die Einteilung in §5 stützt sich auf die Toolnamen des Luma-Connectors in claude.ai.
4. Ob Luma Rate-Limits für MCP-Clients nennt.

## 3. Anmeldung

- `perch luma add --label NAME` startet OAuth 2.1 mit PKCE (S256) und Loopback-Redirect `http://127.0.0.1:<port>/callback`. Bei Bedarf geht das per SSH-Portweiterleitung, wie bei `perch google add`.
- **Client-Identität:**
  - Bietet Luma DCR an, registriert sich Perch pro Konto selbst. Dann braucht es kein Dokument.
  - Sonst nutzt Perch **ein** Client ID Metadata Document für das Produkt, wie Claude Code mit `claude.ai/oauth/claude-code-client-metadata`. Es ist kein Dokument pro Installation: Der Client ist öffentlich, ohne Secret, mit reinen Loopback-Redirects.
  - Wo das Dokument liegt, entscheidet Fritz (§9, Frage 1). Die Adresse ist in Perch fest hinterlegt und per `PERCH_LUMA_CLIENT_ID` überschreibbar, damit andere Betreiber nicht von frilabs.dev abhängen.
- Tokens liegen verschlüsselt im Store (neue Sektion `luma`, Store-Schema v1 bleibt). Der Refresh läuft single-flight; Widerruf und Rotation schlagen geschlossen fehl, wie bei Google und Microsoft.
- Die Identität des Kontos ermittelt Perch nach der Anmeldung über das Luma-Tool `get_self` und speichert sie. Das Label vergibt der Betreiber.

## 4. Technik: Perch als MCP-Client

- Perch nutzt den Client aus `@modelcontextprotocol/sdk` (Streamable HTTP), also keine neue Abhängigkeit. Die einzige Origin ist fest `https://mcp.luma.com`, dazu die Origin des Authorization Servers aus Lumas Metadaten nach Prüfung gegen eine feste Liste.
- **Tool-Allowlist mit Schema-Pin:** Für jedes durchgereichte Tool hält Perch den Namen, die Gruppe (§5) und einen Hash des Eingabe-Schemas fest.
  - Weicht das Schema beim Verbindungsaufbau ab oder fehlt das Tool, blendet Perch es aus und meldet das in `perch status`.
  - Unbekannte neue Tools bleiben verborgen.
- **Argumente:** Perch prüft die Eingaben gegen das eigene zod-Schema und reicht nur bekannte Felder weiter.
- **Ergebnisse:** gelten als nicht vertrauenswürdig (Prompt Injection). Sie werden größenbegrenzt und mit Herkunft (Konto-ID und Label) versehen.
- **Lesen über mehrere Konten:** optionaler Fan-out mit Teilergebnissen und Cursor, wie bei Drive.

## 5. Tools und Rechte

| Gruppe | Luma-Tools (laut claude.ai-Connector) | Wer darf |
| --- | --- | --- |
| Lesen | `get_self`, `list_calendars`, `get_calendar`, `list_events`, `list_calendar_events`, `get_event`, `search_events`, `list_guests`, `get_guest`, `list_blasts`, `list_coupons`, `list_membership_tiers`, `list_calendar_contacts`, `list_calendar_contact_tags`, `list_calendar_event_tags`, `list_pending_calendar_events`, `list_organizations`, `list_organization_calendars`, `lookup_entity` | globales Token, gekoppelte Geräte, Grant `luma_read` |
| Events | `create_event`, `update_event`, `create_ticket_type`, `add_registration_question`, `update_registration_question`, `reorder_registration_questions`, `add_calendar_event`, `approve_calendar_events`, `reject_calendar_events`, `apply_calendar_event_tag`, `unapply_calendar_event_tag` | Grant `luma_events` |
| Gäste | `invite_guests`, `update_guest_status`, `update_guest_tickets` | Grant `luma_guests` (verschickt E-Mails an Dritte) |
| Blasts | `create_blast` | Grant `luma_blast` (Rundmail an alle Gäste, nicht rückholbar) |
| Gar nicht | alle `delete_*`/`remove_*`, `add_calendar_admins`, `add_organization_admins`, `add_host`, `update_host`, `add_to_membership`, `update_membership_status`, `import_calendar_contacts`, `add_calendar_to_organization`, `create_calendar`, `update_calendar`, `update_self`, `create_coupon`, `update_coupon`, `update_blast`, `send_feedback`, `search_people` | niemand |

Begründungen für „gar nicht“:
- Co-Hosts und Admins erhalten selbst Kontrolle über das Konto.
- Kontakt-Import und Mitgliedschaften betreffen Dritte massenhaft.
- `search_people` durchsucht Personen außerhalb der eigenen Events.
- Coupons verändern Preise.

Die Einteilung wird nach §2 Punkt 3 gegen die echte Tool-Liste geprüft.

## 6. Schreiben: Idempotenz und Audit

- Jedes schreibende Tool verlangt eine `requestId`. Es nutzt denselben Ledger wie Mail, Slack und WhatsApp (`src/messaging/send.ts`):
  - Ein dauerhafter Claim entsteht vor dem Aufruf; es gibt genau einen Versuch.
  - Ergebnis `accepted`, `rejected` oder `indeterminate`.
  - Ein unterbrochener Aufruf wird nie automatisch wiederholt.
- Luma-Tools haben vermutlich keine eigenen Idempotenz-Schlüssel. Perch garantiert deshalb nur, selbst nie doppelt aufzurufen. Bei `indeterminate` muss der Betreiber in Luma nachsehen.
- `luma_blast` verlangt zusätzlich das Feld `confirmRecipientCount`: die Zahl der Gäste, die die Rundmail erreichen soll. Perch prüft sie vor dem Senden gegen `list_guests` und lehnt bei Abweichung ab.
- Audit wie bisher, ohne Inhalte: Tool, Konto, Ergebnis, Code.

## 7. CLI und Konfiguration

- `perch luma add --label NAME [--port N] [--timeout SECONDS]`, `perch luma list`, `perch luma remove ID [--revoke]`, `perch luma tools` (verfügbare und ausgeblendete Tools mit Grund).
- `perch client add` bzw. `perch oauth grant` mit `--allow luma_read,luma_events,luma_guests,luma_blast --account luma-…`.
- `perch status`: Live-Check pro Konto über `get_self`.
- Neue Variable: `PERCH_LUMA_CLIENT_ID` (optional, überschreibt die eingebaute Client-ID).

## 8. Akzeptanzkriterien (Mocks)

1. Ein unbekanntes, ein geändertes oder ein „gar nicht“-Tool ist für niemanden sichtbar und nicht aufrufbar.
2. Lesen ohne Grant geht. Jede Schreibgruppe ohne passenden Grant scheitert vor jeder Anfrage an Luma, und für das falsche Konto ebenfalls.
3. Gleiche `requestId` und gleicher Inhalt rufen Luma genau einmal auf. Anderer Inhalt unter derselben `requestId` scheitert vor jeder I/O.
4. Ein Blast mit falscher `confirmRecipientCount` wird abgelehnt, ohne dass gesendet wird.
5. Ein Widerruf oder ein abgelaufener Refresh schlägt geschlossen fehl, mit Hinweis auf Neuverbindung.
6. Argumente außerhalb des eigenen Schemas werden nie an Luma weitergereicht.
7. Anfragen gehen nur an die festen Origins. Der Offline-Guard zählt null externe Aufrufe.
8. `npm run check` grün, keine neuen Produktionsabhängigkeiten.

## 9. Offene Entscheidungen für Fritz

1. **Client-ID-Dokument:** Falls Luma kein DCR anbietet, wo soll das Metadaten-Dokument liegen?
   - (a) frilabs.dev, mit einem PR im home-Repo. Dieses Repo ist in dieser Session nicht verbunden.
   - (b) GitHub Pages des Perch-Repos.
   - (c) Jeder Betreiber hostet es selbst.

   Empfehlung: (b), weil es zum Produkt gehört und nicht zu einer persönlichen Domain.
2. **Blasts:** wie in §6 mit Bestätigung der Empfängerzahl (Empfehlung), oder vorerst gar nicht?
3. **Gäste einladen:** Sollen Einladungen an Adressen gehen dürfen, die noch nie Gast in einem eigenen Event waren? Empfehlung: ja, aber höchstens *50* Adressen pro Aufruf.
4. **Grenzfälle der Einteilung:** `add_host` und Coupons stehen in „gar nicht“. Passt das?

## 10. Umsetzung und Abweichungen (2026-10-15)

- **Entscheidungen §9:** Client-Dokument auf GitHub Pages des Perch-Repos (`pages/luma-client.json`, Workflow `.github/workflows/pages.yml`, veröffentlicht nur `pages/`); Blasts mit Gegenprobe; Einladungen höchstens 50 pro Aufruf; `add_host` und Coupons nie.
- **Schema-Pin statt eigener zod-Schemas:** Statt die (sehr großen) Luma-Schemas abzuschreiben, merkt sich Perch beim `perch luma add` die Schemas der erlaubten Tools mit einem Strukturhash (Trust on first use; Beschreibungs-Schlüsselwörter zählen nicht, gleichnamige Felder schon). Abweichung oder Wegfall sperrt das Tool bis `perch luma tools <id> --accept`; `perch status` meldet gesperrte Tools als Fehler. Tools mit Perch unbekannten Feldern auf oberster Ebene werden nie freigegeben. Perch registriert seine MCP-Tools aus den gespeicherten Schemas (`z.fromJSONSchema`, alle Objekte strikt), pro Client nur aus den Konten, die er nutzen darf; weichen deren Schemas voneinander ab, wird das Tool nicht angeboten. Schreibaufrufe prüfen das Schema unmittelbar vor dem Aufruf frisch.
- **Zusätzliche Regeln:** E-Mails an Dritte brauchen zusätzlich `luma_guests` (`update_event` mit `email_guests: true`, `approve_calendar_events`, `reject_calendar_events` mit Benachrichtigung); `update_guest_status` mit `should_refund: true` lehnt Perch ab.
- **Blast-Gegenprobe:** nur sofortige Blasts (kein `scheduled_for`) mit ausdrücklichem `recipient_groups` (nur `status`). Gezählt werden die Status `approved`, `pending_approval`, `waitlist`, `invited` über das gepinnte `list_guests` (seitenweise, doppelte Gäste einmal). Blasts mit Ticket-Filter oder an `checked_in` lehnt Perch ab, weil es sie nicht nachzählen kann. Ein unbekanntes Antwortformat oder weitere Seiten ohne Cursor führen zur Ablehnung (fail closed). Zwischen Zählen und Senden bleibt ein kurzes Zeitfenster.
- **Zusätzliches Tool:** `luma_write_status` (Ausgang eines eigenen früheren Schreibaufrufs).
- **Keine neuen Abhängigkeiten:** MCP-Client aus dem vorhandenen SDK; nur `https://mcp.luma.com/mcp` erreichbar, keine Redirects, kein SSE-Rückkanal (GET), Antworten höchstens 8 MiB, Timeout 30 s. OAuth-Endpunkte nur auf `luma.com`, `lu.ma` und deren Subdomains.
- **Weiter live zu prüfen (§2):** Registrierungsart, Refresh-Verhalten, echte Tool-Liste und Antwortformat von `list_guests` und `get_self`.
- **Nach dem unabhängigen Review (2026-10-15) behoben:** 401 von Luma wird am HTTP-Status erkannt (Token verworfen, ein neuer Versuch); ein Schreibaufruf, der vor dem eigentlichen Tool-Aufruf scheitert (401, Verbindungsaufbau), gilt als `rejected`, nicht als `indeterminate`; DCR wird bevorzugt (wie §3); Aussteller-Prüfung verlangt `issuer`; Lumas Fehlertext geht als eigenes Feld `lumaError` an den Client, nie in den Ledger; Ergebnisse pro Konto höchstens ~1 MB; ein Cursor nur zusammen mit `accountId`; `perch luma remove` nennt entfernte Client-Grants; `PERCH_LUMA_CLIENT_ID` wird geprüft.
- **Bewusst offen:** Refresh-Rotation zwischen CLI und Server ohne gemeinsames Lock (gleichzeitige Refreshes können ein `invalid_grant` auslösen); Luma-Toolbeschreibungen (bis 1500 Zeichen) stehen in Perchs Toolbeschreibungen und sind nicht vertrauenswürdig; ob Lumas Server die Redirect-URIs ohne Port im Client-Dokument akzeptiert, ist live zu prüfen.
