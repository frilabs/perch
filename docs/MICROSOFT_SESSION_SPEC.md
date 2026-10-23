# Spezifikation: ein Microsoft-Login auf dem Heimserver

Stand: 2026-10-23. **Entwurf zur Freigabe; keine Implementierungsfreigabe.**

Auftrag: ein allgemeines Microsoft-Konto (z. B. PA) in Perch mit Teams, dem eigenen Postfach, Kalender und SharePoint/OneDrive verbinden. Ein interaktiver Login auf dem Heimserver; kein dauerhaft laufender persönlicher Rechner, keine vom Nutzer anzulegende App und keine zusätzliche Admin-Freigabe für Perch. Zuerst Machbarkeit nachweisen, erst danach integrieren.

## 1. Produktversprechen und Grenzen

- Ein Microsoft-Konto erscheint als ein Eintrag mit vier separat prüfbaren und freischaltbaren Diensten. Gemeinsames Server-Browserprofil und Microsoft-SSO; kein universelles Token für alle Dienste.
- „Ohne Admin-Approval“ bedeutet: keine neue Entra-App-Zustimmung oder Teams-App-Installation. Die bestehende Berechtigung des Kontos wird genutzt. Normale Microsoft-Anmeldung, MFA, Geräte-, Netzwerk- und Sitzungsrichtlinien bleiben wirksam.
- Ein Login bedeutet eine anfängliche interaktive Anmeldung für alle vier Dienste. Erfordert ein Dienst dabei eine zweite eigenständige Anmeldung, besteht der vollständige Test nicht. Von Microsoft später erzwungene Wiederanmeldung wird ausdrücklich unterstützt und angezeigt; ewiger unbeaufsichtigter Zugang wird nicht versprochen.
- Kontoarten: Arbeits-/Schulkonten und persönliche Microsoft-Konten im gemeinsamen Modell. Produktverfügbarkeit wird erkannt: ein persönliches Konto ohne SharePoint oder ein Konto ohne Teams-Lizenz bekommt `unavailable`, keinen erfundenen Zugriff. Der erste Nachweis gilt nur für das konkret getestete Konto und dessen Mandant.
- Keine Umgehung einer verweigerten Gerätefreigabe, MFA oder expliziten Zugriffsblockade. Eine erfolgreiche Webanmeldung ist kein Nachweis, dass die Organisation Datenübertragung oder Automatisierung erlaubt.

## 2. Umfang

| Dienst | Lesen | Optionales Schreiben nach Integration |
| --- | --- | --- |
| Teams | eigene Chats, Gruppen, zugängliche Kanäle, Threads, Suche, Anhänge | Nachrichten und Antworten senden |
| Mail | eigenes Postfach: Ordner, Suche, Nachrichten, Anhänge | Entwürfe, senden/antworten/weiterleiten, markieren, verschieben, Papierkorb |
| Kalender | eigene Kalender, Termine, Serien und Zeitzonen | Termine erstellen/ändern; Einladungen separat freigeben |
| Dateien | eigener OneDrive und ausdrücklich ausgewählte zugängliche SharePoint-Sites/Bibliotheken: auflisten, suchen, Metadaten, Download | Upload, Ordner anlegen, Datei aktualisieren, Papierkorb |

„Mail“ meint ausschließlich das Postfach der verbundenen Identität, auch wenn der technische Zugang Outlook Web heißt. Fremde/geteilte Postfächer, zusätzliche Kalenderdelegationen, vollständige SharePoint-Listenverwaltung, Rechtevergabe, Site-Administration, Calls, Aufzeichnungen und organisationsweite Vollindizierung sind nicht Teil dieser Spec. In Teams geteilte Dateien allein erfüllen den SharePoint-Nachweis nicht.

Kalender-Löschen wird vorerst nicht angeboten: die bestehende Ausnahme für endgültiges Löschen gilt nur für Google. Absagen/Teilnahmeantworten mit Wirkung auf andere Personen benötigen die Einladungsfähigkeit und werden separat nachgewiesen.

## 3. Architekturentscheidung

Ein isolierter Session-Worker läuft auf dem Ubuntu-Heimserver unter dem bestehenden Perch-Betriebsmodell. Er besitzt ein Browserprofil pro Konto-Gruppe und vier Adapter. Perch bleibt die einzige MCP-Oberfläche und prüft Konto, Dienstfreigabe und Client-Grant vor jedem Auftrag. MCP-Clients erhalten weder Browserzugriff noch Tokens.

