import {
  createContext,
  createElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type ActionId, bindingsOf, keyLabel, type Mode, type Zone } from "./keymap";
import { afterRender, focusRow } from "./rows";

/**
 * The tiles of the one screen (spec, "Ein Schirm im CLI-Look", rules 2, 6, 17): which one is active, which one is
 * zoomed, and how the focus gets into one. `1`–`5` jump to a tile, Tab and Shift+Tab walk round them (Vim:
 * Ctrl+H/J/K/L too). The active tile follows the focus, so a click into a tile makes it the active one as well.
 */

export type TileId = "alarm" | "repos" | "board" | "stream" | "drawer";
/** The order of the keys 1–5, as in lazygit: alarm, repos, watch board, stream, drawer. */
export const TILE_ORDER: TileId[] = ["alarm", "repos", "board", "stream", "drawer"];

const visible = (el: Element) => el.getClientRects().length > 0;
const tileEl = (id: TileId) =>
  [...document.querySelectorAll<HTMLElement>(`[data-tile="${id}"]`)].find((el) => visible(el)) || null;

export type KeysId =
  | TileId
  | "approval"
  | "approvalOther"
  | "cmdline"
  | "diff"
  | "diffWhole"
  | "term"
  | "termPanel"
  | "view"
  | "panel"
  | "repoPanel";

/** One of the keys the status line shows for a tile: an action (two for a pair like ↑↓), its short word. */
interface TileKey {
  /** Keys that are no binding of their own (a widget's arrows), per mode. */
  fixed?: { standard: string; vim: string };
  action?: ActionId;
  /** The second of a pair, shown right after the first (`↑↓`). */
  also?: ActionId;
  /** Which variant of the action (`tile` board). */
  arg?: string;
  /** Which zone's binding, where an action has several (`run` in the command line). */
  zone?: Zone;
  /** Between a pair, written as Vim writes keys (`n/N`, `]/[`) instead of side by side. */
  sep?: string;
  /** Keys a more specific zone of the tile takes (Enter in the alarm zone is the row's action, not the drawer). */
  skip?: string[];
  de: string;
  en: string;
}

const PICK: TileKey = { action: "up", also: "down", de: "wählen", en: "select" };
const ALL: TileKey = { action: "help", de: "alle", en: "all" };

/**
 * The five keys of each tile for the right of the status line (spec rule 5, lazygit's bottom line), and the three of
 * the command line while it has the focus. The keys themselves come from the keymap in the active mode, so Vim shows
 * its own; an action without a key in that mode is left out.
 */
