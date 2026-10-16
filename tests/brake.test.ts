// The brake through the real, built hook: pause, ask in Fleet, pass the answer to Claude.
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { answer, list } from "../server/core/brake";
import type { Decision } from "../shared/types";
import { ROOT } from "./helpers/server";

afterEach(() => {
  delete process.env.CLAUDE_FLEET_HOME;
});

function setup(o: { brake?: object; limit?: number } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-brake-"));
  const home = path.join(tmp, "fleet");
  const repo = path.join(tmp, "projekt");
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(home, "statusline"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ brake: { waitSeconds: 3, loop: true, ...o.brake } }),
  );
  if (o.limit !== undefined) {
    fs.writeFileSync(
      path.join(home, "statusline", "s1.json"),
      JSON.stringify({
        sessionId: "s1",
        at: Date.now(),
        model: "Sonnet 5.5",
        context: null,
        rateLimits: { five_hour: { used_percentage: o.limit, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      }),
    );
  }
  let n = 0;
  /** Starts the hook in the background; returns its output once it ends. */
  const hook = (ev: Record<string, unknown>) =>
    new Promise<{ out: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      const c = spawn(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
        env: { ...process.env, FLEET_LANG: "de", CLAUDE_FLEET_HOME: home },
      });
      let out = "";
      c.stdout.on("data", (d) => {
        out += d;
      });
      c.on("exit", () => resolve({ out, ms: Date.now() - t0 }));
      c.stdin.end(JSON.stringify({ session_id: "s1", cwd: repo, ...ev }));
    });
  const pre = (tool: string, input: unknown) =>
    hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: `tu${n++}` });
  const decisions = (): Decision[] => {
    try {
      return fs
        .readdirSync(path.join(home, "decisions"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(home, "decisions", f), "utf8")));
    } catch {
      return [];
    }
  };
  /** Like the server: write the answer into the open decision as soon as it exists. */
  const answerSoon = (value: string) => {
    const iv = setInterval(() => {
      const d = decisions().find((x) => x.status === "open");
      if (!d) return;
      clearInterval(iv);
      // Atomic, as the server writes it (decisions.ts): the hook never sees half a file from here.
      const file = path.join(home, "decisions", `${d.id}.json`);
      fs.writeFileSync(
        `${file}.tmp`,
        JSON.stringify({ ...d, status: "answered", answer: value, answeredAt: Date.now() }),
      );
      fs.renameSync(`${file}.tmp`, file);
    }, 50);
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(home, "state", "s1.json"), "utf8"));
  return { home, repo, hook, pre, decisions, answerSoon, state };
}

test("The same call three times: Fleet pauses, the answer from the dashboard goes to Claude", async () => {
  const t = setup();
  assert.strictEqual((await t.pre("Bash", { command: "pnpm test" })).out, "");
  assert.strictEqual((await t.pre("Bash", { command: "pnpm test" })).out, "");
  t.answerSoon("rethink");
  const j = JSON.parse((await t.pre("Bash", { command: "pnpm test" })).out);
  assert.strictEqual(j.hookSpecificOutput.permissionDecision, "deny", "the call does not run");
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /innehalten und neu ansetzen/);
  const [d] = t.decisions();
  assert.deepStrictEqual([d?.kind, d?.status, d?.answer], ["loop", "applied", "rethink"]);
  assert.match(String(d?.title), /3× derselbe Bash-Aufruf/);
  assert.ok(
    d?.options.some((o) => o.id === "escalate"),
    "Sonnet or unknown: an Opus subagent is offered",
  );
  assert.strictEqual(t.state().status, "working", "after the answer no longer 'needs you'");
});

test("Test, change, test is progress, not a loop", async () => {
  const t = setup();
  for (let i = 0; i < 4; i++) {
    assert.strictEqual((await t.pre("Bash", { command: "pnpm test" })).out, "");
    assert.strictEqual(
      (await t.pre("Edit", { file_path: "a.js", old_string: String(i), new_string: String(i + 1) })).out,
      "",
    );
  }
  assert.deepStrictEqual(t.decisions(), []);
});

