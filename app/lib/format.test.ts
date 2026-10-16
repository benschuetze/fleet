// Long paths are shortened in front by the home folder, so the part that tells folders apart stays readable.
import assert from "node:assert";
import { test } from "vitest";
import { age, ago, charBar, duration, signedToks, tildify } from "./format";

test("Age on the board: seconds in the first hour, so it changes every second; short after that", () => {
  assert.strictEqual(age(0, "de-DE"), "0s");
  assert.strictEqual(age(45_900, "de-DE"), "45s");
  assert.strictEqual(age(3 * 60e3 + 7e3, "de-DE"), "3m07s");
  assert.strictEqual(age(3 * 60e3 + 8e3, "de-DE"), "3m08s");
  assert.strictEqual(age(59 * 60e3 + 59e3, "de-DE"), "59m59s");
  assert.strictEqual(age(2 * 3600e3 + 5 * 60e3, "de-DE"), "2h05m");
  assert.strictEqual(age(3 * 86400e3, "de-DE"), "3T");
  assert.strictEqual(age(3 * 86400e3, "en-US"), "3d");
  assert.strictEqual(age(-5000, "de-DE"), "0s");
  // Never wider than the column (7 characters inside an 8 ch cell).
  for (const ms of [59 * 60e3 + 59e3, 23 * 3600e3 + 59 * 60e3, 999 * 86400e3])
    assert.ok(age(ms, "de-DE").length <= 7, age(ms, "de-DE"));
});

test("Character bar: always as wide as asked, never empty or full when the share is not", () => {
  assert.strictEqual(charBar(42), "███░░░░");
  assert.strictEqual(charBar(0), "░░░░░░░");
  assert.strictEqual(charBar(1), "█░░░░░░");
  assert.strictEqual(charBar(99), "██████░");
  assert.strictEqual(charBar(100), "███████");
  assert.strictEqual(charBar(150), "███████");
  assert.strictEqual(charBar(-5), "░░░░░░░");
  assert.strictEqual(charBar(Number.NaN), "░░░░░░░");
  assert.strictEqual(charBar(50, 12).length, 12);
});

test("A balance carries its sign, with a real minus", () => {
  assert.strictEqual(signedToks(1_300_000, "de-DE"), "+1,3 Mio.");
  assert.strictEqual(signedToks(-120_000, "de-DE"), "−120 Tsd.");
  assert.strictEqual(signedToks(-120_000, "en-US"), "−120 k");
  assert.strictEqual(signedToks(0, "de-DE"), "0");
  assert.strictEqual(signedToks(Number.NaN, "de-DE"), "0");
});

test("Paths start with ~ instead of the home folder, on every system", () => {
  assert.strictEqual(tildify("/Users/someone/Downloads/fleet"), "~/Downloads/fleet");
  assert.strictEqual(tildify("/home/someone/src/app"), "~/src/app");
  assert.strictEqual(tildify("C:\\Users\\someone\\src\\app"), "~\\src\\app");
  assert.strictEqual(tildify("/Users/someone"), "~");
  // Not a home folder: unchanged
  assert.strictEqual(tildify("/srv/Users/someone/app"), "/srv/Users/someone/app");
  assert.strictEqual(tildify("/Usersx/a"), "/Usersx/a");
  assert.strictEqual(tildify(null), "");
});

test("ago and duration count the same minutes (round 3: 'last active 9 min' beside 'for 8 min')", () => {
  for (const min of [1.2, 8.6, 59.7, 150.5]) {
    const at = Date.now() - min * 60e3;
    const d = duration(Date.now() - at, "en").split(" ")[0];
    assert.strictEqual(ago(at, "en").split(" ")[0], min < 60 ? d : String(Math.floor(min / 60)), `${min} min`);
  }
});

test("ago keeps the minutes beside the hours, like duration (round 8: 2 h 55 min read '2 Std')", () => {
  const at = Date.now() - (2 * 3600e3 + 55 * 60e3 + 10e3);
  assert.strictEqual(ago(at, "de-DE"), "2 Std 55 Min");
  assert.strictEqual(ago(at, "en"), "2 h 55 min");
  assert.strictEqual(ago(Date.now() - 3 * 86400e3, "en"), "3 d");
});
