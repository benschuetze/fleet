import type { Zone } from "./keymap";

/**
 * The numbered rows of "Now" as the keyboard sees them. Each row carries `data-row` (a key that survives
 * re-rendering), `data-zone` (alarm or board), `data-kind` (session, ci, decision, limit), `data-nr` (the number
 * on screen) and is focusable; focus is the selection (spec: one row has the focus, blue edge and light
 * background). Its one action carries `data-act`, the title that expands it `data-opener`.
 */

export type RowKind = "session" | "ci" | "decision" | "limit" | "balance" | "dup" | "handoff";

export interface RowData {
  "data-row": string;
  "data-zone": "alarm" | "board";
  "data-kind": RowKind;
  "data-nr": number;
  "data-session"?: string;
  "data-owner"?: string;
  "data-mute"?: string;
  "data-open"?: "true";
  "data-approval"?: Approval;
  tabIndex: -1;
}

export function rowProps(
  zone: "alarm" | "board",
  kind: RowKind,
  key: string,
  nr: number,
  more: { session?: string; owner?: string; mute?: string; open?: boolean; approval?: Approval | null } = {},
): RowData {
  return {
    "data-row": key,
    "data-zone": zone,
    "data-kind": kind,
    "data-nr": nr,
    ...(more.session ? { "data-session": more.session } : {}),
    // A row about a session that is not the session's own row (Fleet's question): the log view filters by it.
    ...(more.owner ? { "data-owner": more.owner } : {}),
    ...(more.mute ? { "data-mute": more.mute } : {}),
    ...(more.open ? { "data-open": "true" as const } : {}),
    ...(more.approval ? { "data-approval": more.approval } : {}),
    tabIndex: -1,
  };
}

/**
 * A line on any other view (release 6, plan R11: keys everywhere): focusable, walked with j/k or the arrows, Enter
 * presses its opener (`data-opener`, else its first link or button); a line that stands for a session carries it, so
 * the session keys (i, o, d, x …) act on it as on a row of "Now". No number: those stay with "Now".
 */
export function lineProps(session?: string | null): { "data-line": ""; "data-session"?: string; tabIndex: -1 } {
  return { "data-line": "", ...(session ? { "data-session": session } : {}), tabIndex: -1 };
}

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

export function allRows(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  // The alarm zone is a tile of the screen above the middle (stage 12.6), so its rows come first, as on screen.
  return [...document.querySelectorAll<HTMLElement>(".screen [data-row]")].filter(visible);
}

/** Each session's number on Now (its own row, or the row of Fleet's question about it): what the log view filters by. */
export function rowNumbers(): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of allRows()) {
    const id = r.dataset.session || r.dataset.owner;
    const nr = Number(r.dataset.nr);
    if (id && nr && !m.has(id)) m.set(id, nr);
  }
  return m;
}

export const rowOf = (el: Element | null): HTMLElement | null =>
  (el?.closest?.("[data-row]") as HTMLElement | null) || null;

export const rowByNr = (nr: number) => allRows().find((r) => Number(r.dataset.nr) === nr) || null;
export const rowByKey = (key: string) => allRows().find((r) => r.dataset.row === key) || null;

/**
 * A repo in the repo bar (`data-repo`, `data-roots`). Not a numbered row: the numbers belong to alarm zone and watch
 * board, so `3 Enter` keeps meaning the same row; the repo zone's keys act while the focus is in a repo's line.
 */
export const repoRowOf = (el: Element | null): HTMLElement | null =>
  (el?.closest?.("[data-repo]") as HTMLElement | null) || null;

export function repoRoots(row: HTMLElement): string[] {
  try {
    const v = JSON.parse(row.dataset.roots || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Zones in play for a row, most specific first: Enter in the alarm zone is the row's action, not "expand". Without a
 * row, the tile the focus is in still counts: a repo key there says to pick a line first instead of doing nothing (B15).
 */
export function zonesOf(row: HTMLElement | null, tile: string | null = null, session = false): Zone[] {
  if (!row)
    return tile === "repos" ? ["repo", "list", "global"] : session ? ["session", "list", "global"] : ["list", "global"];
  // The arrows walk the repo bar's lines (list zone; key-actions moves within the tile).
  if (row.dataset.repo) return ["repo", "list", "global"];
  const kind = row.dataset.kind as RowKind;
  const alarm = row.dataset.zone === "alarm";
  const z: Zone[] = alarm ? (row.dataset.approval ? ["approval", "alarm"] : ["alarm"]) : [];
  if (kind === "session") z.push("session", "pr");
  if (kind === "ci") z.push("pr");
  return [...z, "list", "global"];
}

/**
 * The session an element outside the numbered rows stands for (a line of the event stream, of the history): the
 * session keys (`i`, `o`, `x` …) act on it too (release 6, plan R8: into the terminal from anywhere).
 */
export const focusedSession = (el: Element | null): string | null =>
  (el?.closest?.("[data-session]") as HTMLElement | null)?.dataset.session || null;

/** Selects a row: focus, in view, without the page jumping more than needed. */
export function focusRow(row: HTMLElement | null): boolean {
  if (!row) return false;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** Runs after React has drawn the change and its effects (a detail focuses its own title on mount). */
export const afterRender = (fn: () => void) => setTimeout(() => requestAnimationFrame(fn), 0);

/**
 * Puts the selection back on a row once the change is drawn, unless another row was selected in the meantime:
 * a late refocus must never pull the selection away from where the user already went. Without `scroll` the tile
 * stays where the user scrolled it (back from the log view), even if the row is out of sight.
 */
export function refocus(key: string, scroll = true): void {
  afterRender(() => {
    const now = rowOf(document.activeElement);
    if (now && now.dataset.row !== key) return;
    if (scroll) focusRow(rowByKey(key));
    else rowByKey(key)?.focus({ preventScroll: true });
  });
}

/**
 * Selects a row that is not drawn yet (a hidden session brought back by `u`: the overview draws it with the next push).
 * Waits a few seconds; gives up as soon as the user moves the focus somewhere else in the meantime.
 */
export function selectWhenBack(key: string, tries = 40): void {
  const from = document.activeElement;
  const fromKey = rowOf(from)?.dataset.row;
  const step = (left: number) => {
    // A focus that fell to the body (the row it stood on was drawn anew) is no move of yours, nor is the same row
    // drawn anew with the focus put back on it (round 7: after `u` the restored row never got the selection).
    const at = document.activeElement;
    if (at !== from && at !== document.body && !(fromKey && rowOf(at)?.dataset.row === fromKey)) return;
    const row = rowByKey(key);
    if (row) focusRow(row);
    else if (left > 0) setTimeout(() => step(left - 1), 100);
  };
  afterRender(() => step(tries));
}

/** What a row is called in a question or a message: its label, at most 80 characters. */
export function rowLabel(row: HTMLElement): string {
  return (
    row.getAttribute("aria-label") ||
    document.getElementById(row.getAttribute("aria-labelledby") || "")?.textContent ||
    ""
  ).slice(0, 80);
}

export function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

/** Buttons and links keep Enter and Space: the key presses them, as everywhere on the web. */
export function isPressable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.hasAttribute("data-row")) return false;
  return /^(BUTTON|A|SUMMARY)$/.test(el.tagName) || el.getAttribute("role") === "button";
}

/**
 * Who holds an approval in the alarm zone: Fleet (its countdown row, y/a/n answer it), the app or terminal the
 * session runs in (Fleet cannot answer it there), or Fleet's own terminal (the prompt stands in it).
 */
export type Approval = "fleet" | "app" | "elsewhere" | "terminal";
