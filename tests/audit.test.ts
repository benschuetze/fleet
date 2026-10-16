// `fleet audit`: replays invented history through the real status code and finds what Fleet would have missed.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { type AuditEvent, endsWithQuestion, replaySession, report, typedByUser } from "../server/core/audit";
import { ROOT } from "./helpers/server";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const SECRET = "Geheimprojekt Zitronenfalter";
const line = (s: number, o: object) => ({ timestamp: at(s), cwd: "/p", ...o });
const prompt = (s: number, text: string) => line(s, { type: "user", message: { role: "user", content: text } });
const say = (s: number, text: string, stop = "end_turn") =>
  line(s, {
    type: "assistant",
    message: { id: `m${s}`, model: "claude-opus-5-5", stop_reason: stop, content: [{ type: "text", text }] },
  });
const call = (s: number, id: string, name: string, input: object = {}) =>
  line(s, {
    type: "assistant",
    message: {
      id: `m${s}`,
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
    },
  });
const result = (s: number, id: string) =>
  line(s, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });
const ev = (s: number, event: string, status: AuditEvent["status"]): AuditEvent => ({
  at: T0 + s * 1000,
  sessionId: "s1",
  event,
  status,
});
const opts = { from: T0, to: T0 + 3600e3, staleMinutes: 20 };

test("Audit truth: typed prompts answer, injected ones do not; closing questions", () => {
  const u = (content: unknown, extra: object = {}) => ({ type: "user", message: { content }, ...extra });
  assert.ok(typedByUser(u("Ja, mergen")));
  assert.ok(typedByUser(u("<pasted_content>log</pasted_content> was ist das?")), "pasted text is typed");
  for (const t of [
    "<ci-monitor-event>x",
    "<task-notification>x",
    "<command-name>/compact",
    "[Request interrupted by user]",
  ])
    assert.ok(!typedByUser(u(t)), t);
  // The app puts linked-session notes in front of a `!` command: still the user's own action (16.10.2026).
  const reminder = { type: "text", text: "<system-reminder>Linked sessions now: …</system-reminder>" };
  assert.ok(typedByUser(u([reminder, { type: "text", text: "<bash-input>gh auth refresh</bash-input>" }])));
  assert.ok(!typedByUser(u([reminder])), "a note alone answers nothing");
  assert.ok(
    !typedByUser(u([reminder, { type: "text", text: "<task-notification>x" }])),
    "nor an injected tag after it",
  );
  assert.ok(!typedByUser(u("Summary", { isCompactSummary: true })), "compaction summary");
  assert.ok(!typedByUser(u([{ type: "tool_result", tool_use_id: "x" }])), "tool result");
  assert.ok(endsWithQuestion("Fertig.\n\nSoll ich mergen?"));
  assert.ok(endsWithQuestion("Soll ich die Tests anpassen? Das dauert zehn Minuten."), "question before a remark");
  assert.ok(endsWithQuestion("Den Merge mache ich nicht ohne dein Okay."));
  assert.ok(endsWithQuestion("Schritt 1 braucht deine Bestätigung im Browser, deshalb musst du ihn selbst ausführen."));
  assert.ok(!endsWithQuestion("Fertig. Alles grün."));
  assert.ok(!endsWithQuestion("```\nwas?\n```\nFertig."), "code does not ask");
});

test("Audit: a shown question is no miss, a lost one is; an injected prompt does not answer", () => {
  // Turn with a closing question, then the app injects a message: the question is still open.
  const lines = [
    prompt(0, "Baue den Export"),
    say(30, "Export steht. Soll ich mergen?"),
    prompt(200, "<task-notification>Lauf fertig</task-notification>"),
    say(210, "Der Lauf ist fertig."),
  ];
  const a = replaySession("s1", lines, [ev(0, "UserPromptSubmit", "working"), ev(31, "Stop", "waiting")], opts);
  const r = report([a], { hours: 1, ...opts });
  assert.strictEqual(r.byKind.text.waits, 1);
  // Shown from the Stop until the injected prompt …
  assert.ok(a.moments.some((m) => m.kind === "text" && m.fleet === "needs_input" && m.from < T0 + 200e3));
  // … while the injected turn runs nothing is due (Fleet shows it working) …
  assert.ok(a.moments.some((m) => m.kind === "text" && m.paused && m.from >= T0 + 200e3 && m.to <= T0 + 210e3));
  // … and after it, whatever Fleet shows is checked against the open question.
  const after = a.moments.filter((m) => m.from >= T0 + 210e3);
  assert.ok(after.length && after.every((m) => m.kind === "text" && !m.paused), "the truth keeps the question");
});

test("Audit: a permission the brake gave up on is a miss while the hook says working", () => {
  const lines = [prompt(0, "Räum auf"), call(5, "p1", "Bash", { command: "rm -r alt" }), result(300, "p1")];
  const events = [ev(0, "UserPromptSubmit", "working"), ev(6, "PermissionRequest", "needs_input")];
  const expired = [{ sessionId: "s1", kind: "permission", at: T0 + 51e3, reply: "" as const }];
  const a = replaySession("s1", lines, events, { ...opts, decisions: expired });
  const waits = a.moments.filter((m) => m.kind === "permission");
  assert.ok(waits.length, "the approval waits until its result");
  const r = report([a], { hours: 1, ...opts });
  assert.strictEqual(r.byKind.permission.waits, 1);
  // Answered in Fleet: no longer waiting from the answer on, nothing missed.
  const answered = [{ sessionId: "s1", kind: "permission", at: T0 + 20e3, reply: "answer" as const }];
  const b = replaySession("s1", lines, events, { ...opts, decisions: answered });
  assert.strictEqual(report([b], { hours: 1, ...opts }).misses.length, 0);
});

