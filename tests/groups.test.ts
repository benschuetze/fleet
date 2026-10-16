// "Doppelt" should only flag sessions the user really juggles, never the ones Fleet itself replaced.
import assert from "node:assert";
import { test } from "vitest";
import { findDuplicates, markConflicts, titleKey } from "../server/core/groups";
import type { GitInfo, Session } from "../shared/types";

const NOW = Date.UTC(2026, 9, 14, 10);
const repos = new Map<string, GitInfo>([["/w/app", { name: "app" } as GitInfo]]);
const s = (id: string, title: string, status: Session["status"], extra: Partial<Session> = {}): Session =>
  ({
    id,
    title,
    status,
    source: "local",
    repoRoot: "/w/app",
    lastActivity: NOW - 10 * 60e3,
    ...extra,
  }) as Session;

test("Eine von Fleet abgelöste Session zählt nicht als doppelt, auch ohne gespeicherte Verknüpfung", () => {
  // Reported: after "Frisch starten" the dashboard said "2 Sessions arbeiten am selben Repo"
  const list = [
    s("new-1", "Checkout", "working"),
    s("old-1", "Checkout · abgelöst 14.10.", "waiting"),
    s("old-2", "Checkout · replaced 13/10", "idle"),
    s("old-3", "Checkout · zusammengefasst 14.10.", "waiting"),
  ];
  assert.deepStrictEqual(findDuplicates(list, repos, NOW, new Set()), []);
});

test("Wer seine Übergabe geschrieben hat und auf die neue Session wartet, zählt nicht", () => {
  const list = [s("new-1", "Checkout", "working"), s("old-1", "Checkout", "waiting")];
  assert.deepStrictEqual(findDuplicates(list, repos, NOW, new Set(["old-1"])), []);
});

test("Zwei Sessions im selben Repo ohne gemeinsame Dateien, Branch oder Auftrag sind kein Doppelt", () => {
  // Reported: "Doppelt" for every pair in a repo, even when the two had nothing to do with each other
  const d = findDuplicates(
    [
      s("a", "Checkout", "working", { branch: "feat/a", edited: ["/w/app/a.ts"] }),
      s("b", "Suche", "waiting", { branch: "feat/b", edited: ["/w/app/b.ts"] }),
    ],
    repos,
    NOW,
    new Set(),
  );
  assert.deepStrictEqual(d, []);
});

test("Doppelt mit Grund: gleiche Dateien vor gleichem Branch vor gleichem Auftrag", () => {
  const files = findDuplicates(
    [
      s("a", "Checkout", "working", { branch: "main", edited: ["/w/app/src/x.ts", "/w/app/src/y.ts"], cwd: "/w/app" }),
      s("b", "Suche", "waiting", { branch: "main", edited: ["/w/app/src/x.ts"], cwd: "/w/app" }),
    ],
    repos,
    NOW,
    new Set(),
  );
  assert.deepStrictEqual(
    files.map((d) => [d.reason, d.overlap, d.files, d.pairs, d.branch, d.sessions.map((x) => [x.id, x.status, x.cwd])]),
    [
      [
        "files",
        true,
        ["src/x.ts"],
        [["a", "b"]],
        "main",
        [
          ["a", "working", "/w/app"],
          ["b", "waiting", "/w/app"],
        ],
      ],
    ],
  );
  const branch = findDuplicates(
    [s("a", "Checkout", "working", { branch: "feat/x" }), s("b", "Suche", "waiting", { branch: "feat/x" })],
    repos,
    NOW,
    new Set(),
  );
  // Same branch, no shared file: listed, but grey as parallel without overlap, nothing for the conflict drawer
  assert.deepStrictEqual(
    branch.map((d) => [d.reason, d.branch, d.overlap, d.pairs]),
    [["branch", "feat/x", false, []]],
  );
  // The start time Fleet appends to equal titles does not hide the same task
  const title = findDuplicates(
    [
      s("a", "Eitplanken-Aufträge  Guardrails · 14.10., 09:12", "working"),
      s("b", "eitplanken-aufträge guardrails · 14.10., 10:40", "waiting"),
    ],
    repos,
    NOW,
    new Set(),
  );
  assert.deepStrictEqual(
    title.map((d) => [d.reason, d.overlap]),
    [["title", false]],
  );
});