```text
MCP-Client → Perch: aktuelle Grants + Konto + Capability
                  ↓ enges, versioniertes lokales Protokoll
            Microsoft-Session-Worker
                  ├─ gemeinsames Browserprofil / Login / Refresh
                  ├─ Teams
                  ├─ Postfach
                  ├─ Kalender
                  └─ OneDrive / ausgewählte SharePoint-Bibliotheken
```

Adapter liefern strukturierte Daten. Sie dürfen nur geprüfte Operationen ausführen; kein generisches `fetch(url)`, JavaScript-Ausführen, Shell oder Browser-Steuern als MCP-Tool. Der Worker spricht über einen privaten Unix-Socket mit Perch. Auch im Worker gelten feste Operationsschemas, Konto-Bindung und Ziel-Allowlist.

### 3.1 Zwei technische Session-Wege

1. **Browsergebundener Weg als Standard:** Login und Erneuerung erfolgen im echten Microsoft-Webclient; Adapter bedienen die Oberfläche oder führen konkret geprüfte Operationen innerhalb dessen Browserkontext aus. Keine eigene OAuth-Anfrage unter einer Microsoft-First-Party-Client-ID außerhalb des Browsers.
2. **Direkter Session-API-Weg als gesonderte Option:** vorhandene Sitzungstokens außerhalb des Browsers für geprüfte HTTP-Aufrufe/Refresh verwenden. Effizienter, aber inoffiziell und möglicherweise unvereinbar mit der bisherigen Vorgabe „keine Nutzung fremder First-Party-Client-IDs“.

Diese Spec hebt jene Vorgabe **nicht** auf. Der Machbarkeitstest muss die Wege getrennt bewerten. Ein funktionierendes Upstream-Projekt mit externem First-Party-Refresh ist ein Befund, keine automatische Freigabe für Perch. Standardmäßig ist dieser Refresh deaktiviert. Wenn der vollständige Zugang nur damit möglich ist, lautet das Ergebnis `requires-policy-decision`; keine stillschweigende Aktivierung oder Integration.

### 3.2 Vorhandene Projekte

- `m0nkmaster/msteams-mcp` (MIT, TypeScript): erster Kandidat für Teams und strukturierte Session-APIs. Der geprüfte Code erneuert Tokens direkt unter der Teams-Webclient-ID, danach Browser-Fallback. Nur nach Prüfung dieses Unterschieds übernehmen oder kapseln.
- `YourSandwich/mautrix-teams` (AGPL-3.0): Referenz für Teams-Protokoll und Synchronisierung. Kein Code in den MIT-Kern kopieren; eine etwaige separate Bridge ist eine eigene Architektur-/Lizenzentscheidung. Matrix ist keine Voraussetzung dieser Spec.
- `chrischall/office-outlook-mcp`: Referenz für Mail/Kalender aus der Websitzung. Browser-Erweiterung und begrenzte Token-Lebensdauer lösen den autonomen Serverbetrieb nicht allein. Lizenz vor jeder Übernahme nachweisen; öffentlich sichtbarer Code genügt nicht.
- `beeper/teams`: dokumentierter Consumer-Fokus, kein Ersatz für den Firmenkonto-Nachweis.

Vor dem Experiment exakten Commit, Lizenz, Auth-Verfahren, Netzwerkziele und bekannte Auth-Issues erfassen. Keine Installation ungepinnter `latest`-Pakete im produktiven Perch-Prozess. Upstream-Funktionsbehauptungen sind bis zum eigenen Test unbestätigt.

## 4. Phase A: isolierter Machbarkeitstest

### 4.1 Voraussetzungen und Durchführung

Erst nach Freigabe dieser Spec einen separaten Experiment-Branch und einen vom produktiven Perch-Store getrennten Worker anlegen. Keine produktiven Grants oder bestehenden Microsoft-OAuth-Konten verändern. Browserabhängigkeiten und Profil unter dem dedizierten Server-Nutzer betreiben, Browser-Sandbox aktiviert; kein `--no-sandbox` als Standardlösung.

Den Server über `ssh home-ts '…'` verwalten; interaktive Anmeldung im SSH-Terminal und in einer temporären Server-Browseroberfläche. Der sichtbare Browser läuft tatsächlich auf dem Server. Zugriff über Loopback mit SSH-Tunnel oder authentifizierten Tailnet-Zugang, niemals Funnel/öffentliches Debugging. Remote-Desktop und Debugging nach dem Login schließen. Eine noVNC-/Remote-Desktop-Komponente ist vor Nutzung separat zu pinnen und zu prüfen.

