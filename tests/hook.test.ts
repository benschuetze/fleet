// The real, built hook and status line as Claude Code calls them: JSON on stdin, files in ~/.claude-fleet.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ROOT } from "./helpers/server";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-hook-"));
const env = { ...process.env, FLEET_LANG: "de", CLAUDE_FLEET_HOME: home };
const run = (file: string, ev: object) =>
  execFileSync(process.execPath, [path.join(ROOT, "dist", file)], { input: JSON.stringify(ev), env, encoding: "utf8" });
const state = (sid: string) => JSON.parse(fs.readFileSync(path.join(home, "state", `${sid}.json`), "utf8"));

test("Hook: writes the status, ignores invalid ids", () => {
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "sess-1", prompt: "Hallo", cwd: "/p" });
  run("hook.cjs", { hook_event_name: "Stop", session_id: "sess-1" });
  run("hook.cjs", { hook_event_name: "Stop", session_id: "../../evil" });
  const s = state("sess-1");
  assert.deepStrictEqual([s.status, s.lastPrompt, s.cwd], ["waiting", "Hallo", "/p"]);
  assert.ok(!fs.existsSync(path.join(home, "evil.json")));
  run("hook.cjs", { hook_event_name: "SubagentStop", session_id: "sess-1" });
  assert.strictEqual(state("sess-1").status, "waiting", "a subagent finishing changes nothing");
});

test("Hook: shell commands and local commands are no new task", () => {
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "sess-2", prompt: "Baue den Export", cwd: "/p" });
  run("hook.cjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-2",
    prompt: "<bash-input>node setup.js</bash-input><bash-stdout>ok</bash-stdout>",
    cwd: "/p",
  });
  run("hook.cjs", {
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-2",
    prompt: "<local-command-stdout>x</local-command-stdout>",
    cwd: "/p",
  });
  assert.strictEqual(state("sess-2").lastPrompt, "Baue den Export");
  assert.ok(
    !fs.readFileSync(path.join(home, "events.jsonl"), "utf8").includes("bash-input"),
    "not in the activity log either",
  );
});

test("Hook: Stop keeps the end of the answer, so a closing question is seen before the transcript", () => {
  const answer = `${"Bericht. ".repeat(120)}Soll ich den PR aufmachen?`;
  run("hook.cjs", { hook_event_name: "Stop", session_id: "ask-1", last_assistant_message: answer });
  const s = state("ask-1");
  assert.strictEqual(s.status, "waiting", "the hook does not decide; the server reads the question");
  assert.strictEqual(s.lastAnswer, answer.slice(-400));
  assert.ok(s.lastAnswer.endsWith("Soll ich den PR aufmachen?"));
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "ask-1", prompt: "ja" });
  assert.strictEqual(state("ask-1").lastAnswer, undefined, "a new turn drops the old answer");
});

test("Hook: StopFailure names the error and its details; an automatic resume after the limit keeps working", () => {
  run("hook.cjs", {
    hook_event_name: "StopFailure",
    session_id: "fail-1",
    error: "rate_limit",
    error_details: "429 Too Many Requests",
  });
  assert.deepStrictEqual(
    [state("fail-1").status, state("fail-1").detail],
    ["error", "rate_limit: 429 Too Many Requests"],
  );
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "fail-2", prompt: "los" });
  run("hook.cjs", {
    hook_event_name: "Notification",
    session_id: "fail-2",
    notification_type: "quota_auto_resume_fired",
    message: "Limit reset, resuming",
  });
  assert.strictEqual(state("fail-2").status, "working");
  run("hook.cjs", {
    hook_event_name: "Notification",
    session_id: "fail-2",
    notification_type: "quota_auto_resume_disabled",
    message: "Auto resume is off",
  });
  assert.strictEqual(state("fail-2").status, "needs_input");
});

test("Hook: exits 0 on odd fields of the new paths and when its folder cannot be written", () => {
  // execFileSync throws on any exit code other than 0
  for (const ev of [
    { hook_event_name: "Stop", session_id: "odd-1", last_assistant_message: { not: "a string" } },
    { hook_event_name: "Stop", session_id: "odd-1", last_assistant_message: "x".repeat(2_000_000) },
    { hook_event_name: "StopFailure", session_id: "odd-2", error: "rate_limit", error_details: { code: 429 } },
    { hook_event_name: "StopFailure", session_id: "odd-2", error: ["x"], error_details: null },
    { hook_event_name: "Notification", session_id: "odd-3", notification_type: { x: 1 }, message: 5 },
  ])
    assert.doesNotThrow(() => run("hook.cjs", ev));
  assert.ok(state("odd-1").lastAnswer.length <= 400);
  assert.match(state("odd-2").detail, /^\[?"?x/);
  // The Fleet folder is a file: nothing can be written, the session still goes on
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ro-")), "home");
  fs.writeFileSync(blocked, "not a folder");
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
      input: JSON.stringify({ hook_event_name: "StopFailure", session_id: "ro-1", error: "rate_limit" }),
      env: { ...env, CLAUDE_FLEET_HOME: blocked },
    }),
  );
});

