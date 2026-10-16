import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { decisionText } from "../../shared/decision-words";
import { inbox, places } from "../../shared/inbox";
import type { OpenPr, Proc, Session } from "../../shared/types";
import { useActions } from "./actions";
import { CLEANUP_HOURS, cleanupCandidates } from "./cleanup";
import { conflictsOf } from "./conflict";
import { countUse } from "./featureuse";
import { useFleet } from "./fleet";
import { useI18n } from "./i18n";
import { type Binding, clearKey, type Mode, type StatusFilter } from "./keymap";
import { mergeQuestion } from "./merge";
import { statusName } from "./palette";
import { afterRender, allRows, focusedSession, focusRow, refocus, repoRoots, rowByKey, rowLabel, rowOf } from "./rows";
import { appOpens, approvalWhere, openable, resumeCmds } from "./session";
import { sendKill } from "./terminal";
import { covered, sideLines, type TileId, useTiles } from "./tiles";
import { alarmKey } from "./view";
import { useVimKeys } from "./vim-actions";

/**
 * What each key and each palette command does. Keys are shortcuts for commands, not functions of their own
 * (spec, Grundregel 5): both end here and use the same actions as the buttons (`useActions`). Every result goes to
 * the status line; a key that has nothing to act on says why instead of doing nothing silently.
 */

/** The prompt of the command line: `:` for a command, `/` for the search. */
export type CommandPrompt = ":" | "/";

/** One step `u` can take back: sessions hidden together, or one muted alarm. */
export type Undo = { kind: "hide"; ids: string[] } | { kind: "mute"; key: string; label: string };

export interface KeyApi {
  setFilter: (f: StatusFilter | null) => void;
  /** The status filter now on. */
  filter: () => StatusFilter | null;
  replying: () => string | null;
  setReplying: (id: string | null) => void;
  /** A destructive action asks in the status line first: y runs it, any other key drops it. */
  ask: (text: string, run: () => void) => void;
  mute: (key: string, label: string) => void;
  help: () => boolean;
  setHelp: (v: "zone" | "all" | null) => void;
  /** The log view (Shift+L): open or not. */
  log: () => boolean;
  setLog: (v: boolean) => void;
  /** The diff view of a session (release 6). */
  setDiff: (d: { id: string; title: string } | null) => void;
  /** Puts the focus in the command line, with `:` for a command or `/` for the search. */
  setCommand: (c: CommandPrompt | null) => void;
  /** The row selected last; palette commands without an argument act on it. */
  lastRow: () => HTMLElement | null;
  mode: () => Mode;
  setMode: (m: Mode) => void;
  /** Rows marked with Vim's `V` (`data-row` keys); `setVisual(key)` starts marking at a row, null ends it. */
  marked: () => string[];
  setVisual: (key: string | null) => void;
  /** Sessions a hide took away, pushed on the undo stack for `u`. */
  hidden: (ids: string[]) => void;
  /** Pops the newest hide or mute of this page visit (round 7: `u` undid one step only). */
  takeUndo: () => Undo | null;
  unmute: (key: string) => void;
}

const PAGE = 10;

/** The focus is on one of a side tile's lines (repo bar, event stream): an arrow moves from there. */
const onLine = () => !!sideLines(document.activeElement)?.includes(document.activeElement as HTMLElement);
const TILE_NAMES: Record<TileId, [string, string]> = {
  alarm: ["Die Alarmzone", "The alarm zone"],
  repos: ["Die Repo-Leiste", "The repo bar"],
  board: ["Die Wachtafel", "The watch board"],
  stream: ["Der Ereignisstrom", "The event stream"],
  drawer: ["Die Schublade", "The drawer"],
};
const isLive = (s: Session) => s.proc?.mode === "pty" && (s.proc.status === "running" || s.proc.status === "starting");
/**
 * A view without lines or rows still moves by keys (release 6, plan R11): the body of the tile with the focus
 * scrolls. `to` is the same step function a selection uses; asked from the middle of a long list it tells the
 * direction and size (one row, a page, to an end), which here becomes rows of the grid.
 */