test("Without an answer the session continues after the deadline; a late answer applies at the next call", async () => {
  const t = setup({ brake: { waitSeconds: 2 } });
  for (let i = 0; i < 2; i++) await t.pre("Read", { file_path: "x" });
  const r = await t.pre("Read", { file_path: "x" });
  assert.strictEqual(r.out, "", "continues without an instruction");
  assert.ok(r.ms >= 1800 && r.ms < 6000, `waited (${r.ms} ms)`);
  const [d] = t.decisions();
  assert.strictEqual(d?.status, "expired");
  // The user decides later: stop.
  fs.writeFileSync(
    path.join(t.home, "decisions", `${d?.id}.json`),
    JSON.stringify({ ...d, status: "answered", answer: "stop" }),
  );
  const late = JSON.parse((await t.pre("Grep", { pattern: "y" })).out);
  assert.strictEqual(late.continue, false);
  assert.match(late.stopReason, /angehalten/);
});

test("Limit almost used up: a handoff on request, Fleet trusts it afterwards", async () => {
  const t = setup({ limit: 97 });
  t.answerSoon("handoff");
  const j = JSON.parse((await t.pre("Edit", { file_path: "a.js" })).out);
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /HANDOFF\.md/);
  assert.strictEqual(t.decisions()[0]?.kind, "limit");
  const reg = JSON.parse(fs.readFileSync(path.join(t.home, "handoffs.json"), "utf8"));
  assert.strictEqual(reg.byDir[t.repo].key, "brake", "registered as requested by Fleet");
  assert.strictEqual((await t.pre("Edit", { file_path: "b.js" })).out, "", "not again in the same block");
});

test("A run of errors is detected, switching off works, and questions to the user are never braked", async () => {
  const t = setup();
  for (let i = 0; i < 5; i++) {
    await t.pre("Bash", { command: `build ${i}` });
    await t.hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: `tu${i}` });
  }
  t.answerSoon("continue");
  assert.strictEqual((await t.pre("Bash", { command: "build 9" })).out, "", '"carry on": the call runs');
  assert.match(String(t.decisions()[0]?.title), /5 fehlgeschlagene Aufrufe/);

  const off = setup({ brake: { enabled: false } });
  for (let i = 0; i < 4; i++) assert.strictEqual((await off.pre("Bash", { command: "x" })).out, "");
  assert.deepStrictEqual(off.decisions(), []);

  const ask = setup();
  for (let i = 0; i < 4; i++) await ask.pre("AskUserQuestion", { q: "x" });
  assert.deepStrictEqual(ask.decisions(), []);
});

test("Answers: only offered ones, only once, also after the deadline", async () => {
  const t = setup({ brake: { waitSeconds: 2 } });
  for (let i = 0; i < 3; i++) await t.pre("Bash", { command: "x" });
  process.env.CLAUDE_FLEET_HOME = t.home;
  const [d] = t.decisions();
  assert.ok(d);
  assert.strictEqual(d.status, "expired");
  assert.deepStrictEqual(answer(d.id, "quatsch"), { ok: false, status: 400, error: "ungültige Antwort" });
  assert.strictEqual(answer(d.id, "stop").ok, true, "a late answer is accepted");
  const twice = answer(d.id, "continue");
  assert.ok(!twice.ok && twice.status === 409, "not twice");
  const missing = answer("gibt-es-nicht", "stop");
  assert.ok(!missing.ok && missing.status === 404);
  assert.deepStrictEqual(
    list().map((x) => x.status),
    ["answered"],
  );
});

test("Default: loops do not pause, only for those who switch it on", async () => {
  // Measured on real transcripts: the rule would only have paused while waiting in the browser.
  const t = setup({ brake: { loop: undefined } });
  for (let i = 0; i < 4; i++)
    assert.strictEqual((await t.pre("mcp__Claude_Browser__computer", { action: "wait", duration: 10 })).out, "");
  assert.deepStrictEqual(t.decisions(), []);
});

