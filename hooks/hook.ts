/**
 * Claude Code hook for Claude Fleet. Called on session events (JSON on stdin), it writes the live status to
 * ~/.claude-fleet/state/<session>.json and a short event log, requests and delivers handoffs and runs the
 * brake. It has to be fast, prints at most one JSON object and always exits with code 0, so Claude Code is
 * never blocked.
 */
import fs from "node:fs";
import path from "node:path";
import * as brake from "../server/core/brake";
import { beginTurn, endTurn } from "../server/core/fleetturns";
import {
  callKey,
  clip,
  type HookEvent,
  hookBase,
  nextHookState,
  noteCall,
  QUIET,
  settledState,
  type ToolCall,
} from "../server/core/hookstate";
import { tr } from "../server/core/lang";
import * as launch from "../server/core/launch";
import { fleetHome } from "../server/core/paths";
import {
  checkpoint,
  noteWritten,
  notStarted,
  onPrompt,
  onSessionStart,
  onStop,
  onStopFailure,
  takeOpen,
} from "../server/handoff";
import type { Decision } from "../shared/types";

const HOME = fleetHome();
const STATE_DIR = path.join(HOME, "state");
const EVENTS = path.join(HOME, "events.jsonl");
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const MAX_STDIN = 32 * 1024 * 1024;
const T0 = Date.now(); // time of the event (before reading big tool inputs)
// Set when Fleet started this session itself (server/process): links process and session, and the approval
// stands in Fleet's terminal window, so the brake must not hold it back as well.
const FLEET_PROC = /^[\w.-]{1,128}$/.test(process.env.CLAUDE_FLEET_PROC || "") ? process.env.CLAUDE_FLEET_PROC : "";
// Set by Fleet for a session it started for its own reason (server/process/manager.ts); only these two kinds.
const FLEET_TURN = ["fix", "brief"].includes(process.env.CLAUDE_FLEET_TURN || "")
  ? (process.env.CLAUDE_FLEET_TURN as "fix" | "brief")
  : null;

let raw = "";
let tooBig = false;
const done = () => process.exit(0);
let killer = setTimeout(done, 3000);
killer.unref();
/** The brake: wait for an answer from Fleet. */
let pending: { decision: Decision; ev: HookEvent } | null = null;

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, data, { mode: 0o600 });
    } catch {
      // nothing more to try
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // no temp file
    }
  }
}

/** After the answer from Fleet, reset the status so the dashboard no longer shows "needs you". */
function settle(p: NonNullable<typeof pending>, reply: string) {
  try {
    const file = path.join(STATE_DIR, `${p.decision.sessionId}.json`);
    const next = settledState(
      JSON.parse(fs.readFileSync(file, "utf8")),
      reply,
      Date.now(),
      p.decision.kind,
      p.ev.tool_name,
      callKey(p.ev.tool_name, p.ev.tool_input),
    );
    if (next) writeAtomic(file, JSON.stringify(next));
  } catch {
    // the status catches up with the next event
  }
}

