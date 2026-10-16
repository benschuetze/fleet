// Spec rule 16 (ISA-101): only a new alarm blinks, three beats, then it stands.
import assert from "node:assert";
import { test } from "vitest";
import { BLINK_MS, Fresh } from "./fresh";

const list = (s: Set<string>) => [...s].sort();

test("Blinking: what stood there at first sight is not new; an alarm that comes up later is, for three seconds", () => {
  const f = new Fresh();
  assert.deepStrictEqual(list(f.seen(["a", "b"], 0)), []);
  assert.deepStrictEqual(list(f.seen(["a", "b", "c"], 1000)), ["c"]);
  // Re-rendering does not start it again, and it stops after the third beat.
  assert.deepStrictEqual(list(f.seen(["a", "b", "c"], 1000 + BLINK_MS - 1)), ["c"]);
  assert.deepStrictEqual(list(f.seen(["a", "b", "c"], 1000 + BLINK_MS)), []);
});

test("Blinking: an alarm that went away and comes back is new again; two at once both blink", () => {
  const f = new Fresh();
  f.seen(["a"], 0);
  f.seen([], 10_000);
  assert.deepStrictEqual(list(f.seen(["a", "b"], 20_000)), ["a", "b"]);
  // An alarm that disappears while blinking leaves nothing behind.
  assert.deepStrictEqual(list(f.seen(["b"], 21_000)), ["b"]);
  assert.deepStrictEqual(list(f.seen(["a", "b"], 24_000)), ["a"]);
});
