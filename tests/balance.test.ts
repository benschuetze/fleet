// The Fleet balance: what Fleet's own turns cost and what its handoffs saved, only from realised calls.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ALARM_MIN_COST, type BalanceEntry, computeBalance, computeOverage } from "../server/core/balance";
import { MAX_WINDOW, OPEN_WINDOW, parseMark, readJobs, readMarks, windows } from "../server/core/fleetturns";
import type { FleetTurnMark } from "../shared/types";

const MIN = 60e3;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 14, 18, 0, 0).getTime();

/** One assistant call; `p` = prompt tokens (all cache read), o = output. */
const call = (sid: string, t: number, p: number, o = 0, extra: Partial<BalanceEntry> = {}): BalanceEntry => ({
  sid,
  t,
  model: "claude-opus-5-5",
  i: 0,
  o,
  cw: 0,
  cr: p,
  cw1h: 0,
  cost: (p * 0.5 + o * 25) / 1e6,
  ...extra,
});
const begin = (sessionId: string, kind: FleetTurnMark["kind"], at: number, prev?: string[]): FleetTurnMark => ({
  phase: "begin",
  sessionId,
  kind,
  at,
  ...(prev ? { prev } : {}),
});
const end = (sessionId: string, kind: FleetTurnMark["kind"], at: number): FleetTurnMark => ({
  phase: "end",
  sessionId,
  kind,
  at,
});
const balance = (entries: BalanceEntry[], marks: FleetTurnMark[], jobs: Parameters<typeof windows>[1] = []) =>
  computeBalance(entries, windows(marks, jobs, NOW), {
    now: NOW,
    marks: marks.length,
    ends: marks.filter((m) => m.phase === "end").length,
    jobs: jobs.length,
  });

test("Cost: only calls inside a Fleet turn count; an open turn ends after 30 min, a closed one at its real end", () => {
  const t0 = NOW - 5 * HOUR;
  const b = balance(
    [
      call("a", t0 - MIN, 1000), // before the turn: the user's work
      call("a", t0 + MIN, 2000),
      call("a", t0 + 40 * MIN, 3000), // still inside: the turn really took 40 minutes
      call("a", t0 + 50 * MIN, 4000), // after the end
      call("b", t0 + 10 * MIN, 500),
      call("b", t0 + OPEN_WINDOW + MIN, 700), // the hook missed the end: capped after 30 min
    ],
    [begin("a", "fix", t0), end("a", "fix", t0 + 45 * MIN), begin("b", "handoff", t0)],
  );
  assert.ok(b);
  assert.strictEqual(b.cost.tok, 2000 + 3000 + 500);
  assert.deepStrictEqual(b.cost.byKind.fix, { tok: 5000, cost: 0.0025, n: 1 });
  assert.strictEqual(b.cost.byKind.handoff?.tok, 500);
  assert.strictEqual(b.cost.n, 2);
});

test("Cost: an end long after its begin is not believed (the hook was missing in between)", () => {
  const t0 = NOW - 6 * HOUR;
  const b = balance(
    [call("a", t0 + 10 * MIN, 1000), call("a", t0 + 2 * HOUR, 9000)],
    [begin("a", "continue", t0), end("a", "continue", t0 + MAX_WINDOW + HOUR)],
  );
  assert.strictEqual(b?.cost.tok, 1000);
});

test("Cost: a job that also carries a hook mark counts each call once, matching the job's own numbers", () => {
  const t0 = NOW - 2 * HOUR;
  const calls = [call("a", t0 + MIN, 40_000, 800), call("a", t0 + 2 * MIN, 41_000, 1200)];
  const b = balance(
    [call("a", t0 - HOUR, 600_000), ...calls],
    [begin("a", "handoff", t0), end("a", "handoff", t0 + 3 * MIN)],
    [{ sessionId: "a", from: t0, to: t0 + 3 * MIN, tokens: 83_000 }],
  );
  assert.strictEqual(b?.cost.tok, 83_000, "the cross-check: what jobs.jsonl reported");
  assert.strictEqual(b?.cost.byKind.job?.tok, 83_000, "the exactly logged job owns the calls");
  assert.strictEqual(b?.cost.byKind.handoff, undefined);
});

