// The process manager and its pure parts: argument lists, screen detection, buffer, job results.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { childEnv } from "../server/core/childenv";
import { deriveStatus } from "../server/core/status";
import { forkArgs, jobArgs, MAX_PROMPT, newArgs, resumeArgs } from "../server/process/args";
import { RingBuffer } from "../server/process/buffer";
import { parseResult } from "../server/process/jobs";
import { createManager, type TermEvent, type Terminals } from "../server/process/manager";
import { takePending } from "../server/process/pending";
import { classify, nextScreen } from "../server/process/screen";
import { readStore } from "../server/process/store";
import type { Config, Proc, Session } from "../shared/types";
import { fakeClaude, waitFor } from "./helpers/fake-claude";

const ID = "0f4c7a52-3b1e-4c2a-9d1e-5a6b7c8d9e01";
const ESC = "\x1b";

test("Arguments: new with its own id, resume, the headless job; never a shell string", () => {
  assert.deepStrictEqual(newArgs("/repo", ID, "Tests grün machen"), {
    ok: true,
    args: ["--session-id", ID, "Tests grün machen"],
  });
  assert.deepStrictEqual(newArgs("/repo", ID, "", { permissionMode: "acceptEdits" }), {
    ok: true,
    args: ["--session-id", ID, "--permission-mode", "acceptEdits"],
  });
  assert.deepStrictEqual(resumeArgs(ID), { ok: true, args: ["--resume", ID] });
  const NEW = "11111111-2222-4333-8444-555555555555";
  assert.deepStrictEqual(forkArgs(ID, NEW), {
    ok: true,
    args: ["--resume", ID, "--fork-session", "--session-id", NEW],
  });
  assert.strictEqual(forkArgs(ID, "x; rm -rf /").ok, false);
  assert.deepStrictEqual(jobArgs(ID, "Übergabe"), {
    ok: true,
    args: [
      "--resume",
      ID,
      "-p",
      "Übergabe",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "4",
    ],
  });
  // NUL and CR go, a dash cannot become an option, too long is refused, a relative folder too.
  const dirty = newArgs("/repo", ID, "a\0b\r\nc");
  assert.ok(dirty.ok && dirty.args.at(-1) === "ab\nc");
  const dash = newArgs("/repo", ID, "--dangerously-skip-permissions");
  assert.ok(dash.ok && dash.args.at(-1) === " --dangerously-skip-permissions" && dash.args.length === 3);
  assert.strictEqual(newArgs("/repo", ID, "x".repeat(MAX_PROMPT + 1)).ok, false);
  assert.strictEqual(newArgs("repo", ID, "x").ok, false);
  assert.strictEqual(newArgs("/repo", "../etc", "x").ok, false);
  assert.strictEqual(resumeArgs("abc; rm -rf /").ok, false);
});

// The screen is display text only (status never reads it, see tests/process-status.test.ts).
test("Screen: approval with colours, question, empty input line, work; unknown is never an approval", () => {
  const approval = `${ESC}[1mBash command${ESC}[22m\r\n   pnpm e2e\r\n\r\n Do you want to proceed?\r\n ${ESC}[36m❯ 1. Yes${ESC}[39m\r\n   2. No\r\n`;
  assert.deepStrictEqual(classify(approval), { kind: "approval", text: "Do you want to proceed?" });
  const question =
    "╭──╮\n│ Welches Format soll der Export haben?\n│ ❯ 1. PDF\n│   2. CSV\n╰──╯\n Enter to select · ↑/↓ to navigate · Esc to cancel\n";
  assert.deepStrictEqual(classify(question), { kind: "question", text: "Welches Format soll der Export haben?" });
  assert.strictEqual(classify("╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts\n").kind, "prompt");
  assert.strictEqual(classify("✻ Schreibt Tests … (esc to interrupt)\n").kind, "busy");
  assert.strictEqual(classify("random output, nothing known\nDo you like it?\n").kind, "unknown");
  // Several frames in the tail: the last one counts (the answer was given, work goes on).
  assert.strictEqual(classify(`${approval}\n✻ Arbeitet … (esc to interrupt)\n`).kind, "busy");
  assert.strictEqual(classify(`✻ Arbeitet … (esc to interrupt)\n${approval}`).kind, "approval");
  // Cursor steps instead of spaces still read as words.
  assert.strictEqual(classify(`Do${ESC}[1Cyou${ESC}[1Cwant${ESC}[1Cto${ESC}[1Cproceed?\n`).kind, "approval");
});

