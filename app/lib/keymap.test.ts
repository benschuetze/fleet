// The keymap is the one place for keys (spec, "Tastatursteuerung komplett"): these tests hold the promises a
// keyboard user relies on, so a later stage cannot change a key's meaning by accident.
import assert from "node:assert";
import { test } from "vitest";
import {
  type ActionId,
  activeMode,
  bindingsOf,
  clearKey,
  type Effect,
  helpEntries,
  hit,
  IDLE,
  KEYMAP,
  keyLabel,
  keyOf,
  MODES,
  type Pending,
  press,
  REPEATS,
  setActiveMode,
  shownKeys,
  type Zone,
} from "./keymap";

const board: Zone[] = ["session", "pr", "list", "global"];
const alarm: Zone[] = ["alarm", "session", "pr", "list", "global"];
const nothing: Zone[] = ["list", "global"];

/** Types keys one after the other; returns the last effect and the state after it. */
function type(keys: string[], zones: (nr: number | null) => Zone[] = () => board) {
  let state: Pending = IDLE;
  let effect: Effect = { kind: "none" };
  for (const k of keys) ({ state, effect } = press(state, k, zones));
  return { state, effect };
}
const action = (e: Effect) => (e.kind === "run" ? e.binding.action : e.kind);

test("Keys from browser events: letters lower case, Shift only where it is not in the character, Alt by key", () => {
  assert.strictEqual(keyOf({ key: "m" }), "m");
  assert.strictEqual(keyOf({ key: "N", shiftKey: true }), "Shift+n");
  assert.strictEqual(keyOf({ key: "?", shiftKey: true }), "?");
  assert.strictEqual(keyOf({ key: "Enter", shiftKey: true }), "Shift+Enter");
  assert.strictEqual(keyOf({ key: "Tab", shiftKey: true }), "Shift+Tab");
  assert.strictEqual(keyOf({ key: "k", metaKey: true }), "Meta+k");
  assert.strictEqual(keyOf({ key: "K", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+k");
  // macOS: Alt+1 types "¡", Alt+D types "∂"
  assert.strictEqual(keyOf({ key: "¡", code: "Digit1", altKey: true }), "Alt+1");
  assert.strictEqual(keyOf({ key: "∂", code: "KeyD", altKey: true }), "Alt+d");
  assert.strictEqual(keyOf({ key: "ArrowLeft", ctrlKey: true }), "Ctrl+ArrowLeft");
  assert.strictEqual(keyOf({ key: "Shift", shiftKey: true }), null);
  assert.strictEqual(keyOf({ key: "" }), null);
});

test("The spec's standard keys are where the spec puts them", () => {
  const key = (k: string, zones: Zone[]) => action(type([k], () => zones).effect);
  const cases: [string, Zone[], ActionId][] = [
    ["Meta+k", nothing, "palette"],
    ["Ctrl+k", nothing, "palette"],
    ["/", nothing, "search"],
    ["?", nothing, "help"],
    ["Escape", nothing, "close"],
    ["Tab", board, "zoneNext"],
    ["Shift+Tab", board, "zonePrev"],
    ["Alt+1", nothing, "filter"],
    ["1", nothing, "tile"],
    [":", nothing, "command"],
    ["+", nothing, "zoom"],
    ["Alt+r", nothing, "refresh"],
    ["ArrowDown", nothing, "down"],
    ["ArrowUp", board, "up"],
    ["PageDown", board, "pageDown"],
    ["Home", board, "first"],
    ["End", board, "last"],
    ["Enter", board, "drawer"],
    ["ArrowRight", board, "terminal"],
    ["r", board, "reply"],
    ["n", board, "newHere"],
    ["Shift+n", board, "fresh"],
    ["c", board, "copy"],
    ["e", board, "note"],
    ["p", board, "pin"],
    ["x", board, "hide"],
    ["Shift+x", board, "end"],
    ["m", board, "merge"],
    ["Shift+r", board, "rerun"],
    ["f", board, "fix"],
    ["Shift+g", board, "github"],
    ["s", alarm, "mute"],
  ];
  for (const [k, zones, want] of cases) assert.strictEqual(key(k, zones), want, `${k} → ${want}`);
  // Session keys do nothing without a selected session
  assert.strictEqual(key("m", nothing), "none");
  assert.strictEqual(key("x", nothing), "none");
});

test("Enter runs the alarm row's one action, elsewhere it opens the drawer (stage 12: nothing unfolds in the row)", () => {
  assert.strictEqual(action(type(["Enter"], () => alarm).effect), "alarmAct");
  assert.strictEqual(action(type(["Enter"], () => board).effect), "drawer");
});

test("Sequences: g waits, g p goes to the PR, an unknown second key cancels, Escape cancels", () => {
  const g = type(["g"]);
  assert.strictEqual(g.effect.kind, "wait");
  assert.deepStrictEqual(g.state.seq, ["g"]);
  assert.strictEqual(action(type(["g", "p"]).effect), "goPr");
  assert.strictEqual(action(type(["g", "c"]).effect), "goCi");
  assert.strictEqual(type(["g", "z"]).effect.kind, "cancel");
  assert.strictEqual(type(["g", "Escape"]).effect.kind, "cancel");
  assert.deepStrictEqual(type(["g", "z"]).state, IDLE);
});

test("Stage 12, standard: 1–5 jump to the tiles in lazygit's order; digits gather no row number any more", () => {
  const tile = (k: string, zones: Zone[] = board) => {
    const e = type([k], () => zones).effect;
    return e.kind === "run" && e.binding.action === "tile" ? e.binding.arg : action(e);
  };
  assert.deepStrictEqual(
    ["1", "2", "3", "4", "5"].map((k) => tile(k)),
    ["alarm", "repos", "board", "stream", "drawer"],
  );
  // From any zone, also from the alarm zone, where Enter means something else
  assert.strictEqual(tile("3", alarm), "board");
  // No waiting for more digits, no row prefix: `3 Enter` is tile 3, then Enter on the selection
  assert.strictEqual(type(["3"]).effect.kind, "run");
  assert.deepStrictEqual(type(["3"]).state, IDLE);
  assert.strictEqual(action(type(["3", "Enter"]).effect), "drawer");
  for (const k of ["0", "6", "9"]) assert.strictEqual(type([k]).effect.kind, "none", `${k} is no key`);
});

test("Stage 12: the status filters moved to Alt+1–5 in the spec's order, Alt+0 clears; the same in Vim", () => {
  for (const mode of MODES) {
    const filter = (k: string) => {
      const e = press(IDLE, k, () => nothing, mode).effect;
      return e.kind === "run" && e.binding.action === "filter" ? e.binding.arg : null;
    };
    assert.deepStrictEqual(
      ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+0"].map(filter),
      ["needs", "errors", "working", "done", "resting", ""],
      mode,
    );
  }
  // The areas lost Alt+1–4 and are commands (`:repos`), the density switch lost Alt+D
  assert.ok(!KEYMAP.some((x) => x.keys.standard.includes("Alt+d")));
});

test("Frozen keymap: in each mode no key means two things in one zone, every action has a name in both languages", () => {
  for (const mode of MODES) {
    const seen = new Map<string, string>();
    for (const x of KEYMAP) {
      assert.ok(x.de && x.en, `${x.action} has a name`);
      for (const k of x.keys[mode]) {
        const id = `${mode}:${x.zone}:${k}`;
        assert.ok(!seen.has(id) || seen.get(id) === x.action, `${id} is ${seen.get(id)} and ${x.action}`);
        seen.set(id, x.action);
        // A sequence's first key must not be a key of its own in a zone that is active at the same time
        const first = k.split(" ")[0] || "";
        if (k.includes(" "))
          assert.ok(
            !KEYMAP.some((y) => !y.own && y.keys[mode].includes(first)),
            `${mode}: ${first} starts ${k} and is a key of its own`,
          );
      }
    }
  }
});

test("Frozen standard keys (stage 12): the one break of rule 15 is the new freeze point, changes stay additive", () => {
  // Stage 4's map with stage 12's break in it (tiles on 1–5, filters on Alt, Enter opens the drawer). Rule 15
  // allows that break once; from here on, as from stage 4 before, keys keep their meaning.
  const stage12: Partial<Record<ActionId, string[]>> = {
    palette: ["Meta+k", "Ctrl+k"],
    command: [":"],
    search: ["/"],
    help: ["?"],
    close: ["Escape"],
    tile: ["1", "2", "3", "4", "5"],
    zoneNext: ["Tab"],
    zonePrev: ["Shift+Tab"],
    zoom: ["+"],
    filter: ["Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+0"],
    refresh: ["Alt+r"],
    log: ["Shift+l"],
    up: ["ArrowUp", "k"],
    down: ["ArrowDown", "j"],
    first: ["Home"],
    last: ["End"],
    drawer: ["Enter"],
    terminal: ["ArrowRight"],
    openApp: ["o"],
    reply: ["r"],
    newHere: ["n"],
    fresh: ["Shift+n"],
    copy: ["c"],
    note: ["e"],
    pin: ["p"],
    hide: ["x"],
    end: ["Shift+x"],
    merge: ["m"],
    rerun: ["Shift+r"],
    fix: ["f"],
    github: ["Shift+g"],
    mute: ["s"],
  };
  // Additive: a frozen key stays first and keeps its meaning; release 6 may add one behind it (drawer: Shift+Enter).
  for (const [a, keys] of Object.entries(stage12))
    assert.deepStrictEqual(
      KEYMAP.filter((x) => x.action === a)
        .flatMap((x) => x.keys.standard)
        .slice(0, keys.length),
      keys,
      `${a} keeps its standard keys`,
    );
  // Actions only the Vim table names have no standard key; the command line reaches them
  for (const a of ["halfDown", "nextAlarm", "searchNext", "visual", "repeat"] as const)
    assert.deepStrictEqual(bindingsOf(a, "standard"), [], `${a} has no standard key`);
  // Added (practical test 15 Oct): the status line says "u brings it back" in both modes, so u undoes in both.
  assert.deepStrictEqual(
    KEYMAP.filter((x) => x.action === "undo").flatMap((x) => x.keys.standard),
    ["u"],
  );
});

const vim = (keys: string[], zones: (nr: number | null) => Zone[] = () => board) => {
  let state: Pending = IDLE;
  let effect: Effect = { kind: "none" };
  for (const k of keys) ({ state, effect } = press(state, k, zones, "vim"));
  return { state, effect };
};

test("The spec's Vim keys are where the spec puts them", () => {
  // A line of the repo bar (rows.ts zonesOf): its own keys first, then the arrows of a list (stage 12.3).
  const repo: Zone[] = ["repo", "list", "global"];
  const cases: [string[], Zone[], ActionId][] = [
    [["k"], board, "up"],
    [["j"], board, "down"],
    [["j"], nothing, "down"],
    [["Ctrl+u"], board, "halfUp"],
    [["Ctrl+d"], board, "halfDown"],
    [["g", "g"], board, "first"],
    [["Shift+g"], board, "last"],
    [["]", "a"], board, "nextAlarm"],
    [["[", "a"], board, "prevAlarm"],
    [["]", "r"], board, "nextRepo"],
    [["[", "r"], board, "prevRepo"],
    [["/"], board, "search"],
    [["n"], board, "searchNext"],
    [["Shift+n"], board, "searchPrev"],
    [["Ctrl+h"], board, "zonePrev"],
    [["Ctrl+l"], board, "zoneNext"],
    [["Ctrl+j"], board, "zoneAlarm"],
    [["Ctrl+k"], board, "zoneStream"],
    [["z", "o"], board, "expand"],
    [["z", "c"], board, "collapse"],
    [["z", "Shift+r"], board, "expandAll"],
    [["z", "Shift+m"], board, "collapseAll"],
    [["o"], board, "drawer"],
    [["o"], repo, "repoDrawer"],
    [["j"], repo, "down"],
    [["k"], repo, "up"],
    [["q"], board, "drawerClose"],
    [["i"], board, "terminal"],
    [["a"], board, "reply"],
    [["Escape"], nothing, "close"],
    [["Ctrl+["], board, "close"],
    [[":"], board, "command"],
    [["y", "y"], board, "copy"],
    [["c", "n"], board, "note"],
    [["m", "p"], board, "pin"],
    [["d", "d"], board, "hide"],
    [["u"], board, "undo"],
    [["g", "p"], board, "goPr"],
    [["g", "c"], board, "goCi"],
    [["g", "k"], board, "goConflict"],
    [["g", "r"], board, "goRepo"],
    [["g", "m"], board, "merge"],
    [["g", "f"], board, "fix"],
    [["Shift+v"], board, "visual"],
    [["x"], board, "hide"],
    [["."], board, "repeat"],
    // Kept from everywhere: ⌘K, ?, Alt keys, Enter
    [["Meta+k"], nothing, "palette"],
    [["?"], nothing, "help"],
    [["Alt+2"], nothing, "filter"],
    [[":"], nothing, "command"],
    [["+"], board, "zoom"],
    [["Enter"], board, "drawer"],
    [["Enter"], alarm, "alarmAct"],
  ];
  for (const [keys, zones, want] of cases)
    assert.strictEqual(action(vim(keys, () => zones).effect), want, `${keys.join(" ")} → ${want}`);
  // Standard letters the Vim table does not name are no Vim keys: a Vim user's habit must not merge or end
  for (const k of ["m", "Shift+x", "e", "p", "s", "f", "Shift+r", "c"])
    assert.notStrictEqual(vim([k], () => alarm).effect.kind, "run", `${k} does nothing in Vim`);
  // And the other way round: the Vim keys do not leak into standard mode
  assert.strictEqual(action(type(["Shift+g"]).effect), "github");
  assert.strictEqual(action(type(["n"]).effect), "newHere");
  assert.strictEqual(action(type(["Ctrl+k"], () => nothing).effect), "palette");
  assert.strictEqual(action(type([":"]).effect), "command");
});

test("Vim counts: 3j moves three rows from the selection, 5G and 5gg go to row 5, 3 g m merges in row 3", () => {
  const asked: (number | null)[] = [];
  const zones = (nr: number | null) => {
    asked.push(nr);
    return nr === null ? board : nothing;
  };
  const j = vim(["3", "j"], zones).effect;
  assert.strictEqual(action(j), "down");
  assert.strictEqual(j.kind === "run" && j.times, 3);
  assert.strictEqual(j.kind === "run" && j.nr, null);
  // A count beyond the rows on screen still moves (as far as it goes), even when row 30 does not exist
  const far = vim(["3", "0", "k"], () => nothing).effect;
  assert.strictEqual(far.kind === "run" && far.times, 30);
  const ctrl = vim(["2", "Ctrl+d"]).effect;
  assert.strictEqual(ctrl.kind === "run" && ctrl.times, 2);
  const alarmJump = vim(["2", "]", "a"]).effect;
  assert.strictEqual(alarmJump.kind === "run" && alarmJump.times, 2);
  assert.deepStrictEqual(vim(["5", "Shift+g"]).effect, { kind: "select", nr: 5 });
  assert.deepStrictEqual(vim(["5", "g", "g"]).effect, { kind: "select", nr: 5 });
  assert.deepStrictEqual(vim(["1", "2", "Enter"]).effect, { kind: "select", nr: 12 });
  // Without a count G and gg go to the ends
  assert.strictEqual(action(vim(["Shift+g"]).effect), "last");
  assert.strictEqual(action(vim(["g", "g"]).effect), "first");
  // Before anything else the number names the row, as in standard mode
  const merge = vim(["3", "g", "m"], (nr) => (nr === 3 ? board : nothing)).effect;
  assert.strictEqual(action(merge), "merge");
  assert.strictEqual(merge.kind === "run" && merge.nr, 3);
  // Stage 12: in Vim digits stay counts (rule 14) and no tile key; a lone 0 is no count, a count before a global
  // key is dropped
  assert.strictEqual(vim(["3"]).effect.kind, "wait");
  assert.strictEqual(vim(["0"]).effect.kind, "none");
  const help = vim(["3", "?"]).effect;
  assert.strictEqual(action(help), "help");
  assert.strictEqual(help.kind === "run" && help.nr, null);
  // Standard has no counts any more: 3 is tile 3, the arrow after it moves one row
  const std = type(["3", "ArrowDown"]).effect;
  assert.strictEqual(action(std), "down");
  assert.strictEqual(std.kind === "run" && std.nr, null);
  assert.strictEqual(std.kind === "run" && std.times, undefined);
});

test("Components follow the active mode; Vim keys read like Vim (G, gg, ]a, zR)", () => {
  try {
    assert.ok(!hit({ key: "[", ctrlKey: true }, "close"));
    assert.ok(!hit({ key: "q" }, "drawerClose"));
    setActiveMode("vim");
    assert.strictEqual(activeMode(), "vim");
    assert.ok(hit({ key: "[", ctrlKey: true }, "close"));
    assert.ok(hit({ key: "Escape" }, "close"));
    assert.ok(hit({ key: "q" }, "drawerClose"));
    // The palette and inputs keep their keys in both modes
    assert.ok(hit({ key: "n", ctrlKey: true }, "next", undefined, "palette"));
    assert.ok(hit({ key: "Enter" }, "run", undefined, "input"));
  } finally {
    setActiveMode("standard");
  }
  const label = (a: ActionId) => {
    const x = KEYMAP.find((y) => y.action === a);
    return x ? shownKeys(x, "vim", false) : [];
  };
  assert.deepStrictEqual(label("last"), ["G", "End"]);
  assert.deepStrictEqual(label("first"), ["gg", "Home"]);
  assert.deepStrictEqual(label("nextAlarm"), ["]a"]);
  assert.deepStrictEqual(label("expandAll"), ["zR"]);
  assert.deepStrictEqual(label("halfDown"), ["Ctrl+D"]);
  assert.deepStrictEqual(label("searchPrev"), ["N"]);
  assert.deepStrictEqual(label("palette"), []);
  assert.deepStrictEqual(shownKeys(KEYMAP.find((y) => y.action === "palette") as never, "vim", true), ["⌘K"]);
});

test("Log view (stage 11): Shift+L from every zone in both modes, the same key; digits there are its own", () => {
  for (const zones of [board, alarm, nothing, ["repo", "list", "global"] as Zone[]]) {
    assert.strictEqual(action(type(["Shift+l"], () => zones).effect), "log");
    assert.strictEqual(action(vim(["Shift+l"], () => zones).effect), "log");
  }
  assert.deepStrictEqual(bindingsOf("log", "standard")[0]?.keys, { standard: ["Shift+l"], vim: ["Shift+l"] });
  for (const mode of MODES) {
    assert.ok(hit({ key: "3" }, "logPick", mode), `${mode}: 3 picks a row`);
    assert.ok(hit({ key: "0" }, "logAll", mode), `${mode}: 0 shows all`);
    assert.ok(hit({ key: "L", shiftKey: true }, "log", mode));
  }
  // The page's own digit handling (row numbers, status filters) never sees the log zone's keys.
  assert.ok(KEYMAP.filter((x) => x.zone === "log").every((x) => x.own));
});

test("`.` repeats changes only: moving, opening and filtering are no commands to repeat", () => {
  for (const a of ["hide", "pin", "merge", "copy", "mute"] as const) assert.ok(REPEATS.has(a), a);
  for (const a of ["down", "first", "drawer", "filter", "help", "palette", "repeat", "undo"] as const)
    assert.ok(!REPEATS.has(a), a);
});

test("Components ask the keymap, and keys read the same on every system", () => {
  assert.ok(hit({ key: "Escape" }, "close"));
  assert.ok(hit({ key: "ArrowLeft", ctrlKey: true }, "termBack"));
  assert.ok(hit({ key: "n", ctrlKey: true }, "next", "standard", "palette"));
  assert.ok(!hit({ key: "Enter" }, "close"));
  assert.strictEqual(keyLabel("Shift+n"), "Shift+N");
  assert.strictEqual(keyLabel("g p"), "g p");
  assert.strictEqual(keyLabel("Alt+1"), "Alt+1");
  assert.strictEqual(keyLabel("Alt+1", true), "⌥1");
  assert.strictEqual(keyLabel("ArrowUp"), "↑");
  const palette = KEYMAP.find((x) => x.action === "palette");
  assert.ok(palette);
  assert.deepStrictEqual(shownKeys(palette, "standard", true), ["⌘K", "Ctrl+K"]);
  assert.deepStrictEqual(shownKeys(palette, "standard", false), ["Ctrl+K"]);
});

test("Key help (round 3): a key of a specific zone hides the same key of 'everywhere' and 'list', so no key means two things", () => {
  for (const mode of MODES) {
    for (const zones of [alarm, board, ["log", "global"] as Zone[], ["diff", "global"] as Zone[]]) {
      const seen = new Map<string, string>();
      for (const z of helpEntries(zones, mode))
        for (const b of z.list)
          for (const k of b.keys[mode]) {
            const was = seen.get(k);
            assert.ok(!was || was === b.action, `${mode} ${zones.join(",")}: ${k} is ${was} and ${b.action}`);
            seen.set(k, b.action);
          }
    }
    // On an alarm row Enter is the row's action; the drawer keeps Shift+Enter (standard) and o (Vim)
    const onAlarm = helpEntries(alarm, mode).flatMap((z) => z.list);
    assert.ok(onAlarm.find((b) => b.action === "alarmAct")?.keys[mode].includes("Enter"));
    assert.ok(!onAlarm.find((b) => b.action === "drawer")?.keys[mode].includes("Enter"));
  }
  // All keys ("??") stay complete
  assert.strictEqual(
    helpEntries(null, "standard").flatMap((z) => z.list).length,
    KEYMAP.filter((x) => x.keys.standard.length).length,
  );
});

test("Round 5: messages name the filter key as the help does, ⌥0 on a Mac, Alt+0 elsewhere", () => {
  assert.strictEqual(clearKey(true), "⌥0");
  assert.strictEqual(clearKey(false), "Alt+0");
});

test("Round 7: one key, one meaning per place in the help; the special place wins", () => {
  for (const mode of MODES) {
    for (const zones of [alarm, board, ["stream", "list", "global"] as Zone[]]) {
      const seen = new Map<string, string>();
      for (const z of helpEntries(zones, mode))
        for (const b of z.list)
          for (const k of b.keys[mode]) {
            assert.ok(
              !seen.has(k),
              `${mode} ${zones.join(",")}: ${k} is listed as ${seen.get(k)} and ${b.zone}/${b.action}`,
            );
            seen.set(k, `${b.zone}/${b.action}`);
          }
    }
    // x on an alarm row: the alarm zone's wording, once
    const hide = helpEntries(alarm, mode).flatMap((z) => z.list.filter((b) => b.action === "hide"));
    assert.strictEqual(hide.length, 1);
    assert.strictEqual(hide[0]?.zone, "alarm");
    // The stream lists its Enter
    const stream = helpEntries(["stream", "list", "global"], mode).flatMap((z) => z.list);
    assert.ok(stream.find((b) => b.action === "streamJump")?.keys[mode].includes("Enter"));
    assert.ok(!stream.find((b) => b.action === "drawer")?.keys[mode].includes("Enter"));
  }
});

test("Round 7: the + key reads +, not Shift++", () => {
  assert.strictEqual(keyLabel("+"), "+");
  assert.strictEqual(keyLabel("Shift+Tab"), "Shift+Tab");
  assert.strictEqual(keyLabel("Alt+1"), "Alt+1");
});

test("An approval row answers by key like Claude Code's prompt (live 16.10.2026); other rows keep n and a", () => {
  const approval: Zone[] = ["approval", ...alarm];
  for (const [k, want] of [
    ["y", "allow"],
    ["a", "allowSession"],
    ["n", "deny"],
    ["Enter", "alarmAct"],
  ] as const)
    assert.strictEqual(action(type([k], () => approval).effect), want, `${k} → ${want}`);
  assert.strictEqual(action(type(["n"], () => alarm).effect), "newHere");
  // Vim keeps y y (copy), n (search) and a (reply) everywhere: a habit must never let a tool run; Enter asks y/n.
  assert.strictEqual(vim(["y"], () => approval).effect.kind, "wait");
  assert.strictEqual(action(vim(["a"], () => approval).effect), "reply");
  assert.strictEqual(action(vim(["n"], () => approval).effect), "searchNext");
  assert.strictEqual(action(vim(["Enter"], () => approval).effect), "alarmAct");
});
