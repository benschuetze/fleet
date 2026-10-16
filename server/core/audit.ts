import { AUTO_PROMPT_RE, ownText } from "../../shared/prompts";
import type { HookState, Session, Status, TranscriptData } from "../../shared/types";
import { type HookEvent, hookBase, nextHookState, settledState } from "./hookstate";
import { applyTail, emptyData } from "./sessions";
import { deriveStatus } from "./status";

/**
 * `fleet audit`: replays old transcripts and hook events through the real status code (trackAsk via applyTail,
 * the hook's state via hookstate.ts, deriveStatus) and compares every moment with an independent ground truth
 * of "this session waits for the user". The answer to "would Fleet have shown it?" for real history, not only
 * for invented fixtures. Pure: the CLI (server/cli/audit.ts) reads the files and prints ids and times only.
 *
 * Limits of the replay: events.jsonl keeps only the loud hook events, so tool events are rebuilt from the
 * transcript; the hook's own copy of an answer (`lastAnswer`) is taken from the transcript; Fleet's terminal
 * screen (server/process/screen.ts) is not replayed.
 */

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;

export type WaitKind = "fleet" | "permission" | "question" | "plan" | "directory" | "access" | "offer" | "box" | "text";
export const WAIT_KINDS: WaitKind[] = [
  "fleet",
  "permission",
  "question",
  "plan",
  "directory",
  "access",
  "offer",
  "box",
  "text",
];

/** One line of ~/.claude-fleet/events.jsonl as the hook wrote it. */
export interface AuditEvent {
  at: number;
  sessionId: string;
  event: string;
  status: Status;
  detail?: string;
}

/** A stretch of time in one session: what the ground truth says and what Fleet would have shown. */
export interface Moment {
  sessionId: string;
  from: number;
  to: number;
  kind: WaitKind | null;
  fleet: Status;
  source: Session["statusSource"];
  /** An injected turn runs on top of the open question: Fleet shows it working, the wait is not due. */
  paused: boolean;
  /** Why Fleet showed "needs_input" (`hook:<event>`, `ask:<kind>`, `tool`); empty otherwise. Never text. */
  why: string;
}

export interface SessionAudit {
  sessionId: string;
  hooks: boolean;
  /** Every stretch, merged: same truth and same Fleet status in a row. */
  moments: Moment[];
}

export interface AuditReport {
  hours: number;
  from: number;
  to: number;
  sessions: number;
  withHooks: number;
  /** Per kind: stretches where the session waited, and how many of them Fleet missed at some point. */
  byKind: Record<WaitKind, { waits: number; missed: number }>;
  /** Waits for the user, Fleet did not show "needs_input". */
  misses: Moment[];
  /** Fleet showed "needs_input", nothing waited. */
  falseAlarms: Moment[];
  /**
   * Sessions the hook reported in the window without any transcript: Fleet knows only the hook's status (a Fleet
   * terminal that inherited a parent session's markers wrote none, PR #46). Nothing about them can be checked.
   */
  noTranscript: { sessionId: string; from: number; to: number; events: number }[];
}

/** A state shorter than this is not missable: the transcript lags the hook by about that much. */
export const GRACE_MS = 10e3;
const DAY = 24 * 3600e3;