test("Approval in the dashboard: only with Fleet open, the answer goes to Claude Code as its decision", async () => {
  const t = setup({ brake: { approvalSeconds: 5 } });
  const ask = () =>
    t.hook({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf dist" },
      permission_suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });
  // Dashboard closed: back at once, the app asks as always.
  const closed = await ask();
  assert.strictEqual(closed.out, "");
  assert.ok(closed.ms < 2000, `does not wait (${closed.ms} ms)`);
  assert.deepStrictEqual(t.decisions(), []);
  // Dashboard open: a card with the command; "always for this session" only applies to this session.
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  t.answerSoon("allow-session");
  const j = JSON.parse((await ask()).out);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.strictEqual(j.hookSpecificOutput.decision.behavior, "allow");
  assert.strictEqual(
    j.hookSpecificOutput.decision.updatedPermissions[0].destination,
    "session",
    "never permanently into the settings",
  );
  const [d] = t.decisions();
  assert.deepStrictEqual([d?.kind, d?.title, d?.text], ["permission", "Freigabe: Bash", "rm -rf dist"]);
  t.answerSoon("deny");
  assert.strictEqual(JSON.parse((await ask()).out).hookSpecificOutput.decision.behavior, "deny");
});

test("A decision file caught mid-write keeps the hook waiting: the answer after it still applies", async () => {
  // CI (macOS): the hook read the file while it was being written, took "unreadable" for "no longer open" and
  // ended without output; Claude Code then got no decision although one came a moment later.
  const t = setup({ brake: { approvalSeconds: 5 } });
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  const run = t.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  let d: Decision | undefined;
  for (let i = 0; i < 100 && !d; i++) {
    await new Promise((r) => setTimeout(r, 30));
    d = t.decisions().find((x) => x.status === "open");
  }
  assert.ok(d, "the hook opened a decision");
  const file = path.join(t.home, "decisions", `${d.id}.json`);
  fs.writeFileSync(file, '{"id":"');
  // Long enough for at least one of the hook's 300 ms looks at the half-written file.
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(
    `${file}.tmp`,
    JSON.stringify({ ...d, status: "answered", answer: "allow", answeredAt: Date.now() }),
  );
  fs.renameSync(`${file}.tmp`, file);
  const out = (await run).out;
  assert.ok(out, "the hook still waited for the answer");
  assert.strictEqual(JSON.parse(out).hookSpecificOutput.decision.behavior, "allow");
});

test("Approval without an answer: after the deadline the app asks, a late answer no longer applies", async () => {
  const t = setup({ brake: { approvalSeconds: 5 } });
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  const r = await t.hook({
    hook_event_name: "PermissionRequest",
    tool_name: "Write",
    tool_input: { file_path: "/p/a.txt" },
  });
  assert.strictEqual(r.out, "", "without an answer Claude Code decides itself (request in the app)");
  const [d] = t.decisions();
  assert.strictEqual(d?.status, "expired");
  process.env.CLAUDE_FLEET_HOME = t.home;
  const late = answer(String(d?.id), "allow");
  assert.ok(!late.ok && late.status === 409);
});

test("Questions are no approvals: AskUserQuestion and plan approval are answered in the app", async () => {
  // Reported: "Approval: AskUserQuestion" stood with raw JSON under "Fleet asks you" and stayed after it expired.
  const t = setup({ brake: { approvalSeconds: 5 } });
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  for (const tool of ["AskUserQuestion", "ExitPlanMode"]) {
    const r = await t.hook({
      hook_event_name: "PermissionRequest",
      tool_name: tool,
      tool_input: { questions: [{ question: "Was soll öffentlich werden?" }] },
    });
    assert.strictEqual(r.out, "");
    assert.ok(r.ms < 2000, `${tool}: does not wait (${r.ms} ms)`);
  }
  assert.deepStrictEqual(t.decisions(), []);
});

