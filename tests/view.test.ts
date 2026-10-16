// Status filter (keys 1–5) and muted alarms (key s): they only take rows away, never move a session to a second
// place, and the alarm zone keeps its promise of one place per signal.
import assert from "node:assert";
import { test, vi } from "vitest";
import { alarmEmpty, alarmKey, applyView, boardEmpty, filteredIds, MUTE_MS, muteBack, nowView } from "../app/lib/view";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview } from "../server/core/overview";
import { type Inbox, inbox, places } from "../shared/inbox";
import { repoBar } from "../shared/repobar";

const demo = () =>
  buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );

const sessionIds = (ib: Inbox) =>
  [ib.needs, ib.errors, ib.working, ib.done, ib.resting, ib.archive, ib.replaced].flat().map((s) => s.id);

test("Filter: each status keeps only its own sessions, in the same group as without the filter", async () => {
  const o = await demo();
  const ib = inbox(o);
  const now = Date.now();
  for (const f of ["needs", "errors", "working", "done", "resting"] as const) {
    const v = applyView(ib, ib.decisions, f, {}, now).ib;
    assert.deepStrictEqual(v[f], ib[f], `${f}: unchanged`);
    for (const other of ["needs", "errors", "working", "done", "resting", "archive", "replaced"] as const)
      if (other !== f) assert.strictEqual(v[other].length, 0, `${f} hides ${other}`);
    // Pipelines and the limit are no session status
    assert.strictEqual(v.ciRed.length, 0);
    assert.strictEqual(v.limit, null);
    const ids = sessionIds(v);
    assert.strictEqual(new Set(ids).size, ids.length, "no session twice");
  }
  assert.ok(ib.needs.length && ib.errors.length && ib.working.length, "the demo has every case");
  // Fleet's own questions wait for you: they stay under "waiting" only
  assert.strictEqual(applyView(ib, ib.decisions, "needs", {}, now).decisions.length, ib.decisions.length);
  assert.strictEqual(applyView(ib, ib.decisions, "errors", {}, now).decisions.length, 0);
  // Without a filter nothing changes
  assert.deepStrictEqual(sessionIds(applyView(ib, ib.decisions, null, {}, now).ib), sessionIds(ib));
});

test("Muted alarms leave the alarm zone for an hour, appear nowhere else, and come back on their own", async () => {
  const o = await demo();
  const ib = inbox(o);
  const now = Date.now();
  const err = ib.errors[0];
  const red = ib.ciRed[0];
  assert.ok(err && red, "the demo has an error and red CI");
  const muted = { [alarmKey.session(err.id)]: now + MUTE_MS, [alarmKey.ci(red.key)]: now + MUTE_MS };
  const v = applyView(ib, ib.decisions, null, muted, now);
  assert.ok(!v.ib.errors.some((s) => s.id === err.id));
  assert.ok(!v.ib.ciRed.some((c) => c.key === red.key));
  assert.ok(!sessionIds(v.ib).includes(err.id), "not moved to another group");
  assert.strictEqual(v.mutedCount, 2);
  // After the hour it is back
  const later = applyView(ib, ib.decisions, null, muted, now + MUTE_MS + 1);
  assert.ok(later.ib.errors.some((s) => s.id === err.id));
  assert.strictEqual(later.mutedCount, 0);
  // Garbage from storage counts as nothing
  const junk = applyView(ib, ib.decisions, null, { x: Number.NaN, [alarmKey.session(err.id)]: -1 }, now);
  assert.strictEqual(junk.mutedCount, 0);
});

test("The balance alarm mutes like the other alarm rows and steps aside under a status filter", async () => {
  const ib: Inbox = { ...inbox(await demo()), balance: { net: -80_000, cost: 90_000, since: "2026-10-12" } };
  const now = Date.now();
  assert.ok(applyView(ib, ib.decisions, null, {}, now).ib.balance);
  const muted = applyView(ib, ib.decisions, null, { [alarmKey.balance("2026-10-12")]: now + MUTE_MS }, now);
  assert.strictEqual(muted.ib.balance, null);
  assert.strictEqual(muted.mutedCount, 1);
  assert.ok(
    applyView(ib, ib.decisions, null, { [alarmKey.balance("2026-10-11")]: now + MUTE_MS }, now).ib.balance,
    "a new three-day window is a new alarm",
  );
  assert.strictEqual(applyView(ib, ib.decisions, "needs", {}, now).ib.balance, null);
});