// Shapes of Claude Code 2.1.295 in a pty (live probe, 2026-10-15); every text is invented.
const RULE = "─".repeat(60);
const idle = (footer: string) => `${RULE}\n❯ \n${RULE}\n  ${footer}\n`;
const spinner = "✻ Grübelt … (12s · ↓ 300 tokens · esc to interrupt)\n";

test("Screen 2.1.295: the input line between two rules is the prompt, in every mode; the spinner above it is work", () => {
  for (const f of [
    "⏸ manual mode on",
    "⏵⏵ auto mode on (shift+tab to cycle)",
    "⏵⏵ accept edits on (shift+tab to cycle)",
    "⏸ plan mode on (shift+tab to cycle)",
  ])
    assert.deepStrictEqual(classify(idle(f)), { kind: "prompt", text: "" }, f);
  // While working the spinner stands above the same input line and footer: one frame, so work.
  assert.strictEqual(classify(spinner + idle("⏸ manual mode on")).kind, "busy");
  // The next frame without the spinner: the turn is over.
  assert.strictEqual(classify(spinner + idle("⏸ manual mode on") + idle("⏸ manual mode on")).kind, "prompt");
  // An option marker is not the input line.
  assert.notStrictEqual(classify(" Wohin damit?\n ❯ 1. Yes\n   2. No\n").kind, "prompt");
});

test("Screen 2.1.295: dialogs that wait without a hook are questions with their asking sentence", () => {
  const trust = `${RULE}\n Accessing workspace:\n\n /home/demo/projekt-x\n\n Quick safety check: Is this a project you created or one you trust? (Because it may run code.)\n\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
  assert.deepStrictEqual(classify(trust), {
    kind: "question",
    text: "Quick safety check: Is this a project you created or one you trust?",
  });
  const notes = ` Security notes:\n\n 1. Claude kann sich irren\n 2. Vorsicht bei fremden Dateien\n\n Press Enter to continue…\n`;
  assert.deepStrictEqual(classify(notes), { kind: "question", text: "Security notes:" });
  const theme = ` Let's get started.\n\n Choose the text style that looks best with your terminal\n To change this later, run /theme\n\n ❯ 1. Dark mode\n   2. Light mode\n`;
  assert.deepStrictEqual(classify(theme), {
    kind: "question",
    text: "Choose the text style that looks best with your terminal",
  });
  const chrome = `${RULE}\n Claude in Chrome extension detected\n\n Use your browser for web tasks.\n\n ❯ 1. No, keep browser tools off\n   2. Yes, use my browser\n\n Enter to confirm · Esc to keep browser tools off\n`;
  assert.deepStrictEqual(classify(chrome), { kind: "question", text: "Claude in Chrome extension detected" });
  // The approval keeps its kind although its footer also says "Esc to cancel".
  const approval = ` Bash command\n   pnpm e2e\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access to demo/ from this project\n   3. Yes, and switch to auto mode\n   4. No\n\n Esc to cancel · Tab to amend\n`;
  assert.deepStrictEqual(classify(approval), { kind: "approval", text: "Do you want to proceed?" });
  const ask = ` Welche Datenbank?\n\n ❯ 1. Postgres\n   2. SQLite\n   3. Type something.\n\n Enter to select · ↑/↓ to navigate · Esc to cancel\n`;
  assert.deepStrictEqual(classify(ask), { kind: "question", text: "Welche Datenbank?" });
  // A dialog drawn after the idle input line is what is on screen now.
  assert.strictEqual(classify(idle("⏸ manual mode on") + trust).kind, "question");
});

