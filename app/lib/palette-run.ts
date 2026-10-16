import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { fleetWorktree } from "../../shared/repo";
import type { OpenPr } from "../../shared/types";
import { useActions } from "./actions";
import { stoppable } from "./cleanup";
import { countUse } from "./featureuse";
import { useFleet } from "./fleet";
import { useI18n } from "./i18n";
import { askCleanup, type KeyApi, openUrl } from "./key-actions";
import { type Binding, bindingOf, KEYMAP } from "./keymap";
import { mergeAsk, mergeBlocked } from "./merge";
import { type Cmd, isMode } from "./palette";
import { afterRender, allRows, focusRow, rowByNr } from "./rows";
import { sendInput, sendKill } from "./terminal";
import { setTheme } from "./theme";

/**
 * What a palette command does (spec, "Befehlspalette und :-Zeile"). Commands without an argument run the key
 * action on the row selected last; the others use the same `useActions` as the buttons. Results go to the status
 * line, like every key.
 */
export function usePaletteRun(
  api: KeyApi,
  k: {
    dispatch: (b: Binding, row: HTMLElement | null) => boolean;
    later: (stage: number) => void;
    openPr: (root: string, n: number) => OpenPr | undefined;
  },
) {
  const { t, setLang } = useI18n();
  const f = useFleet();
  const a = useActions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, sessionById, preferred, showToast: say } = f;
  const { dispatch, later, openPr } = k;

  return useCallback(
    (c: Cmd) => {
      countUse(`cmd:${c.kind}`);
      switch (c.kind) {
        case "later":
          return later(c.stage);
        case "go":
          return navigate(c.to);
        case "row": {
          const pick = () =>
            focusRow(rowByNr(c.nr)) || say(t(`Keine Zeile ${c.nr} auf Jetzt`, `No row ${c.nr} on Now`));
          if (pathname === "/") return pick();
          navigate("/");
          return afterRender(pick);
        }
        case "action": {
          // An action with an argument (the tile of `1`–`5`) runs the binding of that argument.
          const b =
            (c.arg !== undefined && KEYMAP.find((x) => x.action === c.action && x.arg === c.arg)) ||
            bindingOf(c.action);
          if (b) dispatch(b, api.lastRow());
          return;
        }
        case "session":
        case "pr": {
          const id = c.kind === "session" ? c.id : c.sessionId;
          const jump = () => focusRow(id ? allRows().find((r) => r.dataset.session === id) || null : null);
          if (pathname !== "/") navigate("/");
          afterRender(() => {
            if (jump()) return;
            if (c.kind === "pr" && openUrl(c.url)) return;
            // Folded away or in the archive: the search brings it up.
            const s = id ? sessionById.get(id) : undefined;
            if (s?.title) f.setQuery(String(s.title));
            afterRender(jump);
          });
          return;
        }
        case "repo":
          f.setQuery(c.name);
          if (pathname !== "/") navigate("/");
          return say(t(`Sessions in ${c.name}`, `Sessions in ${c.name}`));
        case "new":
          if (!data?.terminal?.available)
            return say(t("Terminal im Fenster nicht verfügbar", "Terminal in the window not available"));
          return a.newSession(c.root, c.prompt, c.worktree === true);
        case "newFolder":
          if (!data?.terminal?.available)
            return say(t("Terminal im Fenster nicht verfügbar", "Terminal in the window not available"));
          return a.newFolder(c.name, c.prompt);
        case "here":
          if (!data?.terminal?.available)
            return say(t("Terminal im Fenster nicht verfügbar", "Terminal in the window not available"));
          return a.startHere(c.dir, c.prompt);
        case "resume": {
          const s = sessionById.get(c.id);
          if (s) a.openFleet(s);
          return;
        }
        case "reply":
          return sendInput(c.id, `${c.text}\r`)
            .then(() => say(t("Antwort gesendet", "Reply sent")))
            .catch((e) =>
              say(`${t("Senden fehlgeschlagen", "Sending failed")}: ${e instanceof Error ? e.message : e}`),
            );
        case "merge": {
          const known = openPr(c.root, c.number);
          return api.ask(`${mergeAsk(c.number, known, t)} y/n`, () => a.mergePr(c.root, c.number, c.anyway));
        }
        case "mergeBlocked": {
          const known = openPr(c.root, c.number);
          return say(
            `#${c.number}: ${mergeBlocked(c.why, { stackedOn: known?.stackedOn ?? null, base: known?.base || "" }, t)}`,
          );
        }
        case "run":
          if (c.action === "fix" && !preferred)
            return say(t("Kein Ziel für die Fix-Session verfügbar", "No target available for the fix session"));
          return a.runAction(c.root, c.runId, c.action, c.action === "fix" ? preferred?.id : undefined);
        case "handoff": {
          const row = api.lastRow();
          const s = row?.dataset.session ? sessionById.get(row.dataset.session) : undefined;
          if (!s) return say(t("Erst eine Session-Zeile wählen (↑ ↓)", "Select a session row first (↑ ↓)"));
          return a.handoffJob(s);
        }
        case "cleanup": {
          // Sessions first; after their question (or when there is none), the finished worktrees.
          const roots = (c.roots || (data?.repos || []).map((r) => r.root)).filter((r) => !fleetWorktree(r));
          const worktrees = () => void a.cleanWorktrees(roots, api.ask);
          return askCleanup(
            {
              sessions: data?.sessions || [],
              procs: data?.processes || [],
              ask: api.ask,
              hidden: api.hidden,
              hide: (id) => a.meta(id, { hidden: true }),
              say,
              t,
              after: worktrees,
            },
            c.roots || null,
            c.name || "",
          );
        }
        case "stop": {
          const procs = stoppable(data?.processes || []);
          // Sessions of the desktop app or the cloud run in their own process: Fleet cannot end them and says so.
          const outside = (data?.sessions || []).filter(
            (s) => s.status === "working" && !procs.some((p) => p.id === s.id),
          ).length;
          const rest = outside
            ? t(
                ` – ${outside} arbeiten außerhalb von Fleet und laufen weiter`,
                `; ${outside} work outside Fleet and keep running`,
              )
            : "";
          if (!procs.length)
            return say(`${t("Keine Session läuft im Fleet-Fenster", "No session runs in Fleet's window")}${rest}`);
          return api.ask(
            t(
              `Alle ${procs.length} Sessions im Fleet-Fenster beenden? y/n`,
              `End all ${procs.length} sessions in Fleet's window? y/n`,
            ),
            () =>
              Promise.allSettled(procs.map((p) => sendKill(p.id, "term"))).then((r) => {
                const ok = r.filter((x) => x.status === "fulfilled").length;
                say(`${t(`${ok} von ${procs.length} beendet`, `${ok} of ${procs.length} ended`)}${rest}`);
                f.reload(true);
              }),
          );
        }
        case "filter": {
          const b = bindingOf("filter");
          if (b) dispatch({ ...b, arg: c.filter }, null);
          return;
        }
        case "clear":
          api.setFilter(null);
          f.setQuery("");
          return say(t("Filter und Suche geleert", "Filter and search cleared"));
        case "theme":
          setTheme(c.theme);
          return say(`${t("Farbschema", "Colour scheme")}: ${c.theme}`);
        case "lang":
          setLang(c.lang);
          return say(c.lang === "de" ? "Sprache: Deutsch" : "Language: English");
        case "mode":
          if (isMode(c.mode)) return api.setMode(c.mode);
          return say(`${t("Unbekannter Tastaturmodus", "Unknown keyboard mode")}: ${c.mode}`);
        case "help":
          return api.setHelp("all");
        case "repoDrawer":
          f.openDrawer({ kind: "repo", name: c.name, title: c.name, tab: c.tab });
          return;
        case "conflict":
          return f.openDrawer({ kind: "conflict", root: c.root, a: c.a, b: c.b, title: c.title });
        case "report": {
          // The same download the activity page offers; the server builds it from its own overview.
          const link = document.createElement("a");
          link.href = `/api/report/week?format=${c.format}`;
          link.download = "";
          link.click();
          return say(t("Wochenbericht wird geladen", "Downloading the week report"));
        }
      }
    },
    [a, api, data, dispatch, f, later, navigate, openPr, pathname, preferred, say, sessionById, setLang, t],
  );
}
