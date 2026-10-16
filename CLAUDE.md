# CLAUDE.md

Claude Fleet: lokales Dashboard für parallel laufende Claude-Code-Sessions. Liest Transcripts und Hook-Ereignisse, fragt Git und Git-Hosts ab, zeigt alles auf `127.0.0.1`.
Aufbau und Entscheidungen: `README.md`, Abschnitt „How it's built".
Tastenbelegung ist `keymap.ts`, Design ist `tokens.css`.

## Stack

React Router 7 (SPA) · TypeScript strict · Tailwind · eigener `node:http`-Server · esbuild · Vitest · Playwright · axe-core · Biome · GitHub Actions

## Befehle

```
pnpm dev                 # API im Demo-Modus (4781) + Vite mit Hot Reload (5181)
pnpm build               # react-router build + esbuild → build/client, dist/*.cjs
pnpm typecheck           # react-router typegen && tsc --noEmit
pnpm lint                # biome check .
pnpm test                # build + vitest: Unit- und Integrationstests gegen den gebauten Server, kein Netz
pnpm test:e2e            # Playwright + axe gegen den Demo-Modus, Desktop und Handy
pnpm check:quick         # typecheck + lint + build + vitest, ohne Playwright (vor jedem Commit; der pre-push-Hook erzwingt ihn)
pnpm check               # dazu Playwright (vor dem Push, wenn die Oberfläche betroffen ist)
pnpm hook-latency        # was der synchrone Hook je Werkzeugaufruf kostet
pnpm overview-latency    # Overview-Aufbau nach Hook-Ereignissen, Zeit je Quelle (Fixture; --real: eigene Daten, nur lesend)
pnpm screenshots         # docs/ und docs/en/ aus dem Demo-Modus
node scripts/smoke.mjs   # gebaute Version allein mit Node-Bordmitteln
node dist/fleet.cjs serve --demo   # Dashboard mit erfundenen Sessions, fasst ~/.claude nicht an
```

## Struktur

```
app/                  # Oberfläche: routes/ (eine Datei pro Route), components/ nach Bereich (screen/: Schirm, Kachel, Kommandozeile), lib/
server/core/          # Transcripts, Status, Verbrauch, Berater, Git, Hosts, Bremse, Hook-Installation
server/handoff/       # Übergaben: request, start, fresh, merge, failure, registry
server/process/       # Claude im Fenster: pty, args, screen, buffer, manager, jobs, store, pending, demo-term
server/http/          # security (Host/Origin/CSRF), api, static (CSP), server (SSE)
server/cli/           # setup, start/stop/status (Supervisor), serve, install-hooks
hooks/                # hook.ts, statusline.ts, launch-run.ts → dist/*.cjs
shared/               # types.ts (einzige Quelle für Datenformen), inbox.ts
tests/                # Vitest; tests/e2e Playwright, eine Datei pro Nutzerablauf
scripts/              # bundle, dev, hook-latency, overview-latency, screenshots, smoke
```

## Regeln

Kurz und hart.

