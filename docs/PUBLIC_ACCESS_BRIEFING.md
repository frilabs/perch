# Briefing: Öffentlicher Zugang zu Perch über OAuth

Stand 2026-10-14. **Status: freigegeben und umgesetzt** (Fritz am 2026-10-14: „Passt alles, implementiere“; Umsetzung siehe `docs/PUBLIC_ACCESS_SPEC.md` §15 und `docs/SETUP.md` §6a). Grundlage ist Fritz' Plan vom 2026-10-14 („Perch aus dem Internet erreichbar, mindestens so sicher wie heute im Tailnet“). Fritz' Entscheidungen zu den offenen Fragen vom selben Tag stehen unten. Laut `AGENTS.md` wird erst nach Fritz' Freigabe der Spezifikation `docs/PUBLIC_ACCESS_SPEC.md` Code geschrieben.

## Produktrahmen

Perch ist ein Produkt zum **Selbsthosten**: installieren, Konten verbinden, auf dem eigenen Server betreiben. Wer Perch installiert, ist Eigentümer und einziger Nutzer seiner Installation (der **Betreiber**, Root-Namespace). Ein Ausrollen an weitere Personen ist nicht geplant. Deshalb ist nichts fest auf Fritz zugeschnitten:

- Google-Allowlist, Google-OAuth-Client, Perch-Code (TOTP), öffentliche Adresse und Benachrichtigungskanal richtet jeder Betreiber selbst ein.
- Perch liefert keine gemeinsame OAuth-App und keinen gemeinsamen Dienst mit.
- friagent ist Fritz' persönliches System und keine Abhängigkeit von Perch. Später bekommt friagent eine MCP-Schnittstelle und verbindet sich damit wie jeder andere Client mit Perch (eigenes Vorhaben, nicht Teil dieses Plans).

## Problem

Perch ist heute nur im Tailnet erreichbar (Tailscale Serve oder SSH-Tunnel). Auf Geräten ohne Tailscale geht das nicht, etwa am Uni-Laptop oder in claude.ai im Browser, auf dem Handy und in Cowork. Die gehosteten Claude-Apps verbinden sich außerdem aus Anthropics Netz (`160.79.104.0/21`), nicht vom Gerät aus. Ein Custom Connector in claude.ai erreicht ein reines Tailnet also grundsätzlich nicht.

## Heutiges Sicherheitsniveau (Messlatte)

Ein Angreifer braucht heute **beides**:

1. ein Gerät im Tailnet (Tailscale-Login, Geräte-Autorisierung, ACLs) und
2. ein Perch-Token (256 Bit Entropie).

Schreibrechte (Senden, Kalender-Schreiben) gibt es nur über lokale Client-Grants pro Konto (`perch client add`). Konten werden nur lokal per CLI verbunden.

## Zielbild

- Perch ist unter einer öffentlichen HTTPS-Adresse als MCP-Server nach der **MCP-Autorisierung (OAuth 2.1)** erreichbar. In claude.ai trägt der Betreiber die Adresse ein, meldet sich im Browser an und ist verbunden. Claude Code am Uni-Laptop und andere MCP-Clients funktionieren genauso.
- Die weggefallene Tailnet-Schicht wird durch eine **gleich starke Anmeldung** ersetzt: ein lokal geöffnetes **Kopplungsfenster** mit Kopplungscode, Google-Konto aus der Allowlist, eigener Perch-Code und eine abschließende lokale Bestätigung. Jedes Gerät ist einzeln widerrufbar.
- Öffentlich sind **nur** `/mcp` und die Anmelde- und OAuth-Endpunkte. Statusseite, Konten verbinden und alles Administrative bleiben lokal (CLI auf dem Server, Loopback, optional Tailnet).
- Tailscale ist **nicht** Voraussetzung. Der dokumentierte Standardweg ist Tailscale Funnel; jeder andere TLS-Reverse-Proxy mit eigener Domain geht auch.
- Rechtemodell wie heute: Ein OAuth-Client liest standardmäßig alles, was das globale Token liest. Schreiben braucht weiterhin eine ausdrückliche Freigabe pro Konto.
- Ein Notschalter sperrt den öffentlichen Zugang sofort und macht alle OAuth-Tokens ungültig.

## Entscheidungen (Fritz, 2026-10-14)

| Frage | Entscheidung |
| --- | --- |
| Zweiter Faktor | **Pflicht**, als eigener **Perch-Code (TOTP)** aus einer Authenticator-App, nicht als Passkey. Einrichtung lokal per QR-Code, dazu Notfall-Codes. |
| Freigabe neuer Geräte | lokal (CLI bzw. Tailnet/Loopback-Seite). Telegram nur als **Hinweis**. |
| Benachrichtigung | optional und austauschbar. Erster Kanal: Telegram-Bot direkt, vom Betreiber eingerichtet. friagent wird keine Abhängigkeit. |
| Leseumfang eines OAuth-Clients | **alles**, was das globale Token liest |
| Öffentliche Adresse | „was am besten passt“; Tailnet nicht zwingend. Umsetzung: Funnel auf 443 als Standard, beliebiger TLS-Proxy möglich (Spec §1). |
| Namespaces | **nur Root**, als Grundsatz (eine Person pro Installation) |
| Clients ohne Metadaten-Dokument (z. B. Codex) | **ja, unterstützen** (Spec §4) |
| Bibliotheken | **selbst bauen**, keine neuen Abhängigkeiten (Spec §5, §11) |
| Phishing-Schwäche von TOTP | „so sicher wie möglich“ beheben. Umsetzung: Anmeldung nur in einem lokal geöffneten Kopplungsfenster mit Kopplungscode, ein Gerät pro Fenster, abschließende lokale Bestätigung mit den Details der Anmeldung, jede neue Anmeldung ist eine neue Kopplung (Spec §0, §6). |
| Lebensdauern und Limits | wie vorgeschlagen bestätigt (Spec §7, §9) |
| `perch user add` (Nutzer-Isolation) | **entfernen** (Spec §11a) |

## Befunde aus der Quellenprüfung (2026-10-14)

Die Quellen sind dokumentationsgeprüft, nicht live getestet. Einzelheiten stehen in der Spec, §14.

- **Funnel gilt pro Port, nicht pro Pfad**, und nur auf den Ports 443, 8443 und 10000. Deshalb hat Perch einen eigenen öffentlichen Listener, der die Admin-Routen gar nicht kennt.
- **Google lässt Perch den zweiten Faktor nicht prüfen.** Deshalb der eigene Perch-Code.
- **claude.ai verlangt** PKCE (S256), Protected Resource Metadata (RFC 9728), einen `401` mit `resource_metadata`, die Callback-URL `https://claude.ai/api/mcp/auth_callback` und rotierende Refresh-Tokens.
- **Neuere MCP-Spec-Revision:** Eine Sekundärquelle nennt eine Revision 2026-07-28. Die Primärquelle muss vor der Umsetzung gelesen werden.

## Nicht im Umfang

- Änderungen an Tailscale oder am Reverse-Proxy durch Perch selbst (Perch dokumentiert die Befehle)
- Konten verbinden oder Statusseite über das Internet
- Andere Identitätsanbieter als Google, Passwort-Login, Passkeys
- MCP-Schnittstelle für friagent
- Listing im Claude-Connector-Verzeichnis
- Deployment, Live-Tests mit echten Konten (macht der Betreiber)
