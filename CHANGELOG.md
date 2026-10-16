# Änderungen

## 6.1.1

**Behoben**
- Eine Session, deren Prozess ohne Abmeldung starb, stand kurz auf „beendet“ und dann wieder auf „wartet“, sobald irgendwo eine neue Claude-Session startete: Claude Code räumt dabei die Dateien toter Prozesse weg. Fleet merkt sich jetzt eine sicher beendete Session, bis sie wieder lebt (fortgesetzt oder ein neues Ereignis).
- Hielt Fleet eine Freigabe selbst (ein Fleet-Tab im Fokus), stand in der Zeile nur „Freigabe für Bash – im Dashboard oder in der App“, nach Ablauf der Frist „wartet in der App auf Freigabe für Bash“, ohne den Befehl. Jetzt steht in beiden Fällen, was freigegeben werden soll („Freigabe für Bash: touch live-r1.txt – wartet in der App“). Im Live-Nachtest gefunden; die Demo hält keine echten Freigaben.
- Eine Session im Fleet-Terminal gab ihre Übergabe an ein neues Fenster der Terminal-App weiter statt an das Fleet-Terminal. Jetzt startet die Nachfolgerin wieder in Fleets Fenster (Terminal first), solange Fleet sein Terminal hat.
- Nach einer Übergabe öffnete Fleet den Link zur neuen Session in der Desktop-App, die App legte aber keine an (im Live-Test kam im selben Moment eine CI-Meldung in die alte Session); die Statuszeile versprach weiter eine neue Session. Hat nach einer Minute keine Session die Übergabe übernommen, sagt die alte Session es am nächsten Turn-Ende („Neue Session noch nicht gestartet – in Fleet bei der Übergabe „Nochmal öffnen““), und Claude nennt den Weg schon beim Wechsel. Von selbst öffnet Fleet keine zweite: Ein noch nicht abgeschickter Entwurf ist von einem verlorenen Link nicht zu unterscheiden, und zwei Sessions würden dieselbe Übergabe fortsetzen.
- Eine Session, deren Prozess ohne Abmeldung endet (Terminal-Fenster geschlossen, Absturz, Neustart), stand für immer auf „wartet“ oder nach 20 Minuten auf „keine Rückmeldung“ – im Live-Test fünf geschlossene Test-Sessions, vorher alte Proben mit „auf dich gewartet 1649 min“. Claude Codes Prozessliste nennt so einen Prozess als tot: Eine Freigabe oder Frage, die nur der Hook offen hielt, und ein laufender Turn gelten dann als beendet („Prozess beendet, ohne sich abzumelden“). Eine Schlussfrage im Text bleibt, sie lässt sich nach dem Fortsetzen beantworten. Beendet wird nur, was sicher tot ist: kein lebender Prozess derselben Session (gleich mit welchem Status), keine gerade halb geschriebene Datei, kein Prozess eines anderen Rechners, und das letzte Lebenszeichen ist älter als 10 s.
- Live-Test mit echten Sessions (16.10.): Eine Freigabe zeigte nur „Claude needs your permission“ – die spätere Meldung der App überschrieb die genauere Anfrage. Jetzt steht dort, was freigegeben werden soll („Freigabe für Bash: touch live-t1.txt“), eine Rückfrage mit ihrem Text, ein Plan als „Plan freigeben?“. Rückfragen (AskUserQuestion) und Pläne, die die App hält, heißen „Frage“ statt „Freigabe“ und öffnen wie Freigaben nie einen Zweig im Fleet-Terminal („In der App öffnen“ bzw. „Wo antworten?“). Die Aktivität erkennt Fragen am Werkzeug statt am Wortlaut; offensichtliche Geheimnisse im Befehl (`Bearer …`, `token=…`) werden maskiert.
- „Wochenlimit erreicht – wieder frei Mo 19.10.“ blieb stehen, obwohl die Statuszeile später 91 % meldete und alle Sessions arbeiteten: eine alte Limit-Meldung aus dem Transcript schlug jede neuere Messung. Jetzt gilt die neuere Statuszeile desselben Fensters; Mehrkosten nach dem vermeintlichen Treffer zählen nicht mehr als Überziehung.
- Nach dem Verschieben eines Projekts zählte Fleet jede Session doppelt: Die Transcripts liegen dann unter dem alten und dem neuen Ordnernamen in `~/.claude/projects`. Sessionliste, Kosten, Log und `fleet audit`/`fleet compat` lesen jetzt nur die neueste Kopie; vorher verdoppelten sich Kosten und jeder Prüfbefund. Schon gespeicherte Tage älter als eine Woche bleiben in `fleet balance` doppelt.
- Ein `y/n` mitten in einer Erklärung („`:stop` beendet nach `y/n` alle Sessions“) machte die Session zu „wartet“. Als Frage zählt `y/n` bzw. `ja/nein` jetzt nur als Antwortformat: in Klammern („(y/n)“, „[y/N]“), nach „antworte“ oder am Satzende.
- Eine Antwort, vor die die Desktop-App einen Hinweis setzt („Linked sessions now …“), hielt Fleet für eine Nachricht der App: Die beantwortete Frage blieb offen, die Session stand bis zu 26 Minuten auf „wartet“, obwohl Claude längst geantwortet oder weitergearbeitet hatte.
- „Die Anmeldung wartet noch auf dich. … Danach sag kurz Bescheid.“ zeigte Fleet als erledigt; ein „wartet auf dich“ in den letzten zwei Zeilen zählt jetzt auch mit Schritten und „sag Bescheid“ danach.
- Enter auf einer Freigabe, die die Desktop-App hielt, setzte die Session als Zweig im Fleet-Terminal fort; der Zweig zeigte den offenen Aufruf als „Interrupted“, die Freigabe blieb unbeantwortet. Jetzt führt kein Weg (Enter, `→`/`i`, Schublade, Kommandozeile) aus einer Freigabe in einen Zweig: Hält die App sie, öffnet Fleet die Session dort („In der App öffnen“), sonst sagt Fleet, wo sie wartet. Eine Freigabe, die Fleet selbst hält, beantworten `y` (erlauben), `a` (für diese Session) und `n` (ablehnen) sofort wie in Claude Codes eigener Abfrage; die Statuszeile nennt die Tasten. Im Vim-Modus bleiben `y y`, `n` und `a`, wie sie sind, dort fragt Enter y/n.
- `fleet audit` und `fleet compat` zählten zwei richtige Anzeigen als Fehler: ein `!`-Befehl, vor dem die App einen Hinweis einfügt, galt nicht als deine Antwort, und „braucht deine Bestätigung“ nicht als Bitte um ein Ja.

## 6.1.0

**Neu**
- **Parallele Sessions in eigenen Worktrees.** Startest du eine Session in einem Repo, in dessen Ordner schon eine arbeitet oder wartet, legt Fleet einen Git-Worktree neben dem Repo an (`<repo>.wt/<auftrag>-<kürzel>`, Branch `fleet/…`) und startet Claude dort; keine Session sieht die halben Änderungen der anderen. `:wt <repo> [Auftrag]` macht es ausdrücklich. Die Statuszeile nennt den Branch, die Wachtafel zeigt `⎇ <name>` hinter dem Repo. In der Config (`worktree`) pro Repo ein Einrichtungsbefehl (z. B. `pnpm install --frozen-lockfile`) und Dateien zum Mitkopieren; `auto: off` schaltet das Automatische ab.
- `:cleanup` fragt nach dem Ausblenden auch nach erledigten Worktrees (Branch gemergt, nichts offen, keine Session darin) und entfernt sie mit `y` – nie mit Änderungen oder eigenen ignorierten Dateien, nie von Hand angelegte. Sessions im Hauptordner und in einem Worktree desselben Repos, die dieselbe Datei ändern, bekommen weiter die Konfliktmarke.

