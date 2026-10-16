/**
 * Every key of Fleet in one place (spec, "Tastatursteuerung komplett"): action → keys per mode. The help overlay and
 * the command palette are built from this list, and no key is wired anywhere else; components ask `hit(e, action)`.
 *
 * Frozen from stage 4 on, like Bloomberg's keyboard: keys keep their meaning, changes are only additive. Stage 12
 * broke that once, on purpose and completely (spec, "Ein Schirm im CLI-Look", rule 15: tiles on 1–5, filters on
 * Alt+1–5, Enter opens the drawer); since then it is frozen again. The Vim
 * mode (stage 7) is a second list per binding: the keys of the spec's Vim table, plus the keys it keeps from
 * everywhere (`⌘K`, `Esc`, `?`, `/`, `:`, `Alt+…`) and the named keys no Vim key takes (arrows, `Enter`,
 * `Home`, `End`, `PageUp`, `PageDown`, `Tab`). A standard letter the Vim table does not name has no Vim key: Vim
 * users would type it by habit with another meaning; the palette and the `:` line still reach every action.
 * Bindings for zones that arrive later are listed already with the stage that brings them, so their keys stay
 * reserved and the help says honestly what does not work yet.
 *
 * Key names: `KeyboardEvent.key` with letters in lower case, modifiers in the order Ctrl, Meta, Alt, Shift
 * (`Shift+n`, `Alt+1`, `Ctrl+ArrowLeft`); Shift only before letters and named keys, since `?` already says it.
 * A space separates the keys of a sequence (`g p`).
 */

export type Mode = "standard" | "vim";
export const MODES: Mode[] = ["standard", "vim"];

/**
 * The mode the page runs in. Components with their own keys ask `hit(e, action)` without naming a mode, so they
 * follow the switch without knowing about it; the keyboard controller sets it.
 */
let active: Mode = "standard";
export const activeMode = (): Mode => active;
export function setActiveMode(m: Mode): void {
  active = m;
}

export type Zone =
  | "global"
  | "list"
  | "session"
  | "repo"
  | "pr"
  | "approval"
  | "alarm"
  | "stream"
  | "terminal"
  | "palette"
  | "input"
  | "log"
  | "diff";

export type ActionId =
  | "allow"
  | "allowSession"
  | "deny"
  | "palette"
  | "search"
  | "help"
  | "close"
  | "zoneNext"
  | "zonePrev"
  | "filter"
  | "tile"
  | "zoom"
  | "refresh"
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "first"
  | "last"
  | "drawer"
  | "terminal"
  | "openApp"
  | "reply"
  | "newHere"
  | "fresh"
  | "copy"
  | "note"
  | "pin"
  | "hide"
  | "end"
  | "goPr"
  | "goCi"
  | "goConflict"
  | "goRepo"
  | "repoFilter"
  | "repoDrawer"
  | "repoNew"
  | "tidy"
  | "merge"
  | "rerun"
  | "fix"
  | "github"
  | "alarmAct"
  | "mute"
  | "streamJump"
  | "termFocus"
  | "termBack"
  | "termInterrupt"
  | "termExit"
  | "termEsc"
  | "next"
  | "prev"
  | "run"
  | "yes"
  | "no"
  // Stage 7: actions only the Vim table names; in standard mode the palette reaches those that are commands.
  | "command"
  | "zoneAlarm"
  | "zoneStream"
  | "halfUp"
  | "halfDown"
  | "nextAlarm"
  | "prevAlarm"
  | "nextRepo"
  | "prevRepo"
  | "searchNext"
  | "searchPrev"
  | "expand"
  | "collapse"
  | "expandAll"
  | "collapseAll"
  | "drawerClose"
  | "visual"
  | "undo"
  | "repeat"
  // Release 6: the diff and files view of a session.
  | "diff"
  | "diffNext"
  | "diffPrev"
  | "diffFileNext"
  | "diffFilePrev"
  | "diffContent"
  | "diffFiles"
  // Stage 11: the log view.
  | "log"
  | "logPick"
  | "logAll";

