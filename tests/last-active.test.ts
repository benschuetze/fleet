// "Last active" is one time for every view (round 8): a session that waits was last active when the wait began, also
// for Fleet's own question and hours into a run, never "just now".
import assert from "node:assert";
import { test, vi } from "vitest";
import { lastActiveOf } from "../app/lib/session";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview } from "../server/core/overview";
import { inbox, places } from "../shared/inbox";

const H = 3600e3;
const demoAt = async (later: number) => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + later });
  try {
    return await buildOverview(
      { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
      { version: "test", demo: true, sources: demoSources() },
    );
  } finally {
    vi.useRealTimers();
  }
};

test("a waiting session is last active at its wait start, three hours into the run (round 8)", async () => {
  const o = await demoAt(3 * H);
  const now = Date.now() + 3 * H;
  const lastActive = lastActiveOf(o);
  const where = places(inbox(o));
  let checked = 0;
  for (const s of o.sessions) {
    const p = where.get(s.id);
    if (p !== "needs" && p !== "decision") continue;
    assert.ok(
      now - lastActive(s) > 2.9 * H,
      `${s.project} (${p}): last active ${Math.round((now - lastActive(s)) / 60e3)} min ago`,
    );
    checked++;
  }
  // Fleet's own question (decision) and a plain wait are both covered.
  assert.ok(checked >= 4 && [...where.values()].includes("decision"));
});

test("a working session keeps its transcript time", () => {
  const o = { sessions: [{ id: "w", status: "working", lastActivity: 5, statusSince: 1, meta: {} }], repos: [] };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal overview is enough for the inbox
  assert.strictEqual(lastActiveOf(o as any)({ id: "w", lastActivity: 5 }), 5);
});