/** Returns the JSON answer for Claude Code (request or deliver a handoff, brake decision), if any. */
function handle(ev: HookEvent): string | undefined {
  const base = hookBase(ev);
  if (!base) return;
  const { name, sid } = base;
  let status = base.status;
  let detail = base.detail;

  // Automatic handoff: request it at the end of a turn (or right at a prompt after "Start fresh"), deliver it at the start of a new session.
  let reply: string | undefined;
  try {
    // The turn Fleet caused ends here; a handoff requested below opens the next one.
    if (name === "Stop") endTurn(sid, T0);
    // Fleet started this session for a fix or a briefing: its first turn is Fleet's cost.
    else if (name === "SessionStart" && FLEET_TURN && String(ev.source || "startup") === "startup")
      beginTurn(sid, FLEET_TURN, T0);
  } catch {
    // marks only feed the balance
  }
  try {
    noteWritten(sid, ev.cwd);
    if (name === "Stop") {
      // The handoff is written: open a new session with a visible task instead of clearing this chat.
      const o = takeOpen(sid, T0);
      if (o?.target === "fleet")
        detail = tr(
          "Übergabe geschrieben – Fleet startet die neue Session im Fenster",
          "Handoff written; Fleet starts the new session in its window",
        );
      else if (o) {
        // Detached: the hook ends right away with process.exit, a timer here would never fire.
        const started = launch.runDetached(launch.planNew(o.target, o.root, o.prompt, launch.env()));
        detail = started
          ? tr("Übergabe geschrieben, neue Session wird geöffnet", "Handoff written, opening the new session")
          : tr(
              "Übergabe geschrieben – neue Session ließ sich nicht öffnen, bitte in Fleet weitermachen",
              "Handoff written; the new session could not be opened, continue in Fleet",
            );
      } else if (notStarted(sid, T0))
        detail = tr(
          "Neue Session noch nicht gestartet – in Fleet bei der Übergabe „Nochmal öffnen“",
          'The new session has not started; "Open again" at the handoff in Fleet',
        );
      // Tight limit, handoff written: append the current state so a break-off is documented exactly.
      if (checkpoint(ev as Parameters<typeof checkpoint>[0], T0))
        detail = tr("Stand in der Übergabe aktualisiert", "State updated in the handoff");
      const h = onStop(ev as Parameters<typeof onStop>[0], T0);
      if (h) {
        reply = h.output;
        status = "working";
        detail = h.detail;
      }
    } else if (name === "UserPromptSubmit" && !base.injected) {
      const h = onPrompt(ev as Parameters<typeof onPrompt>[0], T0);
      if (h) {
        reply = h.output;
        detail = h.detail;
      }
    } else if (name === "SessionStart") reply = onSessionStart(ev, T0) || undefined;
    else if (name === "StopFailure" && onStopFailure(ev as Parameters<typeof onStopFailure>[0], T0)) {
      detail = `${detail ? `${detail} · ` : ""}${tr("Notfall-Übergabe geschrieben", "Emergency handoff written")}`;
    }
  } catch {
    // the handoff must never prevent the status
  }

  // The brake: pause before the tool call and ask in Fleet.
  let braking = false;
  try {
    if (name === "PostToolUseFailure") brake.noteFailure(sid, ev.tool_use_id);
    else if (name === "PermissionRequest" && !FLEET_PROC) {
      const b = brake.onPermissionRequest(ev, T0);
      if (b) {
        pending = { decision: b.decision, ev };
        braking = true;
        // The request's own words (tool and command), where to answer after them (live 16.10.2026).
        detail = `${base.detail || clip(ev.tool_name, 80)} – ${tr("im Dashboard oder in der App", "in the dashboard or the app")}`;
      }
    } else if (name === "PreToolUse") {
      const b = brake.onPreToolUse(ev, T0);
      if (b && "output" in b) reply = b.output;
      else if (b && "decision" in b) {
        pending = { decision: b.decision, ev };
        braking = true;
        status = "needs_input";
        detail = tr(
          `Fleet hält an: ${b.decision.title} – Entscheidung im Dashboard`,
          `Fleet paused: ${b.decision.title}, decide in the dashboard`,
        );
      }
    }
  } catch {
    // the brake must never block
  }

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(STATE_DIR, `${sid}.json`);
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    // new session
  }
  // Recent tool calls live next to the state (not .json: the server neither reads nor watches them), so a quiet
  // PreToolUse that skips the state write still records the call a later permission request belongs to.
  let calls: ToolCall[] | undefined;
  try {
    if (name === "PreToolUse" || name === "PermissionRequest") {
      const callsFile = path.join(STATE_DIR, `${sid}.calls`);
      try {
        calls = JSON.parse(fs.readFileSync(callsFile, "utf8"));
      } catch {
        // none yet
      }
      const noted = noteCall(calls, base);
      if (noted) writeAtomic(callsFile, JSON.stringify(noted));
    }
  } catch {
    // the request then waits until its turn ends
  }
  const next = nextHookState(prev, base, {
    status,
    detail,
    braking,
    now: T0,
    cwd: ev.cwd,
    proc: FLEET_PROC,
    calls: Array.isArray(calls) ? calls : undefined,
  });
  if (!next) return reply;
  status = next.status;
  const now = T0;
  const cwd = next.cwd;
  writeAtomic(file, JSON.stringify(next));

  if (!QUIET.has(name) || braking) {
    try {
      if (fs.statSync(EVENTS).size > MAX_EVENTS_BYTES) fs.renameSync(EVENTS, `${EVENTS}.old`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(
      EVENTS,
      `${JSON.stringify({ at: now, sessionId: sid, event: name, status, detail, cwd, waits: base.waits })}\n`,
      {
        mode: 0o600,
      },
    );
  }
  return reply;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  if (raw.length + d.length > MAX_STDIN) tooBig = true;
  else raw += d;
});
process.stdin.on("end", () => {
  let out = "";
  try {
    if (!tooBig) out = handle(JSON.parse(raw || "{}")) || "";
  } catch {
    // never fail
  }
  const p = pending;
  if (p) {
    // The brake waits longer than the usual 3 s, but never beyond its own deadline.
    clearTimeout(killer);
    killer = setTimeout(done, Math.max(0, p.decision.expiresAt - Date.now()) + 3000);
    killer.unref();
    try {
      return brake.waitFor(p.decision, p.ev, (reply) => {
        settle(p, reply);
        if (reply) process.stdout.write(reply, done);
        else done();
      });
    } catch {
      return done();
    }
  }
  // Answer for Claude Code: exactly one JSON object, nothing else on stdout.
  if (out) process.stdout.write(out, done);
  else done();
});
process.stdin.on("error", done);