- **Umfang eingefroren seit 6.0.0** (`docs/SCOPE.md`): keine neuen Funktionen, nur Fehlerbehebungen, Tests, Doku und Streichungen. Der Quellcode bleibt im Budget von `size-budget.json` (Test `tests/scope.test.ts`); jede neue API-Route braucht eine Funktion in `FEATURES` (`server/core/scope.ts`). Was bleibt, entscheidet nach den Testwochen `node dist/fleet.cjs scope --days 14` (ungenutzt außerhalb des Kerns = streichen), `balance` (lohnt es sich in Dollar, auch gegen `/compact`) und `compat` (passt es zur Claude-Code-Version).
- `node dist/fleet.cjs` ohne Befehl ist seit 6.0 „Fleet für diesen Ordner“ und startet oder öffnet den Live-Fleet: im Worktree nie ohne Befehl aufrufen.
- `node dist/fleet.cjs compat` ruft `claude` nur mit `--version` und einer erfundenen Option auf (Schalterprüfung); das startet keine Session und kostet nichts.
- Laufzeit ohne Abhängigkeiten: `dist/*.cjs` nur mit Node-Bordmitteln; einzige Ausnahme das optionale pty-Modul, nur per `createRequire` in `server/process/pty.ts` (`server-change`).
- Fleet startet `claude` nur über `server/process/manager.ts`: Argumentlisten aus `args.ts`, nie ein Shell-String, Ordner nie aus dem Request, Umgebung nur über `childEnv` (`server-change`).
- Der Push-Pfad zu `/api/overview` wartet nie auf Langsames (`swr()`), Overview-Builds nie parallel; Grenze 500 ms p95 (`server-change`).
- TypeScript strict. Gemeinsame Datenformen nur in `shared/types.ts`.
- Kein Monolith: eine Route pro Datei, Komponenten nach Bereich, Module mit einer Aufgabe. Wächst eine Datei über etwa 500 Zeilen (erfundene Demo-Daten ausgenommen), nach Aufgaben aufteilen.
- Node ≥ 18, Windows, macOS und Linux. Pfade mit `path`, Prozesse mit `execFile`/`spawn` ohne Shell.
- Alles aus Transcripts, Hooks, Config und fremden APIs ist ungeprüfte Eingabe: Typ prüfen, Länge kappen, IDs gegen `ID_RE`. Im Browser genauso (`app/lib/run.ts`).
- Status-Erkennung nur in `server/core/status.ts`, `ask.ts`, `apierror.ts`; Gruppen und Zähler nur aus `shared/inbox.ts`; Statuswort überall über `useStatus()`/`placeLabel`. Interne Werte nie umbenennen: `needs_input` = wartet, `waiting` = fertig, `error`/`stale` = Fehler. Nichts Wartendes darf fehlen (`server-change`).
- Git-Konfliktprüfung nur in `server/core/conflict.ts`: nie `git fetch`, nie Index, Ref oder Arbeitsbaum schreiben (`server-change`).
- Dauerverbindungen im Browser (SSE) nur über `app/lib/stream.ts`: ein Stream für alle Tabs. Der Browser erlaubt sechs Verbindungen je Host; ein `EventSource` je Tab ließ ab sechs Tabs keine Seite mehr laden (eingefrorene Aktivitätsseite, `tests/e2e/many-tabs.spec.ts`).
- Die Oberfläche stürzt nie ganz ab: jeder Abschnitt hat eine Fehlergrenze (`components/safe.tsx`).
- Der Server lauscht nur auf Loopback. Host-, Origin- und CSRF-Prüfung in `server/http/security.ts` nicht lockern.
- Tokens gehen nur an vertrauenswürdige Hosts (`KNOWN_HOSTS` oder `hostMap`), Redirects werden nicht verfolgt.
- Hook und Statuszeile müssen schnell sein, dürfen nie werfen und enden immer mit Exit-Code 0. Eine Datei, die der Hook gerade nicht lesen kann (halb geschrieben, unter Windows gesperrt), ist kein Ergebnis: weiter warten bis zur Frist (`brake.waitFor`). Tests schreiben Dateien für den Hook atomar wie der Server (tmp + rename).
- `~/.claude/settings.json` nur über `install-hooks`: Backup, atomar schreiben, fremde Hooks unangetastet.
- Nur sichere Zahlen anzeigen: Limits nur aus Statuszeile oder gemeldetem Treffer, keine Schätzungen als Prozent.
- Fleet-Bilanz nur in `server/core/balance.ts`, nur aus realisierten Aufrufen. Jede neue Automatik, die Tokens kostet, setzt eine Marke (`beginTurn` in `server/core/fleetturns.ts`) oder läuft als Job (`jobs.jsonl`), sonst fehlt sie in der Bilanz.
- Dollar außerhalb der Verbrauchsseite nur, wenn `useDollars()` (`app/lib/billing.ts`) es erlaubt; Standard ist `billing: "subscription"`, dann Tokens.
- Keine echten Transcripts, Prompts oder Pfade in Tests, Fixtures oder Screenshots. Demo-Daten erfinden (`server/core/demo.ts`).
- UI zweisprachig über `t("de", "en")`, Server über `tr("de", "en")`. Code, Bezeichner und Kommentare auf Englisch. Kommentare erklären warum.
- Echte `<button>`- und `<a>`-Elemente, alles per Tastatur bedienbar.
- **Live-Praxistest vor jedem Release, nie nur Demo** (Ben, 16.10.2026): Demo-Daten zeigen nur, was jemand erfunden
  hat. Zwei Fehler des Tages (Enter auf einer Freigabe der Desktop-App öffnete einen Zweig; der Hinweis der App vor
  getippten Prompts machte beantwortete Fragen zu „wartet“) gab es nur im echten Betrieb. Vor jedem Release läuft ein
  Live-Praxistest gegen den laufenden Live-Fleet mit echten Sessions, Subagenten, Freigaben und
  Fragen, in der Desktop-App und im Fleet-Terminal. Erst danach die Demo-Runden.
