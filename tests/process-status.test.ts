// Status of sessions Fleet runs itself (server/process): rules 1–3, then K, S, Q; the screen is never read.
import assert from "node:assert";
import { test } from "vitest";
import * as launch from "../server/core/launch";
import { attachProcs } from "../server/core/procs";
import { deriveStatus } from "../server/core/status";
import type { Config, Proc, Session } from "../shared/types";

const cfg = { staleMinutes: 20 } as Pick<Config, "staleMinutes">;
const NOW = 1_800_000_000_000;
type P = NonNullable<Session["proc"]>;
const proc = (o: Partial<P> = {}): P => ({
  mode: "pty",
  status: "running",
  screen: null,
  job: null,
  exitCode: null,
  endedAt: null,
  startedAt: NOW - 600e3,
  lastOutputAt: NOW - 60e3,
  lastInputAt: 0,
  ...o,
});
const hookAt = (status: NonNullable<Session["hook"]>["status"], ago: number, event = "PreToolUse") => ({
  sessionId: "p",
  status,
  event,
  detail: "",
  at: NOW - ago,
  startedAt: 0,
  statusSince: NOW - ago,
});
const run = (s: Partial<Session>) => {
  const x = { id: "p", source: "local", mtime: NOW - 120e3, ...s } as Session;
  deriveStatus(x, cfg, NOW);
  return x;
};
// A screen that asks, to prove it is ignored: the status never reads it (B12).
const asking = { kind: "approval" as const, at: NOW - 30e3, text: "Do you want to proceed?" };

test("Fleet process: the rules as a table", () => {
  const cases: [string, Partial<Session>, Session["status"]][] = [
    [
      "1 crash, no hook afterwards: error",
      { proc: proc({ status: "failed", exitCode: 2, endedAt: NOW - 5e3 }) },
      "error",
    ],
    ["2 exit 0: ended", { proc: proc({ status: "exited", exitCode: 0, endedAt: NOW - 5e3 }) }, "ended"],
    [
      "3 interrupted by a Fleet restart: resting",
      { proc: proc({ status: "interrupted", endedAt: NOW - 5e3 }) },
      "idle",
    ],
    [
      "the hook decides, not the screen",
      { proc: proc({ screen: asking }), hook: hookAt("waiting", 60e3, "Stop"), turn: "done" },
      "waiting",
    ],
    [
      "S no hook 5 s after the spawn: starting",
      { proc: proc({ status: "starting", startedAt: NOW - 5e3, lastOutputAt: 0 }) },
      "working",
    ],
    [
      "S no hook 10 s after the spawn: a dialog before the start",
      { proc: proc({ startedAt: NOW - 12e3, lastOutputAt: NOW - 11e3 }) },
      "needs_input",
    ],
    [
      "Q hook working, output 1 s ago: working",
      { proc: proc({ lastOutputAt: NOW - 1e3 }), hook: hookAt("working", 30e3) },
      "working",
    ],
    [
      "Q hook working, silent for 10 s: look",
      { proc: proc({ lastOutputAt: NOW - 11e3 }), hook: hookAt("working", 30e3) },
      "needs_input",
    ],
    [
      "silence after Stop stays done",
      { proc: proc({ lastOutputAt: NOW - 300e3 }), hook: hookAt("waiting", 300e3, "Stop"), turn: "done" },
      "waiting",
    ],
    [
      "K approval answered in the terminal",
      { proc: proc({ lastInputAt: NOW - 2e3 }), hook: hookAt("needs_input", 5e3, "PermissionRequest") },
      "waiting",
    ],
  ];
  for (const [name, s, want] of cases) assert.strictEqual(run(s).status, want, name);
});

