// Efficiency advisor: does the model fit the work, is a handoff due, does the cache cost money for nothing?
import assert from "node:assert";
import { test } from "vitest";
import { type AdviceInput, advise } from "../server/core/advisor";
import type { Advice } from "../shared/types";

/** A session with a work profile; tokens in the order of a real session. */
function session(
  over: { stats?: object; usage?: object } & Partial<Omit<AdviceInput, "stats" | "usage">> = {},
): AdviceInput {
  const { stats, usage, ...rest } = over;
  return {
    model: "claude-opus-5-5",
    compactions: 0,
    loop: null,
    context: { tokens: 60000, size: 1000000, pct: 6 },
    stats: {
      prompts: 6,
      promptChars: 6 * 120,
      tools: 4,
      edits: 0,
      reads: 4,
      shells: 0,
      errors: 0,
      subagents: 0,
      ...stats,
    },
    usage: {
      cost: 1.2,
      i: 2000,
      o: 3000,
      cw: 80000,
      cr: 400000,
      n: 8,
      mn: 8,
      mo: 3000,
      rebuilds: 0,
      rebuildCost: 0,
      cacheRate: 0.83,
      ...usage,
    },
    ...rest,
  };
}
const byKind = (list: Advice[], k: Advice["kind"]) => list.find((a) => a.kind === k) as Advice;

test("Short questions with Opus: Haiku 5.5 is enough, with an estimated saving", () => {
  const a = byKind(advise(session()), "model");
  assert.strictEqual(a.level, "info");
  assert.strictEqual(a.model, "claude-haiku-5-5");
  assert.match(String(a.how), /\/model haiku/);
  assert.ok((a.saving ?? 0) > 0.5, `saving ${a.saving}`);
});

test("Lots of reading and searching without changes with Opus: Sonnet 5.5 is enough", () => {
  assert.strictEqual(
    byKind(advise(session({ stats: { prompts: 3, tools: 40, reads: 36, edits: 1, shells: 3 } })), "model").model,
    "claude-sonnet-5-5",
  );
});

test("Heavy work with Opus: the model fits, no switch suggested", () => {
  // Many tool calls per prompt, changes through Bash: typical for agents.
  const a = byKind(advise(session({ stats: { prompts: 3, tools: 78, shells: 70, reads: 8, edits: 0 } })), "model");
  assert.strictEqual(a.level, "ok");
  assert.strictEqual(a.model, undefined);
});

test("Haiku on heavy work with a run of errors: a stronger model is recommended", () => {
  const a = byKind(
    advise(
      session({
        model: "claude-haiku-5-5",
        loop: { kind: "errors", tool: "Bash", count: 4 },
        stats: { prompts: 2, tools: 30, edits: 12, errors: 11, shells: 15 },
      }),
    ),
    "model",
  );
  assert.strictEqual(a.level, "warn");
  assert.strictEqual(a.model, "claude-opus-5-5");
  assert.ok((a.saving ?? 0) < 0, "the stronger model costs more, and that is shown honestly");
});

test("Fable for routine work: Opus 5.5 is much cheaper", () => {
  assert.strictEqual(
    byKind(
      advise(session({ model: "claude-fable-5-1", stats: { prompts: 4, tools: 20, edits: 4, reads: 10, shells: 6 } })),
      "model",
    ).model,
    "claude-opus-5-5",
  );
});

test("Too little data: no model recommendation", () => {
  assert.strictEqual(
    byKind(advise(session({ stats: { prompts: 0, tools: 0 }, usage: { mn: 0, n: 0 } })), "model"),
    undefined,
  );
});

test("Handoff: prepare from 60 % context, now from 85 %, compactions count", () => {
  assert.strictEqual(byKind(advise(session()), "handoff"), undefined);
  assert.strictEqual(
    byKind(advise(session({ context: { tokens: 620000, size: 1000000, pct: 62 } })), "handoff").level,
    "info",
  );
  const now = byKind(advise(session({ context: { tokens: 870000, size: 1000000, pct: 87 } })), "handoff");
  assert.strictEqual(now.level, "warn");
  assert.match(now.text, /870 Tsd\./);
  assert.ok(byKind(advise(session({ compactions: 2 })), "handoff"));
});

test("Handoff: a big context makes every call expensive, even when the window is not full", () => {
  const a = byKind(advise(session({ context: { tokens: 420000, size: 1000000, pct: 42 } })), "handoff");
  assert.ok(a);
  assert.match(a.text, /pro Aufruf/);
});

test("Cache: repeated rebuilds after breaks are named with their cost", () => {
  const a = byKind(advise(session({ usage: { rebuilds: 25, rebuildCost: 94.39, cost: 378 } })), "cache");
  assert.strictEqual(a.level, "warn");
  assert.match(a.text, /25×/);
  assert.match(a.text, /94/);
  assert.strictEqual(
    byKind(advise(session({ usage: { rebuilds: 1, rebuildCost: 3.18, cost: 18 } })), "cache"),
    undefined,
    "one rebuild is normal",
  );
});
