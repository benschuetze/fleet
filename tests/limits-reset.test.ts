// A limit whose reset has passed shows no old percentage (round 8), and the demo's resets move with its clock.
import assert from "node:assert";
import { test, vi } from "vitest";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview } from "../server/core/overview";
import { LIMIT_FRESH_MS, limitStale, windowOver } from "../shared/limits";

const H = 3600e3;

test("a window is over once its reset time has passed, and only then", () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(windowOver({ used_percentage: 58, resets_at: now / 1000 - 60 } as never, now), true);
  assert.strictEqual(windowOver({ resets_at: now / 1000 } as never, now), true);
  assert.strictEqual(windowOver({ resets_at: now / 1000 + 60 } as never, now), false);
  // Without a reset time nothing is known to be over.
  assert.strictEqual(windowOver({} as never, now), false);
  assert.strictEqual(windowOver(null, now), false);
});

test("the demo's limit resets move on with the clock, hours and days after the start (round 8)", async () => {
  for (const later of [4 * H, 9 * H, 8 * 24 * H]) {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + later });
    try {
      const o = await buildOverview(
        { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
        { version: "test", demo: true, sources: demoSources() },
      );
      const now = Date.now();
      for (const k of ["five_hour", "seven_day"] as const) {
        const w = o.usage?.limits?.[k];
        assert.ok(w?.resets_at, `${k} has a reset`);
        assert.ok(
          !windowOver(w, now),
          `${k} +${later / H} h: reset ${new Date(w.resets_at * 1000).toISOString()} is over`,
        );
      }
    } finally {
      vi.useRealTimers();
    }
  }
});

test("A status line older than 30 min only gives a floor (16.10.2026: 56 % from 00:00 at 09:20, the app said 86 %)", () => {
  const now = Date.UTC(2026, 9, 16, 7, 20);
  assert.strictEqual(limitStale(now - 9 * 3600e3, now), true);
  assert.strictEqual(limitStale(now - LIMIT_FRESH_MS + 1000, now), false);
  assert.strictEqual(limitStale(undefined, now), false);
});
