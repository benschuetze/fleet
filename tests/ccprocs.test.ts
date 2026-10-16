// Claude Code's own process status (~/.claude/sessions/<pid>.json, server/core/ccprocs.ts) settles what hooks and
// transcripts only guess. Found on 15 Oct: four sessions "no sign of life for 202 min" were all waiting for Ben.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { readClaudeProcs } from "../server/core/ccprocs";
import { parseFull } from "../server/core/sessions";
import { deriveStatus } from "../server/core/status";
import type { Session } from "../shared/types";

process.env.CLAUDE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-home-"));
const cfg = { staleMinutes: 20 };
const T = Date.parse("2026-10-15T10:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

async function session(lines: object[], mtime: number): Promise<Session> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cc-"));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return { ...(await parseFull(f, fs.statSync(f))).data, id: "s", source: "local", mtime };
}
const prompt = (t: number) => ({
  type: "user",
  cwd: "/p",
  timestamp: iso(t),
  message: { role: "user", content: "Los" },
});
const bash = (t: number) => ({
  type: "assistant",
  timestamp: iso(t),
  message: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm e2e" } }],
  },
});
const done = (t: number, text = "Fertig.") => ({
  type: "assistant",
  timestamp: iso(t),
  message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
});

test("readClaudeProcs: live processes only, valid ids and statuses, the newest entry per session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  const w = (pid: number, o: object) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...o }));
  w(101, { sessionId: "aaa-1", status: "waiting", statusUpdatedAt: 5 });
  w(102, { sessionId: "aaa-1", status: "busy", statusUpdatedAt: 9 });
  w(103, { sessionId: "dead-1", status: "busy", statusUpdatedAt: 9 });
  w(104, { sessionId: "../evil", status: "busy" });
  w(105, { sessionId: "odd-1", status: "sleeping" });
  fs.writeFileSync(path.join(dir, "101.9f3c.key"), "never read");
  const gone = new Set<string>();
  const m = readClaudeProcs(home, (pid) => pid !== 103 && pid !== 101, gone);
  assert.deepStrictEqual([...m.entries()], [["aaa-1", { status: "busy", at: 9, pid: 102 }]]);
  // Only a session without any live process is gone (aaa-1 has a dead 101 and a live 102).
  assert.deepStrictEqual([...gone], ["dead-1"]);
  assert.strictEqual(readClaudeProcs(path.join(home, "nothing")).size, 0);
  // The real check: this test's own process is alive.
  w(process.pid, { sessionId: "me-1", status: "idle" });
  assert.strictEqual(readClaudeProcs(home).get("me-1")?.status, "idle");
});

test("waiting: an approval prompt nobody reported is a wait, not a stall", async () => {
  const s = await session([prompt(T), bash(T + 1000)], T + 1000);
  s.cc = { status: "waiting", at: T + 2000, pid: 1 };
  deriveStatus(s, cfg, T + 202 * 60e3);
  assert.deepStrictEqual([s.status, s.statusSource], ["needs_input", "claude"]);
  assert.match(String(s.detail || s.ask?.text), /wartet in der App auf Freigabe für Bash/);
  assert.notStrictEqual(s.failure?.kind, "stuck");
});

test("busy: a long tool run is alive, never 'no sign of life'", async () => {
  const s = await session([prompt(T), bash(T + 1000)], T + 1000);
  deriveStatus(s, cfg, T + 45 * 60e3);
  assert.strictEqual(s.status, "stale", "without Claude's word: stale, as before");
  const t = await session([prompt(T), bash(T + 1000)], T + 1000);
  t.cc = { status: "busy", at: T + 1500, pid: 1 };
  deriveStatus(t, cfg, T + 45 * 60e3);
  assert.strictEqual(t.status, "working");
  assert.strictEqual(t.failure, null);
});

