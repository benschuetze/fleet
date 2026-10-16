// The week report: what it promises (the spec's sections, names not paths, under 5,000 tokens) and how it counts.
import assert from "node:assert";
import { test } from "vitest";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview } from "../server/core/overview";
import { MAX_CHARS, reportMarkdown, weekReport } from "../server/core/report";
import type { FleetEvent, OpenPr, Overview, Repo, Session, Status } from "../shared/types";

const DAY = 24 * 3600e3;
const now = Date.parse("2026-10-14T12:00:00Z");
const remote = (repo: string) =>
  ({ provider: "github", trusted: true, host: "github.com", repo, path: `acme/${repo}`, webUrl: "" }) as const;

const session = (id: string, repo: string, extra: Partial<Session> = {}): Session => ({
  id,
  source: "local",
  status: "waiting",
  title: `Task ${id}`,
  project: repo,
  repoRoot: `/home/someone/work/${repo}`,
  cwd: `/home/someone/work/${repo}`,
  remote: remote(repo),
  lastActivity: now - 3600e3,
  ...extra,
});
const ev = (sessionId: string, hoursAgo: number, status: Status): FleetEvent => ({
  at: now - hoursAgo * 3600e3,
  sessionId,
  event: "x",
  status,
  detail: "",
});
const pr = (number: number, head: string, extra: Partial<OpenPr> = {}): OpenPr => ({
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
  ...extra,
});
const repo = (name: string, root: string, prs: OpenPr[]): Repo => ({
  root,
  name,
  branch: "main",
  dirty: 0,
  remote: remote(name),
  lastCommit: null,
  behind: null,
  ahead: null,
  hasUpstream: true,
  sessions: [],
  prs: { prs },
});
const overview = (o: Partial<Overview>): Overview =>
  ({ sessions: [], repos: [], decisions: [], duplicates: [], usage: null, ...o }) as unknown as Overview;

test("Week report from the demo: every section, schema version, no paths, both forms under 5,000 tokens", async () => {
  const cfg = { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] };
  const src = demoSources();
  const o = await buildOverview(cfg, { version: "test", demo: true, sources: src });
  const events = await (src.readEvents as NonNullable<typeof src.readEvents>)(cfg, 3000);
  const r = weekReport(o, events);
  assert.strictEqual(r.schema, "claude-fleet/week-report");
  assert.strictEqual(r.version, 1);
  for (const k of ["repos", "usage", "fleetBalance", "alarms", "stalePrs", "cacheRebuilds", "haiku", "duplicates"])
    assert.ok(k in r, `section ${k}`);
  assert.ok(r.repos.length > 1, "sessions by repo");
  assert.ok(r.alarms.length > 0, "the demo has alarms");
  const json = JSON.stringify(r);
  const md = reportMarkdown(r);
  assert.ok(json.length < MAX_CHARS && md.length < MAX_CHARS, `${json.length} / ${md.length} characters`);
  for (const text of [json, md]) assert.doesNotMatch(text, /[/\\]demo[/\\]/, "no local paths");
  assert.match(md, /^# Claude Fleet/);
});

test("Week report: sessions of the last 7 days by repo and status, worktrees of one remote together", () => {
  const r = weekReport(
    overview({
      sessions: [
        session("a", "shop", { status: "needs_input" }),
        session("b", "shop", { status: "working", repoRoot: "/home/someone/work/shop-wt" }),
        session("c", "billing", { status: "error" }),
        session("old", "billing", { lastActivity: now - 8 * DAY }),
        session("hid", "billing", { meta: { hidden: true } }),
      ],
    }),
    [],
    now,
  );
  assert.deepStrictEqual(
    r.repos.map((x) => [x.repo, x.sessions, x.needs, x.working, x.errors]),
    [
      ["shop", 2, 1, 1, 0],
      ["billing", 1, 0, 0, 1],
    ],
  );
});

test("Week report: the most frequent alarms, only in the period, only of known sessions", () => {
  const r = weekReport(
    overview({ sessions: [session("a", "shop"), session("b", "billing")] }),
    [
      ev("a", 1, "needs_input"),
      ev("a", 2, "needs_input"),
      ev("a", 3, "error"),
      ev("b", 5, "needs_input"),
      ev("b", 6, "working"),
      ev("b", 24 * 8, "error"),
      ev("ghost", 1, "error"),
    ],
    now,
  );
  assert.deepStrictEqual(
    r.alarms.map((a) => [a.repo, a.session, a.waiting, a.errors]),
    [
      ["shop", "Task a", 2, 1],
      ["billing", "Task b", 1, 0],
    ],
  );
  assert.strictEqual(r.period.eventsFrom, "2026-10-14", "the oldest event in the period, not the one from last week");
});

test("Week report: stale PRs are open PRs nobody worked on for three days, each once", () => {
  const prs = [pr(1, "feat/fresh"), pr(2, "feat/old", { draft: true }), pr(3, "feat/nobody", { ci: "failure" })];
  const r = weekReport(
    overview({
      sessions: [
        session("a", "shop", { branch: "feat/fresh", lastActivity: now - DAY }),
        session("b", "shop", { branch: "feat/old", lastActivity: now - 5 * DAY }),
      ],
      // The same remote in two checkouts (worktrees): each PR is listed once.
      repos: [repo("shop", "/home/someone/work/shop", prs), repo("shop", "/home/someone/work/shop-wt", prs)],
    }),
    [],
    now,
  );
  assert.deepStrictEqual(
    r.stalePrs.map((p) => [p.number, p.draft, p.ci, p.lastSession]),
    [
      [3, false, "failure", null],
      [2, true, "success", "2026-10-09"],
    ],
  );
});

test("Week report: only certain numbers, the Fleet balance and the limit stay unknown without a source", () => {
  const r = weekReport(overview({ sessions: [session("a", "shop")] }), [], now);
  assert.strictEqual(r.fleetBalance, null);
  assert.deepStrictEqual(r.usage, { tokens7d: null, apiValueUsd7d: null, weekLimitPct: null });
  const md = reportMarkdown(r);
  assert.match(md, /Fleet-Bilanz: noch nicht gemessen|Fleet balance: not measured yet/);
  assert.match(md, /Wochenlimit: unbekannt|Weekly limit: unknown/);
});

test("Week report: a huge week is cut to the size limit and says so, titles stay on one line", () => {
  const sessions = Array.from({ length: 400 }, (_, i) =>
    session(`s${i}`, `repo-${i % 120}`, {
      title: `${"Ein sehr langer Auftrag mit | Tabellenzeichen\nund Umbruch ".repeat(10)}${i}`,
      usage: { cost: 1, tok: 1, cr: 0, sub: 0, rebuilds: 1 + (i % 7), rebuildCost: 0.5 },
    }),
  );
  const events = sessions.flatMap((s, i) => [ev(s.id, 1 + (i % 50), "needs_input"), ev(s.id, 2, "error")]);
  const prs = Array.from({ length: 200 }, (_, i) => pr(i + 1, `b${i}`, { title: "x".repeat(300) }));
  const r = weekReport(overview({ sessions, repos: [repo("big", "/home/someone/work/big", prs)] }), events, now);
  const md = reportMarkdown(r);
  assert.ok(r.truncated, "says it was cut");
  assert.ok(JSON.stringify(r).length <= MAX_CHARS, "JSON under the limit");
  assert.ok(md.length <= MAX_CHARS, "Markdown under the limit");
  assert.ok(r.alarms.every((a) => !a.session.includes("\n") && a.session.length <= 80));
  assert.match(md, /gekürzt|cut/);
});
