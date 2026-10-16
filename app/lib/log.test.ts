// The log view's session tags (spec, "Log-Sicht"): a fixed short tag and a fixed colour per session, derived from its
// id, the same after every reload; tags unique among the shown sessions; the server's answer checked like any input.
import assert from "node:assert";
import { test } from "vitest";
import { colorOf, LOG_COLORS, parseLogPage, tagsOf } from "./log";

test("Tags: four characters from the id, longer only where two shown sessions would share them", () => {
  const ids = ["3f2a9c1e-77aa-4b1c-9e0f-0a1b2c3d4e5f", "a9d4e2f7-1b3c-4e5f-a6b7-c8d9e0f1a2b3", "demo-03", "demo-14"];
  const tags = tagsOf(ids);
  assert.deepStrictEqual([...tags.values()], ["3f2a", "a9d4", "demo0", "demo1"]);
  assert.strictEqual(new Set(tags.values()).size, ids.length, "no two sessions share a tag");
  // The same session keeps its tag as long as no look-alike joins.
  assert.strictEqual(tagsOf([ids[0] as string, "b0000000"]).get(ids[0] as string), "3f2a");
});

test("Colours: from the id, the same on every call, spread over all ten", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `session-${i}-${(i * 7919).toString(16)}`);
  for (const id of ids) {
    const c = colorOf(id);
    assert.ok(c >= 1 && c <= LOG_COLORS, `${id}: ${c}`);
    assert.strictEqual(colorOf(id), c);
  }
  assert.strictEqual(new Set(ids.map(colorOf)).size, LOG_COLORS);
});

test("The server's answer: a broken line costs that line, a broken page shows nothing", () => {
  const p = parseLogPage({
    epoch: "e1",
    seq: 9,
    lines: [
      { seq: 1, at: 1000, session: "s1", kind: "tool", tool: "Bash", text: "pnpm test" },
      { seq: 2, at: 2000, session: "../etc", kind: "tool", tool: null, text: "bad id" },
      { seq: 3, at: 3000, session: "s1", kind: "shell", tool: null, text: "bad kind" },
      { seq: 4, at: "x", session: "s1", kind: "text", tool: null, text: "bad time" },
      { seq: 5, at: 5000, session: "s1", kind: "text", tool: 7, text: "x".repeat(900) },
    ],
    sessions: { s1: { name: "Checkout", project: 3 }, "bad id": { name: "x" } },
    waiting: ["s1", 4, "../x"],
  });
  assert.ok(p);
  assert.deepStrictEqual(
    p.lines.map((l) => l.seq),
    [1, 5],
  );
  assert.strictEqual(p.lines[1]?.tool, null);
  assert.strictEqual(p.lines[1]?.text.length, 300);
  assert.deepStrictEqual(p.sessions, { s1: { name: "Checkout", project: null } });
  assert.deepStrictEqual(p.waiting, ["s1"]);
  assert.strictEqual(parseLogPage({ error: "x" }), null);
  assert.strictEqual(parseLogPage(null), null);
});