export interface Binding {
  action: ActionId;
  zone: Zone;
  keys: Record<Mode, string[]>;
  de: string;
  en: string;
  /** Value for actions with variants: the status filter, the route of an area. */
  arg?: string;
  /** Spec stage that builds what this key acts on; until then the key is reserved and says so. */
  stage?: number;
  /** Handled by the element itself (the terminal, a dialog, an input), never by the page's key handler. */
  own?: boolean;
  /** Moves the selection: in Vim a count repeats it (`3j`). */
  motion?: boolean;
  /** Goes to an end of the list: in Vim a count names the row instead (`5G`, `5gg`). */
  goto?: boolean;
}

type More = Partial<Pick<Binding, "arg" | "stage" | "own" | "motion" | "goto">> & { vim?: string[] };

/** Without `vim`, a binding keeps its standard keys in Vim mode too. */
const b = (action: ActionId, zone: Zone, keys: string[], de: string, en: string, more: More = {}): Binding => {
  const { vim, ...rest } = more;
  return { action, zone, keys: { standard: keys, vim: vim ?? keys }, de, en, ...rest };
};

/** The status filters behind Alt+1–5 and Alt+0, in the spec's order: waiting, error, working, done, resting. */
export const FILTERS = ["needs", "errors", "working", "done", "resting"] as const;
export type StatusFilter = (typeof FILTERS)[number];

