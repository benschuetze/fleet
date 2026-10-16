// Fleet's questions in the dashboard's language (round 4): every fixed word the server writes is in the list.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { DECISION_WORDS, decisionText } from "../shared/decision-words";

test("every answer and hint of brake.ts has its pair, and the dashboard shows it in its own language", () => {
  const src = fs.readFileSync(path.join(__dirname, "../server/core/brake.ts"), "utf8");
  const pairs = [...src.matchAll(/(?:label|hint): tr\(\s*"([^"]+)",\s*"([^"]+)",?\s*\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 8, `found ${pairs.length}`);
  for (const [de, en] of pairs)
    assert.ok(
      DECISION_WORDS.some(([d, e]) => d === de && e === en),
      `missing in shared/decision-words.ts: ${de} / ${en}`,
    );
  const de = (d: string) => d;
  const en = (_d: string, e: string) => e;
  assert.strictEqual(decisionText("Allow", de), "Erlauben");
  assert.strictEqual(decisionText("Pause and rethink", de), "Innehalten und neu ansetzen");
  assert.strictEqual(decisionText("Weiter so", en), "Carry on");
  assert.strictEqual(decisionText("Approval: Bash", de), "Freigabe: Bash");
  assert.strictEqual(decisionText("pnpm add -D p-limit", de), "pnpm add -D p-limit");
});