test("Fleet process: a crash names the exit code; a hook after the end wins; interrupted says why", () => {
  const c = run({ proc: proc({ status: "failed", exitCode: 3, endedAt: NOW - 5e3 }) });
  assert.deepStrictEqual(
    [c.status, c.failure?.kind, c.detail, c.statusSource],
    ["error", "crash", "Prozess beendet (Code 3)", "process"],
  );
  const after = run({
    proc: proc({ status: "failed", exitCode: 3, endedAt: NOW - 5e3 }),
    hook: hookAt("working", 1e3),
  });
  assert.strictEqual(after.status, "working", "the session went on after the exit");
  const r = run({ proc: proc({ status: "interrupted", endedAt: NOW - 5e3 }) });
  assert.deepStrictEqual([r.status, r.detail], ["idle", "durch Fleet-Neustart unterbrochen"]);
});

test("Fleet process S: a dialog before the first hook waits; SessionStart clears it; keystrokes restart the clock", () => {
  const s = run({ proc: proc({ startedAt: NOW - 12e3, lastOutputAt: NOW - 11e3 }) });
  assert.deepStrictEqual(
    [s.status, s.ask?.kind, s.detail],
    ["needs_input", "question", "wartet beim Start – bitte ansehen"],
  );
  const old = run({ proc: proc({ startedAt: NOW - 12e3 }), hook: hookAt("waiting", 60e3, "Stop"), turn: "done" });
  assert.strictEqual(old.status, "needs_input", "a hook from before the spawn (resume) is no start");
  const begun = run({ proc: proc({ startedAt: NOW - 12e3 }), hook: hookAt("idle", 8e3, "SessionStart") });
  assert.notStrictEqual(begun.status, "needs_input", "SessionStart ends the start dialogs");
  const typed = run({ proc: proc({ startedAt: NOW - 30e3, lastInputAt: NOW - 4e3 }) });
  assert.strictEqual(typed.status, "working", "answered the trust dialog 4 s ago");
  const next = run({ proc: proc({ startedAt: NOW - 30e3, lastInputAt: NOW - 11e3 }) });
  assert.strictEqual(next.status, "needs_input", "the next dialog of a series alarms again");
});

test("Fleet process Q: hook working and silence for 10 s asks for a look; any sign of life is work", () => {
  const q = run({ proc: proc({ lastOutputAt: NOW - 12e3 }), hook: hookAt("working", 20e3), turn: "running" });
  assert.deepStrictEqual([q.status, q.ask?.kind, q.detail], ["needs_input", "question", "prüfen – Terminal still"]);
  const hook = run({ proc: proc({ lastOutputAt: NOW - 12e3 }), hook: hookAt("working", 4e3), turn: "running" });
  assert.strictEqual(hook.status, "working", "a hook event 4 s ago is a sign of life");
  const key = run({
    proc: proc({ lastOutputAt: NOW - 12e3, lastInputAt: NOW - 3e3 }),
    hook: hookAt("working", 20e3),
    turn: "running",
  });
  assert.strictEqual(key.status, "working", "a keystroke 3 s ago restarts the clock");
  const box = run({
    proc: proc({ lastOutputAt: NOW - 60e3 }),
    hook: { ...hookAt("working", 60e3), lastTool: "AskUserQuestion" },
    turn: "tool_pending",
  });
  assert.deepStrictEqual(
    [box.status, box.detail],
    ["needs_input", "wartet in der App auf dich (AskUserQuestion)"],
    "a known question keeps its own words",
  );
  const unseen = run({ proc: proc({ screen: asking, lastOutputAt: NOW - 1e3 }), hook: hookAt("working", 2e3) });
  assert.strictEqual(unseen.status, "working", "an approval on screen alone decides nothing");
});