1. Leeres Profil erzeugen, einmal Microsoft-Anmeldung und MFA ausführen. Kontotyp und stabile Identität feststellen.
2. Teams, eigenes Postfach, Kalender und eine gewählte SharePoint-Bibliothek sowie OneDrive im selben Profil öffnen. Keine Cookies vom persönlichen Rechner importieren; kein zweiter unabhängiger Login.
3. Je Dienst die unten definierten Leseoperationen ausführen; Konto-/Tenant-Zugehörigkeit prüfen. Fehlende Produkte als `unavailable` protokollieren.
4. Worker und Browser beenden; persönlichen Rechner ausschalten. Dienst ohne interaktive Anmeldung auf dem Server neu starten und dieselben Operationen ausführen.
5. Token-Erneuerung über echte Ablaufgrenzen prüfen, mindestens 72 Stunden beobachten: direkt nach Einrichtung, nach 2, 26, 50 und 72 Stunden. Kein dauerhaft laufender persönlicher Browser und keine manuelle Token-Erneuerung dazwischen. Nach 26 Stunden einen erneuten Worker-/Browser-Neustart prüfen; Server-Neustart nur geplant und mit bestehender Betriebsfreigabe.
6. Ungültige Sitzung und verweigerten Zugriff kontrolliert prüfen: keine Endlosschleife, eindeutiger Wiederanmeldestatus. Lokales Profil löschen als lokaler Fehlerfall; serverseitigen Widerruf nur dokumentiert und bewusst auslösen, da andere Sitzungen betroffen sein könnten.

Zeiten sind Testpunkte, keine zugesicherte Microsoft-Token-Lebensdauer. Ein 72-Stunden-Erfolg belegt keine unbegrenzte Nutzbarkeit. Der Test kann zeitversetzt fortgesetzt werden; kein Watcher oder geplanter Auftrag ohne gesonderten Auftrag.

### 4.2 Verbindliche Nachweise

| Bereich | Erfolgskriterium |
| --- | --- |
| Login | genau eine anfängliche interaktive Anmeldung, gleiche Identität bei allen Diensten, kein Admin-Consent |
| Teams | einen Chat und einen Kanal auflisten, Thread lesen, bekannte Nachricht suchen |
| Mail | eigenen Ordner auflisten, bekannte Mail suchen/lesen, ausgewählten Anhang abrufen |
| Kalender | Termine eines festen Zeitfensters lesen, Zeitzone und mindestens einen Serientermin korrekt zuordnen |
| OneDrive | eigenen Ordner auflisten, Testdatei finden und herunterladen |
| SharePoint | ausgewählte Site/Bibliothek unabhängig von Teams-Anhängen auflisten, Testdatei finden, Metadaten und Inhalt abrufen |
| Betrieb | vorgenannte Operationen nach Neustarts und Ablaufgrenzen ohne persönlichen Rechner wiederholen |
| Fehler | Ablauf, MFA-Bedarf, Richtlinienblockade und fehlendes Produkt getrennt anzeigen; keine Secrets ausgeben |
| Isolation | fremdes Profil, falscher Tenant und unbekanntes Netzwerkziel werden abgelehnt |

Lesetests verwenden vom Nutzer ausgewählte Inhalte. Persistierter Bericht enthält keine Nachrichten, E-Mail-Adressen, Dateinamen, Tenant-IDs, Tokens oder Screenshots mit Inhalten; nur lokale Konto-Aliasse, Methode, Zeitpunkt, Ergebnis, bereinigte Fehlerklasse und Nachweisreferenz. Technische stabile Identitäten bleiben im geschützten Credential-Bereich.

Schreibtests sind separat und ausdrücklich vorab für konkrete Testziele zu autorisieren: Selbst-Chat, Mail an die eigene Adresse, Termin ohne Gäste und neue Datei in einem eigenen Testordner. Keine Nachricht an Dritte, Einladung oder Änderung bestehender Arbeitsdateien im Machbarkeitstest. Nicht live geprüfte Schreiboperationen bleiben `unverified` und gesperrt.

### 4.3 Ergebnis und Übergang

Bericht `docs/MICROSOFT_SESSION_FEASIBILITY.md` enthält Commit-Pins, Kontoart, Betriebsvoraussetzungen, Ergebnismatrix pro Zeitpunkt/Dienst/Operation, genaue Auth-Methode, First-Party-Client-ID-Nutzung, Netzwerk-Allowlist, Wiederanmeldungen und bekannte Grenzen. Erst bei tatsächlicher Durchführung anlegen; keine vorgetäuschten Resultate.

