import type { DiffFile, DiffView, FileView, Session } from "../../shared/types";
import { DEMO_FILES, demoLogSessions } from "./demo";

/**
 * The diff view in demo mode: invented changes, nothing read from disk. The cart session shows the cart fix; every
 * other session shows a change in the files it edits in the demo log, about its own task (practical test 15 Oct: the
 * checkout session's diff was the cart rounding).
 */

const CART = `import { formatCents } from "./money";

export interface Line {
  sku: string;
  qty: number;
  cents: number;
}

/** The cart total in cents: summed as integers, rounded once at the end. */
export function total(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.cents, 0);
}

export function label(lines: Line[]): string {
  return formatCents(total(lines));
}
`;

const TEST = `import { expect, test } from "vitest";
import { total } from "./cart";

test("three items at 0.10 make 0.30, not 0.30000000000000004", () => {
  expect(total([{ sku: "a", qty: 3, cents: 10 }])).toBe(30);
});
`;

const lines = (text: string) => text.replace(/\n$/, "").split("\n");

function added(path: string, text: string, mine: boolean): DiffFile {
  const all = lines(text);
  return {
    path,
    old: null,
    status: "A",
    add: all.length,
    del: 0,
    mine,
    binary: false,
    cut: false,
    hunks: [
      { header: `@@ -0,0 +1,${all.length} @@`, lines: all.map((t, i) => ({ t: "+", a: null, b: i + 1, text: t })) },
    ],
  };
}

/** The files a demo session edits (demo-log.ts uses the same list); none for the cart session, it has the cart fix. */
function editsOf(s: Session): string[] {
  if (/Warenkorb|cart/i.test(String(s.title || ""))) return [];
  const d = demoLogSessions().find((x) => x.id === s.id);
  // The same files its conversation and log edit (DEMO_FILES when it has no list of its own).
  return d?.edits.length ? d.edits : DEMO_FILES;
}

/** The new text of an invented file: one function that now does the session's task. */
function fileText(p: string, task: string): string {
  const name = (p.split("/").pop() || "index").replace(/\.[^.]+$/, "").replace(/[^\w]/g, "") || "main";
  return `// ${task}\nexport function ${name}() {\n  return next();\n}\n`;
}

function changed(p: string, task: string): DiffFile {
  const name = (p.split("/").pop() || "index").replace(/\.[^.]+$/, "").replace(/[^\w]/g, "") || "main";
  return {
    path: p,
    old: null,
    status: "M",
    add: 2,
    del: 1,
    mine: true,
    binary: false,
    cut: false,
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { t: "+", a: null, b: 1, text: `// ${task}` },
          { t: " ", a: 1, b: 2, text: `export function ${name}() {` },
          { t: "-", a: 2, b: null, text: "  return legacy();" },
          { t: "+", a: null, b: 3, text: "  return next();" },
          { t: " ", a: 3, b: 4, text: "}" },
        ],
      },
    ],
  };
}

export function demoDiff(s: Session): DiffView {
  // A session that changes no code has nothing to show (its conversation has no edit either), nor has the one in the
  // loop (it only reruns the failing test), nor one with no steps of its own, as a Cowork session (round 7:
  // src/index.ts "by this session", never edited).
  const d = demoLogSessions().find((x) => x.id === s.id);
  if (!d || d.readOnly || d.loop)
    return {
      root: s.repoRoot || s.cwd || "/home/demo/projects/shop",
      branch: s.branch || null,
      base: "main",
      files: [],
      cut: false,
      error: null,
    };
  const edits = editsOf(s);
  if (edits.length) {
    // The diff is the checkout's (README): every session in it adds its files, only its own are marked (round 4: the
    // neighbour's file was missing and a shared one stood as "by this session" only).
    const me = demoLogSessions().find((x) => x.id === s.id);
    const near = demoLogSessions().filter((x) => me && x.id !== s.id && x.cwd === me.cwd && !x.readOnly);
    const all = [...new Set([...edits, ...near.flatMap((x) => (x.edits.length ? x.edits : DEMO_FILES))])].sort();
    const own = new Set(edits);
    return {
      root: s.repoRoot || s.cwd || "/home/demo/projects/shop",
      branch: s.branch || null,
      base: "main",
      // Its own files first, as in the real diff (round 6: docs/tokens.md of the neighbour stood on top).
      files: all
        .map((p) => ({ ...changed(p, String(s.title || "")), mine: own.has(p) }))
        .sort((x, y) => Number(y.mine) - Number(x.mine) || x.path.localeCompare(y.path)),
      cut: false,
      error: null,
    };
  }
  const cart: DiffFile = {
    path: "src/cart.ts",
    old: null,
    status: "M",
    add: 3,
    del: 2,
    mine: true,
    binary: false,
    cut: false,
    hunks: [
      {
        header: "@@ -8,7 +8,8 @@ export interface Line {",
        lines: [
          { t: " ", a: 8, b: 8, text: "}" },
          { t: " ", a: 9, b: 9, text: "" },
          { t: "-", a: 10, b: null, text: "export function total(lines: Line[]): number {" },
          {
            t: "-",
            a: 11,
            b: null,
            text: "  return lines.reduce((sum, l) => sum + l.qty * (l.cents / 100), 0) * 100;",
          },
          {
            t: "+",
            a: null,
            b: 10,
            text: "/** The cart total in cents: summed as integers, rounded once at the end. */",
          },
          { t: "+", a: null, b: 11, text: "export function total(lines: Line[]): number {" },
          { t: "+", a: null, b: 12, text: "  return lines.reduce((sum, l) => sum + l.qty * l.cents, 0);" },
          { t: " ", a: 12, b: 13, text: "}" },
          { t: " ", a: 13, b: 14, text: "" },
          { t: " ", a: 14, b: 15, text: "export function label(lines: Line[]): string {" },
        ],
      },
    ],
  };
  const readme: DiffFile = {
    path: "README.md",
    old: null,
    status: "M",
    add: 1,
    del: 0,
    mine: false,
    binary: false,
    cut: false,
    hunks: [
      {
        header: "@@ -20,3 +20,4 @@ ## Money",
        lines: [
          { t: " ", a: 20, b: 20, text: "Amounts are integers in cents." },
          { t: "+", a: null, b: 21, text: "The cart sums cents and rounds once, at the end." },
          { t: " ", a: 21, b: 22, text: "" },
        ],
      },
    ],
  };
  return {
    root: s.repoRoot || s.cwd || "/home/demo/projects/shop",
    branch: s.branch || null,
    base: "main",
    files: [cart, added("src/cart.test.ts", TEST, true), readme],
    cut: false,
    error: null,
  };
}

export function demoFile(p: string, s?: Session): FileView | null {
  const text =
    p === "src/cart.ts"
      ? CART
      : p === "src/cart.test.ts"
        ? TEST
        : p === "README.md"
          ? "# Shop\n"
          : s && editsOf(s).includes(p)
            ? fileText(p, String(s.title || ""))
            : null;
  return text === null ? null : { path: p, text, binary: false, cut: false, missing: false, size: text.length };
}
