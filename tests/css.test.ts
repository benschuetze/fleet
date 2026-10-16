// Reported while checking live: a paste cut a CSS rule in two and later rules went missing silently.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { ROOT } from "./helpers/server";

const read = (f: string) => fs.readFileSync(path.join(ROOT, "app", f), "utf8");
/** The UI style sheets; every check below reads all of them, so a sheet missing here would escape them. */
const UI = [
  "app.css",
  "views.css",
  "drawer.css",
  "keys.css",
  "log.css",
  "diff.css",
  "screen.css",
  "rows.css",
  "side.css",
];
const SHEETS = [...UI, "tokens.css"];

test("Style sheets: the list above is every sheet in app/", () => {
  const onDisk = fs.readdirSync(path.join(ROOT, "app")).filter((f) => f.endsWith(".css"));
  assert.deepStrictEqual([...onDisk].sort(), [...SHEETS].sort());
});

test("Style sheets: braces balanced, no cut rules, the component rules exist", () => {
  for (const f of SHEETS) {
    const css = read(f);
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      assert.ok(depth >= 0, `${f}: a closing brace without an opening one`);
    }
    assert.strictEqual(depth, 0, `${f}: every rule is closed`);
    // A remainder like `}:"JetBrains Mono",…` is no rule (selectors like `:root` stay allowed).
    assert.doesNotMatch(css, /\}\s*(?::"|;)/, `${f}: no declaration remainder after a rule`);
  }
  // The formatter spreads rules over lines; compare without that whitespace.
  const flat = SHEETS.map(read)
    .join("\n")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1");
  for (const sel of [
    ".arow{",
    "table.wtable{",
    ".statusline{",
    ".runbox .jobs{",
    ".decision pre.cmd{",
    ".hd-gear{",
    ".drawer{",
    ".term-box{",
    "table.rtable{",
    ".st-list{",
    ".d-tabs{",
    "dialog.modal{",
    ".reply-line input{",
    ".logview{",
    ".log-tag.c10{",
    ".screen{",
    ".tile{",
    ".tile-b{",
    ".cmdline{",
    ".mark{",
  ])
    assert.ok(flat.includes(sel), `rule ${sel} missing`);
});

test("Terminal style: the spec's tokens, no ledger fonts, no raw colours outside the token file", () => {
  const tokens = read("tokens.css");
  for (const [name, dark, light] of [
    ["--bg-0", "#0b0d10", "#ffffff"],
    ["--text-2", "#9aa3ad", "#5b6470"],
    ["--crit", "#ff5a5f", "#d1242f"],
    ["--warn", "#ff9f43", "#c2410c"],
    ["--att", "#f2c94c", "#9a6700"],
    ["--sel", "#4c8dff", "#1f6feb"],
  ])
    assert.ok(
      tokens.includes(`${name}: ${dark};`) && tokens.includes(`${name}: ${light};`),
      `${name} is ${dark} dark and ${light} light`,
    );
  const ui = UI.map(read).join("\n");
  assert.doesNotMatch(ui, /Garamond|Silkscreen|serif;/i, "no serif or pixel font");
  // Raw colours only in tokens.css (and the chart series, which are categories, not signals).
  const raw = ui
    .split("\n")
    .filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(l) && !/--s[1-5]|--s-other|--sel-bg/.test(l));
  assert.deepStrictEqual(raw, [], "colours come from tokens.css");
});

// Spec "Ein Schirm im CLI-Look" (stage 12.7): everything on one character grid, nothing that breaks it.
test("Character grid (rules 7, 8): one face, one size, one line; no rounding, shadow or gradient", () => {
  const ui = UI.map(read)
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [prop, ok] of [
    ["font-family", /^(?:var\(--font\)|inherit)$/],
    ["font-size", /^(?:var\(--fs\)|inherit)$/],
    ["line-height", /^(?:var\(--row\)|inherit)$/],
    ["font", /^(?:inherit|var\(--fs\) \/ var\(--row\) var\(--font\))$/],
  ] as const)
    for (const m of ui.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;}]+)`, "g")))
      assert.match(String(m[1]).trim(), ok, `${prop}: ${m[1]}`);
  assert.doesNotMatch(ui, /border-radius|gradient\(/, "no rounded corners, no gradient");
  // A 2 px edge in a signal or selection colour is a line, not a shadow.
  for (const m of ui.matchAll(/box-shadow:\s*([^;}]+)/g))
    assert.match(String(m[1]).trim(), /^inset 2px 0 0 var\(--[\w-]+\)$/, `box-shadow as an edge only: ${m[1]}`);
  assert.doesNotMatch(read("tokens.css"), /--font-text|--font-num|--fs-|--lh-|--radius|--row-compact|--row-normal/);
  assert.doesNotMatch(read("app.css"), /@fontsource\/(?!jetbrains-mono)/, "JetBrains Mono is the one face loaded");
});

/** Every rule of the UI style sheets as [selector, body], media blocks included. */
const rules = (): [string, string][] =>
  UI.flatMap((f) =>
    [...read(f).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m): [string, string] => [
      String(m[1])
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim(),
      String(m[2]),
    ]),
  );

test("Colour grammar (Recherche II): --att only marks what can be edited, hover only on rows and links", () => {
  const att = rules().filter(([, body]) => body.includes("var(--att)"));
  assert.ok(att.length > 0, "editable fields are marked");
  for (const [sel] of att)
    for (const part of sel.split(","))
      assert.match(
        part.trim(),
        /textarea|\.search|\.reply-line|\.cmdline/,
        `--att on something not editable: ${part.trim()}`,
      );
  const hover = rules()
    .flatMap(([sel]) => sel.split(","))
    .map((s) => s.trim())
    .filter((s) => s.includes(":hover"));
  assert.ok(hover.length > 0);
  for (const s of hover)
    assert.match(
      s,
      /(?:\btr|\.arow)(?:\.[\w-]+)*:hover|\.(?:link|act-link):hover/,
      `hover outside rows and links: ${s}`,
    );
  // Numbers line up in columns.
  assert.ok(
    rules().some(([sel, body]) => /\.mono/.test(sel) && body.includes("tabular-nums")),
    "mono numbers use tabular figures",
  );
});
