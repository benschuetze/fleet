// The merge confirmation says what goes where, so a second click is a real decision.
import assert from "node:assert";
import { test } from "vitest";
import { mergeQuestion } from "./merge";

const de = (d: string) => d;
const en = (_: string, e: string) => e;

test("Merge question names the PR, its commits and the target branch", () => {
  assert.strictEqual(mergeQuestion(14, { base: "main", commits: 3 }, de), "PR #14 (3 Commits) nach main mergen?");
  assert.strictEqual(mergeQuestion(14, { base: "main", commits: 1 }, en), "Merge PR #14 (1 commit) into main?");
  assert.strictEqual(mergeQuestion(14, { base: "main", commits: null }, de), "PR #14 nach main mergen?");
  // A PR only the desktop app knows: neither base nor commit count
  assert.strictEqual(mergeQuestion(9, undefined, de), "PR #9 wirklich mergen?");
});
