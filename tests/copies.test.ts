// A moved project leaves its transcripts in two project folders: every scanner counts a session once.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { transcripts } from "../server/cli/audit";
import { createLogReader } from "../server/core/log";
import { newestCopies } from "../server/core/paths";
import { scanSessions, transcriptOf } from "../server/core/sessions";
import { collectUsage } from "../server/core/usage";

const ID = "efe9a5b6-02d8-498e-a8c0-10a6912af745";
const line = (text: string) =>
  `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), cwd: "/p", message: { role: "user", content: text } })}\n`;
const answer = (id: string, tool = false) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    cwd: "/p",
    message: {
      id,
      model: "claude-sonnet-5-5",
      content: tool ? [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: { command: "ls" } }] : [],
      usage: { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })}\n`;

function home() {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-copies-"));
  const old = path.join(claudeHome, "projects", "-Users-ben-Downloads-app");
  const now = path.join(claudeHome, "projects", "-Users-ben-Projects-app");
  fs.mkdirSync(path.join(old, ID, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(now, ID, "subagents"), { recursive: true });
  const before = line("vor dem Umzug") + answer("m1", true);
  fs.writeFileSync(path.join(old, `${ID}.jsonl`), before);
  fs.writeFileSync(path.join(now, `${ID}.jsonl`), before + line("nach dem Umzug") + answer("m2", true));
  const sub = answer("s1");
  fs.writeFileSync(path.join(old, ID, "subagents", "agent-1.jsonl"), sub);
  fs.writeFileSync(path.join(now, ID, "subagents", "agent-1.jsonl"), sub);
  const past = new Date(Date.now() - 3600e3);
  for (const f of [`${ID}.jsonl`, `${ID}/subagents/agent-1.jsonl`]) fs.utimesSync(path.join(old, f), past, past);
  return { claudeHome, old, now };
}

test("newestCopies keeps the newest copy per path below the project folder, subagents included", () => {
  const p = "/c/projects";
  const st = (mtimeMs: number, size = 1) => ({ mtimeMs, size });
  const items = [
    { file: `${p}/a/${ID}.jsonl`, st: st(1) },
    { file: `${p}/b/${ID}.jsonl`, st: st(2) },
    { file: `${p}/a/${ID}/subagents/agent-1.jsonl`, st: st(5) },
    { file: `${p}/b/${ID}/subagents/agent-1.jsonl`, st: st(5, 9) },
    { file: `${p}/a/other.jsonl`, st: st(1) },
    { file: `${p}/loose-1.jsonl`, st: st(1) },
    { file: `${p}/loose-2.jsonl`, st: st(2) },
    null,
  ];
  assert.deepStrictEqual(
    newestCopies(p, items).map((x) => x.file),
    [
      `${p}/b/${ID}.jsonl`,
      `${p}/b/${ID}/subagents/agent-1.jsonl`,
      `${p}/a/other.jsonl`,
      `${p}/loose-1.jsonl`,
      `${p}/loose-2.jsonl`,
    ],
  );
});

test("the session list, fleet audit and transcriptOf read only the moved copy", async () => {
  const { claudeHome, now } = home();
  const scanned = await scanSessions({ claudeHome, sessionMaxAgeDays: 30 });
  assert.deepStrictEqual(
    scanned.map((s) => s.id),
    [ID],
  );
  assert.deepStrictEqual(transcripts(claudeHome, 0), [path.join(now, `${ID}.jsonl`)]);
  assert.strictEqual(await transcriptOf(claudeHome, ID), path.join(now, `${ID}.jsonl`));
});

test("usage and the log count a moved session once", async () => {
  const { claudeHome } = home();
  const u = await collectUsage({ claudeHome, _fleetHome: path.join(claudeHome, "fleet"), statsDays: 30, prices: {} });
  assert.strictEqual(u.perSession[ID]?.n, 3, "m1, m2 and the subagent, each once");
  const log = await createLogReader().read(claudeHome);
  assert.strictEqual(
    log.lines.filter((l) => l.session === ID && l.kind === "tool").length,
    2,
    "two tool calls, each once",
  );
});
