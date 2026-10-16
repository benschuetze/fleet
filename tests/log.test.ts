// The log view's promises (spec, "Log-Sicht (Shift+L)"): every session appears, every step once, errors red and a
// waiting session orange exactly once, prompts never in full, paths relative, at most 500 lines. Invented
// transcripts in a temporary Claude folder, never real ones.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import { createLogReader, shortPaths, toolText } from "../server/core/log";
import { LOG_MAX, mergeLog, signals } from "../shared/log";
import type { LogLine } from "../shared/types";

const T = Date.parse("2026-10-14T09:00:00Z");
const ts = (s: number) => new Date(T + s * 1000).toISOString();

let home: string;
const REPO = "/work/shop";
const file = (id: string, dir = "-work-shop") => path.join(home, "projects", dir, `${id}.jsonl`);
function write(id: string, objs: object[], dir?: string) {
  const f = file(id, dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, objs.map((o) => `${JSON.stringify(o)}\n`).join(""));
}
const prompt = (s: number, text: string, cwd = REPO) => ({
  type: "user",
  timestamp: ts(s),
  cwd,
  message: { role: "user", content: text },
});
const say = (s: number, text: string, cwd = REPO) => ({
  type: "assistant",
  timestamp: ts(s),
  cwd,
  message: { model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn" },
});
const call = (s: number, id: string, name: string, input: object, cwd = REPO) => ({
  type: "assistant",
  timestamp: ts(s),
  cwd,
  message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] },
});
const result = (s: number, id: string, error: string | null) => ({
  type: "user",
  timestamp: ts(s),
  cwd: REPO,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !!error, content: error || "ok" }] },
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-log-"));
  fs.mkdirSync(path.join(home, "projects"), { recursive: true });
});

const text = (l: LogLine) => `${l.kind}${l.tool ? `:${l.tool}` : ""} ${l.text}`;

describe("Log from transcripts", () => {
  test("Each step one line: tool with file or command, first line of a text, start of a prompt", async () => {
    const long = `Bitte baue den Checkout um. ${"Sehr geheimer Kontext. ".repeat(20)}`;
    write("s1", [
      prompt(0, long),
      say(1, "## Plan\nErst lesen, dann ändern.\nZweite Zeile bleibt weg."),
      call(2, "t1", "Read", { file_path: `${REPO}/src/checkout.ts` }),
      call(3, "t2", "Bash", { command: `cd ${REPO}/web && pnpm test\necho zweite Zeile` }),
      result(4, "t2", null),
    ]);
    const r = await createLogReader().read(home);
    assert.deepStrictEqual(r.lines.map(text), [
      `prompt ${long.slice(0, 59)}…`,
      "text Plan",
      "tool:Read src/checkout.ts",
      "tool:Bash cd web && pnpm test",
    ]);
    assert.ok(r.lines.every((l) => l.session === "s1"));
    assert.ok(!r.lines.some((l) => l.text.includes("Sehr geheimer Kontext. Sehr geheimer")), "no prompt in full");
  });

  test("Every session appears: headless, without title, from a folder Fleet shows nowhere else", async () => {
    write("headless-1", [
      { type: "user", timestamp: ts(0), cwd: REPO, entrypoint: "sdk-cli", message: { content: "x" } },
    ]);
    write("headless-1", [call(1, "a", "Write", { file_path: `${REPO}/HANDOFF.md` })]);
    write("untitled", [call(2, "b", "Grep", { pattern: "TODO" }, "/tmp/scratch")], "-tmp-scratch");
    write("titled", [{ type: "ai-title", title: "Checkout umbauen" }, say(3, "Fertig.")]);
    const r = await createLogReader().read(home);
    assert.deepStrictEqual([...new Set(r.lines.map((l) => l.session))].sort(), ["headless-1", "titled", "untitled"]);
    assert.strictEqual(r.info.get("titled")?.title, "Checkout umbauen");
    assert.strictEqual(r.info.get("untitled")?.title, null);
    assert.strictEqual(r.info.get("untitled")?.cwd, "/tmp/scratch");
  });

  test("Signals once: a failed tool result is one red line, an API error one red line and no text", async () => {
    write("s1", [
      call(0, "t1", "Bash", { command: "pnpm test" }),
      result(1, "t1", "Exit code 1\n2 failed"),
      {
        type: "assistant",
        timestamp: ts(2),
        cwd: REPO,
        isApiErrorMessage: true,
        message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
      },
    ]);
    const r = await createLogReader().read(home);
    assert.deepStrictEqual(r.lines.map(text), [
      "tool:Bash pnpm test",
      "error:Bash Exit code 1",
      "error API Error: 529 Overloaded",
    ]);
    const sig = signals(r.lines, []);
    assert.deepStrictEqual(
      r.lines.map((l) => sig.get(l.seq) ?? null),
      [null, "crit", "crit"],
      "the call stays grey, its result and the API error are red",
    );
  });

  test("New lines without reloading: only what was appended, nothing twice, sidechains left out", async () => {
    const reader = createLogReader();
    write("s1", [say(0, "Eins.")]);
    const a = await reader.read(home);
    write("s1", [say(1, "Zwei."), { ...say(2, "Subagent intern."), isSidechain: true }]);
    // half a line that is still being written
    fs.appendFileSync(file("s1"), '{"type":"assistant","timest');
    const b = await reader.read(home);
    assert.deepStrictEqual(b.lines.map(text), ["text Eins.", "text Zwei."]);
    assert.ok((b.lines[1]?.seq || 0) > a.seq, "the new line has a newer number");
    const c = await reader.read(home);
    assert.deepStrictEqual(
      c.lines.map((l) => l.seq),
      b.lines.map((l) => l.seq),
      "a read without change adds nothing",
    );
  });

  test(`At most ${LOG_MAX} lines, the newest; old files are not read once enough newer lines are there`, async () => {
    write(
      "busy",
      Array.from({ length: 700 }, (_, i) => call(1000 + i, `t${i}`, "Read", { file_path: `${REPO}/f${i}.ts` })),
    );
    write("old", [say(0, "Längst vorbei.")]);
    const old = new Date(T - 3600e3);
    fs.utimesSync(file("old"), old, old);
    const reader = createLogReader();
    const r = await reader.read(home);
    assert.strictEqual(r.lines.length, LOG_MAX);
    assert.strictEqual(r.lines.at(-1)?.text, "f699.ts");
    assert.ok(!r.lines.some((l) => l.session === "old"));
    // What the old session writes from now on still comes.
    write("old", [say(5000, "Wieder da.")]);
    const r2 = await reader.read(home);
    assert.strictEqual(r2.lines.length, LOG_MAX);
    assert.strictEqual(r2.lines.at(-1)?.text, "Wieder da.");
  });
});