test("Now's one view (stage 12.3): the repo narrows board, duplicates, handoffs and pipelines, never the alarms", async () => {
  const o = await demo();
  const now = Date.now();
  const base = { query: "", filter: null, muted: {}, now };
  const whole = nowView(o, { ...base, repo: null });
  const shop = repoBar(o.repos, inbox(o)).find((e) => e.name === "shop-frontend");
  assert.ok(shop, "the demo has shop-frontend");
  const v = nowView(o, { ...base, repo: shop });
  // The alarm zone sees everything, whatever the repo bar chose
  assert.deepStrictEqual(sessionIds(v.ib), sessionIds(whole.ib));
  assert.deepStrictEqual(
    v.decisions.map((d) => d.id),
    whole.decisions.map((d) => d.id),
  );
  // The board, duplicates, handoffs and pipelines only that repo's
  const inShop = (root: string) => shop.roots.includes(root);
  for (const s of [v.mine.working, v.mine.done, v.mine.resting].flat())
    assert.ok(!s.repoRoot || inShop(s.repoRoot), `${s.title} is shop-frontend's`);
  assert.ok(v.mine.working.length < whole.mine.working.length, "other repos' sessions leave the board");
  assert.ok(v.dups.every((d) => inShop(d.root)));
  assert.ok(v.ready.every((r) => inShop(r.root)));
  assert.ok(v.running.every((c) => inShop(c.root)));
  // A handoff whose session still runs is nobody's to continue
  const busy = new Set(o.sessions.filter((s) => s.status === "working").map((s) => s.id));
  assert.ok(whole.ready.every((r) => !busy.has(String(r.handoff.session))));
  // The search takes sessions away before anything else
  const none = nowView(o, { ...base, query: "zzz-nothing-matches", repo: null });
  assert.strictEqual(none.all.length, 0);
});

test("Empty board under a filter (release 6, Ben's finding): it names where the sessions stand, never 'no session works'", async () => {
  const o = await demo();
  const ib = inbox(o);
  const de = (d: string) => d;
  const now = Date.now();
  for (const f of ["needs", "errors"] as const) {
    const v = applyView(ib, ib.decisions, f, {}, now);
    const text = boardEmpty(v.ib, v.decisions.length, f, de);
    const n = f === "needs" ? v.ib.needs.length + v.decisions.length : v.ib.errors.length;
    assert.ok(n > 0);
    assert.match(text, new RegExp(`^${n} Sessions .* stehen oben in der Alarmzone \\(1\\)\\.$`), text);
  }
  const none = applyView({ ...ib, errors: [] }, [], "errors", {}, now);
  assert.strictEqual(boardEmpty(none.ib, 0, "errors", de), "Keine Session mit Fehler.");
  assert.strictEqual(boardEmpty({ ...ib, needs: [], errors: [] }, 0, null, de), "Gerade arbeitet keine Session.");
  // The stream follows the filter: exactly the sessions the filter keeps
  const v = applyView(ib, ib.decisions, "errors", {}, now);
  assert.deepStrictEqual(
    [...(filteredIds(v.ib, v.decisions, "errors") || [])].sort(),
    ib.errors.map((s) => s.id).sort(),
  );
  assert.strictEqual(filteredIds(ib, ib.decisions, null), null);
});

test("Empty alarm zone under a filter or search (round 3): it says how many alarms are hidden, never 'nothing to do'", async () => {
  const o = await demo();
  const base = { query: "", muted: {}, repo: null, now: Date.now() };
  const de = (d: string) => d;
  const whole = nowView(o, { ...base, filter: null });
  assert.strictEqual(whole.hiddenAlarms, 0, "without filter or search nothing is hidden");
  const resting = nowView(o, { ...base, filter: "resting" });
  assert.ok(resting.hiddenAlarms > 0, "the resting filter hides the alarms");
  const text = alarmEmpty(resting.hiddenAlarms, "resting", de);
  assert.match(text, /verbirgt \d+ Alarm/);
  assert.match(text, /Alt\+0|⌥0/);
  assert.doesNotMatch(text, /Nichts zu tun/);
  const search = nowView(o, { ...base, filter: null, query: "zzz-nothing-matches" });
  assert.ok(search.hiddenAlarms > 0, "a search that matches nothing hides the alarms too");
  assert.match(alarmEmpty(search.hiddenAlarms, null, de), /Suche verbirgt \d+ Alarm/);
  assert.match(alarmEmpty(0, null, de), /^Nichts zu tun/);
});