function scrollTile(to: (i: number, n: number) => number): boolean {
  const tile =
    document.activeElement?.closest<HTMLElement>("[data-tile]") ||
    document.querySelector<HTMLElement>('[data-tile="board"]');
  const body = tile?.querySelector<HTMLElement>(".tile-b");
  if (!body) return false;
  const mid = 5000;
  const step = to(mid, 2 * mid) - mid;
  const row = Number.parseFloat(getComputedStyle(body).lineHeight) || 20;
  if (Math.abs(step) >= mid - 1) body.scrollTop = step < 0 ? 0 : body.scrollHeight;
  else body.scrollTop += step * row;
  if (!tile?.contains(document.activeElement)) body.focus({ preventScroll: true });
  return true;
}

/**
 * `:cleanup`, and "tidy up" for one repo (release 6): hides the sessions quiet for CLEANUP_HOURS after a y/n with the
 * count; `u` brings them back. `roots` narrows it to a repo's checkouts.
 */
/** Keys that act on the session a row of Fleet's question is about. */
const OWNER_ACTIONS = new Set(["terminal", "diff", "openApp"]);

export function askCleanup(
  o: {
    sessions: Session[];
    procs: Proc[];
    ask: KeyApi["ask"];
    hidden: KeyApi["hidden"];
    hide: (id: string) => void;
    say: (m: string) => void;
    t: (de: string, en: string) => string;
    /** After the question was answered with y, or when there was nothing to hide (`:cleanup` asks about worktrees). */
    after?: () => void;
  },
  roots: string[] | null = null,
  name = "",
): boolean {
  const { t, say } = o;
  const inRepo = (s: Session) => !roots || (!!s.repoRoot && roots.includes(s.repoRoot));
  const old = cleanupCandidates(o.sessions.filter(inRepo), o.procs, Date.now());
  const where = name ? t(` in ${name}`, ` in ${name}`) : "";
  if (!old.length) {
    say(
      t(
        `Nichts aufzuräumen${where} – keine Session ist länger als ${CLEANUP_HOURS} h still`,
        `Nothing to clean up${where}: no session has been quiet for more than ${CLEANUP_HOURS} h`,
      ),
    );
    o.after?.();
    return true;
  }
  o.ask(
    t(
      `${old.length} Sessions${where} ohne Lebenszeichen seit ${CLEANUP_HOURS} h ausblenden? y/n`,
      `Hide ${old.length} sessions${where} quiet for ${CLEANUP_HOURS} h? y/n`,
    ),
    () => {
      const ids = old.map((s) => s.id);
      for (const id of ids) o.hide(id);
      o.hidden(ids);
      say(
        t(
          `${ids.length} Sessions aufgeräumt – u holt sie zurück; arbeitet eine wieder, steht sie wieder da`,
          `${ids.length} sessions cleaned up: u brings them back; one that works again shows again`,
        ),
      );
      o.after?.();
    },
  );
  return true;
}