export const TILE_KEYS: Record<KeysId, TileKey[]> = {
  // Release 6: what an alarm is about (drawer) and the jump into its session matter more than reply and mute.
  alarm: [
    PICK,
    { action: "alarmAct", de: "Aktion", en: "action" },
    { action: "drawer", skip: ["Enter"], de: "Details", en: "details" },
    { action: "terminal", de: "Terminal", en: "terminal" },
    ALL,
  ],
  // An approval row (live 16.10.2026): Fleet's own answers by key; one the app holds says where Enter goes.
  approval: [
    PICK,
    { action: "allow", de: "erlauben", en: "allow" },
    { action: "allowSession", de: "für Session", en: "for session" },
    { action: "deny", de: "ablehnen", en: "deny" },
    ALL,
  ],
  approvalOther: [
    PICK,
    { action: "alarmAct", de: "Aktion", en: "action" },
    { action: "drawer", skip: ["Enter"], de: "Details", en: "details" },
    ALL,
  ],
  repos: [
    PICK,
    { action: "repoFilter", de: "filtern", en: "filter" },
    { action: "repoDrawer", de: "Details", en: "details" },
    { action: "repoNew", de: "neu", en: "new" },
    ALL,
  ],
  board: [
    PICK,
    { action: "drawer", de: "Details", en: "details" },
    { action: "terminal", de: "Terminal", en: "terminal" },
    { action: "diff", de: "Diff", en: "diff" },
    ALL,
  ],
  stream: [
    PICK,
    { action: "streamJump", de: "zur Zeile", en: "to the row" },
    { action: "goRepo", de: "zum Repo", en: "to the repo" },
    { action: "terminal", de: "Terminal", en: "terminal" },
    ALL,
  ],
  drawer: [
    { action: "close", de: "schließen", en: "close" },
    { action: "terminal", de: "Terminal", en: "terminal" },
    { action: "note", de: "Notiz", en: "note" },
    { action: "copy", de: "kopieren", en: "copy" },
    ALL,
  ],
  // Round 4: the other views (Repos, usage, activity) list lines that open; no session keys there.
  view: [PICK, { action: "drawer", de: "öffnen", en: "open" }, ALL],
  // A drawer that is no session's (repo, conflict, handoff, CI, Fleet's question): its keys are its own buttons.
  panel: [{ action: "close", de: "schließen", en: "close" }, ALL],
  // The repo drawer's tabs go by arrows (Vim: h l) as in the WAI pattern (round 6: nothing said so).
  repoPanel: [
    { fixed: { standard: "←→", vim: "hl" }, de: "Reiter", en: "tabs" },
    { action: "close", de: "schließen", en: "close" },
    ALL,
  ],
  // The diff view (release 6): it is no tile, but it takes the keys while open, so the status line names its own.
  diff: [
    { action: "diffNext", also: "diffPrev", sep: "/", de: "Änderung", en: "change" },
    { action: "diffFileNext", also: "diffFilePrev", sep: "/", de: "Datei", en: "file" },
    { action: "diffContent", de: "ganze Datei", en: "whole file" },
    { action: "diffFiles", de: "Liste", en: "list" },
    { action: "close", de: "zurück", en: "back" },
  ],
  // The whole file (round 6): `t` leads back to the changes.
  diffWhole: [
    { action: "diffNext", also: "diffPrev", sep: "/", de: "Änderung", en: "change" },
    { action: "diffFileNext", also: "diffFilePrev", sep: "/", de: "Datei", en: "file" },
    { action: "diffContent", de: "Änderungen", en: "changes" },
    { action: "diffFiles", de: "Liste", en: "list" },
    { action: "close", de: "zurück", en: "back" },
  ],
  // The drawer shows a terminal but the focus is not in it (round 7: the status line named the session drawer's
  // keys, "i terminal · c n note", for a terminal that is already open).
  termPanel: [
    { action: "close", de: "schließen", en: "close" },
    { action: "termFocus", de: "ins Terminal", en: "into the terminal" },
    ALL,
  ],
  // Inside Claude's terminal (release 6): Esc is Fleet's, so the line says where Claude's Esc went.
  term: [
    { action: "termExit", de: "zurück", en: "back" },
    { action: "termEsc", de: "Esc an Claude", en: "Esc to Claude" },
    { action: "termInterrupt", de: "abbrechen", en: "interrupt" },
    { action: "termBack", de: "zur Liste", en: "to the list" },
  ],
  cmdline: [
    { action: "prev", also: "next", de: "wählen", en: "select" },
    { action: "run", zone: "palette", de: "ausführen", en: "run" },
    { action: "close", de: "zurück", en: "back" },
  ],
};

/**
 * The keys a tile shows in the status line, readable: `↑↓ wählen · Enter Detail · r antworten · n neu · ? alle`. In
 * Vim a letter goes before an arrow (`jk`, the way Vim users name them).
 */
/** Which keys the status line names for the active tile, the view and the drawer's kind (round 4). */
export function keysFor(
  active: TileId,
  path: string,
  drawerKind: string | null,
): TileId | "view" | "panel" | "repoPanel" | "termPanel" {
  if (active === "board" && path !== "/") return "view";
  if (active === "drawer" && drawerKind === "repo") return "repoPanel";
  if (active === "drawer" && drawerKind === "term") return "termPanel";
  if (active === "drawer" && drawerKind && drawerKind !== "session") return "panel";
  return active;
}