test("Fleet process K: your keystrokes after a question end the wait until the next hook event (B13)", () => {
  const notif = hookAt("needs_input", 8e3, "Notification");
  const esc = run({ proc: proc({ lastInputAt: NOW - 5e3, lastInputEsc: true }), hook: notif, turn: "tool_pending" });
  assert.deepStrictEqual([esc.status, esc.ask, esc.detail], ["waiting", null, "im Terminal beantwortet"]);
  const box = run({
    proc: proc({ lastInputAt: NOW - 5e3, lastInputEsc: true }),
    hook: { ...hookAt("working", 8e3), lastTool: "AskUserQuestion" },
    turn: "tool_pending",
  });
  assert.strictEqual(box.status, "waiting", "Esc on AskUserQuestion, hook younger than 15 s");
  const before = run({ proc: proc({ lastInputAt: NOW - 9e3 }), hook: notif, turn: "tool_pending" });
  assert.strictEqual(before.status, "needs_input", "typed before the question: it still waits");
  const text = run({
    proc: proc({ lastInputAt: NOW - 2e3 }),
    hook: { ...hookAt("waiting", 4e3, "Stop"), lastAnswer: "Soll ich das so committen?" },
    turn: "done",
  });
  assert.deepStrictEqual([text.status, text.ask], ["waiting", null], "typing answers a question in the text");
  const open = run({
    proc: proc(),
    hook: { ...hookAt("waiting", 4e3, "Stop"), lastAnswer: "Soll ich das so committen?" },
    turn: "done",
  });
  assert.strictEqual(open.status, "needs_input", "without a keystroke the question stays");
  const after = run({ proc: proc({ lastInputAt: NOW - 9e3 }), hook: hookAt("needs_input", 2e3, "PermissionRequest") });
  assert.strictEqual(after.status, "needs_input", "the next hook event asks again");
});

test("Fleet job: working while it runs; a failed job does not make the session an error", () => {
  const j = run({ proc: proc({ mode: "headless", job: "handoff" }), turn: "done" });
  assert.deepStrictEqual([j.status, j.detail], ["working", "Fleet-Job im Hintergrund: Übergabe"]);
  const failed = run({ proc: proc({ mode: "headless", job: "handoff", status: "failed", exitCode: 1 }), turn: "done" });
  assert.strictEqual(failed.status, "waiting");
});

test("Linking: by id, else by the hook's CLAUDE_FLEET_PROC; a process without a transcript gets one row", () => {
  const p = (id: string, o: Partial<Proc> = {}): Proc => ({
    id,
    kind: "session",
    mode: "pty",
    root: "/r",
    cwd: "/r",
    pid: 1,
    cols: 80,
    rows: 24,
    startedAt: NOW,
    status: "running",
    lastOutputAt: NOW,
    lastInputAt: 0,
    title: "Tests grün",
    ...o,
  });
  const a = { id: "a", source: "local" } as Session;
  const b = { id: "b", source: "local" } as Session;
  const sessions = [a, b];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  attachProcs(sessions, byId, { b: { ...hookAt("working", 0), sessionId: "b", proc: "x" } }, [
    p("a"),
    p("x"),
    p("new"),
    p("gone", { status: "exited" }),
  ]);
  assert.strictEqual(a.proc?.status, "running");
  assert.strictEqual(b.proc?.status, "running", "linked through the hook mark");
  assert.deepStrictEqual(
    sessions.map((s) => [s.id, s.title ?? null]),
    [
      ["a", null],
      ["b", null],
      ["new", "Tests grün"],
    ],
    "one row for the new process, none for an exited one, none twice",
  );
});

test("Targets: the Fleet terminal first when available, else with its reason", () => {
  const env: launch.Env = {
    platform: "darwin",
    desktopApp: true,
    vscode: null,
    cursor: null,
    claude: "/bin/claude",
    wt: null,
    linuxTerminal: null,
  };
  assert.deepStrictEqual(launch.targets(env, { available: true })[0], {
    id: "fleet",
    label: "Fleet-Terminal",
    ok: true,
  });
  assert.deepStrictEqual(launch.targets(env, { available: false, why: "pty-Modul fehlt – pnpm install" })[0], {
    id: "fleet",
    label: "Fleet-Terminal",
    ok: false,
    why: "pty-Modul fehlt – pnpm install",
  });
  assert.strictEqual(launch.targets(env)[0]?.id, "desktop", "without a terminal state as before");
  assert.deepStrictEqual(launch.planNew("fleet", "/r", "x", env), [], "nothing to launch from outside");
});