test("Saving after a fresh start: (old − new) per realised call, never negative, nothing projected", () => {
  const t0 = NOW - 3 * HOUR;
  const b = balance(
    [
      call("old", t0 - 2 * MIN, 600_000),
      call("new", t0 + MIN, 40_000),
      call("new", t0 + 2 * MIN, 60_000),
      call("new", t0 + 3 * MIN, 80_000),
      call("new", t0 + 4 * MIN, 700_000), // grew beyond the old one: 0, not negative
      call("new", t0 + 5 * MIN, 10_000, 0, { side: true }), // a subagent call replaces no main call
    ],
    [begin("new", "continue", t0, ["old"])],
  );
  assert.ok(b);
  assert.strictEqual(b.saved.fresh.tok, 560_000 + 540_000 + 520_000);
  assert.strictEqual(b.saved.fresh.calls, 4);
  assert.strictEqual(b.saved.fresh.n, 1);
  assert.strictEqual(b.saved.tok, b.saved.fresh.tok);
});

test("Saving: a successor without calls saves nothing; its predecessor unknown, nothing is claimed", () => {
  const t0 = NOW - HOUR;
  const none = balance([call("old", t0 - MIN, 600_000)], [begin("new", "continue", t0, ["old"])]);
  assert.strictEqual(none?.saved.tok, 0);
  assert.strictEqual(none?.saved.fresh.calls, 0);
  const unknown = balance([call("new", t0 + MIN, 40_000)], [begin("new", "continue", t0, ["gone"])]);
  assert.strictEqual(unknown?.saved.tok, 0);
  assert.strictEqual(unknown?.unmatched, 1);
});

test("Merge: compared with the smallest predecessor, so it never claims too much", () => {
  const t0 = NOW - HOUR;
  const b = balance(
    [call("a", t0 - MIN, 600_000), call("b", t0 - MIN, 300_000), call("m", t0 + MIN, 50_000)],
    [begin("m", "merge", t0, ["a", "b"])],
  );
  assert.strictEqual(b?.saved.merge.tok, 250_000);
  assert.strictEqual(b?.saved.merge.n, 1);
  assert.strictEqual(b?.saved.fresh.n, 0);
});

test("Avoided cache rewrite: only when the pause really outlasted the old cache", () => {
  const t0 = NOW - 4 * HOUR;
  const run = (pause: number, ttl1h: boolean) =>
    balance(
      [
        call("old", t0, 600_000, 0, { cw1h: ttl1h ? 1 : 0 }),
        call("new", t0 + pause + MIN, 40_000, 0, { cw: 30_000, cr: 10_000 }),
      ],
      [begin("new", "continue", t0 + pause, ["old"])],
    );
  const long = run(2 * HOUR, true);
  assert.strictEqual(long?.saved.rebuild.n, 1, "2 h pause, 1 h cache: expired");
  assert.ok((long?.saved.rebuild.cost || 0) > 0, "only the price differs: the tokens are counted once, above");
  assert.strictEqual(run(10 * MIN, true)?.saved.rebuild.n, 0, "10 min pause, 1 h cache: still there");
  assert.strictEqual(run(10 * MIN, false)?.saved.rebuild.n, 1, "10 min pause, 5 min cache: expired");
});

test("Seven days: older calls drop out, the day series has no gaps", () => {
  const b = balance(
    [call("a", NOW - 8 * 24 * HOUR + MIN, 5000), call("a", NOW - 2 * HOUR + MIN, 1000)],
    [begin("a", "handoff", NOW - 8 * 24 * HOUR), begin("a", "handoff", NOW - 2 * HOUR)],
  );
  assert.strictEqual(b?.cost.tok, 1000);
  assert.strictEqual(b?.daily.length, 7);
  assert.strictEqual(
    b?.daily.reduce((a, d) => a + d.cost, 0),
    1000,
  );
});