- **GO:** alle vier Dienste einschließlich OneDrive und echter SharePoint-Bibliothek bestehen auf dem Zielkonto mit einem Login, ohne Admin-Freigabe und mit dem freigegebenen Auth-Verfahren den 72-Stunden-Test.
- **PARTIAL:** einzelne Dienste fehlen, brauchen einen zweiten Login oder verlieren die Sitzung. Vollständiges Produktversprechen nicht erfüllt; kleinere Integration nur nach ausdrücklich angepasster Spec-Freigabe.
- **REQUIRES-POLICY-DECISION:** Erfolg hängt von direktem externem First-Party-Refresh oder einer anderen bisher ausgeschlossenen Methode ab. Methode und Alternative zur Entscheidung vorlegen.
- **NO-GO:** Geräte-/Adminfreigabe erforderlich, Identität nicht sicher bindbar oder Zugriff nur durch Umgehung möglich. Kein automatischer Wechsel auf andere Client-IDs oder Protokolle.

**Phase B beginnt erst nach Vorlage des Berichts und ausdrücklicher Freigabe des nachgewiesenen Designs.** Die Freigabe dieser Spec erlaubt noch keinen produktiven Rollout.

## 5. Phase B: Integration nach bestandenem Test

### 5.1 Konto und CLI

Geplante Schnittstelle; die Befehle existieren noch nicht:

```bash
perch microsoft add --session --label "Microsoft"
perch microsoft access mgroup-ID
perch microsoft access mgroup-ID --service teams --read-only
perch microsoft access mgroup-ID --service mail --write
perch microsoft access mgroup-ID --service files --read-only
perch microsoft reconnect mgroup-ID
perch microsoft remove mgroup-ID
```

`add --session` erklärt den inoffiziellen Zugang und verlangt bewusstes Opt-in (im Terminal `[y/N]`, ohne TTY explizites `--yes`; kein unbeaufsichtigter Erstlogin). Alle verfügbaren Dienste werden geprüft, Standard nur Lesen. `access` steuert Dienstfreigaben getrennt vom Login; zusätzliche Dienstanmeldung wird bei Bedarf angezeigt, niemals als weiterhin garantiert „ein Login“ ausgegeben.

Kontogruppe über stabile Microsoft-Identität und Tenant binden, nicht über E-Mail oder Label. Adapter müssen dieselbe Identität nachweisen; ohne belastbaren Nachweis kein Zugriff. Tenant-Wechsel/Gastidentität erfordert einen ausdrücklich getrennten Kontext. Reconnect aktualisiert dieselbe Gruppe mit denselben Ressourcen-IDs und Grants. Identitätswechsel bricht ab, anstatt die Gruppe umzuhängen.

Vorhandene `microsoft-…`-Graph-Mailkonten und deren Grants bleiben unverändert. Keine automatische Migration oder stiller Auth-Moduswechsel. Neues `mgroup-…` mit separaten Mitgliedern pro Dienst; bestehende Mail-Familie kann für das neue Session-Mailmitglied verwendet werden, dessen ID bleibt eigenständig. Andere Dienste erhalten eigene Microsoft-Ressourcenfamilien. Gruppen-Grants werden explizit auf Mitglieder aufgelöst; keine Umdeutung alter IDs oder Google-Drive-/Google-Productivity-Familien. Ein später hinzugefügter Dienst erweitert enge Grants nicht automatisch; bestehendes ausdrückliches `--full` behält seine dokumentierte Semantik.

### 5.2 Freigaben und Operationen

Wirksamer Zugriff ist die Schnittmenge aus Microsoft-Zugriff, in Perch aktiviertem Dienst, Kontorechten und aktuellem Client-Grant. Operator/globales Token bleibt nur lesend. UI-Schreibrechte der Sitzung sind niemals automatisch MCP-Schreibrechte.