export function tileKeys(id: KeysId, mode: Mode, mac = false): { keys: string; de: string; en: string }[] {
  const vim = mode === "vim";
  const key = (action: ActionId, arg?: string, zone?: Zone, skip: string[] = [], short = vim): string | null => {
    const b = bindingsOf(action, mode).find((x) => (arg === undefined || x.arg === arg) && (!zone || x.zone === zone));
    const ks = (b?.keys[mode] || []).filter((k) => (mac || !k.startsWith("Meta+")) && !skip.includes(k));
    const k = (vim && ks.find((x) => /^[a-z]$/.test(x))) || ks[0];
    return k ? keyLabel(k, mac, short) : null;
  };
  return TILE_KEYS[id].flatMap((x) => {
    if (x.fixed) return [{ keys: vim ? x.fixed.vim : x.fixed.standard, de: x.de, en: x.en }];
    if (!x.action) return [];
    const a = key(x.action, x.arg, x.zone, x.skip, vim || !!x.sep);
    if (!a) return [];
    const b = x.also ? key(x.also, x.arg, x.zone, [], vim || !!x.sep) : "";
    if (b === null) return [];
    if (x.sep) return [{ keys: `${a}${x.sep}${b}`, de: x.de, en: x.en }];
    // Vim names the pair down first (`jk`); arrows stay up first (`↑↓`).
    const keys = vim && /^[a-z]$/.test(a) && /^[a-z]$/.test(b) ? `${b}${a}` : `${a}${b}`;
    return [{ keys, de: x.de, en: x.en }];
  });
}

/** The tile an element is in: the innermost one (a tile holds no other since stage 12.6; innermost stays safe). */
export function tileOf(el: Element | null): TileId | null {
  const t = el?.closest?.("[data-tile]")?.getAttribute("data-tile");
  return t && (TILE_ORDER as string[]).includes(t) ? (t as TileId) : null;
}

/** What one of a tile's lines is: a numbered row, a repo's name, an event of the stream. */
const ITEMS = "[data-row], [data-repo] [data-opener], button.st-go, [data-line]";

/**
 * Where Tab walks from tile to tile instead of from button to button: on a tile's lines and its body. On any other
 * button or link, Tab stays the browser's, so every control is still reachable the usual way.
 */
export const isTileStop = (el: Element | null): boolean =>
  !!el && !!tileOf(el) && (el.matches(ITEMS) || el.matches(".tile-b, [data-tile] h2[tabindex]"));

type Span = { top: number; bottom: number };

/**
 * Where a scrolling tile stands (rule 3: the position in its frame line), as `first–last/total` of its rows: those
 * at least half in view. With no row in view, how many lie above. Null when nothing scrolls: then all is in sight.
 */
export function scrollPos(rows: Span[], view: Span, scrolls: boolean): string | null {
  if (!scrolls || !rows.length) return null;
  const seen = rows.flatMap((r, i) =>
    Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top) >= (r.bottom - r.top) / 2 ? [i + 1] : [],
  );
  const n = rows.length;
  return seen.length
    ? `${seen[0]}–${seen[seen.length - 1]}/${n}`
    : `${rows.filter((r) => r.bottom <= view.top).length}/${n}`;
}

/**
 * How many of the rows lie below the view, less than half in sight: the alarm zone says how many waiting rows a
 * scroll would bring up (B14), so a request never waits out of sight unannounced.
 */
export function belowView(rows: Span[], view: Span): number {
  return rows.filter((r) => r.top >= view.top && Math.min(r.bottom, view.bottom) - r.top < (r.bottom - r.top) / 2)
    .length;
}

/** Measures a tile body on scroll, resize and new lines, once per frame. */
function useMeasure<T>(ref: RefObject<HTMLElement | null>, initial: T, measure: (el: HTMLElement) => T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const run = () => {
      frame = 0;
      setValue(measure(el));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    later();
    el.addEventListener("scroll", later, { passive: true });
    const resize = new ResizeObserver(later);
    resize.observe(el);
    const rows = new MutationObserver(later);
    rows.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", later);
      resize.disconnect();
      rows.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, measure]);
  return value;
}