test("Doppelt nur mit Dateischnitt: gleicher Branch und Auftrag ohne gemeinsame Datei bleiben parallel", () => {
  // Spec, Konflikt-Visualisierung: "Doppelt nur melden, wenn der Dateischnitt nicht leer ist"
  const d = findDuplicates(
    [
      s("a", "Checkout", "working", { branch: "feat/x", edited: ["/w/app/a.ts"] }),
      s("b", "Checkout", "waiting", { branch: "feat/x", edited: ["/w/app/b.ts"] }),
    ],
    repos,
    NOW,
    new Set(),
  );
  assert.deepStrictEqual(
    d.map((x) => [x.overlap, x.files, x.pairs]),
    [[false, [], []]],
  );
});

test("Konflikt-Markierung an der Session nur bei gemeinsamen Dateien, nicht schon beim gleichen Branch", () => {
  const a = s("a", "Checkout", "working", { branch: "feat/x", edited: ["/w/app/a.ts"] });
  const b = s("b", "Suche", "working", { branch: "feat/x", edited: ["/w/app/b.ts"] });
  markConflicts([a, b], NOW);
  assert.strictEqual(a.conflict, undefined, "same branch alone is no conflict");
  const c = s("c", "Checkout", "working", { branch: "feat/x", edited: ["/w/app/src/x.ts"] });
  const e = s("e", "Suche", "waiting", { branch: "feat/x", edited: ["/w/app/src/x.ts", "/w/app/y.ts"] });
  markConflicts([c, e], NOW);
  assert.deepStrictEqual(c.conflict, {
    with: [{ id: "e", title: "Suche" }],
    sameBranch: true,
    files: ["src/x.ts"],
  });
  assert.deepStrictEqual(e.conflict?.with, [{ id: "c", title: "Checkout" }]);
});

test("Konflikt über Checkouts hinweg (6.1.0): Hauptordner und Worktree desselben Remotes, dieselbe Datei", () => {
  const remote = { provider: "github", host: "github.com", path: "o/app", repo: "app" } as Session["remote"];
  const a = s("a", "Checkout", "working", { remote, edited: ["/w/app/src/cart.ts"] });
  const b = s("b", "Rabatt", "working", {
    remote,
    repoRoot: "/w/app.wt/rabatt-1a2b",
    edited: ["/w/app.wt/rabatt-1a2b/src/cart.ts", "/w/app/README.md"],
  });
  // Another repo with the same relative file is no conflict.
  const c = s("c", "Fremd", "working", { repoRoot: "/w/other", edited: ["/w/other/src/cart.ts"] });
  markConflicts([a, b, c], NOW);
  assert.deepStrictEqual(a.conflict?.with, [{ id: "b", title: "Rabatt" }]);
  assert.deepStrictEqual(b.conflict?.files, ["src/cart.ts"]);
  assert.strictEqual(c.conflict, undefined);
});

test("Doppelt: A teilt mit B, B mit C – eine Gruppe; ohne Branch- oder Dateiangabe keine", () => {
  const d = findDuplicates(
    [
      s("a", "A", "working", { edited: ["/w/app/1.ts"] }),
      s("b", "B", "waiting", { edited: ["/w/app/1.ts", "/w/app/2.ts"] }),
      s("c", "C", "waiting", { edited: ["/w/app/2.ts"] }),
      s("d", "D", "waiting"),
    ],
    repos,
    NOW,
    new Set(),
  );
  assert.strictEqual(d.length, 1);
  assert.deepStrictEqual(d[0]?.sessions.map((x) => x.id).sort(), ["a", "b", "c"]);
  assert.deepStrictEqual(d[0]?.files.sort(), ["1.ts", "2.ts"]);
});

test("Titel-Schlüssel: Groß/klein, Leerraum und Fleets Zusätze zählen nicht", () => {
  assert.strictEqual(titleKey("Checkout  Umbau · 14.10., 09:12"), "checkout umbau");
  assert.strictEqual(titleKey("Checkout Umbau · abgelöst 14.10."), "checkout umbau");
  assert.strictEqual(titleKey("Checkout Umbau · 14/10, 09:12"), "checkout umbau");
});

test("Eine seit Stunden unberührte Session neben einer arbeitenden ist kein Doppelt", () => {
  // Seen live: sessions from earlier fresh starts, waiting for hours, kept the hint up all day
  const list = [s("now", "Checkout", "working"), s("old", "Checkout", "waiting", { lastActivity: NOW - 150 * 60e3 })];
  assert.deepStrictEqual(findDuplicates(list, repos, NOW, new Set()), []);
});
