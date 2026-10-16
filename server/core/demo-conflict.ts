import type { ConflictHunks, ConflictView, OpenPr, PrConflict } from "../../shared/types";
import { SAME_COMMIT, type SideIn } from "./conflict";

/*
 * Invented conflicts for the demo mode: no git runs, nothing is read. billing-service has two PRs that touch the
 * same totals file and cannot be merged together; design-system has two sessions on the same file.
 */

const PR_FILES: Record<number, string[]> = {
  48: ["src/invoice/totals.ts", "src/invoice/tax.ts", "tests/tax.test.ts"],
  51: ["src/invoice/totals.ts", "src/pdf/export.ts", "src/pdf/pdfa.ts", "package.json"],
  52: ["src/pdf/export.ts", "src/pdf/zugferd.ts"],
  87: ["e2e/login.spec.ts"],
  112: ["src/import/schema.ts", "tests/schema.test.ts"],
  14: ["scripts/search-index.ts"],
  231: ["src/checkout/Checkout.tsx", "src/checkout/Summary.tsx"],
};
const PR_CONFLICTS: [number, number, string[]][] = [[48, 51, ["src/invoice/totals.ts"]]];

/** The probe result of the demo: a pair in billing-service collides, every other pair merges cleanly. */
export function demoPrConflicts(_key: string, _root: string, prs: OpenPr[]): Record<number, PrConflict[]> {
  const out: Record<number, PrConflict[]> = {};
  const here = new Set(prs.map((p) => p.number));
  for (const n of here) out[n] = [];
  for (const [x, y, files] of PR_CONFLICTS) {
    if (!here.has(x) || !here.has(y)) continue;
    out[x]?.push({ with: y, files });
    out[y]?.push({ with: x, files });
  }
  return out;
}

const filesOf = (s: SideIn) => (s.kind === "pr" ? PR_FILES[Number(s.ref.slice(3))] || [] : s.files);

export function demoConflictView(root: string, repo: string, a: SideIn, b: SideIn): ConflictView {
  const fa = filesOf(a);
  const fb = new Set(filesOf(b));
  const nums = [a, b].map((s) => (s.kind === "pr" ? Number(s.ref.slice(3)) : 0));
  const hit = PR_CONFLICTS.find(([x, y]) => nums.includes(x) && nums.includes(y));
  const sameBranch = a.kind === "session" && b.kind === "session" && !!a.branch && a.branch === b.branch;
  return {
    root,
    repo,
    a: {
      kind: a.kind,
      ref: a.ref,
      label: a.label,
      branch: a.branch,
      files: fa,
      ...(a.kind === "session" ? { status: a.status } : {}),
    },
    b: {
      kind: b.kind,
      ref: b.ref,
      label: b.label,
      branch: b.branch,
      files: [...fb],
      ...(b.kind === "session" ? { status: b.status } : {}),
    },
    shared: fa.filter((f) => fb.has(f)),
    conflicts: sameBranch ? null : hit ? hit[2] : [],
    why: sameBranch ? SAME_COMMIT() : null,
  };
}

/** Two invented hunks of the same function, one per side, so the drawer has something to set side by side. */
export function demoConflictHunks(a: SideIn, b: SideIn, file: string): ConflictHunks | null {
  const has = (s: SideIn) => filesOf(s).includes(file);
  if (!has(a) && !has(b)) return null;
  const hunk = (s: SideIn, line: string) =>
    has(s)
      ? [
          `diff --git a/${file} b/${file}`,
          `--- a/${file}`,
          `+++ b/${file}`,
          "@@ -12,6 +12,7 @@ export function total(lines: Line[]) {",
          "   const net = lines.reduce((sum, l) => sum + l.net, 0);",
          "-  const tax = Math.round(net * RATE);",
          `+  ${line}`,
          "   return { net, tax, gross: net + tax };",
          " }",
        ].join("\n")
      : null;
  return {
    file,
    a: hunk(a, "const tax = lines.reduce((sum, l) => sum + roundTax(l), 0);"),
    b: hunk(b, "const tax = taxFor(net, { mode: invoice.mode });"),
    truncated: false,
  };
}
