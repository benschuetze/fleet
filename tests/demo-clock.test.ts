// The demo's clock runs like a real one (practical test 15 Oct: the cache countdown stood still, stream times moved
// with every refresh) and the open PRs are counted once, the same in the header and on Repos & PRs.
import assert from "node:assert";
import { afterAll, beforeAll, test } from "vitest";
import { openPrKeys } from "../shared/prs";
import type { Overview } from "../shared/types";
import { startServer } from "./helpers/server";

let srv: Awaited<ReturnType<typeof startServer>>;
const overview = async () => JSON.parse((await srv.request("/api/overview")).body) as Overview;
beforeAll(async () => {
  srv = await startServer({ args: ["--demo"] });
});
afterAll(() => srv.stop());

test("two answers a second apart: the same cache end, the same status times, the same event times", async () => {
  const a = await overview();
  await new Promise((r) => setTimeout(r, 1100));
  const b = await overview();
  const waiting = a.sessions.filter((s) => s.status === "needs_input" && s.cache);
  assert.ok(waiting.length > 0);
  for (const s of waiting) {
    const t = b.sessions.find((x) => x.id === s.id);
    assert.strictEqual(t?.cache?.until, s.cache?.until, `${s.id}: the countdown runs to a fixed end`);
    assert.strictEqual(t?.statusSince, s.statusSince, `${s.id}: waiting since stays`);
  }
  assert.deepStrictEqual(
    b.events.slice(0, 10).map((e) => e.at),
    a.events.slice(0, 10).map((e) => e.at),
  );
});

test("open PRs once: every repo's list plus the PRs of branches, by remote and number", async () => {
  const o = await overview();
  const keys = openPrKeys(o);
  const listed = new Set(
    o.repos.flatMap((r) => (r.prs?.prs || []).map((p) => `${r.remote?.path || r.root}#${p.number}`)),
  );
  for (const k of listed) assert.ok(keys.has(k), k);
  assert.strictEqual(keys.size, 7, "the demo has seven open PRs");
});

test("every waiting demo session keeps its cache through a slow test run (CI, 15 Oct)", async () => {
  const o = await overview();
  const waiting = o.sessions.filter((s) => s.status === "needs_input" && s.cache);
  assert.ok(waiting.length >= 3);
  for (const s of waiting) assert.ok((s.cache?.until ?? 0) - Date.now() > 30 * 60e3, `${s.id}: ${s.cache?.ttl}`);
});

test("Fleet's questions count down to 0 before the next one comes; an approval waits the README's 45 s (round 3)", async () => {
  const { decisionsAt } = await import("../server/core/demo");
  const base = Date.now();
  const left = new Map<string, number>();
  for (let t = base; t < base + 6 * 60e3; t += 1000) {
    for (const d of decisionsAt(t)) {
      const now = d.expiresAt - t;
      const before = left.get(d.id);
      if (before !== undefined && now > before) assert.ok(before <= 1000, `${d.id} jumped back at ${before} ms left`);
      left.set(d.id, now);
      // Asked again it keeps its first time (round 5), so the 45 s are the countdown, not expiry minus creation.
      if (d.kind === "permission") assert.ok(now <= 45e3 && (d.expiresAt - d.createdAt) % 45e3 === 0, `${d.id}: 45 s`);
    }
  }
});

test("limit times stand still: the session's 'free from' is the 5-hour reset, both the same a second later", async () => {
  const a = await overview();
  await new Promise((r) => setTimeout(r, 1100));
  const b = await overview();
  const hit = (o: Overview) => o.sessions.find((s) => s.failure?.kind === "limit")?.failure?.resetsAt;
  const limits = (o: Overview) =>
    (o as unknown as { usage?: { limits?: Record<string, { resets_at: number }> } }).usage?.limits;
  assert.ok(hit(a));
  assert.strictEqual(hit(b), hit(a));
  assert.strictEqual(hit(a), (limits(a)?.five_hour?.resets_at || 0) * 1000);
  assert.strictEqual(limits(b)?.seven_day?.resets_at, limits(a)?.seven_day?.resets_at);
});

test("the session waiting for an approval does nothing else: its log ends with the call that waits", async () => {
  const { decisionsAt } = await import("../server/core/demo");
  const { demoLog } = await import("../server/core/demo-log");
  const approval = decisionsAt(Date.now()).find((d) => d.kind === "permission");
  assert.ok(approval);
  const later = Date.now() + 5 * 60e3;
  const own = demoLog(later).lines.filter((l) => l.session === approval.sessionId);
  assert.strictEqual(own.at(-1)?.text, approval.text);
  assert.ok((own.at(-1)?.at || 0) <= Date.now(), "no step after the approval was asked");
});

test("Fleet's demo question asked again keeps when it was first asked: the wait goes on (round 5: 18 → 18 min)", async () => {
  const { decisionsAt } = await import("../server/core/demo");
  const a = decisionsAt(Date.now());
  const later = Math.max(...a.map((d) => d.expiresAt)) + 2000;
  const b = decisionsAt(later);
  for (const d of a) {
    const e = b.find((x) => x.id === d.id);
    assert.ok(e && e.expiresAt > d.expiresAt, `${d.id}: asked again`);
    assert.strictEqual(e?.createdAt, d.createdAt, `${d.id}: waiting since the first question`);
  }
});