test("Screen: the time stays while the screen stays", () => {
  const s1 = nextScreen(null, " Do you want to proceed?\n ❯ 1. Yes\n", 1000);
  assert.strictEqual(nextScreen(s1, " Do you want to proceed?\n ❯ 1. Yes\n", 5000), s1);
  assert.deepStrictEqual(nextScreen(s1, "✻ … (esc to interrupt)", 3000), { kind: "busy", at: 3000, text: "" });
});

test("Buffer: keeps the newest bytes up to its limit", () => {
  const b = new RingBuffer(10);
  b.push(Buffer.from("abcdef"));
  b.push(Buffer.from("ghijkl"));
  assert.strictEqual(b.read().toString(), "cdefghijkl");
  assert.strictEqual(b.tail(3), "jkl");
  b.push(Buffer.from("0123456789XYZ"));
  assert.strictEqual(b.read().toString(), "3456789XYZ");
});

test("Job result: exact numbers from the result line, null when missing, other lines ignored", () => {
  const lines = [
    "progress",
    JSON.stringify({ type: "system", session_id: ID }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 812,
      total_cost_usd: 0.0421,
      session_id: ID,
      result: "fertig",
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 11 },
    }),
  ];
  assert.deepStrictEqual(parseResult(lines, { exitCode: 0 }), {
    ok: true,
    sessionId: ID,
    durationMs: 812,
    tokens: { input: 5, output: 7, cacheRead: 900, cacheWrite: 11 },
    costUsd: 0.0421,
    text: "fertig",
    error: null,
  });
  const bare = parseResult([JSON.stringify({ type: "result", subtype: "success", result: "x" })], { exitCode: 0 });
  assert.deepStrictEqual([bare.tokens, bare.costUsd, bare.durationMs], [null, null, null], "never estimated");
  const failed = parseResult([JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })], {
    exitCode: 1,
  });
  assert.deepStrictEqual([failed.ok, failed.error], [false, "error_max_turns"]);
  assert.deepStrictEqual(parseResult(["{broken"], { exitCode: 2 }).ok, false);
});

/* ---------- The manager with an invented claude, pipes instead of a pty ---------- */

const fake = fakeClaude();
let home = "";
const saved: Record<string, string | undefined> = {};
const cfg = (max = 8) =>
  ({ terminal: { enabled: true, maxSessions: max, scrollbackKb: 64, permissionMode: {} } }) as unknown as Config;