const rectsOf = (el: HTMLElement, items: string) =>
  [...el.querySelectorAll<HTMLElement>(items)].filter(visible).map((r) => r.getBoundingClientRect());

/** The position of a tile body's lines (numbered rows unless `items` says otherwise). */
export function useScrollPos(ref: RefObject<HTMLElement | null>, items = "[data-row]"): string | null {
  const measure = useCallback(
    (el: HTMLElement) => scrollPos(rectsOf(el, items), el.getBoundingClientRect(), el.scrollHeight > el.clientHeight),
    [items],
  );
  return useMeasure(ref, null, measure);
}

/** How many of a tile body's `items` lie below its view; 0 without `items`. */
export function useBelow(ref: RefObject<HTMLElement | null>, items: string | undefined): number {
  const measure = useCallback(
    (el: HTMLElement) => (items ? belowView(rectsOf(el, items), el.getBoundingClientRect()) : 0),
    [items],
  );
  return useMeasure(ref, 0, measure);
}

/**
 * The lines of the side tile an element is in (repo bar, event stream), in order; null in any other tile. Those
 * lines are no numbered rows: the numbers belong to alarm zone and watch board, so `:12` keeps meaning one row, and
 * the arrows walk the side tile's own lines.
 */
export function sideLines(el: Element | null): HTMLElement[] | null {
  const id = tileOf(el);
  const tile = el?.closest<HTMLElement>("[data-tile]");
  if (!tile) return null;
  if (id === "repos" || id === "stream")
    return [...tile.querySelectorAll<HTMLElement>(ITEMS)].filter((x) => visible(x));
  // Any other view's tile (release 6): its lines, where it has some; "Now" keeps its numbered rows.
  if (tile.querySelector("[data-row]")) return null;
  const lines = [...tile.querySelectorAll<HTMLElement>("[data-line]")].filter((x) => visible(x));
  return lines.length ? lines : null;
}

/** Under 100 columns the middle shows one tile at a time (rule 17); the same width as the media query in screen.css. */
const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 779px)").matches;

/**
 * On a wide window the open drawer stands where the event stream stood (rule 10): the stream is not on screen then,
 * and no key reaches it. Under 100 columns both are tiles of the middle, one in front.
 */
export const covered = (id: TileId): boolean =>
  id === "stream" && !!document.querySelector('[data-tile="drawer"]') && !narrow();

/** A tile of this view, in sight or behind the one in front (narrow window, zoom). */
const onPage = (id: TileId) => !!document.querySelector(`[data-tile="${id}"]`) && !covered(id);

/** The tiles of this view, in the order of their keys; Tab walks them even where only one is in sight. */
export const tilesShown = (): TileId[] =>
  typeof document === "undefined" ? [] : TILE_ORDER.filter((id) => onPage(id));

/**
 * Puts the focus into a tile: where it was last in that tile, else on its first line, else on its body. False when
 * the tile is not on screen (the drawer is shut, or this view has no such tile).
 */
