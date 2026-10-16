// The position in a tile's frame line (spec, "Ein Schirm im CLI-Look", rule 3): which rows are in sight.
import assert from "node:assert";
import { test } from "vitest";
import { belowView, frontOf, keysFor, scrollPos, TILE_ORDER, tileKeys } from "./tiles";

const line = (id: Parameters<typeof tileKeys>[0], mode: "standard" | "vim") =>
  tileKeys(id, mode)
    .map((k) => `${k.keys} ${k.de}`)
    .join(" · ");

test("Status line (rule 5): the five keys of each tile, from the keymap of the active mode", () => {
  assert.strictEqual(line("board", "standard"), "↑↓ wählen · Enter Details · → Terminal · d Diff · ? alle");
  assert.strictEqual(line("alarm", "standard"), "↑↓ wählen · Enter Aktion · Shift+Enter Details · → Terminal · ? alle");
  assert.strictEqual(line("approval", "standard"), "↑↓ wählen · y erlauben · a für Session · n ablehnen · ? alle");
  assert.strictEqual(line("approvalOther", "standard"), "↑↓ wählen · Enter Aktion · Shift+Enter Details · ? alle");
  assert.strictEqual(line("repos", "standard"), "↑↓ wählen · Enter filtern · Shift+Enter Details · n neu · ? alle");
  assert.strictEqual(line("stream", "standard"), "↑↓ wählen · Enter zur Zeile · g r zum Repo · → Terminal · ? alle");
  assert.strictEqual(line("drawer", "standard"), "Esc schließen · → Terminal · e Notiz · c kopieren · ? alle");
  for (const id of TILE_ORDER) assert.strictEqual(tileKeys(id, "standard").length, 5, id);
  // The diff view (release 6): pairs written as Vim writes them, in both modes.
  assert.strictEqual(line("diff", "standard"), "n/N Änderung · ]/[ Datei · t ganze Datei · f Liste · Esc zurück");
  assert.strictEqual(line("diff", "vim"), "n/N Änderung · ]/[ Datei · t ganze Datei · f Liste · Esc zurück");
  // Inside the terminal (release 6): where Claude's Esc went.
  assert.strictEqual(line("term", "vim"), "Esc zurück · Ctrl+[ Esc an Claude · Ctrl+C abbrechen · Ctrl+← zur Liste");
  // The command line, while it has the focus.
  assert.strictEqual(line("cmdline", "standard"), "↑↓ wählen · Enter ausführen · Esc zurück");
});

test("Status line in Vim: Vim's own keys, letters first; what has no Vim key is left out, never shown wrong", () => {
  assert.strictEqual(line("board", "vim"), "jk wählen · o Details · i Terminal · gd Diff · ? alle");
  assert.strictEqual(line("alarm", "vim"), "jk wählen · Enter Aktion · o Details · i Terminal · ? alle");
  assert.strictEqual(line("repos", "vim"), "jk wählen · Enter filtern · o Details · ? alle");
  // The tile keys 1–5 are counts in Vim (rule 14); the stream offers the jump into the terminal (release 6).
  assert.strictEqual(line("stream", "vim"), "jk wählen · Enter zur Zeile · gr zum Repo · i Terminal · ? alle");
  assert.strictEqual(line("drawer", "vim"), "Esc schließen · i Terminal · cn Notiz · yy kopieren · ? alle");
});

test("The tile in front (rule 17: the one a phone shows, the one + zooms): a middle tile; the alarm zone keeps it", () => {
  // The drawer is a tile of the middle since stage 12.5: active, it is the one in front
  for (const id of ["repos", "board", "stream", "drawer"] as const) assert.strictEqual(frontOf(id, "board"), id);
  // The alarm zone stands above the middle since stage 12.6: going there leaves the middle as it was
  assert.strictEqual(frontOf("alarm", "stream"), "stream");
  assert.strictEqual(frontOf("alarm", "board"), "board");
  assert.strictEqual(frontOf(null, "stream"), "stream");
});

/** Rows of 20 px, one under the other, starting at `top`. */
const rows = (n: number, top = 0) =>
  Array.from({ length: n }, (_, i) => ({ top: top + i * 20, bottom: top + i * 20 + 20 }));

test("Tile position: first and last row in sight of all rows, only while the tile scrolls", () => {
  assert.strictEqual(scrollPos(rows(60), { top: 0, bottom: 600 }, true), "1–30/60");
  assert.strictEqual(scrollPos(rows(60, -400), { top: 0, bottom: 600 }, true), "21–50/60");
  assert.strictEqual(scrollPos(rows(60, -600), { top: 0, bottom: 600 }, true), "31–60/60");
  // Everything fits: nothing to say.
  assert.strictEqual(scrollPos(rows(10), { top: 0, bottom: 600 }, false), null);
  assert.strictEqual(scrollPos([], { top: 0, bottom: 600 }, true), null);
});

test("Tile position: a row counts once at least half of it is in sight; none in sight says how many lie above", () => {
  // Half a row above and half below the view: both halves count.
  assert.strictEqual(scrollPos(rows(60, -10), { top: 0, bottom: 600 }, true), "1–31/60");
  assert.strictEqual(scrollPos(rows(60, -11), { top: 0, bottom: 600 }, true), "2–31/60");
  // Scrolled past all rows into what follows them (the archive line, other sections).
  assert.strictEqual(scrollPos(rows(5, -300), { top: 0, bottom: 600 }, true), "5/5");
});

test("Rows below the view: what a scroll would bring up, never rows above or in sight", () => {
  // A body of three rows with eight rows inside.
  assert.strictEqual(belowView(rows(8), { top: 0, bottom: 60 }), 5);
  // Scrolled to the end: nothing below, the ones above do not count.
  assert.strictEqual(belowView(rows(8, -100), { top: 0, bottom: 60 }), 0);
  // A row half in sight is seen.
  assert.strictEqual(belowView(rows(4, 10), { top: 0, bottom: 60 }), 1);
  assert.strictEqual(belowView([], { top: 0, bottom: 60 }), 0);
});

test("The status line names only keys that work where you are (round 4: 'd Diff' on Repos, session keys in the repo drawer)", () => {
  // The other views' lists open their line; no session keys there
  assert.strictEqual(keysFor("board", "/repos", null), "view");
  assert.strictEqual(keysFor("board", "/usage", null), "view");
  assert.strictEqual(keysFor("board", "/", null), "board");
  assert.strictEqual(line("view", "standard"), "↑↓ wählen · Enter öffnen · ? alle");
  // A drawer that is no session's: closing it is what the keys do
  // The repo drawer names its tabs too (round 6)
  assert.strictEqual(keysFor("drawer", "/", "repo"), "repoPanel");
  assert.strictEqual(line("repoPanel", "standard"), "←→ Reiter · Esc schließen · ? alle");
  assert.strictEqual(keysFor("drawer", "/", "conflict"), "panel");
  assert.strictEqual(keysFor("drawer", "/", "session"), "drawer");
  assert.strictEqual(line("panel", "standard"), "Esc schließen · ? alle");
});

test("Round 7: a terminal in the drawer names its own keys, not the session drawer's", () => {
  assert.strictEqual(keysFor("drawer", "/", "term"), "termPanel");
  assert.strictEqual(line("termPanel", "standard"), "Esc schließen · → ins Terminal · ? alle");
  assert.strictEqual(line("termPanel", "vim"), "Esc schließen · → ins Terminal · ? alle");
});