beforeAll(() => {
  for (const k of ["CLAUDE_FLEET_PTY", "FLEET_TEST_CLAUDE", "CLAUDE_FLEET_HOME", "FAKE_CLAUDE_LOG"])
    saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-proc-"));
  process.env.CLAUDE_FLEET_PTY = "pipe";
  process.env.FLEET_TEST_CLAUDE = fake.file;
  process.env.CLAUDE_FLEET_HOME = home;
  process.env.FAKE_CLAUDE_LOG = fake.log;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const text = (m: Terminals, id: string) => {
  let out = "";
  m.attach(id, (e: TermEvent) => {
    if (e.type === "out") out += e.data.toString();
  })?.();
  return out;
};

test("Manager: start, output in the buffer, a second attach gets it, input arrives, exit codes count", async () => {
  let changes = 0;
  const m = createManager({ config: () => cfg(), onChange: () => changes++ });
  const r = await m.start({ root: home, cwd: home, prompt: "Tests grün machen" });
  assert.ok(r.ok);
  const id = r.id;
  await waitFor(() => m.get(id)?.status === "running", 5000, "running");
  await waitFor(() => text(m, id).includes("Do you want to proceed?"), 5000, "output");
  const call = fake.calls().find((c) => c.args.includes("--session-id"));
  assert.deepStrictEqual(call?.args, ["--session-id", id, "Tests grün machen"]);
  assert.strictEqual(call?.proc, id, "the hook can link the process by CLAUDE_FLEET_PROC");
  // Two pages attached: both see the live output.
  const seen: string[] = ["", ""];
  const detach = [0, 1].map((i) =>
    m.attach(id, (e) => {
      if (e.type === "out") seen[i] += e.data.toString();
    }),
  );
  assert.ok(m.write(id, Buffer.from("hallo\n")));
  await waitFor(() => seen.every((s) => s.includes("echo:hallo")), 5000, "echo");
  for (const d of detach) d?.();
  assert.ok((m.get(id)?.lastInputAt || 0) > 0);
  assert.strictEqual(m.get(id)?.lastInputEsc, false, "typed text is no cancel");
  assert.ok(m.write(id, Buffer.from([0x1b])));
  assert.strictEqual(m.get(id)?.lastInputEsc, true, "a lone Esc cancels an open question (status rule 4a)");
  // The screen detection sees the invented approval.
  await waitFor(() => m.get(id)?.screen?.kind === "approval", 5000, "screen");
  assert.deepStrictEqual(
    readStore().map((s) => s.id),
    [id],
    "processes.json lists the running session",
  );
  m.write(id, Buffer.from("exit3\n"));
  await waitFor(() => m.get(id)?.status === "failed", 5000, "failed");
  assert.strictEqual(m.get(id)?.exitCode, 3);
  assert.deepStrictEqual(readStore(), [], "an ended session leaves processes.json");
  const ok = await m.start({ root: home, cwd: home });
  assert.ok(ok.ok);
  await waitFor(() => m.get(ok.id)?.status === "running");
  m.write(ok.id, Buffer.from("exit0\n"));
  await waitFor(() => m.get(ok.id)?.status === "exited");
  assert.ok(changes > 0, "pages are told");
  m.close();
});

test("Manager + status: a fake Claude that keeps drawing stays working; silence after Stop stays done, silence while working asks", async () => {
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  process.env.FAKE_CLAUDE_TICK = "1";
  const busy = await m.start({ root: home, cwd: home });
  delete process.env.FAKE_CLAUDE_TICK;
  const quiet = await m.start({ root: home, cwd: home });
  assert.ok(busy.ok && quiet.ok);
  // LOOK_MS is 10 s: wait past it with real output (or none) from the fake.
  await new Promise((r) => setTimeout(r, 11_000));
  const status = (id: string, hook: { status: "working" | "waiting"; event: string }) => {
    const p = m.get(id) as Proc;
    const s = {
      id,
      source: "local",
      mtime: p.startedAt,
      turn: hook.status === "waiting" ? "done" : "running",
      proc: { ...p, screen: null },
      hook: {
        sessionId: id,
        ...hook,
        detail: "",
        at: p.startedAt + 500,
        startedAt: p.startedAt,
        statusSince: p.startedAt,
      },
    } as unknown as Session;
    deriveStatus(s, { staleMinutes: 20 }, Date.now());
    return s.status;
  };
  assert.strictEqual(status(busy.id, { status: "working", event: "PreToolUse" }), "working", "periodic output");
  assert.strictEqual(status(quiet.id, { status: "waiting", event: "Stop" }), "waiting", "silence after Stop");
  assert.strictEqual(
    status(quiet.id, { status: "working", event: "PreToolUse" }),
    "needs_input",
    "silence while working",
  );
  m.close();
}, 20_000);

test("Manager: a fix session tells the hook it is Fleet's turn, by environment only, never by argument", async () => {
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  const prev = process.env.CLAUDE_FLEET_TURN;
  process.env.CLAUDE_FLEET_TURN = "brief"; // the server's own environment must not leak into a child
  try {
    const fix = await m.start({ root: home, cwd: home, prompt: "CI reparieren", turn: "fix" });
    const own = await m.start({ root: home, cwd: home, prompt: "Eigener Auftrag" });
    assert.ok(fix.ok && own.ok);
    const byId = (id: string) => fake.calls().find((c) => c.args.includes(id));
    await waitFor(() => !!byId(fix.id) && !!byId(own.id), 5000, "both started");
    assert.strictEqual(byId(fix.id)?.turn, "fix");
    assert.ok(!byId(fix.id)?.args.some((a) => a.includes("fix")), "not in the arguments");
    assert.strictEqual(byId(own.id)?.turn, null, "a task of the user is no Fleet turn");
    for (const id of [fix.id, own.id]) m.write(id, Buffer.from("exit0\n"));
    await waitFor(() => m.get(fix.id)?.status === "exited" && m.get(own.id)?.status === "exited");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_FLEET_TURN;
    else process.env.CLAUDE_FLEET_TURN = prev;
    m.close();
  }
});

test("Manager: a session in Fleet's window does not inherit the markers of the Claude session Fleet runs in", async () => {
  // Live probe 2026-10-15: Fleet was started from a Desktop session; every child said "Transcript saving is off -
  // inherited CLAUDE_CODE_CHILD_SESSION marker" and got the parent's session id and messaging socket.
  const inherited: Record<string, string> = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/erfunden.sock",
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    CLAUDE_AGENT_SDK_VERSION: "0.0.0",
    CLAUDE_PID: "4242",
    AI_AGENT: "claude-code",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/erfunden",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };
  const prev = Object.fromEntries(Object.keys(inherited).map((k) => [k, process.env[k]]));
  Object.assign(process.env, inherited);
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  try {
    const r = await m.start({ root: home, cwd: home, prompt: "Sauber starten" });
    assert.ok(r.ok);
    const call = () => fake.calls().find((c) => c.args.includes(r.id));
    await waitFor(() => !!call(), 5000, "started");
    const env = call()?.env || [];
    for (const k of Object.keys(inherited).filter((k) => k !== "CLAUDE_CODE_USE_BEDROCK"))
      assert.ok(!env.includes(k), `${k} is not passed on`);
    assert.ok(env.includes("CLAUDE_CODE_USE_BEDROCK"), "the user's own provider switch stays");
    assert.ok(env.includes("CLAUDE_FLEET_PROC"), "Fleet's own link to the hook stays");
    m.write(r.id, Buffer.from("exit0\n"));
    await waitFor(() => m.get(r.id)?.status === "exited");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    m.close();
  }
});

test("childEnv: only with the host's auth proxy marker is ANTHROPIC_BASE_URL dropped; user settings stay", () => {
  const own = childEnv({
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    PATH: "/bin",
  });
  assert.deepStrictEqual(own, {
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
    PATH: "/bin",
  });
  const desk = childEnv({
    CLAUDECODE: "1",
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    HOME: "/h",
  });
  assert.deepStrictEqual(desk, { HOME: "/h" });
});

test("Manager: at most maxSessions at once; ending takes two steps (int, then term)", async () => {
  const m = createManager({ config: () => cfg(8), onChange: () => {} });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await m.start({ root: home, cwd: home });
    assert.ok(r.ok);
    ids.push(r.id);
  }
  const ninth = await m.start({ root: home, cwd: home });
  assert.deepStrictEqual(ninth, { ok: false, status: 409, error: "Höchstens 8 Sessions gleichzeitig" });
  const id = ids[0] as string;
  await waitFor(() => text(m, id).includes("Do you want"), 5000, "first output");
  if (process.platform !== "win32") {
    assert.ok(m.kill(id, "int"));
    await waitFor(() => text(m, id).includes("^C"), 5000, "interrupt arrives");
    assert.strictEqual(m.get(id)?.status, "running", "an interrupt does not end the session");
  }
  for (const x of ids) m.kill(x, "term");
  await waitFor(() => ids.every((x) => m.get(x)?.status === "exited"), 8000, "all ended");
  assert.deepStrictEqual(m.counts(), { interactive: 0, jobs: 0 });
  m.close();
});

test("Manager: not logged in or no CLI is refused with a reason, never a crash", async () => {
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  process.env.FLEET_TEST_CLAUDE = path.join(home, "missing.cjs");
  process.env.FAKE_CLAUDE_LOGGED_OUT = "1";
  const r = await m.start({ root: home, cwd: home });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.ok && r.status === 422 && /nicht angemeldet/.test(r.error));
  delete process.env.FAKE_CLAUDE_LOGGED_OUT;
  process.env.FLEET_TEST_CLAUDE = fake.file;
  m.close();
});

