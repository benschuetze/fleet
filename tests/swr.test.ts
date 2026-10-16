// The cache behind git, usage and session results: after the first load nothing waits for a slow source again.
import assert from "node:assert";
import { test } from "vitest";
import { onRefresh, swr } from "../server/core/swr";

const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("Only the first call waits; an expired value answers at once and refreshes in the background", async () => {
  let n = 0;
  const get = swr(10, async () => later(++n, 50));
  assert.strictEqual(await get("k"), 1);
  await tick(20); // expired
  const t0 = performance.now();
  assert.strictEqual(await get("k"), 1, "the stale value, not the running refresh");
  assert.ok(performance.now() - t0 < 30, "no wait for the slow source");
  assert.strictEqual(await get("k"), 1, "a second call during the refresh");
  await tick(80);
  assert.strictEqual(n, 2, "one refresh, not one per call");
  assert.strictEqual(get.peek("k"), 2, "the refreshed value");
  await tick(80); // let the refresh this peek started settle before the next test listens
});

test("A refresh that changes the value tells the listeners; an unchanged one does not", async () => {
  let v = "a";
  const get = swr(5, async () => v);
  let heard = 0;
  const off = onRefresh(() => heard++);
  try {
    await get("k");
    await tick(10);
    await get("k");
    await tick(5);
    assert.strictEqual(heard, 0, "same value: no push");
    v = "b";
    await tick(10);
    await get("k");
    await tick(5);
    assert.strictEqual(heard, 1, "new value: one push");
  } finally {
    off();
  }
});

test("peek never waits: unknown keys load in the background and announce themselves", async () => {
  const get = swr(1000, async (k: string) => later(`v-${k}`, 30));
  let heard = 0;
  const off = onRefresh(() => heard++);
  try {
    assert.strictEqual(get.peek("x"), undefined);
    await tick(60);
    assert.strictEqual(heard, 1);
    assert.strictEqual(get.peek("x"), "v-x");
  } finally {
    off();
  }
});

test("A failing first load is not cached; a failing refresh keeps the last value", async () => {
  let fail = true;
  const get = swr(5, async () => {
    if (fail) throw new Error("git timed out");
    return "ok";
  });
  await assert.rejects(get("k"));
  fail = false;
  assert.strictEqual(await get("k"), "ok");
  fail = true;
  await tick(10);
  assert.strictEqual(await get("k"), "ok");
  await tick(5);
  assert.strictEqual(await get("k"), "ok", "still the last good value");
});