export const KEYMAP: Binding[] = [
  // Vim: Ctrl+K goes to the event stream (Vim table); the command line stays on ⌘K and `:`.
  b("palette", "global", ["Meta+k", "Ctrl+k"], "Kommandozeile (⌘K)", "Command line (⌘K)", { vim: ["Meta+k"] }),
  // Stage 12 (spec, "Ein Schirm im CLI-Look", rule 4): `:` puts the focus in the command line in both modes.
  b("command", "global", [":"], "Kommandozeile", "Command line"),
  b("search", "global", ["/"], "Suche in der Kommandozeile", "Search in the command line"),
  b("help", "global", ["?"], "Tastenhilfe (zweimal: alle Tasten mit Suche)", "Key help (twice: all keys with search)"),
  b("close", "global", ["Escape"], "Schließen, zurück, abbrechen", "Close, back, cancel", {
    vim: ["Escape", "Ctrl+["],
  }),
  // Stage 12 (spec, "Ein Schirm im CLI-Look", rules 6, 14, 15): the one keymap break. 1–5 jump to the tiles as in
  // lazygit, the status filters move to Alt+1–5, the areas lose their keys to them and are commands (`:repos`).
  // Vim keeps its digits as counts and walks the tiles with Tab and Ctrl+H/J/K/L.
  b("tile", "global", ["1"], "Kachel 1: Alarmzone", "Tile 1: alarm zone", { arg: "alarm", vim: [] }),
  b("tile", "global", ["2"], "Kachel 2: Repo-Leiste", "Tile 2: repo bar", { arg: "repos", vim: [] }),
  b("tile", "global", ["3"], "Kachel 3: Wachtafel", "Tile 3: watch board", { arg: "board", vim: [] }),
  b("tile", "global", ["4"], "Kachel 4: Ereignisstrom", "Tile 4: event stream", { arg: "stream", vim: [] }),
  b("tile", "global", ["5"], "Kachel 5: Schublade", "Tile 5: drawer", { arg: "drawer", vim: [] }),
  b("zoneNext", "global", ["Tab"], "Nächste Kachel", "Next tile", { vim: ["Ctrl+l", "Tab"] }),
  b("zonePrev", "global", ["Shift+Tab"], "Vorige Kachel", "Previous tile", { vim: ["Ctrl+h", "Shift+Tab"] }),
  b("zoneAlarm", "global", [], "Zur Alarmzone", "To the alarm zone", { vim: ["Ctrl+j"] }),
  b("zoneStream", "global", [], "Zum Ereignisstrom", "To the event stream", { vim: ["Ctrl+k"] }),
  b("zoom", "global", ["+"], "Aktive Kachel als Vollbild und zurück", "Active tile full screen and back"),
  b("filter", "global", ["Alt+1"], "Filter: wartet", "Filter: waiting", { arg: "needs" }),
  b("filter", "global", ["Alt+2"], "Filter: Fehler", "Filter: error", { arg: "errors" }),
  b("filter", "global", ["Alt+3"], "Filter: arbeitet", "Filter: working", { arg: "working" }),
  b("filter", "global", ["Alt+4"], "Filter: fertig", "Filter: done", { arg: "done" }),
  b("filter", "global", ["Alt+5"], "Filter: ruht", "Filter: resting", { arg: "resting" }),
  b("filter", "global", ["Alt+0"], "Filter aufheben, alle zeigen", "Clear the filter, show all", { arg: "" }),
  b("refresh", "global", ["Alt+r"], "Aktualisieren erzwingen", "Force a refresh"),
  b("drawerClose", "global", [], "Schublade schließen", "Close the drawer", { vim: ["q"] }),
  // Release 6, practical test 15 Oct: the status line says "u brings it back" in both modes, so u undoes in both.
  b("undo", "global", ["u"], "Ausblenden rückgängig machen", "Undo hiding", { vim: ["u"] }),
  b("repeat", "global", [], "Letzten Befehl wiederholen", "Repeat the last command", { vim: ["."] }),
  // Stage 11 (spec, "Log-Sicht"): the same key in both modes; Vim's L (bottom of the screen) names no Fleet action.
  b(
    "log",
    "global",
    ["Shift+l"],
    "Log-Sicht: alle Schritte aller Sessions (zurück: Shift+L, Esc)",
    "Log view: every step of every session (back: Shift+L, Esc)",
  ),

  b("up", "list", ["ArrowUp", "k"], "Zeile hoch", "Row up", { motion: true }),
  b("down", "list", ["ArrowDown", "j"], "Zeile runter", "Row down", { motion: true }),
  b("halfUp", "list", [], "Halbe Seite hoch", "Half a page up", { vim: ["Ctrl+u"], motion: true }),
  b("halfDown", "list", [], "Halbe Seite runter", "Half a page down", { vim: ["Ctrl+d"], motion: true }),
  b("pageUp", "list", ["PageUp"], "Seite hoch", "Page up", { motion: true }),
  b("pageDown", "list", ["PageDown"], "Seite runter", "Page down", { motion: true }),
  b("first", "list", ["Home"], "Anfang", "First row", { vim: ["g g", "Home"], goto: true }),
  b("last", "list", ["End"], "Ende", "Last row", { vim: ["Shift+g", "End"], goto: true }),
  b("nextAlarm", "list", [], "Nächste Zeile mit Alarm", "Next row with an alarm", { vim: ["] a"], motion: true }),
  b("prevAlarm", "list", [], "Vorige Zeile mit Alarm", "Previous row with an alarm", {
    vim: ["[ a"],
    motion: true,
  }),
  b("searchNext", "list", [], "Nächster Treffer der Suche", "Next search hit", { vim: ["n"], motion: true }),
  b("searchPrev", "list", [], "Voriger Treffer der Suche", "Previous search hit", {
    vim: ["Shift+n"],
    motion: true,
  }),
  b("expand", "list", [], "Aufklappen (CI-Lauf, sonst Ruht)", "Expand (a CI run, else resting)", { vim: ["z o"] }),
  b("collapse", "list", [], "Zuklappen (CI-Lauf, sonst Ruht)", "Collapse (a CI run, else resting)", { vim: ["z c"] }),
  b("expandAll", "list", [], "Alle Gruppen aufklappen (Ruht)", "Expand all groups (resting)", {
    vim: ["z Shift+r"],
  }),
  b("collapseAll", "list", [], "Alles zuklappen", "Collapse everything", { vim: ["z Shift+m"] }),
  // Stage 12 (rule 15): Enter opens the drawer, nothing unfolds in the row. Release 6: Shift+Enter too, so an alarm
  // row (where Enter runs its action) has a drawer key in standard mode as well.
  b("drawer", "list", ["Enter", "Shift+Enter"], "Schublade öffnen", "Open the drawer", { vim: ["o", "Enter"] }),
  b("visual", "list", [], "Zeilen markieren (dann j/k und x)", "Mark rows (then j/k and x)", { vim: ["Shift+v"] }),

  b("terminal", "session", ["ArrowRight"], "Im Terminal im Fenster öffnen", "Open in the terminal in the window", {
    vim: ["i", "ArrowRight"],
  }),
  b("openApp", "session", ["o"], "Im bevorzugten Programm öffnen", "Open in the preferred program", { vim: [] }),
  b("reply", "session", ["r"], "Inline antworten", "Reply inline", { vim: ["a"] }),
  b(
    "newHere",
    "session",
    ["n"],
    "Neue Session im selben Repo (mit Übergabe)",
    "New session in the same repo (with handoff)",
    { vim: [] },
  ),
  b(
    "fresh",
    "session",
    ["Shift+n"],
    "Frisch starten (Übergabe + neue Session)",
    "Start fresh (handoff + new session)",
    { vim: [] },
  ),
  b("copy", "session", ["c"], "Resume-Befehl kopieren", "Copy the resume command", { vim: ["y y"] }),
  b("note", "session", ["e"], "Notiz bearbeiten", "Edit the note", { vim: ["c n"] }),
  b("pin", "session", ["p"], "Anheften / lösen", "Pin / unpin", { vim: ["m p"] }),
  b("hide", "session", ["x"], "Ausblenden (markierte Zeilen: alle)", "Hide (marked rows: all)", {
    vim: ["d d", "x"],
  }),
  b("end", "session", ["Shift+x"], "Session beenden (Bestätigung)", "End the session (confirm)", { vim: [] }),
  // Release 6 (plan R9, R10): what the session changed, full screen; g d in Vim, next to g p, g c and g k.
  b(
    "diff",
    "session",
    ["d"],
    "Änderungen und Dateien der Session (Diff, Vollbild)",
    "The session's changes and files (diff, full screen)",
    {
      vim: ["g d"],
    },
  ),
  b("goPr", "session", ["g p"], "Zum PR", "Go to the PR"),
  b("goCi", "session", ["g c"], "Zur CI", "Go to CI"),
  b("goConflict", "session", ["g k"], "Zum Konflikt", "Go to the conflict"),
  b("goRepo", "session", ["g r"], "Zum Repo in der Repo-Leiste", "Go to the repo in the repo bar"),
  b("nextRepo", "session", [], "Nächste Zeile desselben Repos", "Next row of the same repo", {
    vim: ["] r"],
    motion: true,
  }),
  b("prevRepo", "session", [], "Vorige Zeile desselben Repos", "Previous row of the same repo", {
    vim: ["[ r"],
    motion: true,
  }),

  b("repoFilter", "repo", ["Enter"], "Filter auf Repo", "Filter on the repo", { own: true }),
  b("repoDrawer", "repo", ["Shift+Enter"], "Repo-Schublade", "Repo drawer", { vim: ["o", "Shift+Enter"] }),
  b("repoNew", "repo", ["n"], "Neue Session in diesem Repo", "New session in this repo", { vim: [] }),
  b(
    "tidy",
    "repo",
    ["o"],
    "Aufräumen nur hier (Sessions still seit 8 h, y/n)",
    "Tidy up only here (sessions quiet for 8 h, y/n)",
    { vim: [] },
  ),

  b("merge", "pr", ["m"], "Mergen (Bestätigung)", "Merge (confirm)", { vim: ["g m"] }),
  b("rerun", "pr", ["Shift+r"], "Fehlgeschlagene Jobs neu starten", "Re-run failed jobs", { vim: [] }),
  b("fix", "pr", ["f"], "Fix-Session starten", "Start a fix session", { vim: ["g f"] }),
  b("github", "pr", ["Shift+g"], "Auf GitHub öffnen", "Open on GitHub", { vim: [] }),

  b("alarmAct", "alarm", ["Enter"], "Die eine Aktion der Zeile ausführen", "Run the row's one action"),
  // Live 16.10.2026: Enter on an approval forked the session into Fleet's terminal. An approval row answers by key
  // like Claude Code's own prompt; one the app holds says where it waits (Fleet cannot answer it there).
  // Not in Vim: there y starts `y y` (copy), n walks the search and a replies; a habit must never let a tool run.
  b("allow", "approval", ["y"], "Freigabe erlauben", "Allow the approval", { vim: [] }),
  b("allowSession", "approval", ["a"], "Für diese Session erlauben", "Allow for this session", { vim: [] }),
  b("deny", "approval", ["n"], "Freigabe ablehnen", "Deny the approval", { vim: [] }),
  // Release 6 (plan R4): an alarm row goes away by key; a session is hidden (u brings it back), the rest muted 1 h.
  b(
    "hide",
    "alarm",
    ["x"],
    "Alarm wegräumen (Session ausblenden, sonst 1 h stumm; markierte Zeilen: alle)",
    "Clear the alarm (hide the session, else mute 1 h; marked rows: all)",
    { vim: ["d d", "x"] },
  ),
  b("mute", "alarm", ["s"], "Stummschalten für 1 h (Bestätigung)", "Mute for 1 h (confirm)", { vim: [] }),

  b("streamJump", "stream", ["Enter"], "Zur betroffenen Zeile springen", "Jump to the row", { own: true }),

  b("termFocus", "terminal", ["ArrowRight"], "Fokus ins Terminal", "Focus into the terminal", { own: true }),
  b("termBack", "terminal", ["Ctrl+ArrowLeft"], "Zurück in die Liste", "Back to the list", { own: true }),
  // Release 6 (plan R8): Esc leaves the full-screen terminal for the overview, the session runs on; Claude gets its
  // Esc from Ctrl+[ (the same byte in a terminal).
  b(
    "termExit",
    "terminal",
    ["Escape"],
    "Terminal verlassen, zurück zur Übersicht",
    "Leave the terminal, back to the overview",
    {
      own: true,
    },
  ),
  b("termEsc", "terminal", ["Ctrl+["], "Esc an Claude senden (im Terminal)", "Send Esc to Claude (in the terminal)", {
    own: true,
  }),
  b(
    "termInterrupt",
    "terminal",
    ["Ctrl+c"],
    "Laufenden Turn abbrechen (im Terminal)",
    "Interrupt the turn (in the terminal)",
    {
      own: true,
    },
  ),

  // In the log view the row numbers of the watch board pick a session; its own keys, digits do nothing else there.
  b(
    "logPick",
    "log",
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    "Nur die Session aus dieser Zeile auf Jetzt (12: zwei Ziffern)",
    "Only the session of this row on Now (12: two digits)",
    { own: true },
  ),
  b("logAll", "log", ["0"], "Wieder alle Sessions", "All sessions again", { own: true }),

  // The diff view's own keys (release 6): it takes every key while open, like the log view.
  b(
    "diffNext",
    "diff",
    ["n"],
    "Nächste Änderung (bei Suche: nächster Treffer)",
    "Next change (while searching: next hit)",
    {
      own: true,
    },
  ),
  b(
    "diffPrev",
    "diff",
    ["Shift+n"],
    "Vorige Änderung (bei Suche: voriger Treffer)",
    "Previous change (while searching: previous hit)",
    {
      own: true,
    },
  ),
  b("diffFileNext", "diff", ["]", "Shift+j"], "Nächste Datei", "Next file", { own: true }),
  b("diffFilePrev", "diff", ["[", "Shift+k"], "Vorige Datei", "Previous file", { own: true }),
  b(
    "diffContent",
    "diff",
    ["t", "Enter"],
    "Ganze Datei zeigen und zurück zum Diff",
    "Show the whole file and back to the diff",
    {
      own: true,
    },
  ),
  b("diffFiles", "diff", ["f"], "In die Dateiliste und zurück", "Into the file list and back", { own: true }),

  b("next", "palette", ["ArrowDown", "Ctrl+n"], "Nächster Vorschlag", "Next suggestion", { own: true }),
  b("prev", "palette", ["ArrowUp", "Ctrl+p"], "Voriger Vorschlag", "Previous suggestion", { own: true }),
  b("run", "palette", ["Enter"], "Ausführen", "Run", { own: true }),
  b("run", "input", ["Enter"], "Senden", "Send", { own: true }),
  b("yes", "input", ["y"], "Bestätigen (Statuszeile)", "Confirm (status line)", { own: true }),
  b("no", "input", ["n"], "Ablehnen (Statuszeile)", "Decline (status line)", { own: true }),
];

