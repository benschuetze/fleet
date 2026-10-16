import assert from "node:assert";
import { test } from "vitest";
import type { Session } from "../../shared/types";
import { allConflicts, conflictsOf, parseConflict, parseHunks } from "./conflict";

test("Konflikt-Antwort: kaputte Felder kosten eine Zeile, nie die Schublade", () => {
  const v = parseConflict({
    root: "/w/app",
    repo: "app",
    a: { kind: "pr", ref: "pr:1", label: "#1 A", branch: "feat/a", files: ["a.ts", 7, null] },
    b: { kind: "evil", files: "nope" },
    shared: ["a.ts", { x: 1 }],
    conflicts: "ja",
    why: 42,
  });
  assert.ok(!("error" in v));
  assert.deepStrictEqual(v.a.files, ["a.ts"]);
  assert.deepStrictEqual([v.b.kind, v.b.label, v.b.files, v.b.branch], ["session", "B", [], null]);
  assert.deepStrictEqual(v.shared, ["a.ts"]);
  assert.strictEqual(v.conflicts, null, "no list means: no probe merge, not 'clean'");
  assert.strictEqual(v.why, null);
  assert.deepStrictEqual(parseConflict({ error: "Repo nicht gefunden" }), { error: "Repo nicht gefunden" });
  const empty = parseConflict(null);
  assert.ok(!("error" in empty) && empty.a.files.length === 0 && empty.shared.length === 0);
  assert.deepStrictEqual(parseHunks({ file: "a.ts", a: "@@ x", b: 3 }), {
    file: "a.ts",
    a: "@@ x",
    b: null,
    truncated: false,
  });
});

test("g k: shared files with another session first, then the PRs git cannot merge with the session's PR", () => {
  const s = {
    id: "a",
    title: "Fokusrahmen",
    project: "ds",
    repoRoot: "/w/ds",
    conflict: { with: [{ id: "b", title: "Doku" }], sameBranch: false, files: ["x.ts"] },
    ci: { pr: { number: 48 } },
  } as unknown as Session;
  const prOf = (root: string, n: number) =>
    root === "/w/ds" && n === 48 ? { number: 48, conflicts: [{ with: 51, files: ["t.ts"] }] } : undefined;
  assert.deepStrictEqual(conflictsOf(s, prOf), [
    { root: "/w/ds", a: "s:a", b: "s:b", title: "Fokusrahmen ↔ Doku" },
    { root: "/w/ds", a: "pr:48", b: "pr:51", title: "#48 ↔ #51" },
  ]);
  assert.deepStrictEqual(conflictsOf({ ...s, repoRoot: null } as unknown as Session, prOf), [], "no repo, no drawer");
  assert.deepStrictEqual(conflictsOf({ ...s, conflict: null, ci: null } as unknown as Session, prOf), []);
});

test("Palette: every known conflict once, whichever side reports it", () => {
  const a = { id: "a", title: "A", repoRoot: "/w", conflict: { with: [{ id: "b", title: "B" }] } };
  const b = { id: "b", title: "B", repoRoot: "/w", conflict: { with: [{ id: "a", title: "A" }] } };
  const repos = [
    {
      root: "/w",
      prs: {
        prs: [
          { number: 1, conflicts: [{ with: 2, files: [] }] },
          { number: 2, conflicts: [{ with: 1, files: [] }] },
        ],
      },
    },
  ];
  assert.deepStrictEqual(
    allConflicts([a, b] as unknown as Session[], repos).map((p) => p.title),
    ["A ↔ B", "#1 ↔ #2"],
  );
});
