// Stage 6 (spec, Reihenfolge): the repo bar as a filter and the event stream. Both read the same inbox as the
// alarm zone, so waiting and failing sessions count the same everywhere, and every signal stands once.
import assert from "node:assert";
import { test } from "vitest";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview } from "../server/core/overview";
import { inbox } from "../shared/inbox";
import { findRepo, inRepo, narrow, repoBar } from "../shared/repobar";
import { stateChanges } from "../shared/stream";
import type { Decision, FleetEvent, OpenPr, Repo, Session } from "../shared/types";

const s = (id: string, status: Session["status"], repoRoot: string | null, extra: Partial<Session> = {}): Session => ({
  id,
  source: "local",
  status,
  repoRoot,
  meta: {},
  ...extra,
});
const remote = (name: string) => ({
  provider: "github" as const,
  trusted: true,
  host: "github.com",
  repo: name,
  path: `example/${name}`,
  webUrl: `https://github.com/example/${name}`,
});
const pr = (number: number, ci: OpenPr["ci"], draft = false): OpenPr => ({
  number,
  title: `PR ${number}`,
  url: null,
  draft,
  base: "main",
  head: `b${number}`,
  ci,
  failed: [],
  review: null,
  onDefault: true,
  stackedOn: null,
});
const repo = (root: string, name: string, sessions: string[], extra: Partial<Repo> = {}): Repo => ({
  root,
  name,
  branch: "main",
  dirty: 0,
  remote: remote(name),
  lastCommit: null,
  behind: 0,
  ahead: 0,
  hasUpstream: true,
  sessions,
  ...extra,
});

test("Repo bar: waiting and failing sessions count like in the alarm zone, each session in exactly one counter", () => {
  const sessions = [
    s("ask", "needs_input", "/r/shop"),
    s("err", "error", "/r/shop"),
    s("stale", "stale", "/r/shop"),
    s("work", "working", "/r/shop"),
    s("done", "waiting", "/r/shop"),
    s("rest", "idle", "/r/shop"),
    // Replaced: waits for nobody anymore and is no alarm, not in the repo bar either
    s("old", "error", "/r/shop", { next: { id: "work", title: null } }),
    s("gone", "ended", "/r/shop"),
    s("hidden", "needs_input", "/r/shop", { meta: { hidden: true } }),
    s("asked", "working", "/r/shop"),
  ];
  const decision = { id: "d1", sessionId: "asked", status: "open" } as Decision;
  const repos = [
    repo(
      "/r/shop",
      "shop",
      sessions.map((x) => x.id),
    ),
  ];
  const ib = inbox({ sessions, repos, decisions: [decision] });
  const [e] = repoBar(repos, ib);
  // Fleet's own question waits for you too: two waiting, counted once each
  assert.deepStrictEqual(e?.counts, { needs: 2, errors: 2, working: 1, done: 1, resting: 1 });
  assert.strictEqual(e?.counts.needs, ib.counts.needs);
  assert.strictEqual(e?.counts.errors, ib.counts.errors);
});

test("Repo bar: worktrees of one remote are one entry, a PR stands there once", () => {
  const sessions = [s("a", "working", "/r/shop"), s("b", "waiting", "/r/.wt/x/shop")];
  const repos = [
    repo("/r/.wt/x/shop", "shop", ["b"], { dirty: 2, prs: { prs: [pr(11, "failure")] } }),
    repo("/r/shop", "shop", ["a"], { dirty: 1, prs: { prs: [pr(11, "failure"), pr(12, "success")] } }),
    repo("/r/local", "local", [], { remote: null, dirty: null }),
  ];
  const bar = repoBar(repos, inbox({ sessions, repos }));
  const shop = findRepo(bar, "shop");
  assert.ok(shop);
  assert.deepStrictEqual(
    shop.prs.map((p) => p.number),
    [11, 12],
  );
  assert.strictEqual(shop.dirty, 3, "changed files over all checkouts");
  assert.strictEqual(shop.root, "/r/.wt/x/shop", "both folders carry the name: the first one is used");
  assert.deepStrictEqual(shop.counts, { needs: 0, errors: 0, working: 1, done: 1, resting: 0 });
  const local = findRepo(bar, "local");
  assert.strictEqual(local?.dirty, null, "unknown stays unknown, never 0");
  assert.strictEqual(local?.quiet, true);
  assert.deepStrictEqual(
    bar.map((x) => x.name),
    ["shop", "local"],
    "quiet repos last",
  );
});