test("The search narrows every row on Now, not only sessions (round 4: Fleet asks, CI, handoffs stayed)", async () => {
  const o = await demo();
  const base = { filter: null, muted: {}, repo: null, now: Date.now() };
  const none = nowView(o, { ...base, query: "zzz-nothing-matches" });
  assert.deepStrictEqual(
    {
      decisions: none.decisions.length,
      ci: none.ib.ciRed.length,
      limit: !!none.ib.limit,
      balance: !!none.ib.balance,
      ready: none.ready.length,
      dups: none.dups.length,
      running: none.running.length,
    },
    { decisions: 0, ci: 0, limit: false, balance: false, ready: 0, dups: 0, running: 0 },
  );
  // A repo's name finds its CI and its handoffs, and nothing of other repos
  const whole = nowView(o, { ...base, query: "" });
  const red = whole.ib.ciRed[0];
  assert.ok(red);
  const one = nowView(o, { ...base, query: red.repo });
  assert.ok(one.ib.ciRed.some((c) => c.key === red.key));
  assert.ok(one.ib.ciRed.every((c) => c.repo.toLowerCase().includes(red.repo.toLowerCase())));
});

test("Activity counts a session's wait and error as Now shows them (round 4: mobile-app waited for Fleet, its lane stood still)", async () => {
  // Two minutes after the demo started: Fleet's questions, asked at the start, have waited that long (round 5).
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60e3 });
  const o = await demo().finally(() => vi.useRealTimers());
  const where = places(inbox(o));
  const lane = (s: (typeof o.sessions)[number]) =>
    o.timeline?.lanes.find((l) => l.id === `${s.repoRoot}` || l.project === s.project);
  for (const s of o.sessions) {
    const p = where.get(s.id);
    if (p !== "decision" && p !== "errors") continue;
    if (!s.statusSince || Date.now() - s.statusSince > 3 * 3600e3) continue;
    const l = lane(s);
    assert.ok(l, `${s.project}: a lane for a session in the ${p}`);
    if (p === "decision") assert.ok(l.attention > 0, `${s.project}: its wait counts`);
  }
});

test("a question whose countdown ran out stays until the next overview: no row vanishes for seconds (round 5)", async () => {
  const { nextExpiry } = await import("../app/lib/view");
  const data = await demo();
  const loop = data.decisions.find((d) => d.kind === "loop");
  assert.ok(loop);
  const now = loop.expiresAt + 1000;
  const v = nowView(data, { query: "", filter: null, muted: {}, repo: null, now });
  // The loop question "carried on" until the server says what happened; the approval is gone (the app asks itself).
  assert.ok(
    v.decisions.some((d) => d.id === loop.id),
    "the lapsed loop question stays",
  );
  // Round 6: a lapsed approval stays in its place too (as "abgelaufen", without its button) until the server says
  // more; it used to vanish for 4.5 s and every row number below it moved.
  const perm = data.decisions.find((d) => d.kind === "permission");
  assert.ok(perm);
  const late = nowView(data, { query: "", filter: null, muted: {}, repo: null, now: perm.expiresAt + 1000 });
  assert.ok(
    late.decisions.some((d) => d.id === perm.id),
    "the lapsed approval stays",
  );
  // The dashboard asks for a new overview right when the first countdown ends, not up to a refresh later.
  assert.strictEqual(nextExpiry(data.decisions, Date.now()), Math.min(...data.decisions.map((d) => d.expiresAt)));
  assert.strictEqual(nextExpiry([], 0), null);
});