export const openUrl = (url: string | null | undefined) => {
  if (!url || !/^https:\/\//.test(url)) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
};

export function useKeyDispatch(api: KeyApi) {
  const { t } = useI18n();
  const f = useFleet();
  const a = useActions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tiles = useTiles();
  const { data, sessionById, repoByRoot, showToast, preferred, targets, prefs } = f;
  const say = showToast;
  /** The conflict `g k` opened last: pressed again on the same row, it walks on to the next one. */
  const lastConflict = useRef("");
  /** Says why a key did nothing; the key counts as handled. */
  const note = useCallback(
    (msg: string) => {
      say(msg, true);
      return true;
    },
    [say],
  );

  const later = useCallback(
    (stage: number) =>
      say(
        t(
          `Noch nicht verfügbar – kommt mit Stufe ${stage} des Leitstands`,
          `Not available yet: comes with stage ${stage} of the control room`,
        ),
      ),
    [say, t],
  );

  const openPr = useCallback(
    (root: string, n: number): OpenPr | undefined => (repoByRoot.get(root)?.prs?.prs || []).find((p) => p.number === n),
    [repoByRoot],
  );

  const merge = useCallback(
    (s: Session | undefined, row: HTMLElement | null) => {
      const pr = s?.ci?.pr;
      if (!s || !pr) {
        say(
          row?.dataset.kind === "ci"
            ? t(
                "CI ist rot – erst reparieren (f) oder neu starten (Shift+R)",
                "CI is red: fix (f) or re-run (Shift+R) first",
              )
            : t("Kein PR in dieser Zeile", "No PR in this row"),
        );
        return;
      }
      const known = s.repoRoot ? openPr(s.repoRoot, Number(pr.number)) : undefined;
      const why =
        pr.state === "draft" || known?.draft
          ? t("Entwurf – erst als bereit markieren", "Draft: mark it ready first")
          : pr.state !== "open"
            ? t(`PR #${pr.number} ist nicht offen`, `PR #${pr.number} is not open`)
            : known?.stackedOn
              ? t(
                  `wartet auf #${known.stackedOn} – erst den mergen`,
                  `waits for #${known.stackedOn}: merge that one first`,
                )
              : !s.remote
                ? t("Kein Git-Host für dieses Repo", "No git host for this repo")
                : pr.ci === "failure"
                  ? t(
                      "CI ist rot – „Trotzdem mergen“ nur über den Knopf in der Zeile",
                      'CI is red: "merge anyway" only through the button in the row',
                    )
                  : pr.ci === "pending" || pr.ci === "running"
                    ? t("CI läuft noch", "CI is still running")
                    : "";
      if (why) return say(`PR #${pr.number}: ${why}`);
      api.ask(`${mergeQuestion(pr.number, known, t)} y/n`, () => a.merge(s));
    },
    [a, api, openPr, say, t],
  );

  /** Re-run or fix a red run: from a CI row, or from a session whose last run is red. */
  const runRed = useCallback(
    (s: Session | undefined, row: HTMLElement | null, action: "rerun" | "fix") => {
      const root = row?.dataset.root || s?.repoRoot || "";
      const id = Number(row?.dataset.run || (s?.ci?.ci?.state === "failure" ? s.ci.ci.id : 0));
      if (!root || !id) return say(t("Kein roter CI-Lauf in dieser Zeile", "No red CI run in this row"));
      if (action === "fix" && !preferred)
        return say(t("Kein Ziel für die Fix-Session verfügbar", "No target available for the fix session"));
      return a.runAction(root, id, action, action === "fix" ? preferred?.id : undefined);
    },
    [a, preferred, say, t],
  );

  const move = useCallback(
    (row: HTMLElement | null, to: (i: number, n: number) => number) => {
      // In the repo bar, the event stream and the other views the arrows walk that tile's own lines. With the focus
      // on nothing (body), the active tile counts, as for Esc (CLAUDE.md).
      const idle = !document.activeElement || document.activeElement === document.body;
      const from =
        idle && tiles.active ? document.querySelector(`[data-tile="${tiles.active}"]`) : document.activeElement;
      const side = sideLines(from);
      if (side) {
        if (!side.length) return false;
        const at = side.findIndex((x) => x === document.activeElement || x.contains(document.activeElement));
        // Nothing selected in this tile yet: any key starts at its first line, End and G at its last (as for rows).
        const i = at < 0 ? (to(-1, side.length) >= side.length - 1 ? side.length - 1 : 0) : to(at, side.length);
        const el = side[Math.max(0, Math.min(side.length - 1, i))];
        el?.focus();
        el?.scrollIntoView?.({ block: "nearest" });
        return !!el;
      }
      // Round 7: a key acts inside the focused tile. Home/End and the page keys stop at the tile's own first and last
      // row; they never land in the alarm zone from the board or the other way round (Ctrl+J/K and the digits cross).
      const home =
        row?.closest<HTMLElement>("[data-tile]") ||
        (idle ? from : document.activeElement)?.closest<HTMLElement>("[data-tile]") ||
        null;
      const rows = allRows().filter((r) => !home || home.contains(r));
      if (!rows.length) return scrollTile(to);
      const last = api.lastRow();
      // Nothing selected yet: the first key starts in the active tile, not on the screen's first row (round 3: the
      // board was active and j went into the alarm zone).
      const mine = idle && !row && tiles.active ? from?.querySelectorAll<HTMLElement>("[data-row]") : undefined;
      if (mine?.length && !(last && from?.contains(last))) return focusRow(mine[0] || null);
      const cur = row ? rows.indexOf(row) : last ? rows.indexOf(last) : -1;
      // Nothing selected in this tile: any key starts at its first row, End at its last.
      const i =
        cur < 0
          ? to(-1, rows.length) >= rows.length - 1
            ? rows.length - 1
            : 0
          : Math.max(0, Math.min(rows.length - 1, to(cur, rows.length)));
      return focusRow(rows[i] || null);
    },
    [api, tiles.active],
  );

  /**
   * Folds a row that is no session open or shut (a CI run's jobs). A session never unfolds in its row since stage 12:
   * its details are in the drawer (spec, "Ein Schirm im CLI-Look", rule 15).
   */
  const toggle = useCallback((row: HTMLElement) => {
    const opener = row.dataset.kind === "session" ? null : row.querySelector<HTMLElement>("[data-opener]");
    if (!opener) return false;
    opener.click();
    refocus(row.dataset.row || "");
    return true;
  }, []);

  const vim = useVimKeys(api, { move, toggle, note });

  const close = useCallback(
    (row: HTMLElement | null) => {
      if (api.replying()) {
        api.setReplying(null);
        return true;
      }
      if (row?.dataset.open) return toggle(row);
      if (f.drawer) {
        f.closeDrawer();
        return true;
      }
      // Round 7: Esc takes off, step by step, what narrows the lists: the search first, then the status filter.
      if (f.query.trim()) {
        f.setQuery("");
        say(t("Suche gelöscht", "Search cleared"));
        return true;
      }
      const on = api.filter();
      if (on) {
        api.setFilter(null);
        say(t("Filter aufgehoben", "Filter cleared"));
        return true;
      }
      return false;
    },
    [api, f, say, t, toggle],
  );

  /**
   * Tab and Shift+Tab walk round the tiles on screen (spec rule 6), from a tile's line or body only (the keyboard
   * controller leaves Tab on any other button to the browser); Ctrl+H/L go from wherever the focus stands (round 8:
   * after a click on × they did nothing).
   */
  const zone = useCallback(
    (dir: 1 | -1) => {
      const next = tiles.next(dir);
      return !!next && tiles.go(next);
    },
    [tiles],
  );
  const tile = useCallback(
    (id: TileId) => {
      if (tiles.go(id)) return true;
      if (id === "drawer")
        return note(
          t("Schublade ist zu – Enter auf einer Zeile öffnet sie", "The drawer is shut: Enter on a row opens it"),
        );
      if (covered(id))
        return note(
          t(
            "Die Schublade steht an Stelle des Stroms – Esc schließt sie",
            "The drawer stands in the stream's place: Esc closes it",
          ),
        );
      const name = TILE_NAMES[id];
      return note(t(`${name[0]} gibt es in dieser Ansicht nicht – :now`, `${name[1]} is not in this view: :now`));
    },
    [tiles, note, t],
  );

  /**
   * Hides a session from a row, the drawer's button or a mark: a session that waits for you only on a yes (round 4: x
   * made a waiting one vanish unasked; round 7: the drawer's button did the same). The focus goes to the next row,
   * and a drawer showing the session closes with it.
   */
  const hideSession = useCallback(
    (s: Session, row: HTMLElement | null) => {
      const title = String(s.title || s.project || "");
      const rows = allRows();
      const at = row ? rows.indexOf(row) : -1;
      const next = row ? rows[at + 1] || rows[at - 1] : rows[0];
      const hide = () => {
        a.meta(s.id, { hidden: true });
        api.hidden([s.id]);
        const key = next?.dataset.row;
        // From the drawer the focus must already stand on the next row when the drawer closes, else it falls back
        // to the hidden row's opener or the body (round 7).
        if (f.drawer?.kind === "session" && f.drawer.id === s.id) {
          if (key) focusRow(rowByKey(key));
          f.closeDrawer();
        }
        say(
          t(
            `${title}: ausgeblendet – u holt sie zurück; arbeitet sie wieder, steht sie wieder da`,
            `${title}: hidden; u brings it back, and it shows again once it works again`,
          ),
        );
        // The row that was hidden still stands (and has the focus) until the overview draws without it: the late
        // refocus would take that for a move of yours and give up, leaving the cursor on nothing (round 8).
        if (next && row && rowOf(document.activeElement) === row) focusRow(next);
        if (key) refocus(key);
      };
      const place = data ? places(inbox(data)).get(s.id) : undefined;
      if (place === "needs" || place === "decision")
        api.ask(
          t(`„${title}“ wartet auf dich – trotzdem ausblenden? y/n`, `"${title}" waits for you: hide anyway? y/n`),
          hide,
        );
      else hide();
    },
    [a, api, data, f, say, t],
  );

  /** Mutes an alarm for 1 h after a y/n: `x` on a row without a session and `s` ask the same (round 7). */
  const askMute = useCallback(
    (row: HTMLElement, next?: HTMLElement | null) => {
      const key = row.dataset.mute;
      if (!key) return false;
      const label = rowLabel(row);
      api.ask(t(`„${label}“ für 1 h stummschalten? y/n`, `Mute "${label}" for 1 h? y/n`), () => {
        api.mute(key, label);
        if (next?.dataset.row) refocus(next.dataset.row);
      });
      return true;
    },
    [api, t],
  );

  const session = useCallback(
    (s: Session | undefined, b: Binding, row: HTMLElement | null): boolean => {
      if (!s) {
        say(t("Erst eine Session-Zeile wählen (↑ ↓)", "Select a session row first (↑ ↓)"), true);
        return true;
      }
      const title = String(s.title || s.project || "");
      const remote = s.source === "cloud" || s.source === "cowork";
      switch (b.action) {
        case "terminal":
          a.jump(s);
          return true;
        case "openApp": {
          if (remote) return openUrl(s.url) || note(t("Kein Link zu dieser Session", "No link to this session"));
          const pick =
            targets.find((x) => x.id === prefs.openTarget && x.id !== "fleet") || targets.find((x) => x.id !== "fleet");
          if (!pick || !openable(s, !!data?.demo))
            say(
              t(
                "Kein Programm zum Öffnen verfügbar – c kopiert den Resume-Befehl",
                "No program to open it: c copies the resume command",
              ),
            );
          else a.openIn(s, pick.id, false);
          return true;
        }
        case "reply":
          if (isLive(s)) api.setReplying(s.id);
          else
            say(
              t(
                "Inline antworten geht bei Sessions im Fleet-Terminal – → öffnet sie dort",
                "Inline replies work for sessions in the Fleet terminal: → opens it there",
              ),
            );
          return true;
        case "newHere": {
          const r = s.repoRoot ? repoByRoot.get(s.repoRoot) : undefined;
          if (!r) say(t("Diese Session gehört zu keinem Repo", "This session belongs to no repo"));
          else if (r.handoff && !r.handoff.delivered && preferred) a.continueIn(r.root, preferred.id);
          else if (data?.terminal?.available) a.newSession(r.root, "");
          else say(t("Kein Weg, hier eine Session zu starten", "No way to start a session here"));
          return true;
        }
        case "fresh":
          if (!s.fresh)
            say(
              t(
                "Frisch starten bietet Fleet hier nicht an – der Kontext ist günstig",
                "Fleet does not offer a fresh start here: the context is cheap",
              ),
            );
          else if (s.fresh.pending)
            say(t("Frisch starten ist schon angefordert", "A fresh start is requested already"));
          else a.fresh(s, preferred?.id || null);
          return true;
        case "copy": {
          const c = remote ? {} : resumeCmds(s, data?.platform || "");
          if (c.main) a.copy(c.main, t("Resume-Befehl", "Resume command"));
          else say(t("Für diese Session gibt es keinen Resume-Befehl", "There is no resume command for this session"));
          return true;
        }
        case "note":
          // The note is in the session's drawer; it takes the focus once the drawer has drawn.
          if (f.drawer?.kind !== "session" || f.drawer.id !== s.id) f.openDrawer({ kind: "session", id: s.id, title });
          afterRender(() => document.getElementById(`note-${s.id}`)?.focus());
          return true;
        case "pin":
          a.meta(s.id, { pinned: !s.meta?.pinned });
          say(
            s.meta?.pinned
              ? t(`${title}: gelöst`, `${title}: unpinned`)
              : t(`${title}: angeheftet`, `${title}: pinned`),
          );
          return true;
        case "hide":
          hideSession(s, row);
          return true;
        case "end":
          if (!isLive(s)) {
            say(
              t(
                "Beenden geht nur bei Sessions im Fleet-Terminal",
                "Ending works only for sessions in the Fleet terminal",
              ),
            );
            return true;
          }
          api.ask(t(`„${title}“ beenden? y/n`, `End "${title}"? y/n`), () =>
            sendKill(s.id, "term")
              .then(() => say(t(`${title}: beendet`, `${title}: ended`)))
              .catch((e) =>
                say(`${t("Beenden ging nicht", "Ending did not work")}: ${e instanceof Error ? e.message : e}`),
              ),
          );
          return true;
        case "diff":
          if (remote)
            return note(t("Läuft in der Cloud – keine Änderungen hier", "Runs in the cloud: no changes here"));
          api.setDiff({ id: s.id, title });
          return true;
        case "goPr":
          return openUrl(s.ci?.pr?.url) || note(t("Kein PR in dieser Zeile", "No PR in this row"));
        case "goCi":
          return openUrl(s.ci?.ci?.url) || note(t("Kein CI-Lauf in dieser Zeile", "No CI run in this row"));
        case "goConflict": {
          const all = conflictsOf(s, openPr);
          if (!all.length) return note(t("Kein Konflikt in dieser Zeile", "No conflict in this row"));
          const i = (all.findIndex((p) => `${p.a}|${p.b}` === lastConflict.current) + 1) % all.length;
          const pick = all[i];
          if (!pick) return false;
          lastConflict.current = `${pick.a}|${pick.b}`;
          f.openDrawer({ kind: "conflict", ...pick });
          if (all.length > 1)
            say(
              t(
                `Konflikt ${i + 1} von ${all.length} – Esc, dann g k zeigt den nächsten`,
                `Conflict ${i + 1} of ${all.length}: Esc, then g k shows the next one`,
              ),
            );
          return true;
        }
        case "goRepo": {
          const line = [...document.querySelectorAll<HTMLElement>("[data-repo]")].find(
            (r) => !!s.repoRoot && repoRoots(r).includes(s.repoRoot),
          );
          const name = line?.querySelector<HTMLElement>("[data-opener]");
          if (name) {
            name.focus();
            // Under 100 columns the repo bar may stand behind the board (rule 17): bring it in sight first.
            if (document.activeElement !== name) {
              tiles.show("repos");
              afterRender(() => name.focus());
            }
          } else
            note(
              t(
                `${s.project || "Das Repo"} steht nicht in der Repo-Leiste`,
                `${s.project || "The repo"} is not in the repo bar`,
              ),
            );
          return true;
        }
        case "drawer":
          f.openDrawer({ kind: "session", id: s.id, title });
          return true;
        default:
          return false;
      }
    },
    [a, api, data, f, hideSession, openPr, preferred, prefs.openTarget, repoByRoot, say, t, targets, note, tiles],
  );

  /** Keys in a line of the repo bar: its drawer, a new session there, tidying up. */
  const repoKey = useCallback(
    (b: Binding, row: HTMLElement): boolean => {
      const name = row.dataset.repo || "";
      const root = repoRoots(row)[0] || "";
      switch (b.action) {
        case "repoDrawer":
          f.openDrawer({ kind: "repo", name, title: name });
          return true;
        case "repoNew":
          if (!root)
            return note(
              t(`${name || "Dieses Repo"} hat keinen Ordner hier`, `${name || "This repo"} has no folder here`),
            );
          if (!data?.terminal?.available)
            return note(t("Neue Sessions gehen nur im Fleet-Terminal", "New sessions need the Fleet terminal"));
          a.newSession(root, "");
          return true;
        case "tidy":
          // Release 6: tidying up is :cleanup for this repo's checkouts.
          return askCleanup(
            {
              sessions: data?.sessions || [],
              procs: data?.processes || [],
              ask: api.ask,
              hidden: api.hidden,
              hide: (id) => a.meta(id, { hidden: true }),
              say,
              t,
            },
            repoRoots(row),
            name,
          );
        default:
          return false;
      }
    },
    [a, api, data, f, note, say, t],
  );

  /** Runs a binding on a row (the selected one, or the one whose number was typed). */
  const dispatch = useCallback(
    (b: Binding, row: HTMLElement | null): boolean => {
      countUse(`key:${b.action}${b.arg ? `:${b.arg}` : ""}`);
      if (b.stage) {
        later(b.stage);
        return true;
      }
      const v = vim(b, row);
      if (v !== null) return v;
      // A row's session, or the one a line outside the rows stands for (event stream, history).
      // Fleet's question is about a session (`data-owner`): the terminal and the diff go to that session; hide and mute
      // keep their meaning for the question's own row (practical test 15 Oct: i did nothing there).
      const ownerEl = row || (document.activeElement?.closest<HTMLElement>("[data-owner]") ?? null);
      const owner = ownerEl?.dataset.owner && OWNER_ACTIONS.has(b.action) ? ownerEl.dataset.owner : null;
      const sid = row?.dataset.session || owner || (!row ? focusedSession(document.activeElement) : null);
      const s = sid ? sessionById.get(sid) : undefined;
      if (row?.dataset.repo && b.zone === "repo") return repoKey(b, row);
      // In the repo bar without a selected line (its body has the focus): say what is missing (B15).
      if (b.zone === "repo")
        return note(t("Erst eine Repo-Zeile wählen (↑↓)", "Pick a line of the repo bar first (↑↓)"));
      // Enter on a line of another view presses its opener (release 6); a line that stands for a session opens its
      // drawer; elsewhere Enter stays what the element makes of it.
      const line = !row ? document.activeElement?.closest<HTMLElement>("[data-line]") : null;
      if (b.action === "drawer" && !row && !s && line) {
        const opener = line.querySelector<HTMLElement>("[data-opener]") || line.querySelector<HTMLElement>("a, button");
        if (opener) opener.click();
        else note(t("Diese Zeile öffnet nichts", "This line opens nothing"));
        return true;
      }
      if (b.action === "drawer" && !row && !s) return false;
      // Fleet's own question: its drawer has every answer.
      const decision = row?.dataset.row?.startsWith("d:")
        ? f.data?.decisions.find((d) => alarmKey.decision(d.id) === row.dataset.row)
        : undefined;
      if (b.action === "drawer" && decision) {
        f.openDrawer({ kind: "decision", id: decision.id, title: decision.sessionTitle || decision.title });
        return true;
      }
      // A red pipeline's title opens its drawer (stage 12.6), which takes the focus: no refocus on the row.
      if (b.action === "drawer" && row?.dataset.kind === "ci" && row.dataset.zone === "alarm") {
        row.querySelector<HTMLElement>("[data-opener]")?.click();
        return true;
      }
      // A running pipeline on the board opens the same drawer (round 3: "o detail" said the drawer was for sessions).
      if (b.action === "drawer" && row?.dataset.kind === "ci" && row.dataset.row?.startsWith("ci:")) {
        f.openDrawer({ kind: "ci", id: row.dataset.row.slice(3), title: row.getAttribute("aria-label") || "CI" });
        return true;
      }
      if (b.action === "drawer" && !s)
        return (
          toggle(row as HTMLElement) ||
          note(t("Die Schublade gibt es für Sessions und Repos", "The drawer is for sessions and repos"))
        );
      switch (b.action) {
        case "palette":
          api.setCommand(":");
          return true;
        case "search":
          // The search lives in the command line behind the `/` prompt (k9s, lnav).
          api.setCommand("/");
          return true;
        case "help":
          api.setHelp("zone");
          return true;
        case "log":
          api.setLog(!api.log());
          return true;
        case "close":
          return close(row);
        case "zoneNext":
          return zone(1);
        case "zonePrev":
          return zone(-1);
        case "tile":
          return tile((b.arg || "board") as TileId);
        case "zoom":
          tiles.setZoom(!tiles.zoom);
          say(
            tiles.zoom
              ? t("Alle Kacheln", "All tiles")
              : t("Kachel als Vollbild – + zurück", "Tile full screen: + back"),
          );
          return true;
        case "filter": {
          const v = (b.arg || null) as StatusFilter | null;
          api.setFilter(v);
          // Alt+0 clears every filter, the repo chosen in the repo bar too (round 4: it said "cleared" and kept it).
          if (!v) navigate({ pathname: "/", search: "" });
          else if (pathname !== "/") navigate("/");
          say(
            v
              ? `${t("Filter", "Filter")}: ${statusName(v, t)} · ${clearKey()} ${t("zeigt alle", "shows all")}`
              : t("Filter aufgehoben – alle Sessions aller Repos", "Filters cleared: every session of every repo"),
          );
          return true;
        }
        case "refresh":
          f.reload(true);
          say(t("Aktualisiert", "Refreshed"));
          return true;
        case "up":
          return move(row, (i) => (row || onLine() ? i - 1 : i));
        case "down":
          return move(row, (i) => (row || onLine() ? i + 1 : i));
        case "pageUp":
          return move(row, (i) => i - PAGE);
        case "pageDown":
          return move(row, (i) => i + PAGE);
        case "first":
          return move(row, () => 0);
        case "last":
          return move(row, (_i, n) => n - 1);
        case "allow":
        case "allowSession":
        case "deny": {
          const holder = row?.dataset.approval;
          const held = s && (holder === "app" || holder === "elsewhere") ? holder : null;
          if (held && s)
            return note(approvalWhere(held, t, held === "app" && appOpens(s, data), s.waits === "question"));
          if (holder === "terminal")
            return note(
              t(
                "Die Freigabe steht im Fleet-Terminal – → springt hinein",
                "The approval stands in Fleet's terminal: → goes in",
              ),
            );
          if (!decision || decision.status !== "open" || decision.expiresAt <= Date.now())
            return note(
              t(
                "Zu spät – die Freigabe ist abgelaufen, die App fragt jetzt selbst",
                "Too late: the approval ran out, the app asks itself now",
              ),
            );
          const id = b.action === "allow" ? "allow" : b.action === "deny" ? "deny" : "allow-session";
          const o = decision.options.find((x) => x.id === id);
          if (!o)
            return note(
              t(
                "„Für diese Session“ bietet Claude Code hier nicht an – y erlaubt einmal",
                'Claude Code offers no "for this session" here: y allows once',
              ),
            );
          a.decide(decision.id, o.id, decisionText(o.label, t));
          return true;
        }
        case "alarmAct": {
          const el = row?.querySelector<HTMLElement>("[data-act] button, [data-act] a, button[data-act]");
          if (!el || (el as HTMLButtonElement).disabled)
            say(t("Diese Zeile hat gerade keine Aktion", "This row has no action right now"));
          // Practical test 15 Oct: one Enter let Claude run a Bash command. An approval asks y/n like merging does.
          else if (el.closest("[data-act]")?.getAttribute("data-act") === "approve") {
            const what = (el.textContent || "").trim();
            const tool = (row?.querySelector(".a-why")?.textContent || "").trim().slice(0, 80);
            // The question may run out while y/n stands: then the yes goes nowhere, and the status line says so
            // (round 4: the answer was lost without a word).
            const key = row?.dataset.row || "";
            api.ask(`${tool} – ${what}? y/n`, () => {
              const now = document.querySelector<HTMLButtonElement>(
                `[data-row="${CSS.escape(key)}"] [data-act="approve"] button`,
              );
              if (now && !now.disabled) now.click();
              else
                say(
                  t(
                    "Zu spät – die Freigabe ist abgelaufen, die App fragt jetzt selbst",
                    "Too late: the approval ran out, the app asks itself now",
                  ),
                );
            });
          } else el.click();
          return true;
        }
        case "mute":
          return row ? askMute(row) : false;
        case "hide":
          // An alarm without a session (CI, limit, balance, Fleet's question) cannot be hidden: it is muted for 1 h.
          if (!s && row?.dataset.zone === "alarm" && row.dataset.mute) {
            const rows = allRows();
            // The selection stays in the alarm zone (round 6: after the last alarm row it went to the watch board).
            const zone = rows.filter((r) => r.dataset.zone === "alarm");
            const next = zone[zone.indexOf(row) + 1] || zone[zone.indexOf(row) - 1] || rows[rows.indexOf(row) + 1];
            // Asks like `s` (round 7: x muted an approval unasked; "Nichts verschwindet ungefragt").
            return askMute(row, next);
          }
          return session(s, b, row);
        case "merge":
          merge(s, row);
          return true;
        case "rerun":
          runRed(s, row, "rerun");
          return true;
        case "fix":
          runRed(s, row, "fix");
          return true;
        case "github":
          return (
            openUrl(s?.ci?.pr?.url || s?.ci?.ci?.url || row?.dataset.url) ||
            note(t("Nichts auf GitHub zu dieser Zeile", "Nothing on GitHub for this row"))
          );
        default:
          return session(s, b, row);
      }
    },
    [
      a,
      api,
      close,
      data,
      f,
      later,
      merge,
      move,
      navigate,
      pathname,
      runRed,
      say,
      session,
      sessionById,
      askMute,
      t,
      toggle,
      zone,
      tile,
      tiles,
      note,
      repoKey,
      vim,
    ],
  );

  /** The drawer's "Hide": the same road as `x` on the session's row. */
  const hideById = useCallback(
    (id: string) => {
      const s = sessionById.get(id);
      if (s) hideSession(s, allRows().find((r) => r.dataset.session === id) || null);
    },
    [hideSession, sessionById],
  );

  return { dispatch, later, openPr, hideSession: hideById };
}