test("Alarm: three days negative with real Fleet cost; a small job or a positive balance raises none", () => {
  const t0 = NOW - HOUR;
  const neg = balance([call("a", t0 + MIN, 80_000)], [begin("a", "handoff", t0), end("a", "handoff", t0 + 5 * MIN)]);
  assert.ok(neg?.alarm, "−80k over three days");
  assert.strictEqual(neg?.alarm?.net, -80_000);
  assert.ok(80_000 >= ALARM_MIN_COST);
  const small = balance([call("a", t0 + MIN, 20_000)], [begin("a", "handoff", t0), end("a", "handoff", t0 + 5 * MIN)]);
  assert.strictEqual(small?.alarm, null, "below the floor: no flapping alarm");
  const pos = balance(
    [call("a", t0 + MIN, 80_000), call("old", t0 - MIN, 600_000), call("new", t0 + 10 * MIN, 40_000)],
    [begin("a", "handoff", t0), end("a", "handoff", t0 + 5 * MIN), begin("new", "continue", t0 + 9 * MIN, ["old"])],
  );
  assert.strictEqual(pos?.alarm, null);
  assert.ok((pos?.net.tok || 0) > 0);
});

test("Incomplete: jobs ran but no hook ever ended a turn; then the alarm stays off", () => {
  const t0 = NOW - HOUR;
  const jobs = [{ sessionId: "a", from: t0, to: t0 + 5 * MIN, tokens: null }];
  const b = balance([call("a", t0 + MIN, 90_000)], [], jobs);
  assert.strictEqual(b?.incomplete, true);
  assert.strictEqual(b?.alarm, null, "an uncertain number raises nothing");
  const ok = balance([call("a", t0 + MIN, 90_000)], [begin("x", "handoff", t0), end("x", "handoff", t0 + MIN)], jobs);
  assert.strictEqual(ok?.incomplete, false);
  assert.strictEqual(balance([call("a", t0, 1)], []), null, "no Fleet activity: no balance");
});

test("Extra usage after a limit hit: realised calls since the hit, nothing after the reset", () => {
  const hit = { kind: "seven_day" as const, at: NOW - HOUR, resetsAt: NOW + 24 * HOUR };
  const entries = [call("a", NOW - 2 * HOUR, 9999), call("a", NOW - 30 * MIN, 1000, 200), call("b", NOW - MIN, 500)];
  assert.deepStrictEqual(computeOverage(entries, hit, NOW), {
    since: hit.at,
    tok: 1700,
    cost: Math.round(((1000 * 0.5 + 200 * 25) / 1e6 + (500 * 0.5) / 1e6) * 1e4) / 1e4,
    n: 2,
  });
  assert.strictEqual(computeOverage([entries[0] as BalanceEntry], hit, NOW), null, "nothing ran since");
  assert.strictEqual(computeOverage(entries, { ...hit, resetsAt: NOW - MIN }, NOW), null, "the window reset");
  assert.strictEqual(computeOverage(entries, null, NOW), null);
});

test("Marks are untrusted input: broken lines, foreign ids and unknown kinds are dropped", () => {
  assert.deepStrictEqual(parseMark('{"phase":"begin","sessionId":"s1","kind":"fix","at":5,"prev":["a","../x"]}'), {
    phase: "begin",
    sessionId: "s1",
    kind: "fix",
    at: 5,
    prev: ["a"],
  });
  for (const l of [
    '{"phase":"begin","sessionId":"../etc","kind":"fix","at":5}',
    '{"phase":"begin","sessionId":"s1","kind":"opus","at":5}',
    '{"phase":"later","sessionId":"s1","kind":"fix","at":5}',
    '{"phase":"end","sessionId":"s1","kind":"fix","at":-1}',
    '{"phase":"begin","sessi',
    "null",
  ])
    assert.strictEqual(parseMark(l), null, l);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-bal-"));
  fs.writeFileSync(
    path.join(home, "fleet-turns.jsonl"),
    `${JSON.stringify(begin("s1", "handoff", NOW - HOUR))}\nkaputt\n${JSON.stringify(end("s1", "handoff", NOW))}\n`,
  );
  fs.writeFileSync(path.join(home, "fleet-turns.jsonl.old"), `${JSON.stringify(begin("s0", "job", NOW - 2 * HOUR))}\n`);
  assert.deepStrictEqual(
    readMarks(home, NOW - 3 * HOUR).map((m) => `${m.sessionId}:${m.phase}`),
    ["s0:begin", "s1:begin", "s1:end"],
    "the rotated file too, oldest first",
  );
  fs.writeFileSync(
    path.join(home, "jobs.jsonl"),
    `${JSON.stringify({ kind: "handoff", id: "s1", startedAt: NOW - HOUR, endedAt: NOW - HOUR + MIN, result: { sessionId: "s1", tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } })}\n{"id":"../x","startedAt":1,"endedAt":2}\n`,
  );
  assert.deepStrictEqual(readJobs(home, NOW - 3 * HOUR), [
    { sessionId: "s1", from: NOW - HOUR, to: NOW - HOUR + MIN, tokens: 10 },
  ]);
});

