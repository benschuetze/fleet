// fleet compat (server/core/compat.ts): does Fleet still fit each Claude Code version in use?
import assert from "node:assert";
import { test } from "vitest";
import type { AuditReport } from "../server/core/audit";
import { byVersion, compatWarning, formatProblems, verdict, versionOf, versionResult } from "../server/core/compat";

const at = "2026-10-15T10:00:00.000Z";
const assistant = (content: object[], usage: object | null = { input_tokens: 3, output_tokens: 5 }) => ({
  type: "assistant",
  timestamp: at,
  version: "2.1.295",
  message: { content, ...(usage ? { usage } : {}) },
});

test("versionOf: the newest line that names a version", () => {
  assert.strictEqual(
    versionOf([{ version: "2.1.286" }, { type: "x" }, { version: "2.1.295" }, { type: "y" }]),
    "2.1.295",
  );
  assert.strictEqual(versionOf([{ version: "bogus" }]), null);
});

test("formatProblems: what Fleet reads and did not find", () => {
  const ok = [
    { type: "user", timestamp: at, message: { content: "Los" } },
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    assistant([{ type: "text", text: "Fertig." }]),
  ];
  assert.deepStrictEqual(formatProblems(ok), {});
  // Usage gone (cost and context), tool ids renamed, timestamps in another format.
  const changed = [
    { type: "user", timestamp: "gestern", message: { content: "Los" } },
    assistant([{ type: "tool_call", callId: "t1" }], null),
    ...Array.from({ length: 6 }, (_, i) => ({
      type: "user",
      timestamp: at,
      message: { content: [{ type: "tool_result", tool_use_id: `x${i}` }] },
    })),
  ];
  assert.deepStrictEqual(formatProblems(changed), { timestamp: 1, usage: 1, "tool ids": 6 });
});

const rep = (waits: number, missed = 0, falseAlarms = 0) =>
  ({
    byKind: { text: { waits, missed } },
    misses: Array(missed).fill({}),
    falseAlarms: Array(falseAlarms).fill({}),
  }) as unknown as AuditReport;

test("verdict: ok from five clean waits, broken on any miss, false alarm or format problem", () => {
  assert.strictEqual(versionResult("2.1.295", 9, rep(5), {}).verdict, "ok");
  assert.strictEqual(versionResult("2.1.296", 2, rep(4), {}).verdict, "unproven");
  assert.strictEqual(versionResult("2.1.296", 2, rep(40, 1), {}).verdict, "broken");
  assert.strictEqual(versionResult("2.1.296", 2, rep(40, 0, 1), {}).verdict, "broken");
  assert.strictEqual(
    verdict({ version: "x", sessions: 1, waits: 50, missed: 0, falseAlarms: 0, format: { usage: 1 } }),
    "broken",
  );
});

test("byVersion: newest first by number, not by text", () => {
  const v = ["2.1.9", "2.1.295", "2.10.0", "2.1.30"].map((version) => ({ version }));
  assert.deepStrictEqual(
    v.sort(byVersion).map((x) => x.version),
    ["2.10.0", "2.1.295", "2.1.30", "2.1.9"],
  );
});

test("compatWarning: only a broken newest version or a missing flag reaches the message row", () => {
  const base = { at: 0, hours: 72, cli: "2.1.296", missingFlags: [] as string[] };
  const good = versionResult("2.1.295", 9, rep(9), {});
  assert.strictEqual(compatWarning({ ...base, versions: [good] }), "");
  assert.strictEqual(
    compatWarning({ ...base, versions: [versionResult("2.1.296", 1, rep(1), {}), good] }),
    "",
    "unproven",
  );
  assert.match(
    compatWarning({ ...base, versions: [versionResult("2.1.296", 3, rep(9, 2), { usage: 4 }), good] }),
    /Claude Code 2\.1\.296: 2 Wartezustände verpasst, Transcript-Format geändert/,
  );
  assert.match(compatWarning({ ...base, missingFlags: ["--resume"], versions: [good] }), /kennt --resume nicht mehr/);
  assert.strictEqual(compatWarning(null), "");
  assert.match(
    compatWarning({ ...base, procs: { files: 4, readable: 0 }, versions: [good] }),
    /schreibt seine Prozessdateien anders/,
  );
  assert.strictEqual(compatWarning({ ...base, procs: { files: 4, readable: 4 }, versions: [good] }), "");
});