export function focusTile(id: TileId, last?: HTMLElement | null): boolean {
  const el = tileEl(id);
  if (!el) return false;
  const own = (x: Element) => x.closest("[data-tile]") === el && visible(x);
  if (last?.isConnected && own(last)) {
    if (last.hasAttribute("data-row")) return focusRow(last);
    last.focus({ preventScroll: true });
    return true;
  }
  const first = [...el.querySelectorAll<HTMLElement>(ITEMS)].find(own);
  if (first?.hasAttribute("data-row")) return focusRow(first);
  const target =
    first ||
    [...el.querySelectorAll<HTMLElement>(".tile-b, h2[tabindex]")].find(own) ||
    [...el.querySelectorAll<HTMLElement>("button, a[href], [tabindex]")].find(own) ||
    null;
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/**
 * The tile of the middle that stands in front: the one `+` shows alone. The drawer is a tile of the middle (stage
 * 12.5); the alarm zone stands above the middle at every width (stage 12.6), so going there leaves the front as it was.
 */
export function frontOf(active: TileId | null, before: TileId): TileId {
  if (active === "repos" || active === "board" || active === "stream" || active === "drawer") return active;
  return before;
}

interface TilesCtx {
  active: TileId | null;
  /** The middle tile in front (see `frontOf`). */
  front: TileId;
  zoom: boolean;
  setZoom: (v: boolean) => void;
  /** Makes a tile the active one without moving the focus: under 100 columns that brings it in sight. */
  show: (id: TileId) => void;
  /** Jumps into a tile; false when it is not on screen. */
  go: (id: TileId) => boolean;
  /** The next tile on screen after the active one (backwards for -1). */
  next: (dir: 1 | -1) => TileId | null;
}

const Ctx = createContext<TilesCtx | null>(null);

export function TilesProvider({
  drawer = false,
  full = false,
  children,
}: {
  drawer?: boolean;
  /** The drawer shows a terminal: it fills the screen while it does (release 6, plan R8), Esc shuts it again. */
  full?: boolean;
  children: ReactNode;
}) {
  const [active, setActive] = useState<TileId | null>("board");
  const [zoom, setZoom] = useState(false);
  const [last] = useState(() => new Map<TileId, HTMLElement>());
  const [front, setFront] = useState<TileId>("board");
  // The drawer comes to the front as it opens, in the same render: under 100 columns it must be in sight before it
  // takes the focus. Shut, it hands the front back to the watch board, so the middle never stands without one.
  const [wasOpen, setWasOpen] = useState(drawer);
  if (drawer !== wasOpen) {
    setWasOpen(drawer);
    if (drawer) {
      setActive("drawer");
      setFront("drawer");
    } else {
      if (active === "drawer") setActive("board");
      if (front === "drawer") setFront("board");
    }
  }
  // Zoomed for the terminal, unzoomed with it; a zoom the user chose with `+` stays theirs.
  const [wasFull, setWasFull] = useState(false);
  const [autoZoom, setAutoZoom] = useState(false);
  if (full !== wasFull) {
    setWasFull(full);
    if (full && !zoom) {
      setZoom(true);
      setAutoZoom(true);
      setActive("drawer");
      setFront("drawer");
    } else if (!full && autoZoom) {
      setZoom(false);
      setAutoZoom(false);
    }
  }

  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const id = tileOf(el);
      if (!id || !el) return;
      setActive(id);
      if (isTileStop(el)) last.set(id, el);
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [last]);

  const go = useCallback(
    (id: TileId) => {
      if (focusTile(id, last.get(id))) {
        setActive(id);
        return true;
      }
      // Under 100 columns (and zoomed) only the tile in front shows (rule 17): bring it forward, then go in.
      if (!onPage(id)) return false;
      setActive(id);
      afterRender(() => focusTile(id, last.get(id)));
      return true;
    },
    [last],
  );
  const next = useCallback(
    (dir: 1 | -1) => {
      const shown = tilesShown();
      if (!shown.length) return null;
      const i = active ? shown.indexOf(active) : -1;
      return shown[(i + dir + shown.length) % shown.length] || null;
    },
    [active],
  );
  useEffect(() => setFront((before) => frontOf(active, before)), [active]);
  const value = useMemo(
    () => ({ active, front, zoom, setZoom, show: setActive, go, next }),
    [active, front, zoom, go, next],
  );
  return createElement(Ctx.Provider, { value }, children);
}

export function useTiles(): TilesCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTiles outside TilesProvider");
  return v;
}

/** The attributes a tile carries: its id for the keys and tests, whether it is the active one and the one in front. */
export function useTileProps(id: TileId): { "data-tile": TileId; "data-active"?: ""; "data-front"?: "" } {
  const { active, front } = useTiles();
  return {
    "data-tile": id,
    ...(active === id ? { "data-active": "" as const } : {}),
    ...(front === id ? { "data-front": "" as const } : {}),
  };
}
