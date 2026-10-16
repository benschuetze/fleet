// The real, built hook marks the turns Fleet caused (fleet-turns.jsonl): the basis of Fleet's own cost.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { readMarks } from "../server/core/fleetturns";
import { mergeNow, setFresh } from "../server/handoff";
import { hookEnv, transcript } from "./helpers/hook";
import { ROOT } from "./helpers/server";

afterEach(() => {
  delete process.env.CLAUDE_FLEET_HOME;
});

const marks = (home: string) => readMarks(home, 0).map((m) => `${m.sessionId}:${m.phase}:${m.kind}`);
const withEnv = (t: ReturnType<typeof hookEnv>, ev: object, extra: Record<string, string>) =>
  execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
    input: JSON.stringify(ev),
    env: { ...t.env, ...extra },
    encoding: "utf8",
  });

test("A handoff Fleet asks for at the end of a turn is Fleet's turn until the next Stop", () => {
  const t = hookEnv({ limit: 90 });
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  assert.deepStrictEqual(marks(t.home), ["s1:begin:handoff"]);
  assert.ok(fs.existsSync(path.join(t.home, "turns", "s1")), "open until the next Stop");
  fs.writeFileSync(t.file, "# Übergabe\n## Offen\n- Export\n");
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo, stop_hook_active: true });
  assert.deepStrictEqual(marks(t.home), ["s1:begin:handoff", "s1:end:handoff"]);
  assert.ok(!fs.existsSync(path.join(t.home, "turns", "s1")));
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  assert.strictEqual(marks(t.home).length, 2, "a later Stop of the user's own turn adds nothing");
});

test("Start fresh while waiting: the prompt that writes the handoff opens Fleet's turn", () => {
  const t = hookEnv({ context: 5 });
  process.env.CLAUDE_FLEET_HOME = t.home;
  assert.strictEqual(setFresh("s1", true), true);
  delete process.env.CLAUDE_FLEET_HOME;
  t.hook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.repo, prompt: "Übergabe" });
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  assert.deepStrictEqual(marks(t.home), ["s1:begin:handoff", "s1:end:handoff"]);
});

test("The session that receives Fleet's handoff: its first turn is marked with the predecessor", () => {
  const t = hookEnv({ limit: 90 });
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  fs.writeFileSync(t.file, "# Übergabe\n## Offen\n- Export\n");
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo, stop_hook_active: true });
  t.hook({ hook_event_name: "SessionStart", session_id: "s2", cwd: t.repo, source: "startup" });
  t.hook({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: t.repo, prompt: "Mach weiter" });
  t.hook({ hook_event_name: "Stop", session_id: "s2", cwd: t.repo });
  const m = readMarks(t.home, 0).filter((x) => x.sessionId === "s2");
  assert.deepStrictEqual(
    m.map((x) => [x.phase, x.kind, x.prev]),
    [
      ["begin", "continue", ["s1"]],
      ["end", "continue", undefined],
    ],
  );
  t.hook({ hook_event_name: "SessionStart", session_id: "s3", cwd: t.repo, source: "startup" });
  assert.ok(!marks(t.home).some((x) => x.startsWith("s3")), "delivered once: the next session gets nothing");
});

test("A foreign HANDOFF.md is no Fleet turn", () => {
  const t = hookEnv();
  fs.writeFileSync(t.file, "# Übergabe\nfremd\n");
  t.hook({ hook_event_name: "SessionStart", session_id: "s2", cwd: t.repo, source: "startup" });
  assert.ok(!fs.existsSync(path.join(t.home, "fleet-turns.jsonl")));
});

test("Merged sessions: the new one's first turn is a merge with all predecessors", () => {
  const t = hookEnv();
  process.env.CLAUDE_FLEET_HOME = t.home;
  const tr = transcript(t.home, t.repo);
  mergeNow({
    root: t.repo,
    sessions: [
      { sid: "a", title: "A", transcript: tr },
      { sid: "b", title: "B", transcript: tr },
    ],
    now: Date.now(),
  });
  delete process.env.CLAUDE_FLEET_HOME;
  assert.ok(!fs.existsSync(path.join(t.home, "fleet-turns.jsonl")), "merging without a model costs nothing");
  t.hook({ hook_event_name: "SessionStart", session_id: "m", cwd: t.repo, source: "startup" });
  const b = readMarks(t.home, 0)[0];
  assert.deepStrictEqual([b?.sessionId, b?.kind, b?.prev], ["m", "merge", ["a", "b"]]);
});

test("Fix and briefing sessions Fleet started: the first turn is marked, unknown kinds and resumes are not", () => {
  const t = hookEnv();
  withEnv(
    t,
    { hook_event_name: "SessionStart", session_id: "f1", cwd: t.repo, source: "startup" },
    {
      CLAUDE_FLEET_TURN: "fix",
    },
  );
  withEnv(
    t,
    { hook_event_name: "SessionStart", session_id: "b1", cwd: t.repo, source: "startup" },
    {
      CLAUDE_FLEET_TURN: "brief",
    },
  );
  withEnv(
    t,
    { hook_event_name: "SessionStart", session_id: "x1", cwd: t.repo, source: "startup" },
    {
      CLAUDE_FLEET_TURN: "handoff",
    },
  );
  withEnv(
    t,
    { hook_event_name: "SessionStart", session_id: "r1", cwd: t.repo, source: "resume" },
    {
      CLAUDE_FLEET_TURN: "fix",
    },
  );
  t.hook({ hook_event_name: "Stop", session_id: "f1", cwd: t.repo });
  assert.deepStrictEqual(marks(t.home), ["f1:begin:fix", "b1:begin:brief", "f1:end:fix"]);
});

test("A session without Fleet's involvement leaves no mark at all", () => {
  const t = hookEnv();
  t.hook({ hook_event_name: "SessionStart", session_id: "s1", cwd: t.repo, source: "startup" });
  t.hook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: t.repo, prompt: "Baue etwas" });
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  assert.ok(!fs.existsSync(path.join(t.home, "fleet-turns.jsonl")));
  assert.ok(!fs.existsSync(path.join(t.home, "turns")));
});

test("An unwritable mark file costs the mark, never the hook: exit 0, the status is written", () => {
  const t = hookEnv();
  fs.mkdirSync(path.join(t.home, "fleet-turns.jsonl"), { recursive: true });
  withEnv(
    t,
    { hook_event_name: "SessionStart", session_id: "f1", cwd: t.repo, source: "startup" },
    {
      CLAUDE_FLEET_TURN: "fix",
    },
  );
  t.hook({ hook_event_name: "Stop", session_id: "f1", cwd: t.repo });
  assert.strictEqual(t.state("f1").status, "waiting");
});
