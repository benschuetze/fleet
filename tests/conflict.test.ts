// Conflict view (spec, Konflikt-Visualisierung): what two sessions or PRs both change, and where git cannot merge
// them. Real git in a temporary repo, no network, nothing fetched.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { conflictSentence } from "../app/lib/conflict";
import {
  changedFiles,
  conflictHunks,
  conflictView,
  defaultBase,
  mergeProbe,
  prConflicts,
  probePrs,
  resolveRef,
  type SideIn,
} from "../server/core/conflict";
import { conflictSummary, conflictTree } from "../shared/conflict";
import type { OpenPr } from "../shared/types";

let root = "";
let tree = "";
const g = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=fleet@example.com", "-c", "user.name=Fleet Test", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

beforeAll(() => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conflict-")));
  root = path.join(tmp, "repo");
  fs.mkdirSync(root);
  g(root, "init", "-q", "-b", "main");
  write(root, "server/http/security.ts", "a\nb\nc\n");
  write(root, "server/http/api.ts", "1\n2\n3\n");
  write(root, "README.md", "readme\n");
  g(root, "add", ".");
  g(root, "commit", "-qm", "base");
  // feat/a and feat/b change the same line of security.ts; feat/c only touches api.ts and docs.
  g(root, "checkout", "-qb", "feat/a");
  write(root, "server/http/security.ts", "A\nb\nc\n");
  write(root, "server/http/api.ts", "1\n2\n3\n4\n");
  g(root, "commit", "-qam", "a");
  g(root, "checkout", "-q", "main");
  g(root, "checkout", "-qb", "feat/b");
  write(root, "server/http/security.ts", "B\nb\nc\n");
  write(root, "docs/b.md", "b\n");
  g(root, "add", ".");
  g(root, "commit", "-qm", "b");
  g(root, "checkout", "-q", "main");
  g(root, "checkout", "-qb", "feat/c");
  write(root, "docs/c.md", "c\n");
  g(root, "add", ".");
  g(root, "commit", "-qm", "c");
  g(root, "checkout", "-q", "main");
  // A second session works in a worktree of feat/c and has an uncommitted edit of security.ts.
  tree = path.join(tmp, "repo-c");
  g(root, "worktree", "add", "-q", tree, "feat/c");
  tree = fs.realpathSync.native(tree);
  write(tree, "server/http/security.ts", "a\nb\nC\n");
  // Git on the Windows runner needs more than vitest's 10 s for this setup (CI, 15 Oct).
}, 60_000);
afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

const pr = (number: number, head: string, o: Partial<OpenPr> = {}): OpenPr => ({
  number,
  title: `PR ${number}`,
  url: null,
  draft: false,
  base: "main",
  head,
  ci: "success",
  failed: [],
  review: null,
  onDefault: true,
  stackedOn: null,
  ...o,
});
const prSide = (p: OpenPr): SideIn => ({
  kind: "pr",
  ref: `pr:${p.number}`,
  label: p.title,
  branch: p.head,
  base: p.base,
});

test("Probe-Merge: gleiche Zeile in zwei Branches ist ein echter Konflikt, getrennte Dateien nicht", async () => {
  const a = (await resolveRef(root, "feat/a", "remote")) as string;
  const b = (await resolveRef(root, "feat/b", "local")) as string;
  const c = (await resolveRef(root, "feat/c", "remote")) as string;
  assert.match(a, /^[0-9a-f]{40}$/, "without a remote branch the local one counts");
  assert.deepStrictEqual(await mergeProbe(root, a, b), { files: ["server/http/security.ts"] });
  assert.deepStrictEqual(await mergeProbe(root, a, c), { files: [] });
  assert.deepStrictEqual(await mergeProbe(root, "--output=x", c), { error: "ref" }, "only SHAs reach git");
  assert.strictEqual(await resolveRef(root, "--upload-pack=x", "local"), null, "no option injection");
  assert.strictEqual(await resolveRef(root, "gibt-es-nicht", "remote"), null);
  assert.deepStrictEqual(await defaultBase(root), { name: "main", sha: g(root, "rev-parse", "main") });
  assert.deepStrictEqual((await changedFiles(root, g(root, "rev-parse", "main"), a))?.sort(), [
    "server/http/api.ts",
    "server/http/security.ts",
  ]);
});

test("PR-Paare: Konflikt an beiden PRs, ein sauberes Paar und ein PR ohne lokalen Branch bleiben ohne", async () => {
  const prs = [pr(1, "feat/a"), pr(2, "feat/b"), pr(3, "feat/c"), pr(4, "nur-auf-github")];
  assert.deepStrictEqual(await probePrs(root, prs), {
    1: [{ with: 2, files: ["server/http/security.ts"] }],
    2: [{ with: 1, files: ["server/http/security.ts"] }],
    3: [],
  });
  // In the overview: nothing until the first probe is done, then the result; in the background, one at a time.
  assert.strictEqual(prConflicts("test/repo", root, prs), null);
  let r: ReturnType<typeof prConflicts> = null;
  for (let i = 0; i < 100 && !r; i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = prConflicts("test/repo", root, prs);
  }
  assert.deepStrictEqual(r?.[1], [{ with: 2, files: ["server/http/security.ts"] }]);
});

