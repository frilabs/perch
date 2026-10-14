# Briefing: Öffentlicher Zugang zu Perch über OAuth

Stand 2026-10-14. **Status: Entwurf, nicht freigegeben.** Grundlage ist Fritz' Plan vom 2026-10-14 („Perch aus dem Internet erreichbar, mindestens so sicher wie heute im Tailnet“). Laut `AGENTS.md` wird erst nach Fritz' Freigabe dieses Briefings und der Spezifikation `docs/PUBLIC_ACCESS_SPEC.md` Code geschrieben.

## Problem

Perch ist heute nur im Tailnet erreichbar (Tailscale Serve oder SSH-Tunnel). Auf Geräten ohne Tailscale geht das nicht, etwa am Uni-Laptop oder in claude.ai im Browser, auf dem Handy und in Cowork. Die gehosteten Claude-Apps verbinden sich außerdem aus Anthropics Netz (`160.79.104.0/21`), nicht vom Gerät aus. Ein Custom Connector in claude.ai erreicht ein reines Tailnet also grundsätzlich nicht.

## Heutiges Sicherheitsniveau (Messlatte)

Ein Angreifer braucht heute **beides**:

1. ein Gerät im Tailnet (Tailscale-Login, Geräte-Autorisierung, ACLs) und
2. ein Perch-Token (globales Read-only-Token, Nutzer-Token oder Client-Grant-Token mit 256 Bit Entropie).

Schreibrechte (Senden, Kalender-Schreiben) gibt es nur über lokale Client-Grants pro Konto (`perch client add`). Konten werden nur lokal per CLI verbunden.

## Zielbild

- Perch ist unter einer öffentlichen HTTPS-Adresse (Tailscale Funnel) als MCP-Server nach der **MCP-Autorisierung (OAuth 2.1)** erreichbar. In claude.ai trägt Fritz die Adresse ein, meldet sich im Browser an und ist verbunden. Claude Code am Uni-Laptop funktioniert genauso.
- Die weggefallene Tailnet-Schicht wird durch eine **gleich starke Anmeldung** ersetzt: nur Fritz, mit zweitem Faktor, pro Gerät, einzeln widerrufbar.
- Öffentlich sind **nur** `/mcp` und die Anmelde- und OAuth-Endpunkte. Statusseite, Konten verbinden und alles Administrative bleiben im Tailnet bzw. in der lokalen CLI.
- Das bestehende Rechtemodell bleibt: Ein über OAuth angemeldeter Client liest standardmäßig nur. Schreiben braucht weiterhin eine ausdrückliche Freigabe pro Konto.
- Ein Notschalter macht Perch sofort wieder rein tailnet-intern und alle OAuth-Tokens ungültig.

## Bausteine (aus Fritz' Plan)

1. **Anmeldung über Google** (OpenID Connect) gegen eine feste Allowlist von Fritz' Google-Konten. Perch speichert kein Passwort.
2. **Passkey direkt in Perch** (WebAuthn). Im Plan optional. Der Spec-Entwurf schlägt ihn als **Pflicht** vor, siehe unten.
3. **Kurzlebige Tokens:** Access-Token ca. 1 Stunde, Refresh-Token rotieren bei jeder Nutzung. Wird ein altes Refresh-Token erneut benutzt, wird die ganze Token-Kette gesperrt.
4. **Geräteliste mit Freigabe:** Jeder neue Client ist ein eigener Eintrag (Name, Datum, Herkunft). Neue Einträge müssen bestätigt werden, einzeln widerrufbar.
5. **Rechte wie heute:** standardmäßig nur lesen; Senden und Kalender-Schreiben nur per ausdrücklichem Grant pro Konto.
6. **Bremsen:** Rate-Limits, Sperre nach Fehlversuchen, Protokoll jeder Anmeldung, Benachrichtigung bei neuem Gerät oder Ort.
7. **Minimale Angriffsfläche:** nur `/mcp` und die Anmeldeseiten öffentlich.
8. **Notschalter:** ein Befehl sperrt den öffentlichen Zugang und widerruft alle OAuth-Tokens.

## Befunde aus der Quellenprüfung (2026-10-14)

Die Quellen sind dokumentationsgeprüft, nicht live getestet. Einzelheiten und Links stehen in der Spec, §12.

- **Funnel gilt pro Port, nicht pro Pfad.** Ein Port ist entweder ganz privat (Serve) oder ganz öffentlich (Funnel). Erlaubt sind nur die Ports 443, 8443 und 10000. „Nur `/mcp` öffentlich, `/status` privat“ geht also nur mit **zwei getrennten Ports**. Der Spec-Entwurf löst das mit einem eigenen öffentlichen Listener in Perch, der die Admin-Routen gar nicht kennt.
- **Google lässt Perch den zweiten Faktor nicht prüfen.** Bei privaten Google-Konten kann eine Anwendung keine Zwei-Faktor-Anmeldung erzwingen und bekommt auch keinen verlässlichen Nachweis, dass eine stattgefunden hat. „Google erzwingt den zweiten Faktor“ hängt allein an Fritz' Kontoeinstellungen. Deshalb schlägt der Entwurf den Perch-Passkey als Pflicht vor, damit die Messlatte unabhängig von Google erreicht wird.
- **claude.ai verlangt** PKCE (S256), Protected Resource Metadata (RFC 9728), einen `401` mit `resource_metadata`, die Callback-URL `https://claude.ai/api/mcp/auth_callback` und rotierende Refresh-Tokens für öffentliche Clients. Als Registrierung reichen **Client ID Metadata Documents (CIMD)**. Dynamic Client Registration wird damit unnötig, was einen offenen Schreib-Endpunkt erspart.
- **Neuere MCP-Spec-Revision:** Eine Sekundärquelle nennt eine Revision 2026-07-28, die DCR zugunsten von CIMD abkündigt. Die Primärquelle war aus der Prüfumgebung nicht erreichbar und muss vor der Umsetzung gelesen werden.

## Nicht im Umfang

- Änderungen an Tailscale durch Perch selbst (Funnel/Serve richtet Fritz ein; Perch dokumentiert die Befehle)
- Konten verbinden, Nutzerverwaltung oder Statusseite über das Internet
- Andere Identitätsanbieter als Google, Passwort-Login
- Öffentlicher Zugang für admin-angelegte Nutzer-Namespaces (erste Version nur Root-Namespace, siehe offene Fragen)
- Gehärteter Multi-Tenant-Betrieb, Listing im Claude-Connector-Verzeichnis
- Deployment, Live-Tests mit echten Konten (macht Fritz)

## Offene Entscheidungen für Fritz

Siehe `docs/PUBLIC_ACCESS_SPEC.md` §11. Die wichtigsten:

1. Ist der Perch-Passkey Pflicht (Empfehlung) oder optional?
2. Wie wird ein neues Gerät freigegeben: im Tailnet bzw. per CLI (Empfehlung) oder per Telegram über friagent?
3. Wie viel darf ein OAuth-Client standardmäßig lesen: alles wie das globale Token, oder ohne WhatsApp und Slack?
4. Welcher Port wird öffentlich: 443 für Funnel (Tailnet-Serve zieht auf 8443 um) oder 8443 für Funnel?
