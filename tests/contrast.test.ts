// Light mode, checked (spec, "Hell-Modus prüfen"): the review had only looked at dark. axe sees the page at rest;
// these checks also cover the hovered and the selected row, where signal text used to fall below 4.5:1 in light.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { ROOT } from "./helpers/server";

const read = (f: string) => fs.readFileSync(path.join(ROOT, "app", f), "utf8");
const tokens = read("tokens.css");

type Rgb = [number, number, number];
type Theme = Record<string, Rgb | [number, number, number, number]>;

/** The custom properties with a literal colour in one block of tokens.css. */
function block(start: string): Theme {
  const at = tokens.indexOf(start);
  assert.ok(at >= 0, `block ${start} exists`);
  const body = tokens.slice(at, tokens.indexOf("}", at));
  const out: Theme = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6}|rgba\([^)]*\))\s*;/gi)) {
    const v = String(m[2]);
    out[String(m[1])] = v.startsWith("#")
      ? ([1, 3, 5].map((i) => Number.parseInt(v.slice(i, i + 2), 16)) as Rgb)
      : (v
          .slice(5, -1)
          .split(",")
          .map((x) => Number(x.trim())) as [number, number, number, number]);
  }
  return out;
}

const dark = block(":root {");
const light = { ...dark, ...block(':root[data-theme="light"] {') };
const lightMedia = block(':root:not([data-theme="dark"]) {');

const lum = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** The backgrounds a row can have: the page, a zone, a hovered row, a selected row (--sel-bg over a zone). */
function grounds(th: Theme): Record<string, Rgb> {
  const sel = th["--sel-bg"] as [number, number, number, number];
  const bg1 = th["--bg-1"] as Rgb;
  const a = sel[3];
  return {
    "--bg-0": th["--bg-0"] as Rgb,
    "--bg-1": bg1,
    "--bg-2": th["--bg-2"] as Rgb,
    "--sel-bg": bg1.map((v, i) => v * (1 - a) + (sel[i] as number) * a) as Rgb,
  };
}

test("Light tokens: the system preference and the explicit choice are the same colours", () => {
  assert.deepStrictEqual(lightMedia, block(':root[data-theme="light"] {'));
});

for (const [name, th] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`Contrast in ${name}: text 4.5:1 on every row background, shapes 3:1`, () => {
    const bg = grounds(th);
    const fails: string[] = [];
    const need = (fg: string, min: number, on: string[]) => {
      for (const g of on) {
        const r = ratio(th[fg] as Rgb, bg[g] as Rgb);
        if (r < min) fails.push(`${fg} on ${g}: ${r.toFixed(2)} < ${min}`);
      }
    };
    const rows = ["--bg-0", "--bg-1", "--bg-2", "--sel-bg"];
    // Text that is read anywhere, and signal text inside rows (alarm kind, "CI red").
    for (const fg of ["--text-1", "--text-2", "--crit-text", "--warn-text"]) need(fg, 4.5, rows);
    // Signal text outside rows, and the marked editable fields: on the page and in zones.
    for (const fg of ["--crit", "--warn", "--att"]) need(fg, 4.5, ["--bg-0", "--bg-1"]);
    // Shapes: the 2 px edges, the bars, the focus ring and the active tile frame.
    for (const fg of ["--text-1", "--crit", "--warn", "--sel"]) need(fg, 3, rows);
    assert.deepStrictEqual(fails, []);
  });
}

test("Signal text inside rows uses the row tokens, never plain --crit or --warn", () => {
  // Every UI sheet: row rules live in rows.css and screen.css now, not only in the old leitstand.css.
  const css = fs
    .readdirSync(path.join(ROOT, "app"))
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map(read)
    .join("\n");
  const bad = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /(?:^|[;\s])color:\s*var\(--(?:crit|warn)\)/.test(String(body)))
    .map(([, sel]) =>
      String(sel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim(),
    )
    // `.sig` but not `.sig-crit`: log lines have no row background, plain signal colours stay readable there.
    .filter((sel) => /\.arow|\btr\b|\.wtable|\.sig(?![\w-])|\.b-row|\.a-k/.test(sel));
  assert.deepStrictEqual(bad, []);
});

/** Hue 0–360 and saturation 0–1 (HSL). */
function hsl([r, g, b]: Rgb): { h: number; s: number } {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}

// Log view (stage 11): the session tags are the one exception to the grey rule. They must be readable and must not
// look like a signal: cyan, violet, magenta, pink or sand, never red, orange, yellow, green or the selection blue.
for (const [name, th] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`Log tags in ${name}: ten colours, text 4.5:1 on page and zone, no signal hue`, () => {
    const tags = Object.keys(th).filter((k) => /^--log-\d+$/.test(k));
    assert.strictEqual(tags.length, 10);
    const bg = grounds(th);
    const sel = hsl(th["--sel"] as Rgb).h;
    const fails: string[] = [];
    for (const k of tags) {
      const c = th[k] as Rgb;
      for (const g of ["--bg-0", "--bg-1"]) {
        const r = ratio(c, bg[g] as Rgb);
        if (r < 4.5) fails.push(`${k} on ${g}: ${r.toFixed(2)}`);
      }
      const { h, s } = hsl(c);
      const cyan = h >= 170 && h <= 200;
      const violetToPink = h >= 245 && h <= 340;
      // Sand: a pale, greyish yellow-brown; saturated, it would be --att or --warn.
      const sand = h >= 25 && h <= 55 && s < 0.45;
      if (!(cyan || violetToPink || sand)) fails.push(`${k}: hue ${h.toFixed(0)} is no tag hue`);
      if (Math.abs(h - sel) < 25) fails.push(`${k}: too close to --sel`);
    }
    assert.deepStrictEqual(fails, []);
  });
}

// The diff view (release 6): added and removed text stays readable on its own tinted line over the page.
for (const [name, th] of [
  ["dark", dark],
  ["light", light],
  ["light (system)", { ...dark, ...lightMedia }],
] as const)
  test(`Diff lines in ${name}: + and − text 4.5:1 on their tinted line`, () => {
    const page = th["--bg-0"] as Rgb;
    for (const k of ["add", "del"]) {
      const tint = th[`--diff-${k}-bg`] as [number, number, number, number];
      const a = tint[3];
      const ground = page.map((v, i) => v * (1 - a) + (tint[i] as number) * a) as Rgb;
      const r = ratio(th[`--diff-${k}`] as Rgb, ground);
      assert.ok(r >= 4.5, `--diff-${k} on its line: ${r.toFixed(2)}`);
    }
  });