test("Audit: a closing question Fleet shows and a turn that asks nothing", () => {
  const ok = replaySession(
    "s1",
    [prompt(0, "Baue X"), say(30, "Fertig. Alles grün.")],
    [ev(0, "UserPromptSubmit", "working"), ev(31, "Stop", "waiting")],
    opts,
  );
  const r = report([ok], { hours: 1, ...opts });
  assert.deepStrictEqual([r.misses.length, r.falseAlarms.length], [0, 0]);
  assert.ok(ok.moments.every((m) => m.kind === null && m.fleet !== "needs_input"));
  assert.strictEqual(ok.moments[ok.moments.length - 1]?.fleet, "waiting");
});

test("fleet audit: read-only, ids and times only, never the text", () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-audit-")));
  const claude = path.join(tmp, "claude");
  const home = path.join(tmp, "fleet");
  const proj = path.join(claude, "projects", "-p");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const t = Date.now() - 3600e3;
  const iso = (s: number) => new Date(t + s * 1000).toISOString();
  const lines = [
    { type: "user", timestamp: iso(0), cwd: "/p", message: { role: "user", content: `Baue ${SECRET}` } },
    {
      type: "assistant",
      timestamp: iso(20),
      message: {
        model: "claude-opus-5-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "p1", name: "Bash", input: { command: `rm ${SECRET}` } }],
      },
    },
  ];
  fs.writeFileSync(path.join(proj, "aud-1.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const events = [
    { at: t, sessionId: "aud-1", event: "UserPromptSubmit", status: "working", detail: SECRET },
    { at: t + 21e3, sessionId: "aud-1", event: "PermissionRequest", status: "needs_input", detail: SECRET },
  ];
  fs.writeFileSync(path.join(home, "events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  // A session the hook reported that never wrote a transcript (a Fleet terminal with a parent's markers).
  fs.appendFileSync(
    path.join(home, "events.jsonl"),
    `${JSON.stringify({ at: t + 5e3, sessionId: "ghost-1", event: "SessionStart", status: "idle", detail: "startup" })}\n`,
  );
  const before = JSON.stringify([
    fs.readdirSync(claude, { recursive: true }),
    fs.readdirSync(home, { recursive: true }),
  ]);
  const env = { ...process.env, FLEET_LANG: "en", CLAUDE_CONFIG_DIR: claude, CLAUDE_FLEET_HOME: home };
  const cli = (args: string[]) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [path.join(ROOT, "dist", "fleet.cjs"), "audit", ...args], {
          env,
          encoding: "utf8",
        }),
      };
    } catch (e) {
      const x = e as { status: number; stdout: string };
      return { code: x.status, out: x.stdout };
    }
  };
  const text = cli(["--hours", "2"]);
  assert.match(text.out, /fleet audit: 2 h, 1 sessions \(1 with hooks\)/);
  assert.match(text.out, /permission\s+1\s+0/);
  assert.match(text.out, /Hook events without a transcript \(cannot be checked\): 1\n.*ghost-1 {2}1 events/);
  assert.strictEqual(text.code, 1, "a session without transcript cannot be checked: exit 1");
  const json = JSON.parse(cli(["--json"]).out);
  assert.strictEqual(json.byKind.permission.waits, 1);
  assert.deepStrictEqual(
    json.noTranscript.map((n: { sessionId: string }) => n.sessionId),
    ["ghost-1"],
  );
  assert.strictEqual(json.misses.length, 0);
  for (const o of [text.out, JSON.stringify(json)]) assert.ok(!o.includes(SECRET) && !o.includes("Baue"), "no text");
  const after = JSON.stringify([
    fs.readdirSync(claude, { recursive: true }),
    fs.readdirSync(home, { recursive: true }),
  ]);
  assert.strictEqual(after, before, "writes nothing");
});

test("Audit: Fleet's own handoff turn after a closing question is a pause, not a miss", () => {
  const lines = [
    prompt(0, "Baue X"),
    say(30, "Fertig. Soll ich mergen?"),
    call(45, "w1", "Write", { file_path: "/p/HANDOFF.md" }),
    result(46, "w1"),
    say(70, "Übergabe geschrieben."),
  ];
  const events = [ev(0, "UserPromptSubmit", "working"), ev(31, "Stop", "working"), ev(71, "Stop", "waiting")];
  const r = report([replaySession("s1", lines, events, opts)], { hours: 1, ...opts });
  assert.deepStrictEqual([r.byKind.text.waits, r.misses.length], [1, 0]);
});

test("Audit: a message behind a system reminder is an injected turn, it pauses the open question", () => {
  const box = line(10, {
    type: "assistant",
    message: {
      id: "m10",
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "b1", name: "mcp__ccd_turn__wrap_up", input: { ask: "Mergen?" } }],
    },
  });
  const lines = [
    prompt(0, "Baue X"),
    box,
    result(11, "b1"),
    say(12, "PR ist offen."),
    prompt(
      100,
      "<system-reminder>Linked sessions</system-reminder>\n<cross-session-message>Neue Fälle</cross-session-message>",
    ),
    call(105, "t1", "Bash", { command: "ls" }),
    result(150, "t1"),
    say(160, "Erledigt."),
  ];
  const events = [ev(0, "UserPromptSubmit", "working"), ev(13, "Stop", "waiting"), ev(161, "Stop", "waiting")];
  const r = report([replaySession("s1", lines, events, opts)], { hours: 1, ...opts });
  assert.deepStrictEqual([r.byKind.box.waits, r.misses.length], [1, 0]);
});