- Mail verwendet die bestehenden Fähigkeiten `read`, `draft`, `send`, `modify` auf dem Session-Mailmitglied.
- Neue Microsoft-Familien: Teams (`microsoft_teams_read`, `microsoft_teams_send`), Kalender (`microsoft_calendar_read`, `microsoft_calendar_write`, `microsoft_calendar_invite`), Dateien (`microsoft_files_read`, `microsoft_files_write`).
- Bestehende Mail-Tools werden über den Session-Mailprovider erweitert. Neue Tools werden als `microsoft_teams_*`, `microsoft_calendar_*`, `microsoft_files_*` benannt; jedes verlangt eine eindeutige Mitgliedskonto-ID und meldet die Gruppenzuordnung. Kein implizites „erstes Konto“.
- Leseoperationen markieren nichts als gelesen. Mail-/Teams-Markierung ist eine eigene mutierende Operation. Falls ein Browserweg unvermeidbar Lesebestätigungen auslöst, ist er kein nebenwirkungsfreier Leseweg; vor Freigabe gesondert kennzeichnen und entscheiden.
- SharePoint-Sites und Bibliotheken werden lokal ausgewählt; keine tenantweite Suche als Standard. Suchergebnisse werden auf freigegebene Ressourcen begrenzt. Bekannte Teams-Dateilinks erweitern diese Freigabe nicht automatisch.
- Senden/Antworten/Weiterleiten, Einladungen und Uploads laufen mit `requestId` durch den gemeinsamen Ledger. Gleiche ID mit anderem Inhalt/Ziel ablehnen. Nach Timeout oder Crash nach möglicher Annahme `indeterminate`, niemals blind erneut senden; keine Zusicherung von Exactly-once bei nicht idempotentem Upstream.
- Dateiaktualisierung mit Versionsbedingung/ETag, sofern nachgewiesen; sonst kein unbeaufsichtigtes Überschreiben. Nur Papierkorb; wenn ein Adapter dessen Semantik nicht garantieren kann, Löschen nicht anbieten.

## 6. Sitzungs-, Netzwerk- und Datensicherheit

- Tokens und Cookies im verschlüsselten Store nach bestehendem AES-256-GCM-Modell, Schlüssel separat. Browserprofil ist ebenfalls ein Credential: nicht fälschlich als vollständig durch den Store verschlüsselt bezeichnen. Privates Verzeichnis `0700`, Dateien soweit steuerbar `0600`; keine Profile in Git, allgemeinen Backups oder Logs. Laufendes Profil liegt außerhalb des verschlüsselten JSON-Stores und benötigt einen geschützten Datenträger; diese Grenze dokumentieren.
- Loginansicht und Browser-Debugging nur lokal/temporär erreichbar, kein beliebiger MCP-Client-Zugriff. Kein Profil des Alltagsbrowsers verwenden. Profil pro Konto, ein Worker-Lock gegen parallele Browser-/Refresh-Rennen; atomare Persistenz, nach gescheitertem Refresh kein Überschreiben funktionierender Credentials.
- Direkte Aufrufe ausschließlich über Perchs kontrollierten Upstream mit Methoden-, Pfad- und Capability-Allowlist. Browsertraffic benötigt zusätzlich eine getestete Egress-Policy: Graph, Teams, Outlook, konkrete SharePoint-/OneDrive-Hosts und nachgewiesene Login-/statische Ressourcen getrennt klassifizieren. Kein pauschales `*.microsoft.com`/`*.sharepoint.com` als Datenziel.
- Federation/SSO-Weiterleitungen und CDN-Hosts im Test erfassen und lokal ausdrücklich zulassen. Unbekannte Ziele stoppen mit bereinigter Diagnose; keine automatische Allowlist-Erweiterung aus Seiteninhalt.
- Download-Redirects und temporäre URLs pro Hop prüfen, private/Link-local/Metadatenziele sperren; Authorization/Cookies nicht an fremde Hosts weitergeben. Dateigrößen, MIME/Dateityp, Timeout und Parallelität begrenzen. Keine beliebigen vom Modell gelieferten URLs abrufen.
- Mitgelieferte MCPs nicht ungefiltert durchreichen: feste Tool-/Schema-Pins und eine Liste erlaubter Operationen; Grants werden unmittelbar vor jeder Mutation neu geprüft. Token-Refresh ist interne Credential-Verwaltung, kein MCP-Tool.
- Inhalte aus Mail, Teams und Dateien sind untrusted data, keine Handlungsanweisungen. Audit enthält nur Operation, lokale Konto-ID, Ergebnis und bereinigte Fehlerklasse; keine Inhalte, Auth-Header, Login-URLs oder Download-URLs mit Query-Secrets.
- Lokales Entfernen stoppt Worker, verwirft Queue und entfernt Credentials/Profil; vorhandene Ledger-Belege bleiben nach der bestehenden Aufbewahrung erhalten. Nicht als serverseitigen Microsoft-Widerruf ausgeben. Abmeldung/Widerruf separat erklären und mögliche Auswirkungen auf alle Dienste nennen.