test("Jobs: exact tokens and cost, one line in jobs.jsonl, a second job on the same session is refused", async () => {
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  const r = await m.job({ kind: "handoff", id: ID, root: home, cwd: home, prompt: "Übergabe" });
  assert.ok(r.ok);
  const again = await m.job({ kind: "handoff", id: ID, root: home, cwd: home, prompt: "Übergabe" });
  assert.strictEqual(again.ok ? 0 : again.status, 409, "two Fleet processes on one transcript");
  const res = await r.done;
  assert.deepStrictEqual(
    [res?.ok, res?.tokens, res?.costUsd, res?.durationMs, res?.sessionId],
    [true, { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }, 0.0123, 1234, ID],
  );
  const log = fs.readFileSync(path.join(home, "jobs.jsonl"), "utf8").trim().split("\n");
  assert.strictEqual(log.length, 1);
  assert.strictEqual(JSON.parse(log[0] as string).result.costUsd, 0.0123);
  // Without usage in the result: null, never a guess.
  process.env.FAKE_CLAUDE_NO_USAGE = "1";
  const bare = await m.job({ kind: "handoff", id: ID, root: home, cwd: home, prompt: "Übergabe" });
  const b = await bare.done;
  delete process.env.FAKE_CLAUDE_NO_USAGE;
  assert.deepStrictEqual([b?.ok, b?.tokens, b?.costUsd], [true, null, null]);
  m.close();
});