test("Against /compact: one compaction call over the old context against writing the handoff, in dollars", async () => {
  const { COMPACT_OUT } = await import("../server/core/balance");
  const { costOf } = await import("../server/core/prices");
  const t0 = NOW - 3 * HOUR;
  const b = balance(
    [
      call("old", t0 - 10 * MIN, 600_000),
      call("old", t0 - 5 * MIN, 610_000, 4_000), // writes the handoff (inside the handoff turn)
      call("new", t0 + MIN, 40_000),
      call("new", t0 + 2 * MIN, 50_000),
    ],
    [begin("old", "handoff", t0 - 6 * MIN), end("old", "handoff", t0 - 4 * MIN), begin("new", "continue", t0, ["old"])],
  );
  assert.ok(b);
  const compact = costOf({ i: 0, o: COMPACT_OUT, cw: COMPACT_OUT, cr: 610_000 }, "claude-opus-5-5");
  const handoff = (610_000 * 0.5 + 4_000 * 25) / 1e6;
  assert.strictEqual(b.vsCompact.n, 1);
  assert.ok(Math.abs(b.vsCompact.compact - compact) < 1e-4, `${b.vsCompact.compact} vs ${compact}`);
  assert.ok(Math.abs(b.vsCompact.fleet - handoff) < 1e-4, "only writing the handoff, not the successor's work");
  assert.ok(Math.abs(b.vsCompact.net - (compact - handoff)) < 2e-4);
  const day = b.daily.find((d) => d.compactUsd > 0);
  assert.ok(day && Math.abs(day.freshUsd - handoff) < 1e-4, "per day as well");
});

test("Ledger: days stay after they leave the window and sum to weeks starting on Monday", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ledger-"));
  process.env.CLAUDE_FLEET_HOME = home;
  try {
    const { readLedger, recordDays, weeks } = await import("../server/core/ledger");
    const d = (day: string, costUsd: number, savedUsd: number, compactUsd = 0, freshUsd = 0) => ({
      day,
      cost: 0,
      saved: 0,
      costUsd,
      savedUsd,
      compactUsd,
      freshUsd,
    });
    recordDays([d("2026-10-11", 1, 3), d("2026-10-12", 2, 5, 0.5, 0.75)]); // Sun, Mon
    recordDays([d("2026-10-12", 2, 6, 0.5, 0.75), d("2026-10-13", 1, 1)]); // Monday recomputed, Tuesday new
    assert.deepStrictEqual(Object.keys(readLedger()), ["2026-10-11", "2026-10-12", "2026-10-13"]);
    const w = weeks(readLedger());
    assert.deepStrictEqual(
      w.map((x) => [x.from, x.days, x.costUsd, x.savedUsd, x.net, x.vsCompact]),
      [
        ["2026-10-05", 1, 1, 3, 2, 0],
        ["2026-10-12", 2, 3, 7, 4, -0.25],
      ],
    );
    if (process.platform !== "win32")
      assert.strictEqual(fs.statSync(path.join(home, "balance-days.json")).mode & 0o777, 0o600);
  } finally {
    delete process.env.CLAUDE_FLEET_HOME;
  }
});

test("Demo balance: the turns in the header are the measures in the table (practical test 15 Oct: 9 against 10)", async () => {
  const { startServer } = await import("./helpers/server");
  const srv = await startServer({ args: ["--demo"] });
  try {
    const b = JSON.parse((await srv.request("/api/overview")).body).usage.balance;
    const rows = Object.values(b.cost.byKind as Record<string, { n: number }>).reduce((a, k) => a + k.n, 0);
    assert.strictEqual(b.cost.n, rows);
    assert.strictEqual(b.saved.n, b.saved.fresh.n + b.saved.merge.n);
  } finally {
    await srv.stop();
  }
});