/** Zone names for the help overlay, in its order. */
export const ZONES: { zone: Zone; de: string; en: string }[] = [
  { zone: "global", de: "Überall", en: "Everywhere" },
  { zone: "list", de: "Liste", en: "List" },
  { zone: "session", de: "Session", en: "Session" },
  { zone: "pr", de: "PR und CI", en: "PR and CI" },
  { zone: "approval", de: "Freigabe", en: "Approval" },
  { zone: "alarm", de: "Alarmzone", en: "Alarm zone" },
  { zone: "repo", de: "Repo-Leiste", en: "Repo bar" },
  { zone: "stream", de: "Ereignisstrom", en: "Event stream" },
  { zone: "terminal", de: "Terminal", en: "Terminal" },
  { zone: "log", de: "Log-Sicht", en: "Log view" },
  { zone: "diff", de: "Diff-Sicht", en: "Diff view" },
  { zone: "palette", de: "Kommandozeile", en: "Command line" },
  { zone: "input", de: "Eingabe und Bestätigung", en: "Input and confirmation" },
];

/**
 * What the key help lists (rounds 3 and 7): for one place, `zones` are given most specific first (the order of
 * `zonesOf`). A key a more specific zone takes is left out of the later ones, so the help never says Enter opens the
 * drawer on an alarm row, where it runs the action, or 1–5 jump to tiles in the log view, where they pick a session,
 * and `x` appears once (the alarm zone's wording wins over the session's). `null` is all keys (`??`), complete.
 */