**Entwicklung**
- Lokales Tor: `git push` im Fleet-Repo läuft vorher `pnpm check:quick` (rund 25 s), rot heißt kein Push; reine Doku-Pushes überspringen es. PRs laufen in der CI schlank auf Ubuntu, die volle Matrix mit macOS und Windows auf `main`, bei Tags und mit dem Label `ci:full`.

**Behoben**
- Die Limit-Anzeige zeigte einen alten Wert als aktuell: Fleet sagte 56 % (Stand 00:00), die App 86 %. Ist die letzte Statuszeile älter als 30 Minuten, steht dort jetzt „≥ 56 %“ mit „Stand 00:00“ und keine Prognose, denn der alte Wert ist nur eine Untergrenze.

## 6.0.2

**Behoben**
- **Terminal first:** Enter und `i` (Standard `→`) öffnen jede eigene Session im Fleet-Terminal, auch eine, die gerade in der Desktop-App oder einem anderen Fenster läuft. Bisher hielt Fleet dort mit einer Warnung an, und es schien nichts zu passieren. Jetzt setzt Fleet sie als eigenen Zweig fort (`--fork-session`, eigene Session-ID); das Original in der App bleibt unberührt, die Statuszeile sagt es. `force` übernimmt weiter die Session selbst. `fleet compat` prüft den neuen Schalter mit.
- Ein einziger Klick auf „VS Code“ in einer Schublade machte VS Code zum Ziel jeder Zeile: überall stand „VS Code“, Enter öffnete VS Code. Die Zeilen öffnen jetzt im Fleet-Terminal, wo es verfügbar ist; Sessions der Desktop-App bieten VS Code und Cursor gar nicht erst an.

## 6.0.1