test("idle: the turn ended, whatever the last hook said; a closing question still waits", async () => {
  const s = await session([prompt(T), bash(T + 1000)], T + 1000);
  s.hook = {
    sessionId: "s",
    status: "working",
    event: "PreToolUse",
    detail: "Bash",
    at: T + 1000,
    startedAt: T,
    statusSince: T,
    lastTool: "Bash",
  };
  s.cc = { status: "idle", at: T + 5000, pid: 1 };
  deriveStatus(s, cfg, T + 60e3);
  assert.deepStrictEqual([s.status, s.statusSource], ["waiting", "claude"]);
  const q = await session([prompt(T), done(T + 2000, "Soll ich den PR aufmachen?")], T + 2000);
  q.cc = { status: "idle", at: T + 3000, pid: 1 };
  deriveStatus(q, cfg, T + 60e3);
  assert.strictEqual(q.status, "needs_input", "the question is the wait, idle does not undo it");
});

test("busy after a finished turn: a new turn Fleet did not hear of is working; Fleet's own questions stay", async () => {
  const s = await session([prompt(T), done(T + 2000)], T + 2000);
  s.cc = { status: "busy", at: T + 9000, pid: 1 };
  deriveStatus(s, cfg, T + 10e3);
  assert.strictEqual(s.status, "working");
  const old = await session([prompt(T), done(T + 2000)], T + 2000);
  old.cc = { status: "busy", at: T + 1000, pid: 1 };
  deriveStatus(old, cfg, T + 10e3);
  assert.strictEqual(old.status, "waiting", "an older busy than the transcript's end changes nothing");
  const held = await session([prompt(T), bash(T + 1000)], T + 1000);
  held.hook = {
    sessionId: "s",
    status: "needs_input",
    event: "PreToolUse",
    detail: "Fleet hält an",
    at: T + 1500,
    startedAt: T,
    statusSince: T,
    lastTool: "Bash",
  };
  held.cc = { status: "busy", at: T + 1600, pid: 1 };
  deriveStatus(held, cfg, T + 5000);
  assert.strictEqual(held.status, "needs_input", "the brake holds the process busy: Fleet's question stays");
});

test("waiting after a tool that never asks for approval names no approval", async () => {
  const s = await session(
    [
      prompt(T),
      {
        type: "assistant",
        timestamp: iso(T + 1000),
        message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: {} }] },
      },
    ],
    T + 1000,
  );
  s.cc = { status: "waiting", at: T + 2000, pid: 1 };
  deriveStatus(s, cfg, T + 5000);
  assert.strictEqual(s.status, "needs_input");
  assert.strictEqual(s.ask?.text, "wartet in der App auf dich");
});

// Live 16.10.2026: five test sessions in terminal tabs were closed; Claude Code sent no SessionEnd and Fleet showed
// all five "wartet" for good (the old probes for 1649 min). Their process files name dead pids.
test("A process that died without SessionEnd: a held prompt and a running turn end; a closing question stays", async () => {
  const held = await session([prompt(T), bash(T + 1000)], T + 1000);
  held.hook = {
    sessionId: held.id,
    status: "needs_input",
    event: "Notification",
    detail: "Freigabe für Bash: rm -r tmp",
    at: T + 2000,
    waitFor: [{ key: "Bash:x1", since: T + 2000 }],
  } as never;
  held.ccGone = true;
  deriveStatus(held, cfg, T + 60e3);
  assert.deepStrictEqual([held.status, held.ask], ["ended", null]);
  assert.match(String(held.detail), /Prozess beendet/);

  const running = await session([prompt(T), bash(T + 1000)], T + 1000);
  running.ccGone = true;
  deriveStatus(running, cfg, T + 3 * 60 * 60e3);
  assert.strictEqual(running.status, "ended", "no 'no sign of life' alarm for a process that is gone");

  const asked = await session([prompt(T), done(T + 1000, "Soll ich die README kürzen?")], T + 1000);
  asked.ccGone = true;
  deriveStatus(asked, cfg, T + 60e3);
  assert.strictEqual(asked.status, "needs_input", "a question in words can be answered after a resume");
});