test("Round 6: history, stream and timeline start a wait for Fleet at the same moment", async () => {
  const { stateChanges, nowForStream } = await import("../shared/stream");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60e3 });
  const o = await demo().finally(() => vi.useRealTimers());
  let checked = 0;
  for (const d of o.decisions) {
    // The history's newest line of the session is the wait itself, at the moment Fleet asked.
    const mine = o.events.filter((e) => e.sessionId === d.sessionId).sort((a, b) => b.at - a.at);
    assert.strictEqual(mine[0]?.status, "needs_input", `${d.sessionId}: the history ends with the wait`);
    assert.strictEqual(mine[0]?.at, d.createdAt, `${d.sessionId}: since Fleet asked`);
    // The stream says "waits" from the same moment.
    const st = stateChanges(o.events, 200, nowForStream(o)).filter((x) => x.sessionId === d.sessionId);
    const waits = st.filter((x) => x.status === "needs_input").map((x) => x.at);
    assert.strictEqual(Math.max(...waits), d.createdAt, `${d.sessionId}: the stream's wait`);
    checked++;
  }
  assert.ok(checked >= 2);
});

test("Round 6: the header counts what the alarm zone shows, muted alarms left out", async () => {
  const { headerCounts } = await import("../app/lib/view");
  const o = await demo();
  const now = Date.now();
  const all = headerCounts(o, {}, now);
  const ci = inbox(o).ciRed[0];
  assert.ok(ci);
  const muted = headerCounts(o, { [alarmKey.ci(ci.key)]: now + MUTE_MS }, now);
  assert.strictEqual(muted.ciRed, all.ciRed - 1, "CI red drops by the muted one");
  const d = o.decisions.find((x) => x.status === "open");
  assert.ok(d);
  assert.strictEqual(headerCounts(o, { [alarmKey.decision(d.id)]: now + MUTE_MS }, now).needs, all.needs - 1);
});

test("Round 7: the alarms a search hides are counted like the header counts them, Fleet's questions included", async () => {
  const o = await demo();
  const now = Date.now();
  const base = { muted: {}, repo: null, now, filter: null };
  const whole = nowView(o, { ...base, query: "" });
  const total =
    whole.ib.needs.length +
    whole.ib.errors.length +
    whole.ib.ciRed.length +
    whole.decisions.length +
    (whole.ib.limit ? 1 : 0) +
    (whole.ib.balance ? 1 : 0);
  const none = nowView(o, { ...base, query: "zzz-nothing-matches" });
  assert.strictEqual(none.hiddenAlarms, total, "a search that matches nothing hides every alarm of the whole view");
  // Whatever a search keeps, shown + hidden is the whole
  for (const query of ["a", "Schema", "shop"]) {
    const v = nowView(o, { ...base, query });
    const shown =
      v.ib.needs.length +
      v.ib.errors.length +
      v.ib.ciRed.length +
      v.decisions.length +
      (v.ib.limit ? 1 : 0) +
      (v.ib.balance ? 1 : 0);
    assert.strictEqual(shown + v.hiddenAlarms, total, query);
  }
});

test("the undo hint names the right pronoun for each kind of muted alarm (round 7)", () => {
  // Freigabe, Frage, CI, Session, Bilanz are feminine ("sie"); the limit is neuter ("es").
  for (const key of [alarmKey.decision("x"), alarmKey.ci("k"), alarmKey.session("s"), alarmKey.balance("2026-10-01")])
    assert.strictEqual(muteBack(key), "sie", key);
  assert.strictEqual(muteBack(alarmKey.limit("five_hour")), "es");
});

test("Round 7: the tab title and the repo bar leave a muted alarm out like the header", async () => {
  const { headerCounts, loudInbox } = await import("../app/lib/view");
  const o = await demo();
  const now = Date.now();
  const d = o.decisions.find((x) => x.status === "open");
  assert.ok(d);
  const muted = { [alarmKey.decision(d.id)]: now + MUTE_MS };
  const loud = loudInbox(o, muted, now);
  // The tab title is the header's waiting count.
  assert.strictEqual(loud.counts.needs, headerCounts(o, muted, now).needs, "title = header");
  const sum = (ib: Inbox) => repoBar(o.repos, ib).reduce((n, e) => n + e.counts.needs, 0);
  assert.strictEqual(sum(loud), sum(inbox(o)) - 1, "repo bar drops the muted question");
});