// Tools whose call waits for an answer in the app until their tool_result.
const TOOL_KIND: [RegExp, WaitKind][] = [
  [/^AskUserQuestion$/, "question"],
  [/^ExitPlanMode$/, "plan"],
  [/^mcp__ccd_directory__\w+$/, "directory"],
  [/^mcp__[\w-]+__request_(access|teach_access|full_control)$/, "access"],
];
const BOX_TOOL = "mcp__ccd_turn__wrap_up";
const OFFER_TOOL = "mcp__ccd_session__start_session";
const INTERRUPT = /^\[Request interrupted by user/;
// Text the user really typed may start with a tag only for pasted content or a shell command; every other tag is the
// app or a command.
// A shell command of the user (`!…`) is their own action in the session: it answers like a prompt.
const TYPED_TAG = /^<(pasted_content|bash-input)[\s>]/;

const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";
const blocks = (o: Line): Line[] => (o.message && Array.isArray(o.message.content) ? o.message.content : []);

/**
 * The ground truth, written independently of trackAsk and detectAsk: a prompt the user typed answers everything
 * that is open, an automated one (`<ci-monitor-event>`, `<task-notification>`, …) answers nothing.
 */
export function typedByUser(o: Line): boolean {
  if (o?.type !== "user" || o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly)
    return false;
  if (blocks(o).some((b) => b?.type === "tool_result")) return false;
  // Context the app puts in front of a prompt (`<system-reminder>…`) is no part of it: a `!` command typed after it
  // is still the user's (fleet audit 16.10.2026).
  const t = ownText(textOf(o.message?.content));
  if (!t || INTERRUPT.test(t)) return false;
  if (AUTO_PROMPT_RE.test(t)) return false;
  return !t.startsWith("<") || TYPED_TAG.test(t);
}

// An explicit request for a yes or a decision, without a question mark.
const REQUEST =
  /\b((deine?n?|your) (ok|okay|ja|go|go-ahead|freigabe|approval|entscheidung|decision|bestätigung|zustimmung|confirmation)|wartet\b.{0,30}\bauf dich|waits (on|for) you)\b/i;

/**
 * A closing question: one of the last two lines of the final text (outside code) has a sentence of two words
 * or more that ends with "?", or asks for an okay or a decision in so many words.
 */
export function endsWithQuestion(text: string): boolean {
  const lines = text
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/[\s*_`)"“”'»«]+$/, "").trim())
    .filter(Boolean)
    .slice(-2);
  return lines.some(
    (l) => REQUEST.test(l) || l.split(/(?<=[.!?])\s+/).some((x) => x.endsWith("?") && x.split(/\s+/).length >= 2),
  );
}

class Truth {
  tools = new Map<string, WaitKind>();
  box = false;
  /** A question box was called; the user sees it once the turn ends. */
  armed = false;
  text = false;
  permission = false;
  /** Fleet's own question (the brake held a tool call), until its answer or deadline. */
  fleet = false;
  autoTurn = false;
  /** An injected turn runs: Fleet shows it working, the open question comes back at its end. */
  busy = false;

  clear() {
    this.tools.clear();
    this.box = false;
    this.armed = false;
    this.text = false;
    this.permission = false;
    this.fleet = false;
    this.busy = false;
  }

  line(o: Line) {
    if (!o || o.isSidechain) return;
    if (o.type === "user") {
      const t = textOf(o.message?.content).trim();
      if (INTERRUPT.test(t)) return this.clear();
      if (typedByUser(o)) {
        this.clear();
        this.autoTurn = false;
        return;
      }
      const results = blocks(o).filter((b) => b?.type === "tool_result");
      for (const b of results) this.tools.delete(String(b.tool_use_id));
      if (results.length) {
        this.permission = false;
        this.fleet = false;
      } else if (
        t &&
        !o.isCompactSummary &&
        !o.isVisibleInTranscriptOnly &&
        // A message of another session or a subagent comes as a meta line with Claude Code's own first words
        // (round 5): it is injected like a tag, no answer of the user.
        (AUTO_PROMPT_RE.test(t) || (!o.isMeta && t.startsWith("<")))
      ) {
        this.autoTurn = true;
        // Context the app puts in front (`<system-reminder>…</system-reminder>`) carries no turn; what follows does.
        const rest = ownText(t);
        this.busy = !!rest && !/^<(bash-|local-command|command-|system-reminder|user-memory)/.test(rest);
      }
      return;
    }
    if (o.type !== "assistant" || !o.message || o.message.model === "<synthetic>") return;
    const content = blocks(o);
    const uses = content.filter((b) => b?.type === "tool_use" && typeof b.name === "string");
    for (const b of uses) {
      const k = TOOL_KIND.find(([re]) => re.test(b.name))?.[1];
      if (k) this.tools.set(String(b.id), k);
      else if (b.name === OFFER_TOOL && b.input?.initiation === "offer" && !b.input?.proposal_id)
        this.tools.set(String(b.id), "offer");
      else if (b.name === BOX_TOOL && typeof b.input?.ask === "string" && b.input.ask.trim()) this.armed = true;
    }
    if (uses.length) return;
    const stop = o.message.stop_reason;
    if (stop !== "end_turn" && stop !== "stop_sequence") return;
    this.endTurn();
    // A turn of the user replaces an old closing question; an automated turn only adds one.
    const asks = endsWithQuestion(textOf(content));
    this.text = this.autoTurn ? this.text || asks : asks;
  }

  endTurn() {
    this.busy = false;
    if (this.armed) this.box = true;
    this.armed = false;
  }

  event(e: AuditEvent) {
    if (e.event === "Stop") {
      this.endTurn();
      // Fleet itself let the turn go on (it asked for a handoff): like an injected turn, the question comes back.
      if (e.status === "working") this.busy = true;
    }
    if (e.event === "PermissionRequest") this.permission = true;
    else if (e.event === "PreToolUse" && e.status === "needs_input") this.fleet = true;
    else if (e.event === "SessionEnd") this.clear();
    else if (e.event === "Stop" || e.event === "StopFailure" || e.event === "UserPromptSubmit") this.permission = false;
  }

  kind(): WaitKind | null {
    if (this.fleet) return "fleet";
    // The app asks for permission to show a question too: the tool says more than "permission".
    for (const k of this.tools.values()) return k;
    if (this.permission) return "permission";
    if (this.box) return "box";
    if (this.text) return "text";
    return null;
  }
}

/** An answer to the brake (~/.claude-fleet/decisions): `reply` "" = it ran out, "stop" = stopped, else answered. */
export interface AuditDecision {
  sessionId: string;
  kind: string;
  at: number;
  reply: "" | "stop" | "answer";
}

type Item =
  | { t: number; n: number; line: Line }
  | { t: number; n: number; ev: HookEvent }
  | { t: number; n: number; rec: AuditEvent }
  | { t: number; n: number; dec: AuditDecision };

/**
 * The tool events the hook saw but events.jsonl does not keep, rebuilt from the transcript. Calls of one message
 * are written at once but run one after the other: the next PreToolUse comes with the previous call's result.
 * The results carry neither tool_use_id nor input on purpose: events.jsonl keeps a PermissionRequest without
 * them, so only an event as bare as that one ends its replayed wait (`waitFor` in hookstate.ts), i.e. any result.
 */
function toolEvents(sessionId: string, lines: Line[], at: (i: number) => number): { t: number; ev: HookEvent }[] {
  const resultAt = new Map<string, number>();
  lines.forEach((l, i) => {
    if (l?.type === "user" && !l.isSidechain)
      for (const b of blocks(l)) if (b?.type === "tool_result") resultAt.set(String(b.tool_use_id), at(i));
  });
  const out: { t: number; ev: HookEvent }[] = [];
  const lastOf = new Map<string, string>();
  lines.forEach((l, i) => {
    if (!l || l.isSidechain || !at(i)) return;
    for (const b of blocks(l)) {
      if (l.type === "assistant" && b?.type === "tool_use") {
        const msg = String(l.message?.id || i);
        const prev = lastOf.get(msg);
        lastOf.set(msg, String(b.id));
        const after = prev === undefined ? at(i) : resultAt.get(prev);
        if (after === undefined) continue;
        out.push({
          t: Math.max(at(i), after),
          ev: { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: b.name, tool_input: b.input },
        });
      } else if (l.type === "user" && b?.type === "tool_result")
        out.push({
          t: at(i),
          ev: { hook_event_name: b.is_error ? "PostToolUseFailure" : "PostToolUse", session_id: sessionId },
        });
    }
  });
  return out;
}

/** What made Fleet show "needs_input": the kind of its question, or the hook event behind it. */
function why(s: Session): string {
  if (s.status !== "needs_input") return "";
  if (s.statusSource === "hook" && s.hook && s.hook.status === "needs_input") return `hook:${s.hook.event}`;
  return s.ask ? `ask:${s.ask.kind}` : "tool";
}

/**
 * Replays one session. `lines` is the transcript in file order, `events` the hook's events and `decisions` the
 * brake's answers of this session.
 */
export function replaySession(
  sessionId: string,
  lines: Line[],
  events: AuditEvent[],
  o: { from: number; to: number; staleMinutes: number; decisions?: AuditDecision[] },
): SessionAudit {
  const hooks = events.length > 0;
  const stamps: number[] = [];
  let last = 0;
  for (const line of lines) {
    const ts = typeof line?.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    if (Number.isFinite(ts)) last = ts;
    stamps.push(last);
  }
  const at = (i: number) => stamps[i] || 0;
  let n = 0;
  const items: Item[] = [];
  lines.forEach((line, i) => {
    if (at(i)) items.push({ t: at(i), n: n++, line });
  });
  if (hooks) for (const e of toolEvents(sessionId, lines, at)) items.push({ t: e.t, n: n++, ev: e.ev });
  for (const rec of events) items.push({ t: rec.at, n: n++, rec });
  for (const dec of o.decisions || []) items.push({ t: dec.at, n: n++, dec });
  items.sort((a, b) => a.t - b.t || a.n - b.n);

  const data: TranscriptData = emptyData(`${sessionId}.jsonl`);
  const truth = new Truth();
  let hook: HookState | null = null;
  let lineAt = 0;
  let activity = 0;
  let answer = "";
  const moments: Moment[] = [];

  const look = (t: number, from: number, to: number) => {
    if (t < o.from || t > o.to) return;
    const s = { ...data, id: sessionId, source: "local", mtime: lineAt, hook: hook ? { ...hook } : null } as Session;
    if (s.hook && typeof s.hook.lastTool === "string" && s.hook.lastTool && s.hook.at >= (s.lastTimestamp || 0))
      s.lastTool = s.hook.lastTool;
    deriveStatus(s, { staleMinutes: o.staleMinutes }, t);
    // Fleet rests every alarm after a day without activity; the truth follows the same rule.
    const kind = t - activity > DAY ? null : truth.kind();
    const paused = !!kind && truth.busy && (kind === "box" || kind === "text");
    const fleet = (s.status === "cloud" ? "idle" : s.status) || "idle";
    const prev = moments[moments.length - 1];
    if (prev && prev.kind === kind && prev.paused === paused && prev.fleet === fleet && prev.to >= from - GRACE_MS)
      prev.to = to;
    else
      moments.push({
        sessionId,
        from: Math.max(from, o.from),
        to,
        kind,
        fleet,
        source: s.statusSource ?? null,
        paused,
        why: why(s),
      });
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    activity = Math.max(activity, it.t);
    if ("line" in it) {
      applyTail(data, [it.line]);
      truth.line(it.line);
      lineAt = it.t;
      if (it.line.type === "assistant" && !it.line.isSidechain) {
        const t = textOf(it.line.message?.content).trim();
        if (t) answer = t.slice(-400);
      }
    } else if ("ev" in it) {
      const b = hookBase(it.ev);
      const next: HookState | null =
        b && nextHookState(hook || {}, b, { status: b.status, detail: b.detail, braking: false, now: it.t });
      if (next) hook = next;
    } else if ("dec" in it) {
      const d = it.dec;
      if (d.reply && d.kind === "permission") truth.permission = false;
      if (d.kind !== "permission") truth.fleet = false;
      const reply = d.reply === "" ? "" : d.reply === "stop" ? '{"continue":false}' : "{}";
      const next: HookState | null = hook && settledState(hook, reply, d.at, d.kind);
      if (next) hook = next;
    } else {
      const r = it.rec;
      truth.event(r);
      const b = hookBase({ hook_event_name: r.event, session_id: sessionId });
      if (b) {
        // The status as it was written, brake and handoff included; the answer's end as the hook copied it.
        const base = { ...b, lastAnswer: r.event === "Stop" ? answer : undefined };
        const next = nextHookState(hook || {}, base, {
          status: r.status,
          detail: String(r.detail || ""),
          braking: false,
          now: r.at,
        });
        if (next) hook = next;
      }
    }
    const nextT = i + 1 < items.length ? (items[i + 1] as Item).t : o.to;
    if (nextT - it.t < GRACE_MS) continue;
    look(it.t + GRACE_MS, it.t, nextT);
    look(nextT - 1, it.t, nextT);
  }
  return { sessionId, hooks, moments };
}

/** Sums up replayed sessions: misses and false alarms, and per kind how often a wait was missed. */
export function report(audits: SessionAudit[], o: { hours: number; from: number; to: number }): AuditReport {
  const byKind = Object.fromEntries(WAIT_KINDS.map((k) => [k, { waits: 0, missed: 0 }])) as AuditReport["byKind"];
  const misses: Moment[] = [];
  const falseAlarms: Moment[] = [];
  for (const a of audits) {
    // A wait is one run of moments with the same kind; it counts as missed if any part of it was not shown.
    let run: { kind: WaitKind; missed: boolean } | null = null;
    const close = () => {
      if (!run) return;
      byKind[run.kind].waits++;
      if (run.missed) byKind[run.kind].missed++;
      run = null;
    };
    for (const m of a.moments) {
      if (m.kind && !m.paused && m.fleet !== "needs_input") misses.push(m);
      if (!m.kind && m.fleet === "needs_input") falseAlarms.push(m);
      if (!m.kind || (run && run.kind !== m.kind)) close();
      if (m.kind) {
        run = run || { kind: m.kind, missed: false };
        if (!m.paused && m.fleet !== "needs_input") run.missed = true;
      }
    }
    close();
  }
  return {
    hours: o.hours,
    from: o.from,
    to: o.to,
    sessions: audits.length,
    withHooks: audits.filter((a) => a.hooks).length,
    byKind,
    misses,
    falseAlarms,
    noTranscript: [],
  };
}