test("Hook: never blocks a session, even when stdin is never closed", async () => {
  const { spawn } = await import("node:child_process");
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write('{"hook_event_name":"Stop","session_id":"open-1"');
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - t0 < 5000, "the 3 s guard ends it");
});

test("Hook: never throws, always exits 0, even on garbage input", () => {
  for (const input of ["", "{", "null", '{"hook_event_name":"Stop"}', "x".repeat(100000)]) {
    assert.doesNotThrow(() => execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], { input, env }));
  }
});

test("Status line: stores limits and context", () => {
  const out = run("statusline.cjs", {
    session_id: "sl-1",
    model: { display_name: "Opus" },
    context_window: {
      context_window_size: 200000,
      used_percentage: 42,
      current_usage: { input_tokens: 1000, cache_read_input_tokens: 83000 },
    },
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  });
  assert.match(out, /Kontext 42 %/);
  const j = JSON.parse(fs.readFileSync(path.join(home, "statusline", "sl-1.json"), "utf8"));
  assert.deepStrictEqual(
    [j.context.size, j.context.tokens, j.rateLimits.five_hour.used_percentage],
    [200000, 84000, 12.5],
  );
});

test("Hook: the Desktop question box (wrap_up ask) and a session offer reach Fleet before the transcript", async () => {
  const { deriveStatus } = await import("../server/core/status");
  const statusOf = (sid: string) => {
    const h = state(sid);
    const s = { id: sid, source: "local", mtime: h.at - 1000, hook: h } as Parameters<typeof deriveStatus>[0];
    deriveStatus(s, { staleMinutes: 20 }, h.at + 1000);
    return s;
  };
  const ask = "PR #3 mergen, sobald die CI grün ist?";
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "box-1", prompt: "Baue den Export" });
  // PreToolUse right after the prompt: the 1.5 s throttle for quiet events must not swallow the question
  run("hook.cjs", {
    hook_event_name: "PreToolUse",
    session_id: "box-1",
    tool_name: "mcp__ccd_turn__wrap_up",
    tool_input: { recap: "Export gebaut.", ask },
  });
  assert.strictEqual(state("box-1").boxAsk, ask);
  run("hook.cjs", { hook_event_name: "PostToolUse", session_id: "box-1", tool_name: "mcp__ccd_turn__wrap_up" });
  run("hook.cjs", { hook_event_name: "Stop", session_id: "box-1", last_assistant_message: "PR ist offen." });
  assert.strictEqual(state("box-1").boxAsk, ask, "kept through the end of the turn");
  const s = statusOf("box-1");
  assert.deepStrictEqual([s.status, s.detail], ["needs_input", ask]);
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "box-1", prompt: "Mergen" });
  assert.strictEqual(state("box-1").boxAsk, undefined, "the answer clears it");
  // A box without a question, odd input: done
  run("hook.cjs", {
    hook_event_name: "PreToolUse",
    session_id: "box-2",
    tool_name: "mcp__ccd_turn__wrap_up",
    tool_input: { recap: "x", ask: { no: 1 } },
  });
  run("hook.cjs", { hook_event_name: "Stop", session_id: "box-2" });
  assert.strictEqual(statusOf("box-2").status, "waiting");

  // The offer card blocks the turn until the user picks; a proposal of its own does not
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "off-1", prompt: "x" });
  run("hook.cjs", {
    hook_event_name: "PreToolUse",
    session_id: "off-1",
    tool_name: "mcp__ccd_session__start_session",
    tool_input: { initiation: "offer", title: "Bremse kürzen" },
  });
  assert.strictEqual(state("off-1").offer, "Bremse kürzen");
  assert.strictEqual(statusOf("off-1").status, "needs_input");
  run("hook.cjs", {
    hook_event_name: "PostToolUse",
    session_id: "off-1",
    tool_name: "mcp__ccd_session__start_session",
  });
  assert.strictEqual(state("off-1").offer, undefined, "answered: the throttle must not keep the offer");
  assert.strictEqual(statusOf("off-1").status, "working");
  run("hook.cjs", {
    hook_event_name: "PreToolUse",
    session_id: "off-2",
    tool_name: "mcp__ccd_session__start_session",
    tool_input: { initiation: "own_initiative", title: "y", prompt: "z" },
  });
  assert.strictEqual(state("off-2").offer, undefined);
});