export function helpEntries(
  zones: Zone[] | null,
  mode: Mode,
): { zone: Zone; de: string; en: string; list: Binding[] }[] {
  // Keys already claimed by the zones before this one, in the order given.
  const before = new Map<Zone, Set<string>>();
  if (zones) {
    const claimed = new Set<string>();
    for (const z of zones) {
      before.set(z, new Set(claimed));
      for (const x of KEYMAP) if (x.zone === z) for (const k of x.keys[mode]) claimed.add(k);
    }
  }
  return ZONES.filter((z) => !zones || zones.includes(z.zone)).map((z) => {
    const taken = before.get(z.zone);
    return {
      ...z,
      list: KEYMAP.filter((x) => x.zone === z.zone && x.keys[mode].length)
        .map((x) => (taken ? { ...x, keys: { ...x.keys, [mode]: x.keys[mode].filter((k) => !taken.has(k)) } } : x))
        .filter((x) => x.keys[mode].length),
    };
  });
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** The key name of an event, or null for a bare modifier. */
export function keyOf(e: KeyLike): string | null {
  if (!e.key || /^(Shift|Control|Alt|Meta|AltGraph|CapsLock|Dead|Unidentified)$/.test(e.key)) return null;
  let base = e.key;
  // With Alt, macOS reports the composed character (Alt+1 = "¡"); the physical key says what was meant.
  if (e.altKey && e.code) {
    const m = /^(?:Digit(\d)|Key([A-Z]))$/.exec(e.code);
    if (m) base = m[1] ?? (m[2] || "").toLowerCase();
  }
  if (base === " ") base = "Space";
  const letter = /^[a-zA-Z]$/.test(base);
  if (letter) base = base.toLowerCase();
  const named = base.length > 1;
  return [
    e.ctrlKey ? "Ctrl+" : "",
    e.metaKey ? "Meta+" : "",
    e.altKey ? "Alt+" : "",
    e.shiftKey && (letter || named) ? "Shift+" : "",
    base,
  ].join("");
}

export const bindingsOf = (action: ActionId, mode: Mode = active) =>
  KEYMAP.filter((x) => x.action === action && x.keys[mode].length);

/** An action's binding whatever its keys: the palette also runs actions without a key in the active mode. */
export const bindingOf = (action: ActionId): Binding | undefined => KEYMAP.find((x) => x.action === action);

/** Whether an event is one of the keys of an action in the active mode; for components with their own keys. */
export function hit(e: KeyLike, action: ActionId, mode: Mode = active, zone?: Zone): boolean {
  const k = keyOf(e);
  return !!k && bindingsOf(action, mode).some((x) => (!zone || x.zone === zone) && x.keys[mode].includes(k));
}

/** Keys in readable form; ⌘ and ⌥ only on a Mac, Ctrl and Alt elsewhere. */
export function keyLabel(key: string, mac = false, vim = false): string {
  return key
    .split(" ")
    .map((part) => {
      // Vim users read Shift+G as G, and a sequence as one word (gg, ]a).
      if (vim && /^Shift\+[a-z]$/.test(part)) return part.slice(-1).toUpperCase();
      // "+" itself is a key (zoom): split leaves empty strings, which are no modifiers (round 7: "Shift++").
      const mods = part.split("+");
      let base = mods.pop() || "";
      if (base === "") base = "+";
      while (mods.length && mods[mods.length - 1] === "") mods.pop();
      const names: Record<string, string> = {
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        Escape: "Esc",
        PageUp: "PageUp",
        PageDown: "PageDown",
      };
      const shown = names[base] || (mods.length && /^[a-z]$/.test(base) ? base.toUpperCase() : base);
      const pre = mods
        .map((m) => (m === "Meta" ? "⌘" : m === "Alt" ? (mac ? "⌥" : "Alt+") : m === "Ctrl" ? "Ctrl+" : "Shift+"))
        .join("");
      return `${pre}${shown}`;
    })
    .join(vim ? "" : " ");
}

/** The keys of a binding to show: ⌘ only on a Mac, where Ctrl+K belongs to the terminal. */
export function shownKeys(x: Binding, mode: Mode = active, mac = false): string[] {
  const keys = x.keys[mode].filter((k) => mac || !k.startsWith("Meta+"));
  return keys.map((k) => keyLabel(k, mac, mode === "vim"));
}

/** Key state between two presses: a started sequence (`g`) and, in Vim, a count being typed (`12`). */
export interface Pending {
  seq: string[];
  count: string;
}
export const IDLE: Pending = { seq: [], count: "" };

export type Effect =
  /** Waiting for the next key; the status line shows what was typed. */
  | { kind: "wait" }
  /** Run a binding, on the row with this number when one was typed first; a Vim count runs a motion `times`. */
  | { kind: "run"; binding: Binding; nr: number | null; times?: number }
  /** Vim's `5G` or `12 Enter`: select row 5 or 12. */
  | { kind: "select"; nr: number }
  /** Escape or an unknown key ended what was typed. */
  | { kind: "cancel" }
  | { kind: "none" };

/**
 * What Vim's `.` repeats: the last key that changed something (spec: "Letzten Befehl wiederholen"). Moving,
 * opening and filtering are no changes; repeating them would only jump around.
 */
export const REPEATS = new Set<ActionId>([
  "alarmAct",
  "copy",
  "end",
  "fix",
  "fresh",
  "hide",
  "merge",
  "mute",
  "newHere",
  "pin",
  "rerun",
]);

/** How long digits typed one after the other make one number in the log view (`12`, log-keys.ts). */
export const DIGIT_WAIT_MS = 1000;
const MAX_DIGITS = 3;

/**
 * One key press. `zonesFor(nr)` names the zones in play, most specific first: those of the selected row, or of
 * row `nr` when a number was typed. In standard mode a digit is a key of its own (1–5: the tiles, spec rule 14); a
 * row is chosen with `:12` in the command line. In Vim digits gather a count: before a motion it repeats it (`3j`
 * moves three rows from the selection), before `G`, `gg` or Enter it names the row to go to (`5G`), before any
 * other key the row to act on (`3 g m`).
 */
export function press(
  state: Pending,
  key: string,
  zonesFor: (nr: number | null) => Zone[],
  mode: Mode = "standard",
): { state: Pending; effect: Effect } {
  const busy = state.seq.length > 0 || state.count !== "";
  if (key === "Escape" && busy) return { state: IDLE, effect: { kind: "cancel" } };
  // A lone 0 is no count (Vim's "start of line"); after another digit it is part of the number.
  if (mode === "vim" && !state.seq.length && /^\d$/.test(key) && (key !== "0" || state.count))
    return state.count.length < MAX_DIGITS
      ? { state: { seq: [], count: state.count + key }, effect: { kind: "wait" } }
      : { state: IDLE, effect: { kind: "cancel" } };
  const nr = state.count ? Number(state.count) : null;
  if (nr !== null && !state.seq.length && key === "Enter")
    return { state: IDLE, effect: nr > 0 ? { kind: "select", nr } : { kind: "cancel" } };
  const seq = [...state.seq, key].join(" ");
  const liveIn = (zones: Zone[]) => KEYMAP.filter((x) => !x.own && zones.includes(x.zone) && x.keys[mode].length);
  // The most specific zone wins: Enter in the alarm zone runs the row's action, elsewhere it opens the drawer.
  const find = (zones: Zone[]) =>
    zones.map((z) => liveIn(zones).find((x) => x.zone === z && x.keys[mode].includes(seq))).find((x) => !!x);
  const counted = nr !== null;
  // A Vim count moves from the selection, so the motion is looked up where the selection is, not in row `nr`.
  const here = counted ? find(zonesFor(null)) : undefined;
  const exact = here && (here.motion || here.goto) ? here : find(zonesFor(nr));
  if (exact) {
    // A global key after a count (`3` then `?`): the count has nothing to act on and is dropped.
    if (exact.zone === "global" && counted) return { state: IDLE, effect: { kind: "run", binding: exact, nr: null } };
    if (counted && exact.goto) return { state: IDLE, effect: nr > 0 ? { kind: "select", nr } : { kind: "cancel" } };
    if (counted && exact.motion)
      return {
        state: IDLE,
        effect: nr > 0 ? { kind: "run", binding: exact, nr: null, times: nr } : { kind: "cancel" },
      };
    return { state: IDLE, effect: { kind: "run", binding: exact, nr } };
  }
  const live = liveIn([...zonesFor(nr), ...(counted ? zonesFor(null) : [])]);
  if (live.some((x) => x.keys[mode].some((k) => k.startsWith(`${seq} `))))
    return { state: { seq: [...state.seq, key], count: state.count }, effect: { kind: "wait" } };
  return { state: IDLE, effect: busy ? { kind: "cancel" } : { kind: "none" } };
}

/** What the status line shows while keys are pending. */
export function pendingText(state: Pending): string {
  return [state.count, ...state.seq].filter(Boolean).join(" ");
}

/** The key that clears every filter, written as the key help writes it (round 5: help "⌥0", messages "Alt+0"). */
export const clearKey = (
  mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || ""),
): string => keyLabel("Alt+0", mac);
