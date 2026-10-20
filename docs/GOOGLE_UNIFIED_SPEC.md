# Spezifikation: ein Google-Login für Drive, Gmail, Kalender und Kontakte

Stand 2026-10-21. **Von Fritz freigegeben** („warum sind google drive, gmail und calender separat … sollte er doch auf alle 3 zugriff haben“ → „baue das so“).

## Ziel

Ein Google-Konto wird mit **einem** Befehl und **einem** Browser-Login verbunden:

```bash
perch google add --label "Privat"
```

## Verhalten

1. Auswahl der Dienste (interaktiv, Standard alle): Drive, Gmail, Kalender, Kontakte. Flags: `--services drive,gmail,calendar,contacts`.
2. Einmal „[r]ead only, or read + [w]rite?“ (wie `chooseAccess`; `--write`/`--read-only`; die bisherigen `--allow-*`-Flags bleiben als Feinsteuerung gültig). Schreiben bedeutet: Drive `drive`, Gmail Entwürfe/Senden/Organisieren (`gmail.modify` bzw. die heute verwendeten Scopes), Kalender `calendar.events.owned`.
3. **Ein** OAuth-Flow (Loopback wie heute, Port 8766) mit allen Scopes der gewählten Dienste, `include_granted_scopes=true`.
4. Granulare Zustimmung: Google kann einzelne Scopes abwählen lassen. Perch wertet die tatsächlich gewährten Scopes aus, schaltet nur die Dienste/Fähigkeiten frei, die gewährt wurden, und sagt klar, was fehlt (und wie man es nachholt).
5. Ergebnis: dieselben Konto-Datensätze wie heute (`google-…` für Drive, `gmail-…`, `gprod-…`), damit Grants, Familien, Tools und `perch client add --account` unverändert funktionieren. Sie werden als **eine Google-Konto-Gruppe** verknüpft (gemeinsame Gruppen-Id, gleiche Identität/E-Mail) und teilen sich **eine** Anmeldung (ein Refresh-Token, einmal gespeichert; Token-Refresh und Fehler wie `invalid_grant` gelten für die ganze Gruppe konsistent, ohne Doppel-Refresh-Rennen).
6. `perch google list` zeigt Gruppen mit ihren Diensten; `perch google remove ggroup-…` entfernt die ganze Gruppe (mit `--revoke` einmal bei Google widerrufen); `perch google remove ID --service gmail` entfernt nur einen Dienst der Gruppe (ohne Widerruf, der würde alle treffen; Hinweis ausgeben). Die ganze Gruppe wird nur über ihre `ggroup-…`-Id entfernt; eine Mitglieds-Id ohne `--service` ist ein Bedienfehler, der die Gruppen-Id und die `--service`-Alternative nennt. Ohne Widerruf (auch wenn ein Alt-Befehl wie `perch gmail remove` den letzten Dienst einer Gruppe entfernt) sagt Perch, dass der Grant bei Google gültig bleibt und wie er widerrufen wird.
6a. **Widerruf trifft den ganzen Grant:** Googles Revoke beendet den Grant des OAuth-Clients für das Google-Konto, nicht nur ein Refresh-Token. `--revoke` (bei `perch google remove` und den Alt-Befehlen `gmail`/`google-productivity remove`) wird deshalb abgelehnt, solange ein anderer gespeicherter Eintrag (Gruppe oder einzeln verbundenes Konto) mit derselben Identität (`sub`, ohne `sub` die E-Mail) und derselben OAuth-Client-Id existiert; die Meldung nennt die betroffenen Konten. Mit `--force` widerruft Perch trotzdem und nennt die mitbetroffenen Konten.
7. Neu verbinden / Rechte erweitern: `perch google add --label "Privat"` für ein schon verbundenes Google-Konto fragt, ob die bestehende Gruppe aktualisiert werden soll (neue Scopes, gleiche Konto-Ids, Grants bleiben gültig), statt Dubletten anzulegen. Die Gruppe wird **nur über `sub`** wiedererkannt; dieselbe E-Mail mit anderem `sub` (Adresse gehört jetzt einem anderen Konto) wird abgelehnt, die alte Gruppe muss zuerst entfernt werden; `sub` wird nie überschrieben. Die Frage hat nur im Terminal den Standard „Ja“; ohne Terminal aktualisiert Perch nur mit `--yes`. Für die Dienste der neuen Anfrage gelten genau die neu angefragten und gewährten Scopes (`--read-only` entfernt also Schreibrechte dieser Dienste, Kalender-Schreiben folgt der Anfrage); Dienste außerhalb der Anfrage behalten ihre bisherigen Scopes. Das alte Refresh-Token wird beim Ersetzen nicht widerrufen: derselbe OAuth-Client würde damit auch den neuen Grant beenden.
8. Die alten Befehle `perch gmail add` und `perch google-productivity add` bleiben funktionsfähig (für „nur Gmail“), Hilfe weist auf den neuen Weg hin. Bisheriges `perch google add` (nur Drive) wird durch den neuen Befehl ersetzt; `--services drive` ergibt das alte Verhalten.
9. `perch setup`: Google-Schritte werden zu einem Schritt „Google-Konto (Drive, Gmail, Kalender, Kontakte)“.
10. `perch status` (neue Terminal-Ansicht und `--plain`/`--json`): verbundene Google-Konten als eine Gruppe mit den Diensten darunter; die ☐-Hinweise schlagen `perch google add --label … --services …` vor.