test("Hook: a message the app injects (CI monitor, side sessions, other sessions) keeps the open question", async () => {
  const { deriveStatus } = await import("../server/core/status");
  const statusOf = (sid: string) => {
    const h = state(sid);
    const s = { id: sid, source: "local", mtime: h.at - 1000, hook: h } as Parameters<typeof deriveStatus>[0];
    deriveStatus(s, { staleMinutes: 20 }, h.at + 1000);
    return s;
  };
  const ask = "PR #3 mergen, sobald die CI grün ist?";
  const injected = [
    "<ci-monitor-event>CI für PR #3: 2 von 5 Checks fertig</ci-monitor-event>",
    "<side-sessions-event>Session export-tests hat ihren Turn beendet</side-sessions-event>",
    '<cross-session-message from="local_abc">Bitte Port 5199 freigeben</cross-session-message>',
    "<task-notification>Hintergrundbefehl beendet</task-notification>",
  ];
  for (const [i, text] of injected.entries()) {
    const sid = `inj-${i}`;
    run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "Baue den Export" });
    run("hook.cjs", {
      hook_event_name: "PreToolUse",
      session_id: sid,
      tool_name: "mcp__ccd_turn__wrap_up",
      tool_input: { recap: "PR offen.", ask },
    });
    run("hook.cjs", { hook_event_name: "Stop", session_id: sid, last_assistant_message: "PR ist offen." });
    // Live case (Fleet 5.0.0): seconds later the app starts a short turn of its own
    run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: text });
    const mid = state(sid);
    assert.strictEqual(mid.status, "working", `${text}: the auto-turn may show as working`);
    assert.strictEqual(mid.boxAsk, ask, `${text}: no answer of the user`);
    assert.strictEqual(mid.lastPrompt, "Baue den Export", `${text}: never the task text (B8)`);
    run("hook.cjs", { hook_event_name: "Stop", session_id: sid, last_assistant_message: "CI läuft noch." });
    const s = statusOf(sid);
    assert.deepStrictEqual([s.status, s.detail], ["needs_input", ask], `${text}: the question waits again`);
  }
  // The auto-turn ends with a new box: the new question wins
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "inj-0", prompt: injected[0] });
  run("hook.cjs", {
    hook_event_name: "PreToolUse",
    session_id: "inj-0",
    tool_name: "mcp__ccd_turn__wrap_up",
    tool_input: { recap: "CI grün.", ask: "Jetzt mergen?" },
  });
  run("hook.cjs", { hook_event_name: "Stop", session_id: "inj-0", last_assistant_message: "CI ist grün." });
  assert.strictEqual(statusOf("inj-0").detail, "Jetzt mergen?");
  // The user's own answer still clears it, even one that starts with a tag of its own
  run("hook.cjs", { hook_event_name: "UserPromptSubmit", session_id: "inj-0", prompt: "<b>Mergen</b>" });
  assert.strictEqual(state("inj-0").boxAsk, undefined);
});

test("Hook: a permission request is tied to its tool call, even when the call's PreToolUse was too quiet to write", () => {
  const sid = "wait-1";
  const ev = (o: object) => run("hook.cjs", { session_id: sid, cwd: "/p", ...o });
  ev({ hook_event_name: "UserPromptSubmit", prompt: "Räum auf" });
  ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" }, tool_use_id: "r1" });
  // Within the 1.5 s quiet window: the state is not written, the call is still noted.
  ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "p1" });
  ev({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm x" } });
  const s = state(sid);
  assert.strictEqual(s.status, "needs_input");
  assert.deepStrictEqual(
    s.waitFor.map((w: { id: string }) => w.id),
    ["p1"],
  );
  ev({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a" }, tool_use_id: "r1" });
  assert.strictEqual(state(sid).status, "needs_input", "a parallel tool's result answers nothing");
  assert.match(state(sid).detail, /Bash/);
  ev({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm x" }, tool_use_id: "p1" });
  assert.strictEqual(state(sid).status, "working");
  assert.strictEqual(state(sid).waitFor, undefined);
});

test("Hook: exits 0 on a broken list of recent calls and odd ids", () => {
  const sid = "wait-2";
  fs.mkdirSync(path.join(home, "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "state", `${sid}.calls`), '[{"id":1},null,"x",{"id":"a"');
  for (const ev of [
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "../x" },
    { hook_event_name: "PreToolUse", tool_name: { x: 1 }, tool_input: "plain", tool_use_id: "t1", agent_id: 5 },
    { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: null, agent_id: "../../a" },
  ])
    assert.doesNotThrow(() => run("hook.cjs", { session_id: sid, ...ev }));
  assert.strictEqual(state(sid).status, "needs_input");
  assert.strictEqual(state(sid).waitFor[0].agent, undefined, "an invalid agent id is the main thread");
});

test("Hook: a permission request names its kind in the log and masks obvious secrets (review #145)", () => {
  const fake = ["not", "real", "42"].join("-"); // built at run time: secret scanners must not flag the test
  run("hook.cjs", {
    hook_event_name: "PermissionRequest",
    session_id: "perm-1",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Rot oder blau?", header: "Farbe", options: [] }] },
  });
  run("hook.cjs", {
    hook_event_name: "PermissionRequest",
    session_id: "perm-2",
    tool_name: "Bash",
    tool_input: { command: `curl -H "Authorization: Bearer ${fake}" "https://x.test/a?api_key=${fake}&q=1"` },
  });
  const lines = fs
    .readFileSync(path.join(home, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const q = lines.find((l) => l.sessionId === "perm-1");
  const b = lines.find((l) => l.sessionId === "perm-2");
  assert.strictEqual(q.waits, "question");
  assert.strictEqual(b.waits, "approval");
  for (const text of [b.detail, state("perm-2").detail]) {
    assert.match(text, /^Freigabe für Bash: curl/);
    assert.ok(!text.includes(fake), text);
    assert.match(text, /q=1/, "the rest of the command stays");
  }
});