- **Terminal first** (Ben, 16.10.2026): Enter und `i` auf einer Session öffnen sie im Fleet-Terminal, immer und
  sofort. Läuft sie noch woanders (Desktop-App, anderes Fenster), setzt Fleet sie als eigenen Zweig fort
  (`forkArgs`, `--fork-session`), statt mit einer Warnung anzuhalten. Ein einmal gewähltes anderes Ziel (VS Code …)
  gilt nur im Menü der Schublade, nie für Zeilenknöpfe und Tasten.
  Ausnahme Freigaben (16.10.2026): Hält die Desktop-App oder ein fremdes Terminal eine Freigabe, kann ein Zweig sie
  nicht beantworten (er zeigt den Aufruf als „Interrupted“). Die Zeile öffnet die Session dann in der App bzw. sagt, wo
  die Freigabe wartet; `y`/`a`/`n` beantworten nur Freigaben, die Fleet selbst hält (`approvalHolder`, Zone `approval`).
- Oberfläche (`ui-screen`): ein Schirm, die Seite scrollt nie, gescrollt wird nur im Körper einer Kachel; neue Bereiche sind Kacheln. Tasten nur in `app/lib/keymap.ts` (eingefroren, nur additiv), Komponenten fragen `hit(e, action)`. Destruktives fragt in der Statuszeile (`y/n`), nie per Dialog. Nummerierte Zeilen tragen `rowProps(...)`. Details nur in der Schublade, nichts klappt in der Zeile auf. Log- und Diff-Sicht sind die einzigen festen Ebenen.

## Tests

- Jede Änderung an Logik kommt mit Test; jeder gefundene Fehler zuerst als roter Test.
- „Wartet“ ist eine Garantie: jede Art zu warten ist eine Zeile in `tests/waiting-cases.test.ts`; `node dist/fleet.cjs audit` vor jedem Release 0 verpasst (`verify`).
- Integrationstests gegen den echten gebauten Server mit eigenem `CLAUDE_CONFIG_DIR`/`CLAUDE_FLEET_HOME`, nie das echte `claude` (`verify`).
- E2E über Rollen und Beschriftungen, nie CSS-Klassen; jede neue Ansicht ohne Seitenscroll; neue Dialoge in den axe-Test (`ui-screen`, „Tests der Oberfläche“).

## Design

- Farben und Schriften nur aus `app/tokens.css`; Grau ist normal, Signalfarben nur als Text, 2-px-Kante oder Balken, kein Grün; `--crit` nur Fehler, `--warn` nur „wartet auf Ja“, `--att` nur Editierbares (`tests/css.test.ts`, `tests/contrast.test.ts`).
- Ein Raster: eine Schrift (`--font`, `--fs`), Zeilenhöhe `var(--row)` = 20 px, Breiten in `ch`; kein `border-radius`, kein Verlauf. Knöpfe und Tags sind Text. Status-Symbol ist ein Textzeichen (`Mark`). Animationen nur unter `prefers-reduced-motion: no-preference`. Alles Weitere: `ui-screen`, Abschnitt „Design“.

## Commits

Conventional Commits, Arbeit auf Branches mit PR. `main` bleibt grün. Ein Commit = eine logische Änderung, bis 1200
geänderte Zeilen ohne Lockfile und generierte Dateien (globaler Hook). Ein PR = ein Thema.

- Vor jedem Commit `pnpm check:quick`. Der Git-Hook `.githooks/pre-push` (eingeschaltet durch `pnpm install`) läuft
  ihn vor jedem Push (rund 25 s); rot = kein Push, Doku-only überspringt, `--no-verify` nur im Notfall. Bei Änderungen an der
  Oberfläche vor dem Push zusätzlich `pnpm check` mit Playwright.
- CI: Ein PR läuft schlank auf Ubuntu (Typen/Lint/Tests, Laufzeit Node 18 und 24, E2E; das sind die Pflicht-Checks).
  Die volle Matrix mit macOS und Windows läuft auf `main`, bei Tags `v*`, per Hand und mit dem Label `ci:full` am PR.
  Ein PR nur mit `docs/` und Markdown meldet die Pflicht-Checks grün, ohne zu bauen.
- Commits werden vor allem von Agenten gelesen. Der Text erklärt den Diff, damit niemand ihn rekonstruieren muss:

```
feat(scope): what changes, in one line

What: the behaviour before and after, in two or three sentences.
Why: the reason (spec rule, bug, review finding).
Files: path – what it does there (only the non-obvious ones).
Tests: new or changed tests and what they pin down.
Decisions: assumptions and choices a later session must know.
```