test("Leaving Fleet while the hook waits hands the approval to the app at once", async () => {
  // Bug B3: the hook held the request for the whole wait although the user had gone back to the app.
  const t = setup({ brake: { approvalSeconds: 30 } });
  const markFile = path.join(t.home, "ui-active");
  fs.writeFileSync(markFile, "");
  const run = t.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  let d: Decision | undefined;
  for (let i = 0; i < 100 && !d; i++) {
    await new Promise((r) => setTimeout(r, 30));
    d = t.decisions().find((x) => x.status === "open");
  }
  assert.ok(d, "the hook opened a decision");
  const left = Date.now();
  fs.rmSync(markFile);
  const r = await run;
  assert.strictEqual(r.out, "", "Claude Code decides itself: the request appears in the app");
  assert.ok(Date.now() - left < 4000, `ends soon after the tab lost focus (${Date.now() - left} ms)`);
  assert.strictEqual(t.decisions()[0]?.status, "expired", "the card leaves Fleet");
});

test("An approval nobody answered in Fleet still waits for the user after the hook lets go", async () => {
  // Live probe 2026-10-15: after the brake's deadline the app shows its own request, but the hook had set the
  // session to "working", so the waiting approval vanished from Fleet.
  const t = setup({ brake: { approvalSeconds: 30 } });
  const markFile = path.join(t.home, "ui-active");
  fs.writeFileSync(markFile, "");
  const run = t.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  for (let i = 0; i < 100 && !t.decisions().some((x) => x.status === "open"); i++)
    await new Promise((r) => setTimeout(r, 30));
  fs.rmSync(markFile);
  assert.strictEqual((await run).out, "", "the request goes to the app");
  const s = t.state();
  assert.strictEqual(s.status, "needs_input", "still waits for the user, now in the app");
  assert.strictEqual(s.event, "PermissionRequest");
  // Live 16.10.2026: with a Fleet tab in focus the row said only "Approval for Bash", without the command.
  assert.match(s.detail, /^(Freigabe für|Approval for) Bash: ls/);
});

test("An approval answered in Fleet no longer waits", async () => {
  const t = setup({ brake: { approvalSeconds: 30 } });
  fs.writeFileSync(path.join(t.home, "ui-active"), "");
  t.answerSoon("allow");
  const r = await t.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.match(r.out, /"behavior":"allow"/);
  assert.strictEqual(t.state().status, "working");
});

test("A stale mark (no report from a focused tab for 40 s) does not hold approvals", async () => {
  const t = setup({ brake: { approvalSeconds: 5 } });
  const markFile = path.join(t.home, "ui-active");
  fs.writeFileSync(markFile, "");
  const old = new Date(Date.now() - 41e3);
  fs.utimesSync(markFile, old, old);
  const r = await t.hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.strictEqual(r.out, "");
  assert.ok(r.ms < 2000, `does not wait (${r.ms} ms)`);
  assert.deepStrictEqual(t.decisions(), []);
});

test("list() reads each decision file once, but sees every change and hands out copies", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-brake-list-"));
  process.env.CLAUDE_FLEET_HOME = home;
  const dir = path.join(home, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const write = (status: string) => {
    const d = { id: "d1", sessionId: "s1", kind: "permission", status, createdAt: now, expiresAt: now + 60e3 };
    fs.writeFileSync(path.join(dir, "tmp.part"), JSON.stringify({ ...d, options: [] }));
    fs.renameSync(path.join(dir, "tmp.part"), path.join(dir, "d1.json"));
  };
  write("open");
  const first = list(now);
  assert.deepStrictEqual(
    first.map((x) => x.status),
    ["open"],
  );
  (first[0] as Decision).status = "answered"; // a caller changing its copy
  assert.deepStrictEqual(
    list(now).map((x) => x.status),
    ["open"],
    "the cache is not the caller's object",
  );
  assert.deepStrictEqual(
    list(now + 70e3).map((x) => x.status),
    ["expired"],
    "past the deadline",
  );
  assert.deepStrictEqual(
    list(now).map((x) => x.status),
    ["open"],
    "marking expired did not stick",
  );
  write("answered!"); // other size: a new file version
  assert.deepStrictEqual(
    list(now).map((x) => x.status),
    ["answered!"],
  );
  fs.rmSync(path.join(dir, "d1.json"));
  assert.deepStrictEqual(list(now), []);
});