## Sicherheit und Migration

- Keine neuen Scopes gegenüber heute; nur die Bündelung. Gemeinsames Token heißt: ein Widerruf trifft alle Dienste der Gruppe (dokumentiert).
- Bestehende einzeln verbundene Konten bleiben gültig und unverändert (keine automatische Migration); sie erscheinen im Status als eigene Einträge.
- Store-Schema abwärtskompatibel (neue optionale Felder), Tests für Gruppe anlegen, Teil-Zustimmung, Refresh einmal pro Gruppe, Entfernen ganz/teilweise, Aktualisieren ohne Dubletten, alte Befehle weiterhin, Grants auf Gruppen-Konten.
- Doku: README (Provider-Vorbereitung, Onboarding, Fähigkeiten), `SETUP.md` §3/§4.

## Nachtrag 2026-10-21: ein Google-Eintrag im Status, Rechte über eigenen Befehl

**Von Fritz freigegeben** („Warum ist bei perch status noch immer drive/calendar/gmail einzeln … Wenn man für verschiedene Sachen separat Write/Read festlegen soll, dann soll es dafür einen separaten Command geben“).

- `perch status` (Terminal, `--plain`, `--json`-Felder unverändert): Google erscheint **als ein Dienst**. Nicht verbunden: eine Zeile „☐ Google (Drive, Gmail, Kalender, Kontakte)“ mit `perch google add --label NAME`. Verbunden: pro Google-Konto ein Block, darunter die Dienste mit ihren Rechten (☑/☐).
- Neuer Befehl **`perch google access ID`** (Gruppen- oder Mitglieds-Id): zeigt pro Dienst die aktuellen Rechte und ändert sie, z. B. `perch google access ggroup-… --service gmail --write`, `--service drive --read-only`, `--service calendar --write`, oder interaktiv (Dienst wählen, r/w). Fehlt ein Scope, startet er den Login für dieselbe Gruppe mit den nötigen Scopes (gleiche Ids, keine Dubletten, Sub-Prüfung wie beim Re-Add); Entziehen braucht keinen Login (Perch schaltet die Fähigkeit lokal ab und nimmt die Scopes aus dem Mitglied). Ein Dienst hinzufügen: `perch google access ggroup-… --add gmail` (Login wie oben); entfernen: wie bisher `perch google remove ggroup-… --service gmail`.
- `perch google add` fragt Dienste und r/w nur noch einmal für alle; die `--allow-*`-Feinflags bleiben als Option, die Hilfe verweist aber auf `perch google access`.
- Alle ☐-Hinweise im Status für Google-Mitglieder verweisen auf `perch google access …` statt auf `add --services …`. Separat verbundene Altkonten (ohne Gruppe) bleiben eigene Einträge mit ihren bisherigen Hinweisen.
