import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFleet } from "./fleet";
import { clock } from "./format";
import { useI18n } from "./i18n";
import { type CommandPrompt, type KeyApi, type Undo, useKeyDispatch } from "./key-actions";
import {
  type Binding,
  type Effect,
  hit,
  IDLE,
  KEYMAP,
  keyOf,
  type Mode,
  type Pending,
  pendingText,
  press,
  REPEATS,
  type StatusFilter,
  setActiveMode,
  type Zone,
} from "./keymap";
import { type LogFilter, useLogKeys } from "./log-keys";
import { type Cmd, isMode } from "./palette";
import { usePaletteRun } from "./palette-run";
import {
  afterRender,
  allRows,
  focusedSession,
  focusRow,
  isEditable,
  isPressable,
  refocus,
  repoRowOf,
  rowByKey,
  rowByNr,
  rowOf,
  zonesOf,
} from "./rows";
import { load, save } from "./store";
import { isTileStop, tileOf } from "./tiles";
import { liveMutes, MUTE_MS, muteBack } from "./view";

/**
 * The keyboard controller: one key handler for the whole page, reading the keymap. It keeps what the keys need
 * between presses (a started sequence, a Vim count, a question waiting for y/n) and the state keys change
 * (status filter, muted alarms, the inline reply, help and the command line). Focus is the
 * selection.
 *
 * Elements with their own keys keep them: inputs, the terminal, the drawer and the dialogs; from an input only
 * the palette key (⌘K) reaches the page, and it puts the focus in the command line. From the drawer outside its
 * inputs and the terminal, the keys between tiles reach the page as well (`FROM_DRAWER`).
 *
 * Two key maps (spec, "Tastatursteuerung komplett"): standard and Vim, switched in the settings or with
 * `mode <standard|vim>`, kept per browser; Vim is the default since release 6 (a browser without a saved mode). In Vim the status line names the state the keys are in: NORMAL on the
 * list, INSERT in an input or the terminal, COMMAND while the `:` line has the focus, VISUAL while rows
 * are marked with `V`.
 */

export type HelpView = "zone" | "all" | null;
/** The session whose changes the diff view shows. */
export interface DiffTarget {
  id: string;
  title: string;
  /** The whole file is shown instead of the changes: the status line names `t` as the way back (round 6). */
  whole?: boolean;
}
export type ModeLabel = "STANDARD" | "NORMAL" | "INSERT" | "COMMAND" | "VISUAL";

/** What `.` runs again: a key's binding on the selected row, or a palette command. */
type Last = { binding: Binding } | { cmd: Cmd };

interface KeysCtx {
  mode: Mode;
  setMode: (m: Mode) => void;
  /** What the status line shows on the left. */
  label: ModeLabel;
  /** Rows marked with `V` (their `data-row` keys), in screen order. */
  marked: string[];
  /** Keys typed so far (`g`, `12`), for the status line. */
  pending: string;
  /** The question of a destructive action, answered with y or n. */
  confirm: string | null;
  answer: (yes: boolean) => void;
  /** Asks in the status line, as every destructive key does: y runs `run`, anything else drops the question. */
  ask: (text: string, run: () => void) => void;
  filter: StatusFilter | null;
  setFilter: (f: StatusFilter | null) => void;
  muted: Record<string, number>;
  unmuteAll: () => void;
  replying: string | null;
  setReplying: (id: string | null) => void;
  help: HelpView;
  setHelp: (v: HelpView, zones?: Zone[]) => void;
  /** Zones of the selection when help opened: `?` once shows these. */
  helpZones: Zone[];
  /** The command line has the focus: `:` for commands, `/` for the search; null when it has not. */
  command: CommandPrompt | null;
  setCommand: (c: CommandPrompt | null) => void;
  runCmd: (c: Cmd) => void;
  /** The one-line hint under the header was closed once and stays closed. */
  hintClosed: boolean;
  closeHint: () => void;
  /** The log view (Shift+L) is open; while it is, it takes the keys. */
  log: boolean;
  setLog: (v: boolean) => void;
  /** The session the log shows alone, picked by its row number on "Now"; null shows all. */
  logFilter: LogFilter | null;
  /** The diff view of a session (release 6): open, it takes every key; null when shut. */
  diff: DiffTarget | null;
  setDiff: (d: DiffTarget | null) => void;
  /** Clears an alarm row as its key `x` does (the row's button uses it): hide its session, else mute it. */
  clearAlarm: (row: HTMLElement) => void;
  /** Sessions just hidden outside the keys (the drawer's button): `u` brings them back like after `x`. */
  noteHidden: (ids: string[]) => void;
  /** Hides a session as `x` does, with its y/n for a waiting one (the drawer's button uses it). */
  hideSession: (id: string) => void;
}

