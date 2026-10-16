import { createHash } from "node:crypto";
import { AUTO_PROMPT_RE, LOCAL_PROMPT_RE, ownText } from "../../shared/prompts";
import type { HookState, Status, WaitFor } from "../../shared/types";
import { INTERACTIVE, toolQuestion } from "./ask";
import { tr } from "./lang";

/**
 * What the hook writes to ~/.claude-fleet/state/<session>.json for one event, as pure functions: the hook calls
 * them, and `fleet audit` replays old events through the same code. Handoff and brake adjust status and detail
 * in between (hooks/hook.ts); everything else about the state is decided here. Kept tiny: the hook bundles it.
 */

// biome-ignore lint/suspicious/noExplicitAny: hook input from Claude Code, checked field by field
export type HookEvent = Record<string, any>;

// null = keep the status (background subagents keep running after "done").
export const HOOK_STATUS: Record<string, Status | null> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "working",
  SubagentStart: null,
  SubagentStop: null,
  PreCompact: "working",
  PostCompact: "working",
  PermissionRequest: "needs_input",
  Notification: "needs_input",
  Stop: "waiting",
  StopFailure: "error",
  SessionEnd: "ended",
};
export const QUIET = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
]);

const SID_RE = /^[\w.-]{1,128}$/;

export const clip = (v: unknown, n: number) => {
  const s = String(v || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What one event says before handoff and brake: null = no event for Fleet. */
export interface HookBase {
  name: string;
  sid: string;
  status: Status | null;
  detail: string;
  lastAnswer?: string;
  boxAsk: string;
  offer: string | null;
  /** A prompt the app injected (CI monitor, side sessions, other sessions): a short turn, no answer of the user. */
  injected: boolean;
  /** The question of a tool that waits in the app; null for any other event. */
  toolAsk: string | null;
  /** SessionStart: startup, resume, clear or compact. */
  source?: string;
  /** The subagent the event belongs to (`agent_id`), "" for the main thread. */
  scope: string;
  /** Tool and a hash of its input: ties a permission request (which has no tool_use_id) to its tool call. */
  key?: string;
  toolUseId?: string;
  /** PermissionRequest: a tool the app answers in words (question, plan) or one that needs a yes. */
  waits?: "approval" | "question";
}

/** A recent PreToolUse, kept by the hook next to the state (`<session>.calls`). */
export interface ToolCall {
  id: string;
  key: string;
  agent?: string;
}
const CALLS_PER_SCOPE = 8;
const WAITS_MAX = 8;
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);

export function callKey(tool: unknown, input: unknown): string {
  let s = "";
  try {
    s = JSON.stringify(input ?? null) ?? "";
  } catch {
    // an input that cannot be serialized: the tool name alone
  }
  return `${clip(tool, 80)}:${createHash("sha1").update(s).digest("hex").slice(0, 16)}`;
}

/** The recent calls after this event's PreToolUse, or null when it adds none. */
export function noteCall(calls: unknown, b: HookBase): ToolCall[] | null {
  if (b.name !== "PreToolUse" || !b.toolUseId || !b.key) return null;
  const list = (Array.isArray(calls) ? calls : []).filter(
    (c): c is ToolCall => !!c && typeof c.id === "string" && typeof c.key === "string" && c.id !== b.toolUseId,
  );
  list.push({ id: b.toolUseId, key: b.key, ...(b.scope ? { agent: b.scope } : {}) });
  // The last few per scope: a busy subagent must not push out the main thread's call that waits.
  const count = new Map<string, number>();
  const kept: ToolCall[] = [];
  for (let i = list.length - 1; i >= 0 && kept.length < 4 * CALLS_PER_SCOPE; i--) {
    const c = list[i] as ToolCall;
    const n = count.get(c.agent || "") || 0;
    if (n >= CALLS_PER_SCOPE) continue;
    count.set(c.agent || "", n + 1);
    kept.unshift(c);
  }
  return kept;
}

/**
 * Obvious secrets in a command or address (bearer tokens, `key=`/`token=` values, well-known token prefixes): the
 * detail lands in the state file, events.jsonl and a browser notification (review #145).
 */
export function maskSecrets(text: string): string {
  // Cut first and bound every quantifier: the hook has a 5 s timeout and commands can be heredocs of many KB.
  return text
    .slice(0, 400)
    .replace(/\b((?:authorization:\s*(?:basic|bearer|token)|bearer)\s+)[\w.~+/=-]{4,}/gi, "$1***")
    .replace(/\b([\w-]{0,30}(?:api[_-]?key|token|secret|passw(?:or)?d|pwd)["']?(?:=|:(?=\S)))[^\s"'&;]{2,}/gi, "$1***")
    .replace(/(--?(?:password|passwd|token|secret|api-key)\s+)[^\s-]\S*/gi, "$1***")
    .replace(/(\/\/[^\s/:@]{1,64}:)[^\s/@]{1,128}@/g, "$1***@")
    .replace(/\b(sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|xox[abpr]-[\w-]{8,}|AKIA[0-9A-Z]{12,})/g, "***");
}

/**
 * What a permission request asks, as the row shows it (live 16.10.2026: real rows said only "Claude needs your
 * permission", the demo "Approval for Bash: pnpm e2e …"): the tool and its command, file or address; a question or a
 * plan in their own words.
 */
function permissionText(tool: unknown, input: unknown): string {
  const name = clip(tool, 80);
  if (INTERACTIVE.test(name))
    return (
      toolQuestion(name, input) ||
      (name === "ExitPlanMode"
        ? tr("Plan freigeben?", "Approve the plan?")
        : tr("Frage in der App", "Question in the app"))
    );
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const what = [i.command, i.file_path, i.notebook_path, i.url, i.query].find((v) => typeof v === "string") as
    | string
    | undefined;
  const head = `${tr("Freigabe für", "Approval for")} ${name}`;
  return what ? clip(`${head}: ${maskSecrets(what.slice(0, 2000).replace(/\s+/g, " ").trim())}`, 200) : head;
}

export function hookBase(ev: HookEvent): HookBase | null {
  const name = ev.hook_event_name;
  const sid = typeof ev.session_id === "string" ? ev.session_id : "";
  if (!name || !sid || !(name in HOOK_STATUS) || !SID_RE.test(sid)) return null;
  let status = HOOK_STATUS[name] ?? null;
  let detail = "";
  let injected = false;

  if (name === "Notification") {
    const t = String(ev.notification_type || "");
    const msg = String(ev.message || "");
    if (t === "auth_success") return null;
    if (t === "idle_prompt" || t === "agent_completed" || /waiting for your input/i.test(msg)) status = "waiting";
    // The limit reset and the session resumed on its own: it keeps working, nobody is needed.
    if (t === "quota_auto_resume_fired") status = null;
    detail = clip(msg, 200);
  } else if (name === "UserPromptSubmit") {
    // Own shell commands (!…) and local commands land here too but are no task for Claude.
    // A prompt that is only the app's note is none; an empty one (an image alone) still is the user's turn.
    const raw = String(ev.prompt || "");
    const text = ownText(raw);
    if (LOCAL_PROMPT_RE.test(text) || (!text && raw.trim())) return null;
    injected = AUTO_PROMPT_RE.test(text);
    detail = injected ? tr("Nachricht der App", "message from the app") : clip(text, 200);
  } else if (name === "PermissionRequest") detail = permissionText(ev.tool_name, ev.tool_input);
  else if (name === "PreToolUse" || name === "PostToolUse" || name === "PostToolUseFailure")
    detail = clip(ev.tool_name, 80);
  else if (name === "SubagentStart" || name === "SubagentStop")
    detail = clip(ev.agent_type || ev.subagent_type || "", 80);
  else if (name === "SessionEnd") detail = clip(ev.reason, 80);
  else if (name === "SessionStart") detail = clip(ev.source, 80);
  // `error` is an enum (rate_limit, authentication_failed, …); the server reads the kind from the part before ":".
  else if (name === "StopFailure")
    detail = clip(
      `${ev.error || ev.message || ""}${ev.error && ev.error_details ? `: ${typeof ev.error_details === "string" ? ev.error_details : JSON.stringify(ev.error_details)}` : ""}`,
      200,
    );
  // The answer's end, so the server sees a closing question at once (the transcript is written asynchronously).
  const lastAnswer =
    name === "Stop" && typeof ev.last_assistant_message === "string"
      ? ev.last_assistant_message.slice(-400)
      : undefined;

  // The Desktop app's question box and its "new session or here?" card are tool calls: their question is never in
  // the answer's text, so the server learns it here (the transcript is written asynchronously).
  let boxAsk = "";
  let offer: string | null = null;
  let toolAsk: string | null = null;
  try {
    if (name === "PreToolUse" && typeof ev.tool_name === "string" && INTERACTIVE.test(ev.tool_name))
      toolAsk = toolQuestion(ev.tool_name, ev.tool_input);
    const input = name === "PreToolUse" && ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : null;
    if (input && ev.tool_name === "mcp__ccd_turn__wrap_up" && typeof input.ask === "string")
      boxAsk = clip(input.ask, 200);
    else if (
      input &&
      ev.tool_name === "mcp__ccd_session__start_session" &&
      input.initiation === "offer" &&
      !input.proposal_id
    )
      offer = typeof input.title === "string" ? clip(input.title, 160) : "";
  } catch {
    // the status goes on without the question
  }
  const source = name === "SessionStart" ? String(ev.source || "startup") : undefined;
  const scope = typeof ev.agent_id === "string" && SID_RE.test(ev.agent_id) ? ev.agent_id : "";
  let key: string | undefined;
  let toolUseId: string | undefined;
  try {
    if (TOOL_EVENTS.has(name)) key = callKey(ev.tool_name, ev.tool_input);
    if (typeof ev.tool_use_id === "string" && SID_RE.test(ev.tool_use_id)) toolUseId = ev.tool_use_id;
  } catch {
    // no tie to the tool call: the request then waits until the turn ends
  }
  const waits =
    name === "PermissionRequest" ? (INTERACTIVE.test(String(ev.tool_name || "")) ? "question" : "approval") : undefined;
  return {
    name,
    sid,
    status,
    detail,
    lastAnswer,
    boxAsk,
    offer,
    injected,
    toolAsk,
    source,
    scope,
    key,
    toolUseId,
    waits,
  };
}

const validWait = (w: unknown): w is WaitFor =>
  !!w && typeof (w as WaitFor).key === "string" && typeof (w as WaitFor).since === "number";

/**
 * The permission requests still open after this event. Claude Code keeps one session but runs tools in parallel
 * and subagents in the background: their tool events say nothing about a request that waits (live replay
 * 2026-10-15: a parallel Read's PostToolUse and a background Grep both hid an approval).
 */
function nextWaits(p: Partial<HookState>, b: HookBase, calls: ToolCall[] | undefined, now: number, fresh: boolean) {
  let waits = p.status === "needs_input" && Array.isArray(p.waitFor) ? p.waitFor.filter(validWait) : [];
  const sc = b.scope;
  const mine = (w: WaitFor) => (w.agent || "") === sc;
  if (b.name === "PermissionRequest" && b.key) {
    const taken = new Set(waits.map((w) => w.id));
    let id: string | undefined;
    for (let i = (calls?.length || 0) - 1; i >= 0; i--) {
      const c = calls?.[i];
      if (c && c.key === b.key && (c.agent || "") === sc && !taken.has(c.id)) {
        id = c.id;
        break;
      }
    }
    const w: WaitFor = { ...(id ? { id } : {}), key: b.key, ...(sc ? { agent: sc } : {}), since: now };
    waits = [...waits.filter((x) => !(mine(x) && (id ? x.id === id : !x.id && x.key === b.key))), w];
    return waits.slice(-WAITS_MAX);
  }
  if (!waits.length) return waits;
  // The user is back at the prompt or the session is gone: nothing of the old turn waits any more.
  if (fresh || b.name === "SessionEnd") return [];
  if (b.name === "PostToolUse" || b.name === "PostToolUseFailure")
    return waits.filter((w) => !(mine(w) && (w.id && b.toolUseId ? w.id === b.toolUseId : w.key === b.key)));
  // The main turn ended; a background subagent may still wait for its approval.
  if (b.name === "Stop" || b.name === "StopFailure") return waits.filter((w) => w.agent);
  if (b.name === "SubagentStop" && sc) return waits.filter((w) => w.agent !== sc);
  return waits;
}

/**
 * The state after an event, or null when nothing is written: a newer state is already there (hooks run in
 * parallel), or a quiet tool event follows too closely on one with the same status.
 */
export function nextHookState(
  prev: Partial<HookState> | Record<string, unknown>,
  b: HookBase,
  o: {
    status: Status | null;
    detail: string;
    braking: boolean;
    now: number;
    cwd?: unknown;
    proc?: string;
    /** Recent PreToolUse calls of the session (hook's `<session>.calls`), to tie a permission request to its call. */
    calls?: ToolCall[];
  },
): HookState | null {
  const { name, sid } = b;
  const now = o.now;
  const p = prev as Partial<HookState>;
  let status: Status = o.status === null ? (p.status as Status) || "working" : o.status;
  // An open question outlasts a compaction and a resume: nobody answered it. Compacting a session that waits
  // keeps it waiting; afterwards it is back at the prompt with the question.
  const asking = p.status === "waiting" || p.status === "needs_input";
  if ((name === "PreCompact" || name === "PostCompact") && asking && o.status === "working")
    status = p.status as Status;
  const resumed = name === "SessionStart" && (b.source === "compact" || b.source === "resume");
  if (resumed && o.status === "idle" && (asking || p.boxAsk)) status = "waiting";
  if (typeof p.at === "number" && p.at > now) return null;
  const userTurn = (name === "UserPromptSubmit" && !b.injected) || (name === "SessionStart" && !resumed);
  const waits = nextWaits(p, b, o.calls, now, userTurn);
  // An open request outlasts other tools' events: keep what it says (tool, question) and stay waiting.
  const held = waits.length > 0 && o.status !== "needs_input";
  // The main thread's own status behind the open request: a subagent's events do not set it.
  const underWait: Status | undefined = held
    ? (b.scope ? undefined : (o.status ?? undefined)) || p.underWait || "working"
    : waits.length
      ? p.underWait
      : undefined;
  // The last request went away with an event that keeps the status (SubagentStop): back to what lay behind it.
  if (!waits.length && o.status === null && p.status === "needs_input" && Array.isArray(p.waitFor) && p.waitFor.length)
    status = p.underWait || "working";
  if (held) status = "needs_input";
  // "Waiting for your input" while an approval or question is open is no "done".
  const idleOnAsk = name === "Notification" && o.status === "waiting" && p.status === "needs_input";
  if (idleOnAsk) status = "needs_input";
  const frozen = held || idleOnAsk;
  const sameWaits = JSON.stringify(waits) === JSON.stringify(p.status === "needs_input" ? p.waitFor || [] : []);
  // Tool events in quick succession: write at most every 1.5 s (less disk I/O and fewer push updates).
  if (
    QUIET.has(name) &&
    !o.braking &&
    !b.boxAsk &&
    b.offer === null &&
    p.offer === undefined &&
    b.toolAsk === null &&
    p.toolAsk === undefined &&
    p.status === status &&
    sameWaits &&
    typeof p.at === "number" &&
    now - p.at < 1500
  )
    return null;
  // Held until the user's next prompt: other tool calls, the Stop of the same turn and turns the app injects come after
  // the box; a new box in such a turn wins. A compaction or a resume is no answer either.
  const keptBox = b.boxAsk || (userTurn ? "" : p.boxAsk);
  // The permission request and the app's notification come after the tool's PreToolUse and belong to it.
  // The answer of the user's last turn: an injected turn's Stop does not replace it.
  const heldAnswer = userTurn
    ? undefined
    : name === "Stop" && b.lastAnswer && !p.injectedTurn
      ? b.lastAnswer
      : p.heldAnswer;
  const injectedTurn = name === "UserPromptSubmit" ? b.injected : userTurn ? false : p.injectedTurn;
  const keptTool =
    b.toolAsk ?? (name === "PermissionRequest" || name === "Notification" || frozen ? p.toolAsk : undefined);
  const cwd = typeof o.cwd === "string" ? o.cwd.slice(0, 1000) : p.cwd;
  return {
    sessionId: sid,
    status,
    event: frozen && typeof p.event === "string" ? p.event : name,
    // The app's notification after a permission request says less ("Claude needs your permission"): the request's
    // own words stay.
    detail:
      (frozen || (name === "Notification" && p.event === "PermissionRequest" && status === "needs_input")) &&
      typeof p.detail === "string"
        ? p.detail
        : o.detail,
    at: now,
    cwd,
    startedAt: p.startedAt || now,
    statusSince: p.status === status ? p.statusSince || now : now,
    lastPrompt: name === "UserPromptSubmit" && !b.injected ? o.detail : p.lastPrompt,
    lastTool: name === "PreToolUse" && !frozen ? o.detail : p.lastTool,
    ...(o.proc || typeof p.proc === "string" ? { proc: o.proc || p.proc } : {}),
    // Only for the turn that just ended; any later event belongs to a new turn.
    ...(b.lastAnswer ? { lastAnswer: b.lastAnswer } : {}),
    ...(typeof keptBox === "string" && keptBox ? { boxAsk: keptBox } : {}),
    // Only while its PreToolUse is the last event: the next one is the user's pick.
    ...(b.offer !== null ? { offer: b.offer } : {}),
    ...(typeof keptTool === "string" ? { toolAsk: keptTool } : {}),
    ...(typeof heldAnswer === "string" && heldAnswer ? { heldAnswer } : {}),
    ...(injectedTurn ? { injectedTurn: true } : {}),
    ...(status === "needs_input" && waits.length ? { waitFor: waits } : {}),
    ...(underWait ? { underWait } : {}),
  };
}

/**
 * The state once the brake's wait ends with `reply` (Fleet's answer, or "" without one); null = leave it.
 * `kind` is the decision's kind, `tool` the tool it held.
 */
export function settledState(
  prev: HookState,
  reply: string,
  now: number,
  kind: string,
  tool: unknown = prev?.lastTool,
  key?: string,
): HookState | null {
  if (prev?.status !== "needs_input") return null;
  // Fleet gave no answer to a permission: Claude Code now shows its own dialog, the session still waits. Setting it
  // to "working" made the approval vanish from Fleet (live probe B10).
  if (!reply && kind === "permission") {
    const t = clip(tool, 80) || tr("ein Werkzeug", "a tool");
    // The request's own words (tool and command) stay; only where it waits changes (live 16.10.2026).
    const asked = typeof prev.detail === "string" ? prev.detail.split(" – ")[0] || "" : "";
    const own = /^(Freigabe für|Approval for) /.test(asked);
    return {
      ...prev,
      event: "PermissionRequest",
      detail: own
        ? `${asked} – ${tr("wartet in der App", "waits in the app")}`
        : tr(`wartet in der App auf Freigabe für ${t}`, `waits in the app for approval of ${t}`),
      at: Math.max(now, typeof prev.at === "number" ? prev.at : 0),
    };
  }
  const stopped = reply.includes('"continue":false');
  // Fleet answered one request; others of parallel calls or subagents still wait in the app.
  const rest = Array.isArray(prev.waitFor) && key ? prev.waitFor.filter((w) => validWait(w) && w.key !== key) : [];
  if (!stopped && rest.length) return { ...prev, waitFor: rest, at: now };
  const { waitFor: _w, underWait: _u, ...base } = prev;
  return {
    ...base,
    status: stopped ? "waiting" : "working",
    event: "PreToolUse",
    detail: stopped ? tr("von dir in Fleet angehalten", "stopped by you in Fleet") : "",
    at: now,
    statusSince: now,
  };
}
