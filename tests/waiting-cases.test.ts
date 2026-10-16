// The guarantee "a session that waits for you shows as wartet": one case per way a session can wait, each run
// three times, as Fleet sees it with hooks only, with the transcript only, and with both. The hook is the real,
// built dist/hook.cjs; the transcript goes through the real reader; deriveStatus decides. Invented data only.
// A new way to wait (a new tool, a new app event) gets a row here first. `fleet audit` checks the same promise
// against the real local history.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { parseFull } from "../server/core/sessions";
import { deriveStatus } from "../server/core/status";
import type { Session } from "../shared/types";
import { ROOT } from "./helpers/server";

type Mode = "hook" | "transcript" | "both";
const MODES: Mode[] = ["hook", "transcript", "both"];

/** `late`: a transcript line written half a minute after everything else (Fleet looks right after it). */
type Step = { line: object } | { hook: Record<string, unknown> } | { late: object };
/** `wait`: needs_input with this text in the alarm row; `no`: anything but needs_input. */
type Expect = { wait: string | RegExp } | { no: string };
interface Case {
  name: string;
  steps: Step[];
  /** Per mode; a mode left out expects the same as `all`. A `no` that is a known limit says why. */
  all: Expect;
  hook?: Expect;
  transcript?: Expect;
  both?: Expect;
  /** Config for the brake (written to the Fleet folder); Fleet then counts as open in a browser tab. */
  brake?: object;
  /** Modes that still miss the wait, and why: they must fail (test.fails), so a fix turns them red. */
  known?: Partial<Record<Mode, string>>;
}