**Behoben**
- Bei 1280 px schnitt die Wachtafel lange Repo-Namen („billing-service“) und PRs mit Wort und CI-Zeichen („#231 Entwurf ◌“) ab. In dieser Breite zeigt die Spalte Kontext jetzt die Prozentzahl ohne Balken (der Balken steht ab einer breiteren Tafel, der Wert im Tooltip bleibt), und Repo und PR bekommen die Breite, die sie brauchen. Die Aufgabe bleibt so breit wie vorher.

## 6.0.0

> **Fleet ersetzt die Desktop-App.** Alles, wofür man sie noch öffnete, geht jetzt in Fleet und per Tastatur.
> **Tasten / keys:** Vim ist die Standardbelegung (`:mode standard` wechselt zurück). Im Terminal führt `Esc` zurück zur
> Übersicht, Claudes eigenes Esc ist `Ctrl+[`. Beim ersten Start sagt die Meldungszeile einmal, was neu ist.

**Neu**
- **`fleet` in jedem Ordner:** `setup` legt den Befehl `fleet` in den PATH (`~/.local/bin`, unter Windows `WindowsApps`; ein fremdes `fleet` bleibt unangetastet). `fleet` im Terminal startet Fleet bei Bedarf und öffnet es für den Ordner, in dem du stehst: sein Repo ist gewählt, ein Ordner ohne Sessions bietet „Claude hier starten“ (`:here [Auftrag]`). Claude startet dabei nur in genau dem Ordner, den die Kommandozeile genannt hat. `fleet ~/code/x` geht auch, `fleet open` öffnet ohne Ordner.
- **Von überall in die Session:** `i` (Standard `→`) auf jeder Zeile, die für eine Session steht – Alarmzone, Wachtafel, Ereignisstrom, Verlauf, Verbrauch, Session-Schublade – öffnet ihr Terminal als Vollbild mit den Tasten darin; `Esc` zurück, die Session läuft weiter. Eine Session, die schon in Fleet läuft, öffnet ohne Wartezeit. Das Fleet-Terminal ist das echte `claude`, jeder Befehl (`/remote-control`, `/model` …) geht dort.
- **Änderungen und Dateien einer Session:** `gd` (Standard `d`), `d` in der Session-Schublade oder `:diff` zeigt im Vollbild, was die Session geändert hat – gegen die Abzweigung vom Standard-Branch, mit ungespeicherten und neuen Dateien, die eigenen Dateien zuerst; rot/grün mit Zeilennummern. `n`/`N` nächste Änderung, `]`/`[` Datei, `t` ganze Datei, `/` suchen, `Esc` zurück. Auch Dateien, die die Session außerhalb des Repos bearbeitet hat.
- **Neue Session in neuem Ordner:** `:new <name> [Auftrag]` legt `<Projektordner>/<name>` an (mit `git init`) und startet dort Claude im Vollbild-Terminal. Projektordner: `projectsDir` in der Config, sonst der Ordner, in dem die meisten Repos liegen.
- **Wegräumen:** `x` (Vim auch `dd`) und `×` in jeder Alarmzeile: Session ausblenden (`u` holt sie zurück), alles andere 1 h stumm. `:cleanup` blendet alle Sessions aus, die seit 8 h still sind (fragt mit Anzahl), die Alarmzone bietet es an, sobald alte Alarme dastehen. `o` in der Repo-Leiste und `:tidy <repo>` räumen nur ein Repo auf. Eine weggeräumte Session steht wieder da, sobald sie wieder arbeitet.
- **`:stop`** beendet alle Sessions im Fleet-Fenster (fragt, nennt, was außerhalb weiterläuft).
- **Was ist los:** die Session-Schublade zeigt Auftrag und die letzten 12 Schritte.

**Verbessert**
- Die Alarmzone zeigt sechs Zeilen statt drei; ihre Statuszeile nennt Detail (`o`) und Terminal (`i`).
- Tastatur überall: Verlauf, Verbrauch und Repos haben Zeilen (`j`/`k`, `Enter`, Session-Tasten), Kacheln ohne Zeilen und die Schublade scrollen per Taste.
- Unter einem Statusfilter sagt die leere Wachtafel, wie viele oben in der Alarmzone stehen, und der Ereignisstrom folgt dem Filter.

**Sicherheit des Hooks**
- Der Hook läuft in jeder Claude-Session, ein Fehler darin hätte alle zugleich getroffen. Jetzt startet `settings.json` einen kleinen Wächter in `~/.claude-fleet/hook/`. Er lädt nur eine Kopie des Builds, die ihren Selbsttest bestanden hat; ein kaputtes `pnpm build` lässt den letzten guten aktiv. Beim Start übernimmt Fleet einen neuen Build nur von einem sauberen `main` gleich `origin/main`; eine Session, die an Fleet selbst arbeitet, kann ihren Code so nicht in alle Sessions bringen (`install-hooks` übernimmt bewusst). Jeden Absturz macht er zu Exit 0 und einer Zeile in `hook/errors.jsonl`, nach 10 Abstürzen in 10 min schaltet er den Hook ab. `fleet hook off|on|status` ist der Notschalter, er wirkt ab dem nächsten Ereignis jeder Session. Fleet zeigt einen abgeschalteten Hook und jeden Absturz der letzten Stunde in der Meldungszeile. Kosten: ≈ 5 ms je Aufruf (Median 48 statt 43 ms).

**Sicherheit (unabhängiges Audit)**
- Die API des echten Fleet verlangt ein Token-Cookie (`HttpOnly`, `SameSite=Strict`). Bisher konnte jeder lokale Prozess – etwa eine per Prompt-Injection übernommene Session mit `curl` – ihre eigene Freigabe erteilen, in andere Sessions tippen oder mit `--admin` mergen. Ein Browser wird einmal verbunden, über den Link, den `fleet start` oder neu `fleet open` öffnet; das Token bleibt über Neustarts gleich. Ein nicht verbundener Browser sagt in der Meldungszeile, was zu tun ist. Die Demo braucht kein Token.
- `fleet.log` und `supervisor.pid` entstehen mit `0600`.
- „Fix“ für eine rote CI gibt der neuen Session den CI-Text nur noch als markierten Datenblock (`<ci-output>`) mit der Anweisung, nichts darin zu befolgen; eine Logzeile „ignore previous instructions …“ aus einem Fork-PR wird so kein Auftrag. Fix-Sessions starten nie mit `bypassPermissions` (dann `auto`).
- Die Dateisicht liest nichts mehr durch einen verlinkten Ordner außerhalb des Repos; eine ausgelieferte Übergabe wird durch spätere Änderungen nie wieder vertrauenswürdig.

**Umfang eingefroren (unabhängige Bewertung)**
- Ab 6.0.0 wächst Fleet nur noch durch Fehlerbehebungen (`docs/SCOPE.md`): Kern (wer wartet, Antworten, Konflikte, Frisch starten), Ersatz der Desktop-App, Beiwerk. Ein Test hält den Quellcode im Budget (`size-budget.json`, 38.400 Zeilen) und verlangt für jede API-Route eine Funktion im Umfang.
- Fleet zählt lokal, welche Ansichten, Befehle, Tasten und Funktionen benutzt werden (`~/.claude-fleet/feature-use.json`, nur Zähler je Tag, nie Text). `fleet scope [--days 14]` zeigt nach den Testwochen, was ungenutzt blieb – die ersten Kandidaten zum Streichen in 6.1.
- Zwei Funktionen ohne Aufrufer entfernt (`ConflictTag`, `isGerman`); sonst fand die Suche keinen toten Code – die Zeilen sind Funktionen, kürzer wird Fleet nur durch Streichen.

**Bilanz (unabhängige Bewertung)**
- Die Fleet-Bilanz vergleicht Frischstarts jetzt auch mit `/compact` an denselben Stellen: ein Kompaktierungsaufruf über den alten Kontext plus Zusammenfassung (Median 5 Tsd. Tokens aus 6 echten Kompaktierungen) gegen das Schreiben der Übergabe, in Dollar. Erstes Ergebnis bei Ben: +18,71 $ gegen Weitermachen, −1,30 $ gegen `/compact`. Die Verbrauchsseite zeigt beides.
- Jeder Bilanztag bleibt erhalten, auch nachdem er das 7-Tage-Fenster verlassen hat (`~/.claude-fleet/balance-days.json`); `fleet balance` zeigt Woche für Woche: gekostet, gespart, Bilanz, und gegen `/compact`. Nach den zwei Testwochen steht dort die Antwort, ob sich Fleet in Dollar lohnt.

**Neu (Erkennung)**
- `fleet compat [--hours 72]`: Passt Fleet noch zu jeder Claude-Code-Version, die du benutzt? Jede Transcript-Zeile nennt ihre Version; Fleet spielt die Sessions je Version durch die echte Erkennung (wie `fleet audit`), prüft das Transcript-Format (Zeitstempel, `usage`, Werkzeug-IDs) und fragt `claude` selbst, ob es jeden Schalter noch annimmt, den Fleet übergibt (die Hilfe verschweigt manche, etwa `--max-turns`). Urteil je Version: `ok` ab 5 Wartezuständen ohne Fehler, `broken` bei einem verpassten, einem Fehlalarm oder einem Formatfehler, sonst `unproven`. Der Server prüft eine Minute nach dem Start und alle 6 h im Hintergrund; ist die neueste Version `broken` oder fehlt ein Schalter, sagt es die Meldungszeile.
- `fleet audit [--hours 48]`: spielt die lokalen Transcripts und Hook-Ereignisse der letzten Stunden durch die echte Erkennung und listet jeden Moment, in dem eine Session auf dich wartete, Fleet sie aber nicht als *wartet* gezeigt hätte, und jeden Fehlalarm. Nur IDs, Arten und Zeiten, nie Text; liest nur.
- Fragen aus der App (AskUserQuestion, Ordner- und Zugriffsanfragen, „Plan freigeben?“) stehen mit ihrem Text in der Alarmzone statt „wartet in der App auf dich“.

**Behoben**
- **Claude Codes eigener Prozessstatus:** Fleet liest `~/.claude/sessions/<pid>.json`, wo jeder laufende Claude-Code-Prozess `busy`, `waiting` oder `idle` meldet. Am 15.10. standen vier Sessions über drei Stunden auf „seit 202 Min keine Rückmeldung“ – laut Claude Code warteten alle vier auf eine Freigabe. Jetzt: *waiting* ist „wartet auf dich“ (mit „Freigabe für Bash“, wenn das Werkzeug eine verlangen kann), *busy* ist nie „keine Rückmeldung“, auch bei langen Läufen, *idle* beendet einen Turn, dessen Ende der Hook verpasst hat. Fleets eigene Fragen und erkannte Schlussfragen bleiben, wie sie sind. Mit deinen echten Sessions: 7 von 7 Wartenden erkannt, 0 „keine Rückmeldung“. `fleet compat` prüft, ob das Format noch lesbar ist.
- Lief Fleets Stop-Hook in einer Session nicht (nur die Hooks der App liefen), stand sie nach ihrer Schlussfrage stundenlang als *arbeitet*. Jetzt gilt das Transcript, sobald es den Turn nach dem letzten Hook-Ereignis beendet hat (gefunden von `fleet compat`: 168 min an einem Stück).
- Eine leere Wachtafel sagte unter dem Filter „Fehler“ „Gerade arbeitet keine Session“, während oben drei Fehler standen.
- „Ordnung machen“ (Taste und `:tidy`) sagte „gibt es noch nicht“.
- Lief die Bremse ab, ohne dass in Fleet geantwortet wurde, stand die Session als *arbeitet*, obwohl die App dann ihre eigene Freigabe zeigte. Jetzt bleibt sie *wartet*.
- Eine wartende Freigabe verschwand, sobald ein paralleles Werkzeug derselben Antwort fertig wurde oder ein Subagent im Hintergrund weiterarbeitete; auch „wartet auf deine Eingabe“ der App machte eine offene Frage zu *fertig*. Jetzt hält Fleet jede Freigabe bis zu ihrem eigenen Ergebnis, dem Ende ihres Turns oder deinem nächsten Prompt; eine Ablehnung ohne Hook-Ereignis erkennt Fleet am Transcript.
- Eine wartende Freigabe verschwand, sobald die App Buchhaltungszeilen ins Transcript schrieb (z. B. eingereihte Nachrichten).
- Kompaktierung und Resume löschten eine offene Frage; die Zusammenfassung nach einer Kompaktierung zählte als neuer Auftrag.
- Eine Schlussfrage im Text überlebte keine Nachricht, die die App einschiebt, und keine Übergabe-Runde von Fleet. Fragen vor einer Schlusszeile „Festgehalten: …“, „Soll ich …? Dann …“ und „… wartet auf dich: …“ zählen jetzt als *wartet*.
- Freigaben warten nur noch in Fleet, solange ein Fleet-Tab sichtbar und fokussiert ist. Bisher reichte irgendeine offene Fleet-Seite, auch ein Hintergrund-Tab, und die Desktop-App zeigte jede Freigabe 45 s lang nicht. Verlässt man Fleet, während eine Freigabe wartet, erscheint sie nach etwa einer Sekunde in der App.
- Eine wartende Session steht sofort in Fleet, auch mit vielen Sessions. Nach jedem Hook-Ereignis wartete der Server bisweilen mehrere Sekunden auf Git, Verbrauchszahlen oder einen zweiten, parallel laufenden Aufbau (gemessen bis 6,6 s bei ~100 Sessions). Jetzt antworten diese Teile aus dem Cache und frischen sich im Hintergrund auf; ein Statuswechsel steht in unter 0,5 s in der Übersicht.
- Aus acht Runden Praxistest vor dem Release: nichts abgeschnitten bei 1440 px, dieselbe Rückfrage und dasselbe `u` auf jedem Weg zum Ausblenden (auch `V`+`x`), der Cursor bleibt nach Diff, Schublade und `u` sichtbar, `?` zeigt nur Tasten der aktuellen Seite, „zuletzt aktiv“ ist überall dieselbe Zeit, nach einem Limit-Reset steht kein alter Prozentwert mehr, englische Daten als „16 Oct“.

## 5.0.0

> **Tasten geändert / keys changed.** Stufe 12 bricht die Tastenbelegung einmal:
> - `1`–`5` springen jetzt in eine Kachel (1 Alarmzone, 2 Repo-Leiste, 3 Wachtafel, 4 Ereignisstrom, 5 Schublade), nicht mehr in den Statusfilter.
> - Statusfilter liegen auf `Alt+1`–`Alt+5` (wartet, Fehler, arbeitet, fertig, ruht), `Alt+0` zeigt wieder alle.
> - Bereiche nur noch als Befehle: `:now`, `:repos`, `:usage`, `:activity` (statt `Alt+1`–`4`).
> - `Enter` öffnet die Schublade der Zeile; nichts klappt mehr in der Zeile auf.
> - `+` zeigt die aktive Kachel als Vollbild und zurück. Eine Zeile wählt `:12`.
>
> Beim ersten Start nach dem Update sagt das die Meldungszeile und die Tastenhilfe einmal.

**Neu: ein Schirm im CLI-Look**
- Jetzt ist genau so hoch wie das Fenster und scrollt nie; gescrollt wird nur in einer Kachel. Jede Kachel hat eine Rahmenzeile mit Nummer, Name und Position (`1–3/13`), die aktive ist blau umrandet.
- Die Alarmzone ist Kachel 1 und steht auf jeder Ansicht: höchstens drei Zeilen, mehr scrollt in ihr. Ein neues `?` oder `✗` blinkt dreimal, sonst bewegt sich nichts.
- Die Schublade ist Kachel 5 und steht an Stelle des Ereignisstroms: Terminal, Session, Repo, Konflikt, Übergabe, Fleet-Frage (mit allen Antworten) und roter CI-Lauf (Jobs, Tests, Log-Auszug). Ihr Inhalt sind Zeilen auf dem Raster.
- Die letzte Zeile ist eine Kommandozeile: `:` oder `⌘K` für Befehle, `/` zum Suchen (auf dem Handy `:/`). Das Suchfeld im Kopf ist weg.
- Kopfzeile in einer Textzeile: Bereiche, Zähler als Zeichen (`?7 ✗3`), Limit als Zeichenbalken, Fleet-Bilanz. Darunter höchstens eine Meldungszeile; die Statuszeile nennt die fünf Tasten der aktiven Kachel.
- Unter 100 Spalten zeigt die Mitte eine Kachel auf einmal mit einer Reiterzeile darüber.
- Log-Sicht (`Shift+L`): jeder Schritt jeder Session live in einer Liste, farbig nach Session; eine Zeilennummer engt auf eine Session ein.

**Neu: Übergaben**
- Übernimmt eine Session in der Desktop-App Fleets Übergabe, archiviert sie nach dem Umbenennen still die abgelöste Session, beim Zusammenfassen alle Vorgänger – nie sich selbst, nie eine andere Session. Ohne das Werkzeug (Terminal, VS Code) passiert nichts. Abschalten mit `autoHandoff.archivePredecessor: false`.

**Verbessert**
- Eine Schrift (JetBrains Mono, 13 px) auf einem 20-px-Raster, Spalten in Zeichen: Wachtafel, Repo-Leiste und Strom stehen bündig. Status ist ein Textzeichen neben seinem Wort (`?` wartet, `●` arbeitet, `✓` fertig, `✗` Fehler, `·` ruht), Kontext ein Zeichenbalken.
- Knöpfe und Tags sind Text, Karten eine dünne Linie: keine Rundungen, Schatten oder Flächen mehr. Die Schiffe, der Dichte-Schalter und die Schriften Inter, EB Garamond und Silkscreen sind entfernt.
- „Doppelt“ und Übergaben sind eigene Zeilen der Wachtafel; Enter öffnet ihre Schublade.
- Spalten der Wachtafel fallen nach der Breite der Kachel weg (erst Branch, dann Cache), nicht nach der Fensterbreite.

## 4.0.1

**Behoben**
- `g k` und der Befehl `conflict <a> <b>` (auch `:conflict` im Vim-Modus) sagten noch „kommt mit Stufe 8“, obwohl die Konflikt-Schublade da ist. `g k` öffnet jetzt den Konflikt der gewählten Session – gemeinsame Dateien zuerst, sonst den PR, mit dem sich ihr PR nicht mergen lässt; nochmal `g k` auf derselben Zeile zeigt den nächsten. `conflict` ohne Argumente listet die bekannten Konflikte, mit zwei Seiten (Session-Titel, Branch oder `#PR`) vergleicht es beliebige zwei Seiten eines Repos.

## 4.0.0

**Neu: Jetzt als Leitstand**
- Oben die Alarmzone: nur, was eine Entscheidung braucht – Fragen von Fleet (Bremse, Freigaben), Sessions mit Fehler, Sessions, die auf dich warten, rote CI ohne Fix-Session, Limit ab 90 %. Je Eintrag eine Zeile, die Ursache in einem Satz, genau eine Aktion. Ist nichts zu tun, sagt die Zone das in einem Satz.
- Darunter die Wachtafel: eine Zeile je Session mit Repo, Branch, Aufgabe, Status, Alter, Kontext-Balken, Cache-Rest, PR/CI und einer Aktion, gruppiert nach Arbeitet, Fertig und Ruht. „Ruht“ ist eingeklappt (je Repo gruppiert, Zustand bleibt gespeichert); Archiv und abgelöste Sessions findet die Suche. Jede Session steht an genau einem Ort.
- Jede Zeile in Alarmzone und Wachtafel trägt eine Nummer: `3 Enter` wählt Zeile 3, `3 m` mergt ihren PR.
- Repo-Leiste: je Repo der lokale Zustand, offene PRs mit CI-Zeichen und die Sessions nach Status. Ein Klick filtert Wachtafel, Ereignisse und die übrigen Abschnitte (`/?repo=…`, übersteht Neuladen); die Alarmzone bleibt immer ungefiltert. Worktrees desselben Remotes zählen als ein Repo.
- Ereignisstrom rechts: Statuswechsel der Sessions, neueste zuerst; ein Klick springt zur Zeile.
- Schublade rechts für Details, ohne die Seite zu verlassen: Session (Umschalt+Klick oder Umschalt+Enter), Repo mit den Reitern Architektur (liest `.architektur/README.md` oder `ARCHITECTURE.md`), Sessions, PRs, Verbrauch und Werkzeuge.
- Statuszeile unten: Tastaturmodus, Tastenhinweise und das Ergebnis der letzten Aktion (statt kurzer Einblendungen).
- Neues Aussehen im Terminal-Stil: dunkel als Grundlage, hell nach System oder Wahl, Graustufen als Normalfall und nur drei Signalfarben. Erklärtexte stehen als Tooltip am „i“. Dichte-Schalter „Kompakt / Normal“ im Kopf. Der Status jeder Session ist ein kleines Schiff neben seinem Wort: am Ufer (wartet), auf See (arbeitet, nur dieses bewegt sich), angelegt (fertig), schief und rot (Fehler), vor Anker (ruht).

**Neu: Claude im Fenster**
- Fleet startet `claude` selbst und zeigt es in einem Terminal in der Schublade. Die Session läuft weiter, wenn der Tab zu ist, und zeigt beim Wiederöffnen, was inzwischen kam. „Fleet-Terminal“ ist das bevorzugte Ziel für Öffnen, Fortsetzen, Frisch starten und neue Sessions („Neue Session“ je Repo).
- Freigaben und Fragen in Sessions im Fenster erkennt Fleet auch ohne Hooks am Bildschirm. Antworten geht direkt in der Zeile (`r`).
- „Übergabe jetzt (Job)“ und „Frisch starten“ laufen als Hintergrund-Job; Tokens und Kosten stammen nur aus der Ergebniszeile von Claude Code.
- Nach einem Neustart von Fleet stehen Sessions aus dem Fenster als „unterbrochen“ mit „Fortsetzen“. Ein Update wartet, solange Sessions im Fenster laufen; `stop` und `restart` brauchen dann `--force`.

**Neu: Tastatur**
- Alles per Tastatur: Pfeile oder `j`/`k`, `Enter` klappt auf, `→` Terminal, `o` Programm, `m` mergen, `1`–`5` Statusfilter, `Alt+1`–`4` Bereiche, `Tab` wechselt die Zone. Destruktives fragt in der Statuszeile `y/n`, nie in einem Dialog.
- Befehlspalette mit `⌘K` / `Strg+K`: Kürzel wie `NOW`, `REP`, `USE`, `ACT`, Sessions, Repos, `#PR`, Branches und Befehle wie `merge 8`, `filter wartet`, `new …`, `report week`.
- `?` zeigt die Tasten für die aktuelle Stelle, `??` alle Tasten mit Suche. Ein Hinweis beim ersten Start nennt beides.
- Vim-Modus (Einstellungen oder `mode vim`): NORMAL, INSERT, COMMAND und VISUAL in der Statuszeile, Zähler (`3j`, `5G`), `:`-Zeile, `gg`/`G`, `]a`/`[a` zum nächsten Alarm, `V` markiert Zeilen, `dd`/`x` blendet aus, `u` macht es rückgängig, `.` wiederholt.

**Neu: Fleet-Bilanz und Limit statt Dollar**
- Fleet zählt, was es selbst kostet (Übergaben, Jobs, erste Turns von Sessions, die es gestartet hat) und was es realisiert spart (weniger Tokens je Aufruf nach „Frisch starten“ oder Zusammenfassen, vermiedene Cache-Neuaufbauten). Kennzahl im Kopf mit Methode im Tooltip, Aufschlüsselung auf „Verbrauch“. Ist die Bilanz drei Tage im Minus, steht das in der Alarmzone.
- Im Kopf ein Limit-Balken für das bindende Fenster (5 Stunden oder Woche) mit Prozent und Reset; nach einem Limit-Treffer „läuft über Guthaben“ mit den Tokens seither.
- Neue Einstellung `billing`: `subscription` (Standard) zeigt Dollar nur noch auf „Verbrauch“, überall sonst Tokens; `api` zeigt sie wie bisher.

**Neu: Konflikte**
- „Doppelt“ nur noch, wenn Sessions dieselben Dateien geändert haben; gleicher Branch oder gleiche Aufgabe allein steht grau unter „Parallel“.
- Offene PRs desselben Repos werden alle 5 Minuten paarweise mit `git merge-tree` probegemergt (ohne `git fetch`, ohne den Arbeitsbaum zu berühren). „Konflikt mit #n“ steht an beiden PRs.
- Konflikt-Schublade: ein Satz oben, ein Ordnerbaum mit A/B-Markierung, die Änderungen beider Seiten nebeneinander und die Auswege (B anhalten, A zuerst mergen, Rebase-Session starten).

**Neu: Aktivität und Wochenbericht**
- Zeitleiste je Repo statt je Session; ein Klick auf ein Repo filtert den Verlauf. Der Verlauf kommt seitenweise.
- „Wochenbericht exportieren“ als Markdown oder JSON (unter 5 Tsd. Tokens): Sessions nach Repo und Status, Verbrauch, häufigste Alarme, liegengebliebene PRs, Cache-Neuaufbauten, Haiku-Kandidaten, Doppelt-Fälle. Ohne lokale Pfade.

**Neu: Repos & PRs**
- „Repos & PRs“ zeigt alle offenen GitHub-PRs jedes Repos, auch solche ohne Session, mit CI, Review und den Namen roter Checks. Grün: *Mergen* mit Rückfrage. Rot, laufend oder ohne CI: *Trotzdem mergen* mit Rückfrage, per Admin-Merge. Ein PR, der auf einem anderen aufbaut, zeigt „wartet auf #N“ und lässt sich erst danach mergen. Mehrere Checkouts desselben Repos erscheinen einmal.

**Verbessert**
- „Wartet auf dich“ statt „fertig“, wenn der letzte Turn mit einer Frage oder der Bitte um ein Ja endet – auch ohne Fragezeichen („… an der ich dein Ja brauche“). Bedingte Angebote („Sag Bescheid, wenn …“) bleiben „fertig“.
- Eigener Status „Fehler“ mit Ursache und passender Aktion: Anmeldung abgelaufen („Neu anmelden“), Limit erreicht mit Uhrzeit („Fortsetzen“), Ausgabenlimit („Limit anheben“), API-Fehler, abgestürzter Prozess und keine Rückmeldung seit `staleMinutes` („Neu starten“). Eigener Zähler im Kopf.
- Signale einmal: Ein PR und seine CI stehen nur an der jüngsten Session; rote CI, an der schon eine Session arbeitet, ist kein Alarm, sondern steht an deren Zeile.
- Merge-Rückfrage nennt PR, Zielbranch und Zahl der Commits („PR #14 (3 Commits) nach main mergen?“). Entwürfe und gestapelte PRs zeigen „Mergen“ ausgegraut mit Grund.
- Notfall-Übergaben erfinden keinen nächsten Schritt mehr und sind als „automatisch (Turn abgebrochen)“ gekennzeichnet.
- Kontrast im Hell-Modus: Signaltext auf überfahrenen und gewählten Zeilen erreicht jetzt 4,5:1.

**Behoben**
- Ab sechs offenen Fleet-Tabs lud keine Seite mehr (etwa „Aktivität“ blieb leer, der Titel zeigte nur die Adresse): Jeder Tab hielt eine eigene Live-Verbindung, Browser erlauben sechs je Host. Jetzt hält ein Tab die Verbindung und teilt sie mit den anderen.

**Entwicklung**
- Das Terminal braucht `@lydell/node-pty` (optionale Abhängigkeit, vorgebaut, kein node-gyp). Fehlt es, läuft alles außer dem Terminal, und Fleet nennt den Grund.
- `pnpm screenshots` nimmt die neuen Ansichten auf: Jetzt hell und dunkel, Terminal, Tastenhilfe, Konflikt, Verbrauch, Repos, Aktivität.
- E2E-Tests nehmen einen Port je Checkout (oder `FLEET_E2E_PORT`): Parallele Sessions in mehreren Worktrees teilten sich sonst einen Demo-Server und testeten fremden Code.

## 3.0.0

**Neu aufgebaut**
- Gleiche Architektur wie die anderen Projekte: Oberfläche mit React Router 7, TypeScript strict und Tailwind; der Server aufgeteilt in `core`, `handoff`, `http` und `cli`, die Übergabe in einzelne Schritte, die Git-Hosts in je ein Modul. Statt einer 1.900-Zeilen-`index.html` eine Datei pro Route und Komponenten nach Bereich.
- Weiterhin ohne Laufzeit-Abhängigkeiten: esbuild bündelt Server, CLI und Hooks zu `dist/*.cjs`, die nur Node-Bordmittel brauchen. Ein CI-Job startet die gebaute Version ohne `pnpm install` auf Node 18, 22 und 24 unter Linux, macOS und Windows.
- Tests mit Vitest gegen den gebauten Server und den echten Hook, E2E mit Playwright und axe, eine Datei pro Nutzerablauf.

**Neu**
- Englisch: Oberfläche, Hinweise, Übergaben und Demo-Daten auf Deutsch oder Englisch, umschaltbar im Kopf; Standard ist die Systemsprache. `README.md` auf Englisch, `README.de.md` auf Deutsch.
- „Trotzdem mergen“, wenn GitHub die CI gar nicht gestartet hat (z.B. Ausgabenlimit), mit Rückfrage.
- Frisch starten: Die alte Session schreibt zuerst eine echte Zusammenfassung, erst dann öffnet sich die neue. Geht auch im Terminal.

**Behoben**
- „Doppelt“ nach „Frisch starten“: Sessions, die Fleet selbst abgelöst hat, und Sessions, die seit über einer Stunde unberührt sind, zählen nicht mehr als doppelt. Die Karte sagt jetzt, wie viele arbeiten und wie viele warten, und warum Zusammenfassen hilft.
- „Zusammenfassen“ öffnete die neue Session ohne Projektordner, wenn die Desktop-App den Ordner ignorierte. Die neue Session bekommt jetzt trotzdem die Übergabe und wechselt in den richtigen Ordner.

**Stabilität**
- Jeder Abschnitt der Oberfläche fängt eigene Renderfehler ab; der Rest bleibt bedienbar und versucht es mit den nächsten Daten erneut.
- Pipeline-Details aus GitHub werden im Browser Feld für Feld geprüft; eine unvollständige Antwort legte vorher das ganze Dashboard lahm.

## 2.16.1

**Behoben**
- Auch das Wochenlimit zählt: War es erreicht, zeigte Fleet nichts, weil nur 5-Stunden-Treffer ausgewertet wurden. Jetzt „Wochenlimit erreicht“ mit dem Reset-Tag, genau wie Claude Code es meldet.

## 2.16.0

**Behoben**
- Limit nur noch, wenn es sicher ist: Ohne Statuszeile (Desktop-App) hat Fleet den Prozentwert aus früheren Limit-Treffern geschätzt. Die Schätzung stand bei 80 %, als das Limit längst erreicht war, und hielt später Sessions an, die schon über Nutzungsguthaben liefen. Jetzt gibt es keine geschätzten Prozent mehr, weder in der Anzeige noch für Bremse und automatische Übergabe. Sicher sind: der echte Limit-Treffer aus dem Transcript („erreicht um …, wieder frei um …“) und die Tokens seit Beginn des Fensters.
- Werkzeuge, die in der App auf dich warten (Ordner wechseln, Rückfrage, Plan, Zugriff), stehen als „wartet in der App auf dich“ statt „keine Rückmeldung – hängt?“.
- Unter Windows: Laufwerkswurzel statt „D:“ beim Projekt-Briefing, relative Pfade mit Schrägstrich.

**Stabilität**
- Jeder Browser-Test scheitert jetzt an jedem Skriptfehler der Seite.

## 2.15.0

**Neu**
- Kopfzeile: Die Zähler („brauchen dich“, „fehlgeschlagen“, „arbeiten“, „fertig“, offene PRs, Limit) stehen als kleine Symbole neben den Reitern. Ein Klick springt zum passenden Abschnitt auf „Jetzt“. Der Seitenkopf („Jetzt“ mit Datum) fällt weg, darunter beginnen sofort die Sessions.

**Behoben**
- Eine abgelöste Session galt wieder als aktiv, sobald im selben Ordner eine neue Übergabe entstand (etwa beim Zusammenfassen). Der Token-Hebel zeigte dann weiter ihren alten Kontext („liest bei jedem Aufruf 718 Tsd. Tokens neu“). Die Verbindung alt → neu bleibt jetzt erhalten.
- Sessions, deren Übergabe schon geschrieben ist, erscheinen nicht mehr als Hebel für „Frisch starten“.

## 2.14.0

**Neu**
- Auf einen Blick: Nach „Frisch starten“ benennt die neue Session sich selbst wie die alte („Claude Fleet“) und die alte in „Claude Fleet · abgelöst 14.10.“. Generische Titel („… Übergabe fortsetzen“) werden zum Ordnernamen.
- Doppelt: Arbeiten mehrere aktuelle Sessions am selben Repo, zeigt „Jetzt“ das an, mit „Zu einer zusammenfassen in …“. Fleet stellt aus allen Verläufen eine gemeinsame Übergabe zusammen und öffnet eine neue Session. Die alten zeigen danach auf sie und heißen „· zusammengefasst“. Kurze Animation beim Zusammenfassen. Arbeitet eine noch, wartet Fleet ihren Turn ab.

## 2.13.1

**Behoben**
- Rückfragen (`AskUserQuestion`) und Plan-Freigaben erscheinen nicht mehr als „Freigabe“ mit rohem JSON in „Fleet fragt dich“. Beantwortet werden sie in der App.
- Eine abgelaufene Freigabe verschwindet sofort, statt mit „abgelaufen“ stehen zu bleiben.

## 2.13.0

**Neu**
- Die neue Session ordnet sich selbst in die Gruppe der Seitenleiste ein, in der die alte war. Per Link geht das nicht, die Session erledigt es beim Start.
- „Bereit zum Weitermachen“ zeigt neue Sessions, die geöffnet sind, aber noch auf Enter warten („In Desktop-App geöffnet – mit Enter abschicken“), oben und mit „Nochmal öffnen in …“.

## 2.12.1

**Behoben**
- Die neue Session nach „Frisch starten“ ging nicht auf: Der Hook beendet sich sofort, ein verzögertes Öffnen lief nie. Geöffnet wird jetzt in einem abgekoppelten Prozess, jeder Versuch steht in `~/.claude-fleet/launch.log`, und ein Fehlschlag erscheint als Hinweis im Dashboard.
- „Frisch starten“ bei einer wartenden Session passierte nie, weil kein Turn-Ende mehr kam. Fleet übergibt jetzt sofort (eigene frische Übergabe oder aus dem Verlauf zusammengestellt, ohne Modell) und öffnet die neue Session. Schon vorgemerkte Sessions, die inzwischen warten, holt Fleet nach.
- Fertige Sessions haben „Frisch weiter“ mit Zielwahl statt „Übergabe-Prompt kopieren“.

## 2.12.0

**Neu**
- „Frisch starten“ fragt gleich, wo es weitergehen soll (Desktop-App, VS Code, Terminal …). Nach der Übergabe öffnet Fleet die neue Session genau dort. Ist das Ziel nicht verfügbar, nimmt Fleet das Programm, in dem die Session lief.
- „Bereit zum Weitermachen“ bietet alle verfügbaren Ziele direkt an der Karte. Übergaben, mit denen schon weitergemacht wird (von Fleet geöffnet, weitergegeben oder die Session läuft noch), stehen dort nicht mehr.

**Behoben**
- Eine Notfall-Übergabe (Turn bricht ab, z.B. Rate-Limit) hängt nicht mehr an die Übergabe einer anderen Session. Eine frische fremde bleibt unangetastet, eine ältere als zwei Stunden wird durch eine eigene ersetzt.

## 2.11.1

**Geändert**
- „Läuft gerade“ steht auf „Jetzt“ ganz oben.

## 2.11.0

**Geändert**
- Knappes Limit heißt nicht mehr aufhören: Claude schreibt die Übergabe als Sicherung und arbeitet weiter. Fleet hängt nach jedem Turn den aktuellen Stand an (Aufträge, Todo-Liste, Dateien, letzte Antwort), ohne Modell und ohne Tokens. Bricht die Session ab, ist der genaue Punkt dokumentiert.

## 2.10.2

**Behoben**
- 2.10.1 hat mit dem gemergten PR auch den roten Lauf auf `main` ausgeblendet. Jetzt entfällt nur der PR, der Lauf auf dem Branch bleibt.

## 2.10.1

**Behoben**
- Ein gemergter oder geschlossener PR steht nicht mehr unter „CI rot“, auch wenn sein letzter Lauf rot war.

## 2.10.0

**Geändert**
- Ein Kopf für alle Tabs statt Kachelleiste: brauchen dich, fehlgeschlagen, arbeiten, fertig, offene PRs und das 5-Stunden-Limit mit Reset. Auf jedem Tab dieselben Zahlen.
- Dollar nach hinten: Mit Abo-Limit zeigt der Kopf Limit-Prozent, Kosten nur noch unter „Verbrauch“. Ohne Limitdaten (API) steht dort „heute X $“.

**Behoben**
- Das Pipeline-Panel hieß wie der Zähler „arbeiten“ (`.run`) und verschob ihn. Der CSS-Test verbietet die Klasse jetzt.

## 2.9.0

**Neu**
- Konfliktwarnung: Arbeiten zwei Sessions gleichzeitig im selben Repo auf demselben Branch oder an denselben Dateien, zeigen beide „Konflikt?“, nennen die andere Session und die Dateien und bieten „Worktree-Befehl kopieren“. Wartende Sessions warnen nur bei gemeinsamen Dateien, Worktrees nie.

## 2.8.1

**Geändert**
- Pipeline-Details: Ein Grund, den alle fehlgeschlagenen Jobs teilen (z.B. Ausgabenlimit), steht einmal oben statt bei jedem Job. GitHub-Hinweise, die keine Fehler sind, entfallen.

## 2.8.0

**Neu**
- Pipelines direkt in Fleet: „CI läuft“ mit Laufbalken und dem gerade laufenden Job und Schritt, aktualisiert alle 5 s. Rote Läufe lassen sich aufklappen: Jobs und Schritte, fehlgeschlagene Tests, Log-Auszug und die Begründung von GitHub (z.B. „Job nicht gestartet: Ausgabenlimit“).
- Aktionen auf der Seite: fehlgeschlagene Jobs neu starten, laufenden Lauf abbrechen, Fix-Session starten. Ihr Auftrag nennt Job, Schritt, Fehler und den Befehl für das volle Log.

**Behoben**
- Seit 2.6.0 war eine CSS-Regel zerschnitten: Die Zeitangabe in „Fertig“ verlor ihre Schrift, und der Befehlsblock der Freigaben blieb ohne Stil. Ein Test prüft den Stilblock jetzt.

## 2.7.0

**Neu**
- Freigaben im Dashboard: Fragt Claude Code nach einer Erlaubnis, während Fleet offen ist, steht sie unter „Fleet fragt dich“ mit dem Befehl oder der Datei: „Erlauben“, „Immer für diese Session“ (nur für diese Session, nie dauerhaft) oder „Ablehnen“. Ohne Antwort in 45 s fragt die App wie gewohnt. Ist Fleet zu, wartet nichts.
- Die Selbstheilung richtet den PermissionRequest-Hook dafür synchron ein.

## 2.6.1

**Behoben**
- Die Ergebniszeile zählt nur die eigenen Commits der Session: per ID aus der Ausgabe von `git commit`, bei `git commit -q` per Zeitpunkt. Vorher standen bei einer Session, die nichts geändert hatte, die Commits anderer Sessions.
- Testläufe werden nur in der ersten Zeile eines Befehls erkannt, nicht mehr in Heredoc-Text.

## 2.6.0

**Neu**
- Ergebniszeile für fertige Sessions: Commits seit dem Start, geänderte Dateien mit +/− Zeilen, letzter Testlauf (grün/rot, aus dem Transcript) und PR mit CI-Stand. Damit lässt sich eine Session abhaken, ohne sie zu öffnen.
- Mergen direkt aus Fleet: „Mergen“ an der Ergebniszeile, mit Rückfrage am Knopf, Squash über `gh` (nur bei offenem PR ohne rote oder laufende CI).

## 2.5.0

**Neu**
- Cache-Countdown für wartende Sessions: „Cache noch 3:12“ aus der Laufzeit im Transcript (5 Min oder 1 Std ab dem letzten Aufruf), unter einer Minute hervorgehoben, mit Benachrichtigung bei Kontext über 100 Tsd. Tokens. Danach: „Cache abgelaufen – nächster Aufruf ≈ X $“ und „Übergabe-Prompt kopieren“.

## 2.4.0

**Behoben**
- Eine Quelle für alle Zähler (`lib/inbox.js`): Kopfzeile, Kacheln, Abschnitte und Tab-Badges zeigen dieselben Zahlen.
- „Braucht dich“ nur bei echter Rückfrage oder Freigabe. Rote CI steht als eigene Karte je Repo und PR unter „CI rot“, nicht mehr an jeder Session, die dort gearbeitet hat.
- Sessions, die im Elternordner starten und in einem Repo arbeiten, heißen wie das Repo. Gleiche Titel bekommen die Startzeit.
- Limit-Prognose („voll um …“) nur, solange eine Session arbeitet. Sonst steht nur der Reset da.
- „Frisch starten“ nur für Sessions, mit denen gerade gearbeitet wird.
- Repo und Branch in der aufgeklappten Karte stehen wieder in einer Zeile (Klassenkonflikt mit der Projektkarte).
- Zeitleiste ohne namenlose Zeilen. „Wirkung“ in „Wo Tokens verloren gehen“ ist nie leer.

## 2.3.2

**Geändert**
- Die Bremse hält bei Schleifen standardmäßig nicht mehr an. An 5.077 echten Werkzeugaufrufen hätte sie zweimal gegriffen, beide Male beim Warten im Browser, nie bei einer echten Schleife. „Schleife?“ steht weiter im Dashboard, das Anhalten lässt sich mit `brake.loop: true` einschalten. Beim Limit ab 95 % hält sie weiter an.

## 2.3.1

**Geändert**
- Neue Sessions nur, wenn sie helfen: Fleet öffnet eine nur nach „Frisch starten“ oder wenn der Kontext selbst zu groß ist. Beim knappen 5-Stunden-Limit und nach einer Entscheidung in der Bremse bleibt es bei der Übergabe. Höchstens einmal, nur bis 30 Minuten nach der Anforderung.
- Der vorausgefüllte Auftrag sagt, warum es eine neue Session gibt und woran sie weitermacht: „Fortsetzung in <Repo>, frisch gestartet, weil …“.

## 2.3.0

**Neu**
- Projekte: Die Gruppen der Seitenleiste der Desktop-App erscheinen unter „Repos & PRs“. Jede Karte zeigt die Sessions, die Kosten und alle Repos, in denen die Sessions gearbeitet haben, Worktrees nur einmal.
- Projekt-Briefing: Eine neue Session im gemeinsamen Ordner verschafft sich einen Überblick über alle Repos des Projekts und fasst zusammen, was projektübergreifend ansteht.

## 2.2.1

**Geändert**
- Frisch weitermachen leert den Chat nicht mehr. Ist die Übergabe geschrieben, öffnet Fleet eine neue Session im selben Programm und Ordner. Ihr Auftrag ist sichtbar vorausgefüllt (Repo und Ziel aus der Übergabe), und Claude beginnt dort mit einer kurzen Zusammenfassung des letzten Stands. Der alte Chat bleibt lesbar.

## 2.2.0

Schlanker: Die Startseite zeigt, wer dich braucht, was gerade am meisten Tokens spart und was als Nächstes zu tun ist. Alles andere liegt eine Ebene tiefer.

**Neu**
- Frisch starten mit einem Klick: Am nächsten Turn-Ende schreibt Claude die Übergabe und es geht in einer neuen Session weiter. Fleet zeigt die Session, bei der das am meisten spart, mit der Ersparnis pro Aufruf.
- Bremse: Bei einer Schleife oder einem Limit, das mitten in der Arbeit ausgeht, hält Fleet die Session vor dem nächsten Werkzeugaufruf an und fragt im Dashboard: neu ansetzen, an einen Opus-Subagenten geben, Übergabe schreiben, weiter oder anhalten. Die Antwort geht direkt an die Session.
- Sessions in Desktop-App, VS Code/Cursor oder Terminal öffnen; mit der Übergabe eines Repos per Klick in einer neuen Session weitermachen.
- „Weiter in neuer Session“: Nachfolger nach `/clear`, frischem Start oder Übergabe, aus den Session-Daten der Desktop-App.
- PRs aus der Desktop-App: auch nach dem Merge oder auf `main` sichtbar.

**Verbessert**
- Startseite entschlackt: Token-Leiste statt Leitstand (Puls und Zeitleiste unter „Aktivität“), Kacheln ohne Verbrauchskurve und Werkzeugspur, technische Angaben eingeklappt, Hinweise auf der Karte nur, wenn sie dringend sind.

**Behoben**
- PRs privater Repos fehlten (404), wenn Fleet als Hintergrunddienst lief: `gh` in `~/.local/bin` oder Homebrew wurde nicht gefunden.
- Die Übergabe kam nicht an, wenn die neue Session im übergeordneten Ordner startete (Desktop-App).
- Ein reiner Versionssprung startete den Server nicht neu.

## 2.1.0

**Neu**
- Automatische Übergabe: Ab 85 % Limit oder Kontext bzw. 400 Tsd. Tokens schreibt die Session am Turn-Ende eine `HANDOFF.md`; eine neue Session im selben Ordner bekommt sie mitgegeben. Nur selbst angeforderte Übergaben werden mitgegeben (SHA-256).
- Frischer Start: Bei großem Kontext leert Claude danach den Chat (Desktop-App), die nächste Nachricht startet mit der Übergabe statt mit dem ganzen Verlauf.
- Notfall-Nachtrag aus dem Transcript, wenn ein Turn abbricht; eine Übergabe von Claude wird ergänzt, nie ersetzt.
- Leitstand auf der Startseite: Verbrauch pro Minute je Projekt, Limit mit Prognose, Zeitleiste mit Wartezeit auf dich.
- Kacheln mit Verbrauchskurve, aktueller Rate und Spur der letzten Werkzeuge.
- „Bereit zum Weitermachen“: nächste Schritte je Repo aus der Übergabe.
- Limit-Schätzung ohne Statuszeile (Desktop-App), gelernt aus früheren Limit-Treffern.

**Behoben**
- Der Überwacher beendete sich nach einem Update, wenn auf einem Nachbarport eine Demo lief.
- Keine Dauerwarnung mehr, wenn die Claude-CLI nicht installiert ist.
- Preise auch für Anzeigenamen aus der Statuszeile („Opus 5.5“).

## 2.0.0

**Neu**
- Effizienz-Berater je Session: passt das Modell zur Arbeit, ist eine Übergabe fällig, verfällt der Cache in Pausen. Mit Grund, geschätzter Wirkung in Dollar, `/model …` und Übergabe-Prompt zum Kopieren.
- „Wo Tokens verloren gehen“ im Verbrauch, mit Sparpotenzial.
- Schleifen-Erkennung: gleicher Werkzeugaufruf in Serie oder Fehlerserie, erscheint unter „Braucht dich“.
- Cache-Trefferquote je Session und gesamt.
- Demo-Modus `node server.js --demo` mit erfundenen Daten über denselben Weg wie echte Daten.

**Verbessert**
- Status ohne Hooks aus dem Ende des letzten Turns: fertige Sessions stehen unter „wartet auf dich“ statt unter „ruht“.
- Kontextfenster je Modell (aktuelle Modelle 1 Mio. Tokens statt pauschal 200 Tsd.).
- Preise nach aktueller Liste, Haiku 5.5 mit zwei Preisstufen je Aufruf.
- Werkzeug-Hooks laufen im Hintergrund und blockieren Claude nicht mehr (`--sync` für das alte Verhalten).
- Barrierefreiheit: echte Buttons, WCAG-AA-Kontrast, benannte Abschnitte, Fokus bleibt bei Live-Updates, Tabellen am Handy per Tastatur erreichbar.

**Entwicklung**
- Strikte Typprüfung per JSDoc (`tsc --checkJs`), Biome, Integrations- und E2E-Tests (Playwright + axe), CI auf Linux, macOS und Windows.

## 1.5.0

Ausgangsstand: Board, Repos & PRs, Verbrauch mit Limits, Aktivität, Hooks und Statuszeile, Cowork-Plugin, Autostart.
