// Round 8: dates read the same everywhere and are unambiguous in English; wording in both languages.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { dayLabel, tokenWord, weekdayLabel } from "../app/lib/format";
import { dateTime, dateTimeFull, shortDate } from "../shared/dates";

const at = new Date(2026, 9, 16, 6, 43).getTime();

test("German dates stay '16.10.', English ones spell the month: '16 Oct', never 16/10", () => {
  assert.strictEqual(shortDate(at, "de-DE"), "16.10.");
  assert.strictEqual(shortDate(at, "en-GB"), "16 Oct");
  assert.match(shortDate(at, "en-GB", true), /^Fri,? 16 Oct$/);
  assert.match(shortDate(at, "de-DE", true), /^Fr\.?,? 16\.10\.$/);
  assert.strictEqual(dateTime(at, "en-GB"), "16 Oct, 06:43");
  assert.strictEqual(dateTime(at, "de-DE"), "16.10., 06:43");
  assert.match(dateTimeFull(at, "en-GB"), /^16 Oct 2026,? 06:43:00$/);
  assert.strictEqual(dayLabel("2026-10-16", "en-GB"), "16 Oct");
  assert.strictEqual(dayLabel("2026-10-16", "de-DE"), "16.10.");
  assert.doesNotMatch(weekdayLabel("2026-10-16", "en-GB"), /\d\/\d/);
});

test("'tokens' is lower case in English running text, 'Tokens' in German", () => {
  assert.strictEqual(tokenWord("en-GB"), "tokens");
  assert.strictEqual(tokenWord("de-DE"), "Tokens");
});

/** Every source file under app/ (the dashboard's texts). */
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );

test("no text hard-codes 'Tokens' after a value and no date is formatted by numbers alone (round 8)", () => {
  const bad: string[] = [];
  for (const f of files("app")) {
    fs.readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\}\)?\}? Tokens\b/.test(line) || /\} Tokens/.test(line)) bad.push(`${f}:${i + 1} hard-coded "Tokens"`);
        if (/month: "(2-digit|numeric)"/.test(line)) bad.push(`${f}:${i + 1} numeric month, use shared/dates.ts`);
        if (/loud again/.test(line)) bad.push(`${f}:${i + 1} "loud again"`);
      });
  }
  assert.deepStrictEqual(bad, []);
});