// Review #146: "gone" must be certain. Any sign of a live process (an unknown status, a file not yet readable), a pid
// of another machine's domain, or a hook event of the last seconds (a new process not yet written) keeps it.
test("gone is certain: a live pid with an odd status, a half-written file and another pid domain keep the session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir);
  const w = (pid: number, o: object) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...o }));
  const dead = (pid: number) => pid >= 200;
  w(201, { sessionId: "odd-2", status: "busy" });
  w(102, { sessionId: "odd-2", status: "compacting" });
  w(203, { sessionId: "far-1", status: "busy", pidDomain: "some-other-host" });
  w(204, { sessionId: "here-1", status: "busy", pidDomain: process.platform });
  w(106, { sessionId: "linux-1", status: "waiting", pidDomain: "linux:abc:pid:[4026531836]" });
  let gone = new Set<string>();
  readClaudeProcs(home, (pid) => !dead(pid), gone);
  assert.deepStrictEqual(
    [...gone],
    ["here-1"],
    "a live pid with an unknown status still lives; another domain is unknown",
  );
  fs.writeFileSync(path.join(dir, "105.json"), "{ half");
  gone = new Set<string>();
  readClaudeProcs(home, (pid) => !dead(pid), gone);
  assert.deepStrictEqual([...gone], [], "an unreadable file may be the live one");
});

test("gone waits a moment: a hook event of the last seconds keeps the prompt", async () => {
  const s = await session([prompt(T), bash(T + 1000)], T + 1000);
  s.hook = {
    sessionId: s.id,
    status: "needs_input",
    event: "PermissionRequest",
    detail: "Freigabe für Bash: rm -r tmp",
    at: T + 2000,
    waitFor: [{ key: "Bash:x1", since: T + 2000 }],
  } as never;
  s.ccGone = true;
  deriveStatus(s, cfg, T + 4000);
  assert.strictEqual(s.status, "needs_input", "a new process may not have written its file yet");
});

// Live retest 16.10.2026: a session killed with -9 showed "ended", then "waits" again: the next claude process that
// started removed the dead process files. A session once certainly gone stays gone until it shows life again.
test("gone is remembered: the dead file vanishing changes nothing, a live file or a newer hook event does", async () => {
  const { stickyGone } = await import("../server/core/ccprocs");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gone-")), "gone.json");
  const none = new Set<string>();
  const at = (m: Record<string, number>) => (sid: string) => m[sid] || 0;
  let gone = new Set(["dead-1"]);
  stickyGone(file, gone, none, at({ "dead-1": T }), T + 60e3);
  gone = new Set(); // the file was cleaned up by the next process
  stickyGone(file, gone, none, at({ "dead-1": T }), T + 120e3);
  assert.deepStrictEqual([...gone], ["dead-1"], "still gone without its file");
  gone = new Set();
  stickyGone(file, gone, new Set(["dead-1"]), at({}), T + 130e3);
  assert.deepStrictEqual([...gone], [], "resumed: a live process");
  gone = new Set(["dead-2"]);
  stickyGone(file, gone, none, at({ "dead-2": T }), T + 60e3);
  gone = new Set();
  stickyGone(file, gone, none, at({ "dead-2": T + 90e3 }), T + 100e3);
  assert.deepStrictEqual([...gone], [], "a hook event after it was found gone: alive again");
  gone = new Set();
  stickyGone(file, gone, none, at({}), T + 120e3);
  assert.deepStrictEqual([...gone], [], "and it stays forgotten");
});

test("gone is remembered, review: a live pid with an unknown status revives it, as readClaudeProcs counts it", async () => {
  const { stickyGone } = await import("../server/core/ccprocs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  fs.mkdirSync(path.join(home, "sessions"));
  const file = path.join(home, "gone.json");
  fs.writeFileSync(file, JSON.stringify({ "back-1": T, "future-1": T + 10 * 86400e3 }));
  fs.writeFileSync(
    path.join(home, "sessions", "301.json"),
    JSON.stringify({ pid: 301, sessionId: "back-1", status: "compacting" }),
  );
  const gone = new Set<string>();
  const living = new Set<string>();
  const cc = readClaudeProcs(home, () => true, gone, living);
  assert.strictEqual(cc.size, 0, "an unknown status reports nothing");
  stickyGone(file, gone, living, () => 0, T + 60e3);
  assert.deepStrictEqual([...gone], [], "resumed with an unknown status: alive; a time in the future is dropped");
});