test("Repo bar: what needs a decision comes first, then work; by name within", () => {
  const sessions = [
    s("1", "waiting", "/r/a"),
    s("2", "working", "/r/b"),
    s("3", "needs_input", "/r/c"),
    s("4", "error", "/r/d"),
    s("5", "idle", "/r/e"),
  ];
  const repos = ["a", "b", "c", "d", "e", "f"].map((n, i) => repo(`/r/${n}`, n, [String(i + 1)]));
  assert.deepStrictEqual(
    repoBar(repos, inbox({ sessions, repos })).map((x) => x.name),
    ["c", "d", "b", "a", "e", "f"],
  );
});

test("Repo filter: narrows the watch board, never the alarm zone; an unknown name filters nothing", () => {
  const sessions = [
    s("a-work", "working", "/r/a"),
    s("a-ask", "needs_input", "/r/a"),
    s("b-work", "working", "/r/b"),
    s("b-err", "error", "/r/b"),
    s("cowork", "working", null),
  ];
  const repos = [repo("/r/a", "a", ["a-work", "a-ask"]), repo("/r/b", "b", ["b-work", "b-err"])];
  const ib = inbox({ sessions, repos });
  const bar = repoBar(repos, ib);
  const a = findRepo(bar, "a");
  const n = narrow(ib, a);
  assert.deepStrictEqual(
    n.working.map((x) => x.id),
    ["a-work"],
  );
  // An alarm in another repo stays where it is
  assert.deepStrictEqual(
    n.errors.map((x) => x.id),
    ["b-err"],
  );
  assert.deepStrictEqual(n.counts, ib.counts, "the header counters do not change with the filter");
  assert.strictEqual(findRepo(bar, "nope"), null);
  assert.strictEqual(narrow(ib, null), ib);
  assert.ok(inRepo(null, { repoRoot: null }));
  assert.ok(!inRepo(a, { repoRoot: null }), "a session without a repo is in no repo");
});

test("Event stream: only changes of state, newest first; unchecked lines cost themselves, nothing else", () => {
  const ev = (at: number, sessionId: string, status: string, event = "x", detail = ""): FleetEvent =>
    ({ at, sessionId, status, event, detail, cwd: "/r/a" }) as FleetEvent;
  const events = [
    ev(1, "s1", "working", "UserPromptSubmit", "Baue X"),
    ev(2, "s1", "working", "PreCompact"),
    ev(3, "s1", "needs_input", "PermissionRequest", "Freigabe für Bash"),
    ev(4, "s1", "working", "PostToolUse"),
    ev(5, "s2", "error", "StopFailure", "x".repeat(500)),
    ev(6, "s1", "waiting", "Stop"),
    ev(7, "s1", "waiting", "Stop"),
    ev(8, "../etc", "error"),
    ev(9, "s3", "bogus"),
    ev(Number.NaN, "s3", "error"),
    null as unknown as FleetEvent,
  ].reverse();
  const out = stateChanges(events);
  assert.deepStrictEqual(
    out.map((x) => `${x.at}:${x.sessionId}:${x.status}`),
    ["6:s1:waiting", "5:s2:error", "4:s1:working", "3:s1:needs_input", "1:s1:working"],
  );
  assert.strictEqual(out.find((x) => x.sessionId === "s2")?.detail.length, 200);
  assert.strictEqual(stateChanges(events, 2).length, 2);
  assert.deepStrictEqual(stateChanges(undefined as unknown as FleetEvent[]), []);
  // The overview knows better (a question at the turn's end, an API error without a hook): the stream ends with it,
  // and never invents a session it has no event of (practical test 15 Oct: ✓ while the alarm zone said it waits).
  const now = stateChanges(events, 40, [
    { id: "s1", status: "needs_input", statusSince: 9, detail: "Soll ich den PR aufmachen?" },
    { id: "s2", status: "error", statusSince: 9 },
    { id: "s9", status: "error", statusSince: 9 },
  ]);
  assert.deepStrictEqual(
    now.slice(0, 2).map((x) => `${x.at}:${x.sessionId}:${x.status}`),
    ["9:s1:needs_input", "6:s1:waiting"],
  );
  assert.ok(!now.some((x) => x.sessionId === "s9"));
});

test("Demo: one entry per repo, the counters add up to the inbox, the stream has entries", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  const ib = inbox(o);
  const bar = repoBar(o.repos, ib);
  assert.strictEqual(new Set(bar.map((e) => e.name)).size, bar.length, "one entry per repo");
  const sum = (k: keyof (typeof bar)[number]["counts"]) => bar.reduce((a, e) => a + e.counts[k], 0);
  const withRepo = (ss: Session[]) => ss.filter((x) => x.repoRoot).length;
  assert.strictEqual(sum("errors"), withRepo(ib.errors));
  assert.strictEqual(sum("working"), withRepo(ib.working));
  assert.ok(stateChanges(o.events).length > 0, "the demo has a stream");
});
