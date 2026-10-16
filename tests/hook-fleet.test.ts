// The real, built hook in a session Fleet runs itself (CLAUDE_FLEET_PROC) and a fresh start into Fleet's window.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vitest";
import { setFresh } from "../server/handoff";
import { hookEnv } from "./helpers/hook";
import { ROOT } from "./helpers/server";

afterEach(() => {
  delete process.env.CLAUDE_FLEET_HOME;
});

const withProc = (t: ReturnType<typeof hookEnv>, ev: object, proc = "0f4c7a52-3b1e-4c2a-9d1e-5a6b7c8d9e01") => {
  const t0 = Date.now();
  const out = execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
    input: JSON.stringify(ev),
    env: { ...t.env, CLAUDE_FLEET_PROC: proc },
    encoding: "utf8",
  });
  return { out, ms: Date.now() - t0 };
};

test("Start fresh into Fleet's window: the hook leaves the start to Fleet, opens nothing itself", () => {
  const t = hookEnv({ context: 5, config: { autoHandoff: { enabled: false } } });
  fs.writeFileSync(path.join(t.home, "runtime.json"), JSON.stringify({ port: 1, terminal: true }));
  process.env.CLAUDE_FLEET_HOME = t.home;
  assert.strictEqual(setFresh("s1", true, "fleet"), true);
  delete process.env.CLAUDE_FLEET_HOME;
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  const regFile = path.join(t.home, "handoffs.json");
  assert.strictEqual(JSON.parse(fs.readFileSync(regFile, "utf8")).byDir[t.repo].openIn, "fleet");
  fs.writeFileSync(t.file, "# Übergabe\n## Ziel\nPDF-Export fertig bauen\n");
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo, stop_hook_active: true });
  const e = JSON.parse(fs.readFileSync(regFile, "utf8")).byDir[t.repo];
  assert.strictEqual(e.pendingStart, true);
  assert.match(e.pendingPrompt, /PDF-Export fertig bauen/);
  assert.deepStrictEqual(t.launched(), [], "no launch-log entry: the hook starts nothing");
  assert.strictEqual(t.state("s1").detail, "Übergabe geschrieben – Fleet startet die neue Session im Fenster");
});

test("Start fresh into Fleet's window while Fleet has no terminal: falls back to a program", () => {
  const t = hookEnv({ context: 5, config: { autoHandoff: { enabled: false } } });
  fs.writeFileSync(path.join(t.home, "runtime.json"), JSON.stringify({ port: 1, terminal: false }));
  process.env.CLAUDE_FLEET_HOME = t.home;
  setFresh("s1", true, "fleet");
  delete process.env.CLAUDE_FLEET_HOME;
  t.hook({ hook_event_name: "Stop", session_id: "s1", cwd: t.repo });
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(t.home, "handoffs.json"), "utf8")).byDir[t.repo].openIn,
    "desktop",
  );
});

test("A session Fleet runs: the state names the process; the brake leaves approvals to the terminal", () => {
  const t = hookEnv();
  withProc(t, { hook_event_name: "SessionStart", session_id: "s1", cwd: t.repo, source: "startup" });
  assert.strictEqual(t.state("s1").proc, "0f4c7a52-3b1e-4c2a-9d1e-5a6b7c8d9e01");
  // Dashboard open: elsewhere the approval would wait there; in Fleet's terminal it is answered in the window.
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  const r = withProc(t, {
    hook_event_name: "PermissionRequest",
    session_id: "s1",
    cwd: t.repo,
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
  });
  assert.strictEqual(r.out, "");
  assert.ok(r.ms < 2000, `does not wait (${r.ms} ms)`);
  assert.strictEqual(
    fs.existsSync(path.join(t.home, "decisions")) && fs.readdirSync(path.join(t.home, "decisions")).length,
    false,
  );
  assert.strictEqual(t.state("s1").status, "needs_input");
  assert.strictEqual(t.state("s1").proc, "0f4c7a52-3b1e-4c2a-9d1e-5a6b7c8d9e01", "kept on later events");
  // A garbage mark is ignored, the hook still exits 0.
  withProc(t, { hook_event_name: "Stop", session_id: "s2", cwd: t.repo }, "../../x");
  assert.strictEqual(t.state("s2").proc, undefined);
});