## 7. Status und Fehlerverhalten

Ein Microsoft-Block pro Konto; darunter Teams, Mail, Kalender, Dateien mit Rechten, letzter erfolgreicher Prüfung und Zustand: `ready`, `unverified`, `unavailable`, `reauth_required`, `blocked_by_policy`, `degraded`. OneDrive und ausgewählte SharePoint-Bibliotheken werden innerhalb Dateien einzeln geprüft und angezeigt. Statusänderung eines Dienstes schaltet die anderen nicht pauschal ab; ein nachgewiesener gemeinsamer Sitzungswiderruf setzt alle betroffenen Dienste auf Wiederanmeldung.

`401`/`403` nicht pauschal als Admin-Consent interpretieren. Fehlendes Produkt, fehlende Ressourcenrechte, Sitzung abgelaufen, MFA, Rate-Limit, Richtlinienblockade und unbekannter Fehler bleiben unterscheidbar. Begrenzte Wiederholungen nur bei sicheren Lese-/Refresh-Aufrufen, `Retry-After` beachten. Kein wiederholtes MFA-Anstoßen oder endloser Browserstart. Bei Reauth nennt Status `perch microsoft reconnect mgroup-ID`.

## 8. Abnahme der Integration und Lieferung

- Unit-/Mocktests: Identitäts- und Tenantbindung, Gruppen-Reconnect, Legacy-Graph-Kompatibilität, Dienstfreigaben und Client-Grants, Schreibsperren, Ressourcenfilter, Token-Audience, Ablauf/Refresh-Rennen, Endpoint-/Redirect-Prüfung, Bereinigung und Ledger-Crashfälle.
- Worker-Integrationstests: Browser-/Worker-Neustart, Lock, beschädigtes Profil, lokales Entfernen, fehlender Browser, gesperrtes Ziel und unverfügbarer Dienst. Browser-Sandbox und Egress-Policy werden tatsächlich geprüft, nicht nur konfiguriert behauptet.
- Live-Abnahme pro freigeschalteter Operation und Kontoart; Mocks ersetzen keine Aussage über Session-Lebensdauer oder Produktverfügbarkeit. Nicht getestete Kontoarten/Funktionen als unbestätigt dokumentieren.
- Terminal-Onboarding und Status im echten Pseudo-Terminal prüfen. `npm run check` vor fertigem Push; bei Billing-Problemen lokales Ergebnis im PR nennen.
- README, SETUP, HANDOFF und Capability-/Lizenzdokumentation bei der Implementierung aktualisieren. Diese Spec ist zunächst die einzige Produktänderung.
- Branch und PR pro Phase; kein Merge und kein Deployment ohne Fritz' OK. Der Spec-PR enthält weder Browserabhängigkeiten noch Änderungen am laufenden Heimserver.

## 9. Quellen und Evidenzstand

Recherche aus dieser Unterhaltung, 2026-10-22; Links und Implementierungen vor dem Experiment erneut prüfen und auf konkrete Commits pinnen. **Noch kein Live-Nachweis mit PA oder einem anderen Microsoft-Konto.**

- Teams-MCP: https://github.com/m0nkmaster/msteams-mcp
- HTTP-Refresh unter Teams-Webclient-ID: https://github.com/m0nkmaster/msteams-mcp/blob/main/src/auth/token-refresh-http.ts
- HTTP-/Browser-Refresh-Orchestrierung: https://github.com/m0nkmaster/msteams-mcp/blob/main/src/auth/token-refresh.ts
- Bekannte Auth-Probleme: https://github.com/m0nkmaster/msteams-mcp/issues
- Firmen-Teams-Bridge: https://github.com/YourSandwich/mautrix-teams
- Consumer-Bridge: https://github.com/beeper/teams
- Outlook-Session-Referenz: https://github.com/chrischall/office-outlook-mcp
- Browser-Auth-State: https://playwright.dev/docs/auth
- Microsoft-Sitzungsrichtlinien: https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime

## 10. Freigabe

Mit Freigabe dieser Spec wird ausschließlich Phase A autorisiert. Phase B benötigt zusätzlich einen vorgelegten Machbarkeitsbericht und die Freigabe des darin nachgewiesenen Zugangswegs. Der direkte externe First-Party-Refresh ist durch diese Spec nicht freigegeben; sollte er nötig werden, ist das eine ausdrücklich zu entscheidende Abweichung.
