// `:cleanup` and `:stop` (release 6, plan R5, R6): what leaves "Now" and what ends.
import assert from "node:assert";
import { test } from "vitest";
import type { Proc, Session } from "../../shared/types";
import { cleanupCandidates, stoppable } from "./cleanup";

const NOW = 1_800_000_000_000;
const H = 3600e3;
const s = (id: string, more: Partial<Session>) =>
  ({
    id,
    title: id,
    project: "p",
    status: "waiting",
    lastActivity: NOW - 10 * H,
    statusSince: NOW - 10 * H,
    ...more,
  }) as Session;
const proc = (id: string, status: Proc["status"], kind: Proc["kind"] = "session") => ({ id, kind, status }) as Proc;

test("cleanup hides what has been quiet for more than 8 h, whatever it waited for", () => {
  const ids = cleanupCandidates(
    [
      s("old-done", {}),
      s("old-error", { status: "error" }),
      s("old-waiting", { status: "needs_input" }),
      s("fresh", { lastActivity: NOW - 2 * H, statusSince: NOW - 2 * H }),
      // A late status change counts as a sign of life too.
      s("moved", { statusSince: NOW - H }),
    ],
    [],
    NOW,
  ).map((x) => x.id);
  assert.deepStrictEqual(ids, ["old-done", "old-error", "old-waiting"]);
});

test("cleanup never touches what works, runs in Fleet's window, is pinned or already hidden", () => {
  const ids = cleanupCandidates(
    [
      s("working", { status: "working" }),
      s("in-fleet", {}),
      s("pinned", { meta: { pinned: true } }),
      s("hidden", { meta: { hidden: true } }),
      s("no-clock", { lastActivity: 0, statusSince: 0 }),
      s("ended-in-fleet", {}),
    ],
    [proc("in-fleet", "running"), proc("ended-in-fleet", "exited")],
    NOW,
  ).map((x) => x.id);
  assert.deepStrictEqual(ids, ["ended-in-fleet"]);
});

test("stop ends Fleet's running sessions, not its jobs and not what has ended", () => {
  const ids = stoppable([
    proc("a", "running"),
    proc("b", "starting"),
    proc("c", "exited"),
    proc("d", "interrupted"),
    proc("job", "running", "job"),
  ]).map((p) => p.id);
  assert.deepStrictEqual(ids, ["a", "b"]);
});
