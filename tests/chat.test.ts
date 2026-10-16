// A session's conversation in its drawer (Ben: opening a session always shows the conversation and what Claude does
// right now): the reader on invented transcript lines, and /api/chat against the real, built server.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { CHAT_MAX, chatOf } from "../server/core/chat";
import type { ChatPage } from "../shared/types";
import { startServer } from "./helpers/server";

const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, s)).toISOString();
const you = (s: number, content: unknown) => ({ type: "user", timestamp: at(s), message: { role: "user", content } });
const claude = (s: number, content: object[]) => ({
  type: "assistant",
  timestamp: at(s),
  message: { model: "claude-opus-5-5", content },
});
const result = (s: number, id: string, extra: object = {}) => ({
  type: "user",
  timestamp: at(s),
  message: { content: [{ type: "tool_result", tool_use_id: id, ...extra }] },
});
const long = "Bitte baue den Checkout um.\n\nDanach:\n- Tests\n- PR öffnen";

test("chatOf: whole prompts and answers, one entry per tool call, the running call open", () => {
  const e = chatOf([
    you(0, long),
    claude(1, [
      { type: "text", text: "Ich lese zuerst den Code.\nDann baue ich um." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/shop/src/a.ts" } },
    ]),
    result(2, "t1"),
    claude(3, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test\nsecond line" } }]),
    result(4, "t2", { is_error: true, content: "Exit code 1\nmore" }),
    { ...claude(5, [{ type: "text", text: "sidechain" }]), isSidechain: true },
    claude(6, [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/w/shop/src/b.ts" } }]),
  ]);
  assert.deepStrictEqual(
    e.map((x) => [x.kind, x.tool, x.text, x.open ?? false]),
    [
      ["you", null, long, false],
      ["claude", null, "Ich lese zuerst den Code.\nDann baue ich um.", false],
      ["tool", "Read", "/w/shop/src/a.ts", false],
      ["tool", "Bash", "pnpm test", false],
      ["error", "Bash", "Exit code 1", false],
      ["tool", "Edit", "/w/shop/src/b.ts", true],
    ],
  );
});

test("chatOf: a call without a result that is not the newest entry was interrupted, not running", () => {
  const e = chatOf([
    claude(0, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 99" } }]),
    you(1, "[Request interrupted by user]"),
    you(2, "Lass das"),
  ]);
  assert.ok(e.every((x) => !x.open));
  assert.strictEqual(e.at(-1)?.text, "Lass das");
});

test("/api/chat: an old session has its whole conversation; unknown is empty, a bad id is 400", async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-chat-")));
  const claudeHome = path.join(tmp, "claude");
  const dir = path.join(claudeHome, "projects", "-tmp-shop");
  fs.mkdirSync(dir, { recursive: true });
  const lines: object[] = [you(0, long)];
  for (let i = 1; i <= CHAT_MAX + 10; i++) lines.push(claude(i, [{ type: "text", text: `Antwort ${i}` }]));
  fs.writeFileSync(path.join(dir, "old.jsonl"), lines.map((x) => `${JSON.stringify(x)}\n`).join(""));
  const srv = await startServer({ claudeHome });
  try {
    const p = JSON.parse((await srv.request("/api/chat?session=old")).body) as ChatPage;
    assert.strictEqual(p.session, "old");
    assert.strictEqual(p.entries.length, CHAT_MAX);
    assert.strictEqual(p.more, true);
    assert.strictEqual(p.entries.at(-1)?.text, `Antwort ${CHAT_MAX + 10}`);
    const none = JSON.parse((await srv.request("/api/chat?session=nope")).body) as ChatPage;
    assert.deepStrictEqual(none.entries, []);
    assert.strictEqual((await srv.request("/api/chat?session=..%2F..%2Fetc")).status, 400);
    assert.strictEqual((await srv.request("/api/chat")).status, 400);
  } finally {
    await srv.stop();
  }
});

test("/api/chat in demo mode: a working session ends with its running tool call", async () => {
  const srv = await startServer({ args: ["--demo"] });
  try {
    const o = JSON.parse((await srv.request("/api/overview")).body) as { sessions: { id: string; status: string }[] };
    const busy = o.sessions.find((s) => s.status === "working");
    assert.ok(busy);
    const p = JSON.parse((await srv.request(`/api/chat?session=${busy.id}`)).body) as ChatPage;
    assert.strictEqual(p.entries[0]?.kind, "you");
    const last = p.entries.at(-1);
    assert.ok(last?.kind !== "tool" || last.open, "a working session's last tool call runs");
  } finally {
    await srv.stop();
  }
});