const MODEL = "claude-opus-5-5";
const now = () => new Date().toISOString();
const user = (content: unknown, extra: object = {}) => ({
  line: { type: "user", message: { role: "user", content }, ...extra },
});
const prompt = (text: string): Step[] => [user(text), { hook: { hook_event_name: "UserPromptSubmit", prompt: text } }];
const say = (text: string): Step[] => [
  {
    line: { type: "assistant", message: { model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text }] } },
  },
];
const stop = (text: string): Step => ({ hook: { hook_event_name: "Stop", last_assistant_message: text } });
const call = (id: string, name: string, input: object): Step[] => [
  {
    line: {
      type: "assistant",
      message: { model: MODEL, stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
    },
  },
  { hook: { hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id } },
];
const result = (id: string, name: string, input: object = {}): Step[] => [
  user([{ type: "tool_result", tool_use_id: id, content: "ok" }]),
  { hook: { hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_use_id: id } },
];
/** The app asks for permission; the request carries no tool_use_id, only tool and input. */
const ask = (name: string, input: object, extra: object = {}): Step => ({
  hook: { hook_event_name: "PermissionRequest", tool_name: name, tool_input: input, ...extra },
});
/** A tool call of a subagent: hook events only (its lines go to the subagent's own transcript). */
const agentTool = (agent: string, id: string, name: string, input: object): Step[] => [
  { hook: { hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id, agent_id: agent } },
  { hook: { hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_use_id: id, agent_id: agent } },
];
const RM = { command: "rm -r logs/alt" };
const EDIT = { file_path: "src/export.ts", old_string: "a", new_string: "b" };
const LIMIT_PERM = "limit: without hooks a waiting approval looks like a running tool";
/** A message the app sends on its own: a turn of its own, no answer of the user. */
const auto = (tag: string, reply: string): Step[] => [
  ...prompt(`<${tag}>\nCI für PR #7 ist grün.\n</${tag}>`),
  ...say(reply),
  stop(reply),
];

const BOX_Q = "PR #7 mergen, sobald die CI grün ist?";
/** The Desktop app's question box at the end of a turn. */
const box = (): Step[] => [
  ...prompt("Baue den CSV-Export"),
  ...call("box", "mcp__ccd_turn__wrap_up", { recap: "Export steht, PR #7 ist offen.", ask: BOX_Q }),
  ...result("box", "mcp__ccd_turn__wrap_up"),
  ...say("PR #7 ist offen."),
  stop("PR #7 ist offen."),
];
const TEXT_Q = "Soll ich die alte Exportfunktion gleich mit entfernen?";
const OPEN_Q = "Was wolltest du noch sagen?";
const OKAY_Q = "Erst danach wird das Repo öffentlich, ebenfalls auf dein Okay.";
const IDLE = '[Cross-session idle notice] "stufe-12-7", which you asked to be notified about, is idle now.';
const PEER =
  'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] Zehn Befunde.\n</agent-message>';
const permission = (tool = "Bash"): Step[] => [...prompt("Räum die Logs auf"), ...call("p1", tool, RM), ask(tool, RM)];

/** The app's notification after a permission request, as Claude Code 2.1.295 sends it (live 16.10.2026). */
const notify = (message = "Claude needs your permission"): Step => ({
  hook: { hook_event_name: "Notification", notification_type: "permission_prompt", message },
});
const PICK = { questions: [{ question: "Soll die Testdatei rot oder blau heißen?", header: "Farbe", options: [] }] };

const CASES: Case[] = [
  // Live test 16.10.2026: real rows said only "Claude needs your permission"; the request's words now stay.
  {
    name: "live: Bash approval, then the app's notification",
    steps: [...permission(), notify()],
    all: { wait: "Freigabe für Bash: rm -r logs/alt" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "live: AskUserQuestion held by the app, then its notification",
    steps: [
      ...prompt("Frag mich nach der Farbe"),
      ...call("q2", "AskUserQuestion", PICK),
      ask("AskUserQuestion", PICK),
      notify(),
    ],
    all: { wait: "Soll die Testdatei rot oder blau heißen?" },
  },
  {
    name: "live: plan held by the app, then its notification",
    steps: [
      ...prompt("Plane notes.md"),
      ...call("pl2", "ExitPlanMode", { plan: "1. notes.md anlegen" }),
      ask("ExitPlanMode", { plan: "1. notes.md anlegen" }),
      notify("Claude Code needs your approval for the plan"),
    ],
    all: { wait: /Plan/ },
  },
  {
    // fleet compat, 15 Oct: a desktop session ran without Fleet's Stop hook (only the app's own hooks ran), so the
    // hook's last word was a tool and Fleet showed "working" for 168 min while the closing question waited.
    name: "closing question, the hook missed the Stop event",
    steps: [
      ...prompt("Richte die Demo ein"),
      ...call("b1", "Bash", { command: "pnpm check" }),
      ...result("b1", "Bash", { command: "pnpm check" }),
      ...say("Dafür lege ich ein Projekt in deinem Konto an. Ist das okay?"),
    ],
    all: { wait: "Ist das okay?" },
    hook: { no: "limit: without its Stop event the hook alone cannot know the turn ended" },
  },
  {
    name: "question (AskUserQuestion)",
    steps: [
      ...prompt("Plane die Migration"),
      ...call("q1", "AskUserQuestion", {
        questions: [{ question: "Welche Datenbank soll es werden?", header: "DB", options: [] }],
      }),
    ],
    all: { wait: "Welche Datenbank soll es werden?" },
  },
  {
    name: "plan (ExitPlanMode)",
    steps: [...prompt("Plane die Migration"), ...call("pl", "ExitPlanMode", { plan: "1. Schema\n2. Daten" })],
    all: { wait: /Plan/ },
  },
  {
    name: "folder (ccd_directory)",
    steps: [
      ...prompt("Arbeite im Shop weiter"),
      ...call("d1", "mcp__ccd_directory__request_directory", { reason: "Der Shop liegt in einem anderen Ordner." }),
    ],
    all: { wait: "Der Shop liegt in einem anderen Ordner." },
  },
  {
    name: "access (request_access)",
    steps: [
      ...prompt("Öffne die Notizen"),
      ...call("a1", "mcp__computer-use__request_access", { apps: ["Notizen"], reason: "Notizen öffnen" }),
    ],
    all: { wait: /request access|Zugriff/ },
  },
  {
    name: "permission",
    steps: permission(),
    all: { wait: "Freigabe für Bash" },
    transcript: { no: LIMIT_PERM },
  },
  { name: "question box (wrap_up ask)", steps: box(), all: { wait: BOX_Q } },
  {
    name: "offer (start_session)",
    steps: [
      ...prompt("Mach weiter"),
      ...call("o1", "mcp__ccd_session__start_session", { initiation: "offer", title: "Bremse kürzen" }),
    ],
    all: { wait: "Bremse kürzen" },
  },
  {
    name: "closing question in text",
    steps: [...prompt("Baue den CSV-Export"), ...say(`Export steht.\n\n${TEXT_Q}`), stop(`Export steht.\n\n${TEXT_Q}`)],
    all: { wait: TEXT_Q },
  },
  ...["ci-monitor-event", "side-sessions-event", "cross-session-message", "task-notification"].map(
    (tag): Case => ({
      name: `box, then an automated prompt <${tag}>`,
      steps: [...box(), ...auto(tag, "CI ist grün.")],
      all: { wait: BOX_Q },
    }),
  ),
  {
    // The note in front never lets an injected message through as the user's answer (review 16 Oct).
    name: "box, then the app's note and a subagent's report",
    steps: [
      ...box(),
      user([
        { type: "text", text: "<system-reminder>\nLinked sessions now: vault = local_1 (working)\n</system-reminder>" },
        { type: "text", text: PEER },
      ]),
      { hook: { hook_event_name: "UserPromptSubmit", prompt: `<system-reminder>Linked</system-reminder>\n${PEER}` } },
      ...say("Der Bericht ist da."),
      stop("Der Bericht ist da."),
    ],
    all: { wait: BOX_Q },
  },
  {
    // fleet audit, 16 Oct: the Desktop app puts a note in front of a prompt the user typed. Fleet took the prompt for
    // an injected one, kept the answered box open and showed "wartet" for 26 min after Claude's plain reply.
    name: "box, then the user answers with the app's note in front",
    steps: [
      ...box(),
      user([
        { type: "text", text: "<system-reminder>\nLinked sessions now: vault = local_1 (working)\n</system-reminder>" },
        { type: "text", text: "Nein, lass das Repo erstmal lokal." },
      ]),
      {
        hook: {
          hook_event_name: "UserPromptSubmit",
          prompt: "<system-reminder>Linked sessions now</system-reminder>\nNein, lass das Repo erstmal lokal.",
        },
      },
      ...say("Gut, das Repo bleibt lokal."),
      stop("Gut, das Repo bleibt lokal."),
    ],
    all: { no: "answered" },
  },
  {
    // fleet audit, 15 Oct (round 5): a subagent's report comes as "Another Claude session sent a message:", not as
    // a tag; Fleet took it for the user's answer and dropped the open okay for 11 min.
    name: "request for an okay, then a subagent hands back its report",
    steps: [
      ...prompt("Mach das Repo fertig"),
      ...say(`Der Key fehlt noch.\n\n${OKAY_Q}`),
      stop(`Der Key fehlt noch.\n\n${OKAY_Q}`),
      user(PEER, { isMeta: true, origin: { kind: "peer" }, promptSource: "system" }),
      { hook: { hook_event_name: "UserPromptSubmit", prompt: PEER } },
      ...say("Der Review ist da, ich arbeite ihn ab."),
      stop("Der Review ist da, ich arbeite ihn ab."),
    ],
    all: { wait: /dein Okay/ },
  },
  {
    name: "request for an okay, then the note that a watched session went idle",
    steps: [
      ...prompt("Räum die Worktrees auf"),
      ...say("Branch und Worktree warten auf dein Ok zum Löschen."),
      stop("Branch und Worktree warten auf dein Ok zum Löschen."),
      user(IDLE, { isMeta: true }),
      { hook: { hook_event_name: "UserPromptSubmit", prompt: IDLE } },
      ...say("Die andere Session ist fertig. Ich greife nicht ein."),
      stop("Die andere Session ist fertig. Ich greife nicht ein."),
    ],
    all: { wait: /dein Ok/ },
  },
  {
    // fleet audit, 15 Oct (round 5): the question stood before a sentence saying what is still open.
    name: "closing question, then what is still open",
    steps: [
      ...prompt("Kürze den Schluss"),
      ...say(`Die PDF ist neu erzeugt.\n\nDein Satz bricht ab. ${OPEN_Q} Offen ist sonst nur die Telefonnummer.`),
      stop(`Die PDF ist neu erzeugt.\n\nDein Satz bricht ab. ${OPEN_Q} Offen ist sonst nur die Telefonnummer.`),
    ],
    all: { wait: OPEN_Q },
  },
  {
    name: "closing question, then a note of what was recorded",
    steps: [
      ...prompt("Baue den CSV-Export"),
      ...say(`Export steht.\n\n${TEXT_Q} Das dauert zehn Minuten.\n\n**Festgehalten:** Der Prüfpunkt steht im Skill.`),
      stop(`Export steht.\n\n${TEXT_Q} Das dauert zehn Minuten.\n\n**Festgehalten:** Der Prüfpunkt steht im Skill.`),
    ],
    all: { wait: TEXT_Q },
  },
  {
    name: "box, then a message behind a system reminder",
    steps: [
      ...box(),
      ...prompt(
        '<system-reminder>\nLinked sessions now: two.\n</system-reminder>\n\n<cross-session-message from="local_1">Neue Fälle</cross-session-message>',
      ),
      ...say("Fälle eingetragen."),
      stop("Fälle eingetragen."),
    ],
    all: { wait: BOX_Q },
  },
  {
    name: "closing question, then an automated prompt",
    steps: [
      ...prompt("Baue den CSV-Export"),
      ...say(`Export steht.\n\n${TEXT_Q}`),
      stop(`Export steht.\n\n${TEXT_Q}`),
      ...auto("task-notification", "Der Hintergrundlauf ist fertig."),
    ],
    all: { wait: TEXT_Q },
  },
  {
    name: "box, then interrupted",
    steps: [
      ...prompt("Baue den CSV-Export"),
      ...call("box", "mcp__ccd_turn__wrap_up", { recap: "Export steht.", ask: BOX_Q }),
      ...result("box", "mcp__ccd_turn__wrap_up"),
      user([{ type: "text", text: "[Request interrupted by user]" }]),
    ],
    all: { no: "the user stopped the turn: they are there, nothing waits" },
  },
  {
    name: "permission answered in the app",
    steps: [...permission(), ...result("p1", "Bash", RM)],
    all: { no: "answered" },
  },
  {
    // Seen 2026-10-15: every tool event wrote "working", so a parallel tool of the same answer hid the approval.
    name: "permission, a parallel tool of the same answer finishes",
    steps: [
      ...prompt("Räum die Logs auf"),
      ...call("p1", "Bash", RM),
      ...call("r1", "Read", { file_path: "logs/README" }),
      ask("Bash", RM),
      ...result("r1", "Read", { file_path: "logs/README" }),
    ],
    all: { wait: "Freigabe für Bash" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "permission, a background subagent keeps working",
    steps: [
      ...prompt("Baue den Export und prüfe nebenher die Abhängigkeiten"),
      ...call("t1", "Task", { description: "Abhängigkeiten", prompt: "Prüfe package.json", run_in_background: true }),
      ...result("t1", "Task"),
      { hook: { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "general-purpose" } },
      ...call("e1", "Edit", EDIT),
      ask("Edit", EDIT),
      ...agentTool("a1", "g1", "Grep", { pattern: "lodash" }),
      ...agentTool("a1", "g2", "Read", { file_path: "package.json" }),
    ],
    all: { wait: "Freigabe für Edit" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "permission, the next tool of the same answer starts",
    steps: [...permission(), { hook: { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "r9" } }],
    all: { wait: "Freigabe für Bash" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "two approvals at once, the second answered first",
    steps: [
      ...prompt("Räum auf"),
      ...call("p1", "Bash", RM),
      ...call("p2", "Bash", { command: "rm -r tmp" }),
      ask("Bash", RM),
      ask("Bash", { command: "rm -r tmp" }),
      ...result("p2", "Bash", { command: "rm -r tmp" }),
    ],
    all: { wait: "Bash" },
    transcript: { no: LIMIT_PERM },
  },
  {
    // Both answers come within the hook's 1.5 s quiet window: the first must not be dropped.
    name: "two approvals at once, both answered",
    steps: [
      ...prompt("Räum auf"),
      ...call("p1", "Bash", RM),
      ...call("p2", "Bash", { command: "rm -r tmp" }),
      ask("Bash", RM),
      ask("Bash", { command: "rm -r tmp" }),
      ...result("p1", "Bash", RM),
      ...result("p2", "Bash", { command: "rm -r tmp" }),
    ],
    all: { no: "both answered" },
  },
  {
    name: "permission denied, Claude goes on (no hook event for the denial)",
    steps: [
      ...permission(),
      user([{ type: "tool_result", tool_use_id: "p1", is_error: true, content: "The user doesn't want to proceed." }]),
      ...call("r2", "Read", { file_path: "logs/README" }),
    ],
    all: { no: "denied: the transcript has the tool's result" },
    hook: { wait: "Freigabe für Bash" },
  },
  {
    name: "question with a permission request, then the idle notification",
    steps: [
      ...prompt("Plane die Migration"),
      ...call("q1", "AskUserQuestion", { questions: [{ question: "Welche Datenbank?", header: "DB", options: [] }] }),
      ask("AskUserQuestion", { questions: [{ question: "Welche Datenbank?", header: "DB", options: [] }] }),
      {
        hook: {
          hook_event_name: "Notification",
          notification_type: "idle_prompt",
          message: "Claude is waiting for your input",
        },
      },
    ],
    all: { wait: "Welche Datenbank?" },
  },
  {
    name: "background subagent asks for a permission, the main turn ends",
    steps: [
      ...prompt("Prüfe nebenher die Abhängigkeiten"),
      ...call("t1", "Task", { description: "Abhängigkeiten", prompt: "Prüfe package.json", run_in_background: true }),
      ...result("t1", "Task"),
      { hook: { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "general-purpose" } },
      {
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "WebFetch",
          tool_use_id: "w1",
          agent_id: "a1",
          tool_input: { url: "https://registry.npmjs.org/" },
        },
      },
      ask("WebFetch", { url: "https://registry.npmjs.org/" }, { agent_id: "a1" }),
      ...say("Der Subagent prüft im Hintergrund."),
      stop("Der Subagent prüft im Hintergrund."),
    ],
    all: { wait: "Freigabe für WebFetch" },
    transcript: { no: "limit: the subagent's approval is in its own transcript" },
  },
  {
    name: "subagent's permission, the subagent ends",
    steps: [
      ...prompt("Prüfe nebenher die Abhängigkeiten"),
      ...call("t1", "Task", { description: "Abhängigkeiten", prompt: "Prüfe package.json", run_in_background: true }),
      ...result("t1", "Task"),
      {
        hook: {
          hook_event_name: "PreToolUse",
          tool_name: "WebFetch",
          tool_use_id: "w1",
          agent_id: "a1",
          tool_input: { url: "https://registry.npmjs.org/" },
        },
      },
      ask("WebFetch", { url: "https://registry.npmjs.org/" }, { agent_id: "a1" }),
      { hook: { hook_event_name: "SubagentStop", agent_id: "a1", agent_type: "general-purpose" } },
    ],
    all: { no: "the subagent is gone, its request with it" },
  },
  {
    name: "permission, then transcript lines without a message",
    // The app writes bookkeeping lines (queued messages, file history) while the approval waits.
    steps: [...permission(), { late: { type: "queue-operation", operation: "enqueue" } }],
    all: { wait: "Freigabe für Bash" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "permission, the brake ran out",
    brake: { approvalSeconds: 5 },
    steps: permission(),
    all: { wait: "Bash" },
    transcript: { no: LIMIT_PERM },
  },
  {
    name: "subagent asks for a permission",
    steps: [
      ...prompt("Prüfe die Abhängigkeiten"),
      ...call("t1", "Task", { description: "Abhängigkeiten prüfen", prompt: "Prüfe package.json" }),
      { hook: { hook_event_name: "SubagentStart", agent_type: "general-purpose" } },
      {
        hook: {
          hook_event_name: "PermissionRequest",
          tool_name: "WebFetch",
          agent_id: "a1",
          tool_input: { url: "https://registry.npmjs.org/" },
        },
      },
    ],
    all: { wait: "Freigabe für WebFetch" },
    transcript: { no: "limit: the subagent's approval is in its own transcript; the parent shows a running Task" },
  },
  {
    name: "compaction while a question is open",
    steps: [
      ...box(),
      { hook: { hook_event_name: "PreCompact", trigger: "manual" } },
      { line: { type: "system", subtype: "compact_boundary", content: "Conversation compacted" } },
      user("This session is being continued from a previous conversation. Summary: CSV-Export gebaut.", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      { hook: { hook_event_name: "SessionStart", source: "compact" } },
    ],
    all: { wait: BOX_Q },
  },
  {
    name: "closing question, then compaction",
    steps: [
      ...prompt("Baue den CSV-Export"),
      ...say(`Export steht.\n\n${TEXT_Q}`),
      stop(`Export steht.\n\n${TEXT_Q}`),
      { hook: { hook_event_name: "PreCompact", trigger: "manual" } },
      { line: { type: "system", subtype: "compact_boundary", content: "Conversation compacted" } },
      user("This session is being continued from a previous conversation. Summary: CSV-Export gebaut.", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      { hook: { hook_event_name: "SessionStart", source: "compact" } },
    ],
    all: { wait: TEXT_Q },
  },
  {
    name: "session resumed with an open question",
    steps: [...box(), { hook: { hook_event_name: "SessionStart", source: "resume" } }],
    all: { wait: BOX_Q },
  },
];

/** One run of a case: its own Fleet folder, the real hook for hook events, the reader for the transcript. */
async function run(c: Case, mode: Mode, sid: string): Promise<Session> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wait-"));
  const home = path.join(tmp, "fleet");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ brake: { approvals: true, ...c.brake } }));
  // Without an open Fleet tab the brake never holds: the runs that need it say so with `brake`.
  if (c.brake) fs.writeFileSync(path.join(home, "ui-active"), String(Date.now()));
  const env = { ...process.env, FLEET_LANG: "de", CLAUDE_FLEET_HOME: home, CLAUDE_DESKTOP_SESSIONS_DIR: "" };
  const lines: object[] = [];
  let late = 0;
  for (const st of c.steps) {
    if ("late" in st) {
      late = 30e3;
      if (mode !== "hook")
        lines.push({ cwd: tmp, sessionId: sid, timestamp: new Date(Date.now() + late).toISOString(), ...st.late });
    } else if ("line" in st) {
      if (mode !== "hook") lines.push({ cwd: tmp, sessionId: sid, timestamp: now(), ...st.line });
    } else if (mode !== "transcript") {
      if (c.brake && st.hook.hook_event_name === "PermissionRequest")
        fs.writeFileSync(path.join(home, "ui-active"), String(Date.now()));
      execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
        input: JSON.stringify({ session_id: sid, cwd: tmp, ...st.hook }),
        env,
        encoding: "utf8",
      });
    }
  }
  let s: Session = { id: sid, source: "local", mtime: 0 };
  if (lines.length) {
    const f = path.join(tmp, `${sid}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    if (late) fs.utimesSync(f, new Date(), new Date(Date.now() + late));
    const st = fs.statSync(f);
    s = { ...(await parseFull(f, st)).data, source: "local", mtime: st.mtimeMs };
  }
  if (mode !== "transcript") s.hook = JSON.parse(fs.readFileSync(path.join(home, "state", `${sid}.json`), "utf8"));
  deriveStatus(s, { staleMinutes: 20 }, Date.now() + late + 1000);
  return s;
}

describe.concurrent("waiting cases", () => {
  CASES.forEach((c, i) => {
    for (const mode of MODES) {
      const want = c[mode] || c.all;
      const t = c.known?.[mode] ? test.fails : test;
      t(`${c.name} · ${mode}`, { timeout: 30e3 }, async () => {
        const s = await run(c, mode, `wait-${i}-${mode}`);
        if ("wait" in want) {
          assert.strictEqual(s.status, "needs_input", `status (${s.statusSource}: ${s.detail})`);
          const text = `${s.ask?.text || ""} ${s.detail || ""}`;
          if (typeof want.wait === "string") assert.ok(text.includes(want.wait), `question text, got: ${text}`);
          else assert.match(text, want.wait);
        } else assert.notStrictEqual(s.status, "needs_input", want.no);
      });
    }
  });
});