test("Jobs: a hanging run ends at the timeout, as failed", async () => {
  const m = createManager({ config: () => cfg(), onChange: () => {}, jobTimeoutMs: 400 });
  process.env.FAKE_CLAUDE_HANG = "1";
  const r = await m.job({ kind: "handoff", id: ID, root: home, cwd: home, prompt: "Übergabe" });
  delete process.env.FAKE_CLAUDE_HANG;
  const res = await r.done;
  assert.deepStrictEqual([res?.ok, res?.error], [false, "Zeitüberschreitung"]);
  assert.strictEqual(m.get(ID)?.status, "failed");
  m.close();
});

test("Restart: a stored session whose process is gone stands as interrupted", () => {
  fs.writeFileSync(
    path.join(home, "processes.json"),
    JSON.stringify([{ id: ID, root: home, cwd: home, startedAt: Date.now() - 60e3, pid: 999999, title: "Alt" }]),
  );
  const m = createManager({ config: () => cfg(), onChange: () => {} });
  m.restore();
  assert.deepStrictEqual(
    m.list().map((p) => [p.id, p.status, p.title]),
    [[ID, "interrupted", "Alt"]],
  );
  assert.deepStrictEqual(readStore(), [], "taken over once");
});

test("Pending fresh start: each mark is taken exactly once", () => {
  fs.writeFileSync(
    path.join(home, "handoffs.json"),
    JSON.stringify({
      byDir: {
        [home]: {
          sessionId: "s1",
          requestedAt: 1,
          reason: "x",
          key: "manual:1",
          file: "",
          openIn: "fleet",
          pendingStart: true,
          pendingPrompt: "Mach weiter",
        },
      },
    }),
  );
  assert.deepStrictEqual(takePending(), [{ root: home, prompt: "Mach weiter" }]);
  assert.deepStrictEqual(takePending(), []);
});