test("Konflikt-Ansicht für zwei PRs: Dateischnitt, echter Konflikt, Hunks beider Seiten", async () => {
  const a = prSide(pr(1, "feat/a"));
  const b = prSide(pr(2, "feat/b"));
  const v = await conflictView(root, "repo", a, b);
  assert.deepStrictEqual(v.a.files.sort(), ["server/http/api.ts", "server/http/security.ts"]);
  assert.deepStrictEqual(v.b.files.sort(), ["docs/b.md", "server/http/security.ts"]);
  assert.deepStrictEqual(v.shared, ["server/http/security.ts"]);
  assert.deepStrictEqual(v.conflicts, ["server/http/security.ts"]);
  assert.strictEqual(v.why, null);
  const h = await conflictHunks(root, a, b, "server/http/security.ts");
  assert.match(h?.a || "", /^-a\n\+A$/m);
  assert.match(h?.b || "", /^-a\n\+B$/m);
  // A file only one side changed: the other side has no diff.
  const one = await conflictHunks(root, a, b, "docs/b.md");
  assert.strictEqual(one?.a, null);
  assert.match(one?.b || "", /\+b/);
  // Files outside both lists never reach git.
  assert.strictEqual(await conflictHunks(root, a, b, "../../etc/passwd"), null);
  assert.strictEqual(await conflictHunks(root, a, b, "README.md"), null);
});

test("Konflikt-Ansicht für zwei Sessions: Dateischnitt aus dem Transcript, Hunks aus dem Arbeitsstand", async () => {
  write(root, "server/http/security.ts", "a\nB2\nc\n");
  try {
    const a: SideIn = {
      kind: "session",
      ref: "s:a",
      label: "Härtung",
      branch: "main",
      dir: root,
      files: ["server/http/security.ts"],
    };
    const b: SideIn = {
      kind: "session",
      ref: "s:b",
      label: "Doku",
      branch: "feat/c",
      dir: tree,
      files: ["server/http/security.ts", "docs/c.md"],
    };
    const v = await conflictView(root, "repo", a, b);
    assert.deepStrictEqual(v.shared, ["server/http/security.ts"]);
    // Session A works on main itself: there is no branch to merge, only the shared files count.
    assert.strictEqual(v.conflicts, null);
    assert.match(v.why || "", /eigenen Branch|own branch/);
    const h = await conflictHunks(root, a, b, "server/http/security.ts");
    assert.match(h?.a || "", /^\+B2$/m, "uncommitted edits count");
    assert.match(h?.b || "", /^\+C$/m, "the worktree's own state");
  } finally {
    g(root, "checkout", "--", "server/http/security.ts");
  }
});

test("Ordnerbaum: nur Ordner mit Dateien beider Seiten offen, einzelne Unterordner zusammengezogen", () => {
  const t = conflictTree(
    ["server/http/security.ts", "server/http/api.ts", "app/x.tsx"],
    ["server/http/security.ts", "docs/b.md"],
    ["server/http/security.ts"],
  );
  assert.deepStrictEqual(
    t.dirs.map((d) => [d.name, d.open, d.count, d.both]),
    [
      ["app", false, 1, 0],
      ["docs", false, 1, 0],
      ["server/http", true, 2, 1],
    ],
  );
  const http = t.dirs[2];
  assert.deepStrictEqual(
    http?.files.map((f) => [f.name, f.a, f.b, f.conflict]),
    [
      ["api.ts", true, false, false],
      ["security.ts", true, true, true],
    ],
  );
});

test("Satz oben: Zahl, gemeinsamer Ordner und echter Konflikt; ohne Schnitt parallel", () => {
  const de = (x: string) => x;
  assert.deepStrictEqual(conflictSummary(["server/http/a.ts", "server/http/b/c.ts"], ["server/http/a.ts"]), {
    shared: 2,
    dir: "server/http/",
    conflicts: 1,
    first: "a.ts",
  });
  assert.strictEqual(
    conflictSentence(
      {
        shared: ["server/http/a.ts", "server/http/b.ts", "server/http/security.ts"],
        conflicts: ["server/http/security.ts"],
      },
      de,
    ),
    "3 Dateien in server/http/ von beiden geändert, 1 echter Merge-Konflikt in security.ts.",
  );
  assert.strictEqual(
    conflictSentence({ shared: ["a.ts"], conflicts: [] }, de),
    "1 Datei von beiden geändert, git führt sie ohne Konflikt zusammen.",
  );
  assert.strictEqual(
    conflictSentence({ shared: [], conflicts: null }, de),
    "Parallel, ohne Überschneidung: keine Datei von beiden geändert.",
  );
});