const Ctx = createContext<KeysCtx | null>(null);

/** Keys that reach the page from inside the drawer (tile 5): moving between tiles, zoom, help, search, log. */
const FROM_DRAWER = [
  "tile",
  "zoneNext",
  "zonePrev",
  "zoneAlarm",
  "zoneStream",
  "zoom",
  "help",
  "search",
  "log",
] as const;

/** Palette commands that change something; `.` runs them again. */
const CMD_REPEATS = new Set<Cmd["kind"]>(["merge", "run", "reply", "handoff", "new"]);

/** Typing goes to an element: an input, or Claude's terminal. Vim calls that INSERT. */
const typing = (el: Element | null) => isEditable(el) || !!el?.closest?.(".xterm");

/** The rows from `from` to `to` in screen order, both included. */
function range(from: string, to: string): string[] {
  const keys = allRows().map((r) => r.dataset.row || "");
  const a = keys.indexOf(from);
  const b = keys.indexOf(to);
  if (a < 0 || b < 0) return a < 0 ? [] : [from];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * The zones `?` lists for the place of the focus. With a row selected they are the row's (`zonesOf`); on a tile
 * without a selected row they are what the status line promises for that tile (round 7: help in the board had no
 * → and d, in the stream no Enter, in the alarm zone no Enter at all), most specific first.
 */
export function helpZonesAt(el: Element | null, zones: Zone[], tileOnly: boolean): Zone[] {
  if (!tileOnly) return zones;
  const tile = tileOf(el);
  const now = !!document.querySelector('[data-tile="board"] [data-row]');
  if (tile === "alarm") return ["alarm", "list", "global"];
  if (tile === "board" && now) return ["session", "pr", "list", "global"];
  if (tile === "stream") return ["stream", ...(focusedSession(el) ? (["session"] as Zone[]) : []), "list", "global"];
  return zones;
}

export function KeysProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const { showToast, drawer, openDrawer, sessionById, data } = useFleet();
  const [pending, setPendingState] = useState<Pending>(IDLE);
  const pendingRef = useRef<Pending>(IDLE);
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  const [filter, setFilter] = useState<StatusFilter | null>(null);
  const [muted, setMuted] = useState<Record<string, number>>(() => {
    const v = load<Record<string, number>>("muted");
    return v && typeof v === "object" ? liveMutes(v, Date.now()) : {};
  });
  const [replying, setReplyingState] = useState<string | null>(null);
  const [help, setHelpState] = useState<HelpView>(null);
  const [helpZones, setHelpZones] = useState<Zone[]>(["list", "global"]);
  const [command, setCommand] = useState<CommandPrompt | null>(null);
  // The note on the stage 12 keymap break (message row, first key help); earlier hints closed do not count.
  const [hintClosed, setHintClosed] = useState(() => !!load<boolean>("keysChanged6"));
  const [mode, setModeState] = useState<Mode>(() => {
    const m = load<string>("keyMode");
    const v = typeof m === "string" && isMode(m) ? m : "vim";
    setActiveMode(v);
    return v;
  });
  const [insert, setInsert] = useState(false);
  const [diff, setDiffState] = useState<DiffTarget | null>(null);
  const diffOpen = useRef(false);
  /** Where the focus was when the diff view opened: it goes back there. */
  const diffBack = useRef<{ row: string | null; el: HTMLElement | null }>({ row: null, el: null });
  const setDiff = useCallback((d: DiffTarget | null) => {
    if (d && !diffOpen.current) {
      const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      diffBack.current = { row: rowOf(el)?.dataset.row || null, el };
    }
    if (!d && diffOpen.current) {
      const b = diffBack.current;
      afterRender(() => {
        if (b.row) refocus(b.row, false);
        else if (b.el?.isConnected) b.el.focus({ preventScroll: true });
      });
    }
    diffOpen.current = !!d;
    setDiffState(d);
  }, []);
  /** The row `V` started on; null when nothing is marked. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [marked, setMarked] = useState<string[]>([]);
  const lastKey = useRef<string | null>(null);
  /** The row element that has the selection: when the overview draws it anew, the new one gets the focus back. */
  const selected = useRef<HTMLElement | null>(null);
  const lastCmd = useRef<Last | null>(null);
  /** Every hide and mute of this page visit, newest last: `u` walks back through them (round 7: it undid one step). */
  const undoStack = useRef<Undo[]>([]);
  const live = useRef({ replying, help, mode, anchor, marked, filter });
  live.current = { replying, help, mode, anchor, marked, filter };

  const setPending = useCallback((p: Pending) => {
    pendingRef.current = p;
    setPendingState(p);
  }, []);
  const setReplying = useCallback((id: string | null) => {
    const back = live.current.replying;
    live.current.replying = id;
    setReplyingState(id);
    // Leaving the reply line puts the selection back on its row.
    if (!id && back) refocus(back);
  }, []);
  const noteHidden = useCallback((ids: string[]) => {
    if (ids.length) undoStack.current.push({ kind: "hide", ids });
  }, []);
  const lastRow = useCallback(() => (lastKey.current ? rowByKey(lastKey.current) : null), []);
  const setMode = useCallback(
    (m: Mode) => {
      setActiveMode(m);
      live.current.mode = m;
      setModeState(m);
      save("keyMode", m);
      setPending(IDLE);
      setAnchor(null);
      setMarked([]);
      showToast(`${t("Tastaturmodus", "Keyboard mode")}: ${m === "vim" ? "Vim" : "Standard"}`);
    },
    [showToast, t, setPending],
  );
  /** `V` on a row starts marking there; null ends it. The marks follow the selection (focusin below). */
  const setVisual = useCallback((key: string | null) => {
    live.current.anchor = key;
    live.current.marked = key ? [key] : [];
    setAnchor(key);
    setMarked(key ? [key] : []);
  }, []);
  const setHelp = useCallback(
    (v: HelpView, zones?: Zone[]) => {
      // The place the focus is in, as the keys see it (round 6: on a repo `?` showed the last session's keys);
      // the last row only when the focus is nowhere.
      const el = document.activeElement;
      const nowhere = !el || el === document.body;
      if (v === "zone") {
        const here =
          zones ||
          helpZonesAt(
            el,
            nowhere ? zonesOf(lastRow()) : zonesOf(rowOf(el) || repoRowOf(el), tileOf(el), !!focusedSession(el)),
            !nowhere && !rowOf(el) && !repoRowOf(el),
          );
        // Marking with V: x hides every marked row, wherever the selection stands (round 7: x was missing in VISUAL).
        const marking = live.current.marked.length > 0 && !here.includes("session") && !here.includes("alarm");
        setHelpZones(marking ? ["session", ...here] : here);
      }
      setHelpState(v);
    },
    [lastRow],
  );
  const { log, isOpen: logOpen, setLog, logFilter, logKey } = useLogKeys({ setCommand, setHelp });
  const mute = useCallback(
    (key: string, label: string) => {
      const until = Date.now() + MUTE_MS;
      undoStack.current.push({ kind: "mute", key, label });
      setMuted((m) => {
        const next = { ...liveMutes(m, Date.now()), [key]: until };
        save("muted", next);
        return next;
      });
      showToast(
        t(
          `${label}: stumm bis ${clock(until, locale)} – u holt ${muteBack(key)} zurück`,
          `${label}: muted until ${clock(until, locale)}; u brings it back`,
        ),
      );
    },
    [showToast, t, locale],
  );
  const unmuteAll = useCallback(() => {
    setMuted({});
    save("muted", {});
    showToast(t("Stummgeschaltete Alarme wieder an", "Muted alarms back on"));
  }, [showToast, t]);
  const ask = useCallback((text: string, run: () => void) => setConfirm({ text, run }), []);
  const answer = useCallback(
    (yes: boolean) => {
      const c = confirm;
      setConfirm(null);
      if (!c) return;
      // A question started by a click on a row's button (×) leaves the focus on that button, where Tab and the tile
      // keys behave as on any button (round 8): the selection goes back to the row, unless the answer moved it on.
      const at = rowOf(document.activeElement);
      if (at?.dataset.row && at !== document.activeElement) refocus(at.dataset.row, false);
      if (yes) c.run();
      else showToast(t("Abgebrochen", "Cancelled"));
    },
    [confirm, showToast, t],
  );

  const api = useMemo<KeyApi>(
    () => ({
      setFilter,
      filter: () => live.current.filter,
      replying: () => live.current.replying,
      setReplying,
      ask,
      mute,
      help: () => !!live.current.help,
      log: logOpen,
      setLog,
      setHelp,
      setCommand,
      lastRow,
      mode: () => live.current.mode,
      setMode,
      marked: () => live.current.marked,
      setVisual,
      hidden: noteHidden,
      setDiff,
      unmute: (key) =>
        setMuted((m) => {
          const { [key]: _gone, ...rest } = m;
          save("muted", rest);
          return rest;
        }),
      takeUndo: () => undoStack.current.pop() || null,
    }),
    [setReplying, ask, mute, setHelp, lastRow, setMode, setVisual, setLog, logOpen, setDiff, noteHidden],
  );
  const keyFns = useKeyDispatch(api);
  const { dispatch, hideSession } = keyFns;
  const runPalette = usePaletteRun(api, keyFns);
  const runCmd = useCallback(
    (c: Cmd) => {
      if (CMD_REPEATS.has(c.kind) || (c.kind === "action" && REPEATS.has(c.action))) lastCmd.current = { cmd: c };
      runPalette(c);
    },
    [runPalette],
  );

  const apply = useCallback(
    (effect: Effect, row: HTMLElement | null): boolean => {
      switch (effect.kind) {
        case "wait":
        case "cancel":
          return true;
        case "none":
          return false;
        case "select":
          if (!focusRow(rowByNr(effect.nr))) showToast(t(`Keine Zeile ${effect.nr}`, `No row ${effect.nr}`));
          return true;
        case "run": {
          if (effect.binding.action === "repeat") {
            const last = lastCmd.current;
            if (!last) showToast(t("Noch kein Befehl zum Wiederholen", "No command to repeat yet"));
            else if ("cmd" in last) runPalette(last.cmd);
            else dispatch(last.binding, rowOf(document.activeElement) || row);
            return true;
          }
          const target = effect.nr !== null ? rowByNr(effect.nr) : row;
          if (effect.nr !== null && !target) {
            showToast(t(`Keine Zeile ${effect.nr}`, `No row ${effect.nr}`));
            return true;
          }
          if (REPEATS.has(effect.binding.action)) lastCmd.current = { binding: effect.binding };
          // `3j`: each step starts from where the last one put the selection.
          let done = dispatch(effect.binding, target);
          for (let i = 1; i < (effect.times || 1); i++)
            done = dispatch(effect.binding, rowOf(document.activeElement)) || done;
          return done;
        }
      }
    },
    [dispatch, runPalette, showToast, t],
  );

  const keys = useRef({ apply, confirm: !!confirm, answer, setPending, logKey, logOpen });
  keys.current = { apply, confirm: !!confirm, answer, setPending, logKey, logOpen };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // The diff view takes every key while it is open (components/diff).
      if (diffOpen.current) return;
      const k = keyOf(e);
      if (!k) return;
      const target = e.target instanceof Element ? e.target : null;
      const L = keys.current;
      // The terminal, the drawer and the dialogs handle their keys themselves; inputs keep theirs. The drawer is a
      // tile like the others, though: the keys between tiles, zoom, help and search work from it too.
      const inDrawer = !!target?.closest(".drawer") && !target.closest(".xterm, dialog") && !isEditable(target);
      const between = inDrawer && FROM_DRAWER.some((a) => hit(e, a));
      // A question asked from a button in the drawer (its Hide) is answered where the focus stands (round 7).
      if (inDrawer && L.confirm && !L.logOpen()) {
        e.preventDefault();
        L.answer(hit(e, "yes"));
        return;
      }
      if (!between && (target?.closest(".xterm, .drawer, dialog") || isEditable(target))) {
        if (!target?.closest(".xterm, dialog") && hit(e, "palette")) {
          e.preventDefault();
          setCommand(":");
        }
        return;
      }
      // The log view takes the keys while it is open (log-keys.ts).
      if (L.logOpen()) {
        L.logKey(e);
        return;
      }
      if (L.confirm) {
        e.preventDefault();
        L.answer(hit(e, "yes"));
        return;
      }
      // Enter and Space press the focused button; on a row itself Enter opens its drawer (keymap).
      if (isPressable(target) && /^(Enter|Space)$/.test(k) && !pendingRef.current.count) return;
      // Tab on a button or link that is no line of a tile stays the browser's: every control remains reachable.
      if (/^(Shift\+)?Tab$/.test(k) && !isTileStop(document.activeElement)) return;
      // The focus fell to the body (a view closed a moment ago, the row was drawn anew): the selection is still the
      // row last selected in the active tile, so the key acts on it (round 8: Enter after Esc from the diff did nothing).
      if (!document.activeElement || document.activeElement === document.body) {
        const last = lastKey.current ? rowByKey(lastKey.current) : null;
        const tile = document.querySelector("[data-tile][data-active]");
        if (last && (!tile || tile.contains(last)) && !/^(Escape|Tab|Shift\+Tab)$/.test(k))
          last.focus({ preventScroll: true });
      }
      const row = rowOf(document.activeElement) || repoRowOf(document.activeElement);
      const mode = live.current.mode;
      // Marked rows act together: `x` on the marks must work whichever row the selection ends on, a group row
      // (Duplicates) included (round 7: V+x there did nothing and said nothing).
      const marking = (z: Zone[]): Zone[] =>
        live.current.marked.length && !z.includes("session") ? ["session", ...z] : z;
      const { state, effect } = press(
        pendingRef.current,
        k,
        (nr) =>
          marking(
            nr !== null
              ? zonesOf(rowByNr(nr))
              : zonesOf(row, tileOf(document.activeElement), !!focusedSession(document.activeElement)),
          ),
        mode,
      );
      L.setPending(state);
      if (L.apply(effect, row)) e.preventDefault();
    };
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      setInsert(typing(el));
      // The palette commands without argument act on the row selected last.
      const r = rowOf(el);
      selected.current = r?.dataset.row ? r : null;
      if (r?.dataset.row) {
        lastKey.current = r.dataset.row;
        // Marking: the rows from where `V` started to the selection.
        const from = live.current.anchor;
        if (from) {
          const keys = range(from, r.dataset.row);
          live.current.marked = keys;
          setMarked(keys);
        }
      }
    };
    const onBlur = () => setInsert(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, []);

  // Round 8: a row drawn anew while it had the focus (the overview changed under it) drops the focus to the body, and the
  // cursor is gone though the selection is still there. Once the change is drawn, the new row gets the focus back; a
  // focus that left on purpose (the element is still in the page) stays where it went.
  useEffect(() => {
    if (!data) return;
    afterRender(() => {
      const gone = selected.current;
      if (!gone || gone.isConnected) return;
      selected.current = null;
      const at = document.activeElement;
      if (at && at !== document.body) return;
      rowByKey(gone.dataset.row || "")?.focus({ preventScroll: true });
    });
  }, [data]);

  // Round 7: a click on a row selects it, and an open drawer shows the clicked session (it kept the previous one while
  // the selection had moved). Closed, the drawer opens from the title as before; a terminal in the drawer stays.
  const shown = useRef({ drawer, openDrawer, sessionById });
  shown.current = { drawer, openDrawer, sessionById };
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const { drawer: d, openDrawer: open, sessionById: byId } = shown.current;
      const target = e.target instanceof Element ? e.target : null;
      if (
        !d ||
        d.kind === undefined ||
        d.kind === "term" ||
        !target ||
        target.closest(".drawer, dialog, a, button, input, textarea, select")
      )
        return;
      const row = target.closest<HTMLElement>(".screen [data-row][data-session]");
      const s = row?.dataset.session ? byId.get(row.dataset.session) : undefined;
      if (!s || (d.kind === "session" && d.id === s.id)) return;
      open({ kind: "session", id: s.id, title: String(s.title || s.project || ""), keep: true });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const clearAlarm = useCallback(
    (row: HTMLElement) => {
      const b = KEYMAP.find((x) => x.action === "hide" && x.zone === "alarm");
      if (b) dispatch(b, row);
    },
    [dispatch],
  );

  const closeHint = useCallback(() => {
    save("keysChanged6", true);
    setHintClosed(true);
  }, []);

  const label: ModeLabel =
    mode === "standard"
      ? "STANDARD"
      : command === ":"
        ? "COMMAND"
        : insert || replying
          ? "INSERT"
          : anchor
            ? "VISUAL"
            : "NORMAL";

  const value = useMemo<KeysCtx>(
    () => ({
      mode,
      setMode,
      label,
      marked,
      pending: pendingText(pending),
      confirm: confirm?.text || null,
      answer,
      ask,
      filter,
      setFilter,
      muted,
      unmuteAll,
      replying,
      setReplying,
      help,
      setHelp,
      helpZones,
      command,
      setCommand,
      runCmd,
      hintClosed,
      closeHint,
      log,
      setLog,
      logFilter,
      clearAlarm,
      noteHidden,
      hideSession,
      diff,
      setDiff,
    }),
    [
      mode,
      setMode,
      label,
      marked,
      pending,
      confirm,
      answer,
      ask,
      filter,
      muted,
      unmuteAll,
      replying,
      setReplying,
      help,
      setHelp,
      helpZones,
      command,
      runCmd,
      hintClosed,
      closeHint,
      log,
      setLog,
      logFilter,
      clearAlarm,
      noteHidden,
      hideSession,
      diff,
      setDiff,
    ],
  );
  return (
    <Ctx.Provider value={value}>
      <Marks keys={marked} />
      {children}
    </Ctx.Provider>
  );
}

/**
 * The rows marked with `V`, drawn like the selection. A style rule by row key instead of a prop on every row: the
 * rows keep their markup, and a row drawn anew (re-sorted) stays marked.
 */
function Marks({ keys }: { keys: string[] }) {
  if (keys.length < 1 || typeof CSS === "undefined") return null;
  const sel = (k: string) => `.screen [data-row="${CSS.escape(k)}"]`;
  const rows = keys.map(sel).join(", ");
  const cells = keys.map((k) => `${sel(k)} > td`).join(", ");
  const edge = keys.map((k) => `${sel(k)} > td:first-child`).join(", ");
  return (
    <style>{`${rows}, ${cells} { background: var(--sel-bg); } ${rows}:not(tr), ${edge} { border-left-color: var(--sel); }`}</style>
  );
}

export function useKeys(): KeysCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useKeys outside KeysProvider");
  return v;
}