describe("Log signals and merging", () => {
  const line = (seq: number, session: string, kind: LogLine["kind"] = "tool", at = seq): LogLine => ({
    seq,
    at,
    session,
    kind,
    tool: kind === "tool" ? "Bash" : null,
    text: `step ${seq}`,
  });

  test("Waiting: orange only on the newest line of a waiting session, once; an error there stays red", () => {
    const lines = [line(1, "a", "text"), line(2, "a"), line(3, "b"), line(4, "c"), line(5, "c", "error")];
    const sig = signals(lines, ["a", "c", "gone"]);
    assert.deepStrictEqual(
      lines.map((l) => sig.get(l.seq) ?? null),
      [null, "warn", null, null, "crit"],
    );
    assert.strictEqual([...sig.values()].filter((v) => v === "warn").length, 1);
    // Answered and working again: no orange left.
    assert.deepStrictEqual([...signals(lines, []).values()], ["crit"]);
  });

  test(`Merging: each line once, in time order, the newest ${LOG_MAX}`, () => {
    const have = [line(1, "a", "tool", 10), line(2, "b", "tool", 30)];
    const merged = mergeLog(have, [line(2, "b", "tool", 30), line(3, "a", "tool", 20)]);
    assert.deepStrictEqual(
      merged.map((l) => l.seq),
      [1, 3, 2],
    );
    const many = Array.from({ length: 700 }, (_, i) => line(i + 10, "a"));
    const capped = mergeLog(merged, many);
    assert.strictEqual(capped.length, LOG_MAX);
    assert.strictEqual(capped.at(-1)?.seq, 709);
  });
});

test("Paths relative to the session's folder, the home folder as ~, a sibling folder untouched", () => {
  assert.strictEqual(shortPaths("/work/shop/src/a.ts", "/work/shop", "/home/x"), "src/a.ts");
  assert.strictEqual(shortPaths("cd /work/shop && ls", "/work/shop", "/home/x"), "cd . && ls");
  assert.strictEqual(shortPaths("/work/shop-old/a.ts", "/work/shop", "/home/x"), "/work/shop-old/a.ts");
  assert.strictEqual(shortPaths("/home/x/.claude/settings.json", "/work/shop", "/home/x"), "~/.claude/settings.json");
  // Windows (CI): a path below the folder reads the same as everywhere else, with forward slashes.
  const win = { cwd: "C:\\work\\shop", home: "C:\\Users\\x" };
  assert.strictEqual(shortPaths("C:\\work\\shop\\src\\a.ts", win.cwd, win.home), "src/a.ts");
  assert.strictEqual(shortPaths("type C:\\work\\shop\\src\\a.ts", win.cwd, win.home), "type src/a.ts");
  assert.strictEqual(shortPaths("C:\\Users\\x\\.claude\\settings.json", win.cwd, win.home), "~/.claude/settings.json");
  assert.strictEqual(shortPaths("C:\\work\\shop-old\\a.ts", win.cwd, win.home), "C:\\work\\shop-old\\a.ts");
  assert.strictEqual(toolText("Bash", { command: "git status\ngit diff" }), "git status");
  assert.strictEqual(toolText("Task", { description: "Tests prüfen" }), "Tests prüfen");
  assert.strictEqual(toolText("Unknown", null), "");
});
