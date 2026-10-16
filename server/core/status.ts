import type { Ask, Config, Failure, Session, Status } from "../../shared/types";
import { LOOK_MS } from "../process/screen";
import { classifyHook, describe } from "./apierror";
import { detectAsk, INTERACTIVE } from "./ask";
import { tr } from "./lang";
import { contextSize } from "./models";

/**
 * The status of a session from hook, transcript and agent view, and its context window. The only place that
 * decides "waits for you" and "error"; the groups on the dashboard come from shared/inbox.ts.
 */

const KNOWN: Status[] = ["working", "stale", "needs_input", "waiting", "error", "idle", "ended"];
const DAY = 24 * 3600e3;
/** How old the last sign of a session must be before a dead process file ends it (review #146). */
const GONE_GRACE_MS = 10e3;

/**
 * Status without hooks, guessed from the end of the transcript. An open tool call can be a long test run or a
 * waiting approval, which cannot be told apart without hooks: so "working" (after staleMinutes "stale"). A turn
 * without an end stays "working" too, so a long thinking step does not look like resting; if it never ends, it
 * becomes "stale" (process gone).
 */
function fromTranscript(s: Session, age: number): Status {
  if (s.turn === "done" || s.turn === "interrupted") return "waiting";
  if (s.turn === "tool_pending" || s.turn === "running") return "working";
  return age < 120e3 ? "working" : "idle";
}

/** A failure from the transcript counts unless the hook saw the session go on afterwards. */
function transcriptFailure(s: Session): Failure | null {
  const f = s.failure;
  if (!f) return null;
  const h = s.hook;
  if (h && h.at > f.at && (h.status === "working" || h.status === "needs_input" || h.status === "waiting")) return null;
  // A Fleet process that started after the failure is the session going on.
  if (s.proc && !s.proc.job && s.proc.startedAt > f.at && s.proc.status === "running") return null;
  return f;
}

/**
 * A session Fleet runs itself (server/process): the process is the surest source for "crashed", "ended" and
 * "interrupted". While it runs, the status comes from hook and transcript plus three signals Fleet owns; the
 * screen is never read for the status (its patterns broke with every Claude Code release, B12):
 * - K: own keystrokes after the hook asked (Esc, a digit, Enter, text) answer it, until the next hook event.
 * - S: no hook event within LOOK_MS of the spawn (or of the last keystroke) means a dialog before the session
 *   starts (folder trust, theme, security notes, login, anything new): it waits for you.
 * - Q: the hook says working, but no output, keystroke or hook event for LOOK_MS: Claude Code redraws its spinner
 *   all the time while it works, so silence is a dialog without a hook. An extra look is the accepted price.
 */
function fromProcess(
  s: Session,
  base: Status,
  now: number,
): { status: Status; failure?: Failure; ask?: Ask; detail?: string; answered?: true } | null {
  const p = s.proc;
  if (!p) return null;
  const h = s.hook;
  if (p.job) {
    return p.status === "running" || p.status === "starting"
      ? {
          status: "working",
          detail: tr("Fleet-Job im Hintergrund: Übergabe", "Fleet job in the background: handoff"),
        }
      : null;
  }
  // 1: crashed or could not start, unless a hook saw the session go on afterwards.
  if (p.status === "failed" && !(h && p.endedAt && h.at > p.endedAt)) {
    const text =
      p.exitCode === null || p.exitCode === undefined
        ? tr("Prozess abgebrochen oder nicht gestartet", "Process aborted or did not start")
        : tr(`Prozess beendet (Code ${p.exitCode})`, `Process ended (code ${p.exitCode})`);
    return { status: "error", failure: { kind: "crash", text, at: p.endedAt || now } };
  }
  // 2: a clean exit confirms the end.
  if (p.status === "exited") return { status: "ended" };
  // 3: cut off by a Fleet restart: nothing is broken, it is only no longer attached.
  if (p.status === "interrupted")
    return { status: "idle", detail: tr("durch Fleet-Neustart unterbrochen", "interrupted by a Fleet restart") };
  if (p.status !== "running" && p.status !== "starting") return null;
  const look = (text: string): { status: Status; ask: Ask } => ({
    status: "needs_input",
    ask: { kind: "question", text },
  });
  // S: no hook event since the spawn. Keystrokes restart the clock, so the next dialog of a series alarms again.
  if (!h || h.at < p.startedAt) {
    if (now - Math.max(p.startedAt, p.lastInputAt) >= LOOK_MS)
      return look(tr("wartet beim Start – bitte ansehen", "waits at startup – please take a look"));
    return { status: "working", detail: tr("startet …", "starting …") };
  }
  // K: the hook asked (approval, question, a question at the end of the turn) and you typed since.
  const pending =
    h.event === "PreToolUse" && (INTERACTIVE.test(String(h.lastTool || "")) || typeof h.offer === "string");
  const asked = h.status === "needs_input" || h.status === "waiting" || (h.status === "working" && pending);
  if (asked && base === h.status && p.lastInputAt > h.at)
    return { status: "waiting", answered: true, detail: tr("im Terminal beantwortet", "answered in the terminal") };
  // Q: the hook says working, and nothing has stirred for LOOK_MS.
  if (h.status === "working" && !pending && now - Math.max(p.lastOutputAt, p.lastInputAt, h.at) >= LOOK_MS)
    return look(tr("prüfen – Terminal still", "check – terminal silent"));
  return null;
}

/** The alarm row's sentence for a tool that waits in the app: its own question, else what it waits for. */
function toolWords(tool: string, q: string): string {
  const name = tool.replace(/^mcp__[\w-]+__/, "").replace(/_/g, " ");
  if (tool === "ExitPlanMode") return tr("Plan freigeben?", "Approve the plan?");
  if (q && tool === "AskUserQuestion") return q;
  if (q && /request_directory|change_directory/.test(tool)) return tr(`Ordner wählen: ${q}`, `Choose a folder: ${q}`);
  if (q) return tr(`Zugriff freigeben (${name}): ${q}`, `Grant access (${name}): ${q}`);
  return tr(`wartet in der App auf dich (${name})`, `waits for you in the app (${name})`);
}

/**
 * The hook waits for permission requests, but the transcript already has a result for each of their tool calls:
 * answered without a hook event (a denial), so the hook's "waits" is stale.
 */
function answeredInTranscript(s: Session): boolean {
  const w = s.hook?.status === "needs_input" && Array.isArray(s.hook.waitFor) ? s.hook.waitFor : [];
  if (!w.length || !Array.isArray(s.recent)) return false;
  const pending = new Set(s.pending || []);
  return w.every((x) => typeof x?.id === "string" && !pending.has(x.id) && s.recent?.some((r) => r.id === x.id));
}

/**
 * Why a waiting session waits, for the browser (the hook data stays on the server): a tool call held for a yes (the
 * hook's open permission request, or the screen of Fleet's own window) or an answer in words.
 */
export function waitsFor(s: Session): "approval" | "question" | null {
  if (s.status !== "needs_input") return null;
  const h = s.hook;
  // A question (AskUserQuestion) or a plan held by the app is answered in words, not with a yes (live 16.10.2026).
  if (h?.status === "needs_input" && Array.isArray(h.waitFor) && h.waitFor.length)
    return h.waitFor.every((w) => INTERACTIVE.test(String(w.key || "").split(":")[0] || "")) ? "question" : "approval";
  if (s.proc?.screen?.kind === "approval") return "approval";
  return "question";
}

/** Tools that can stop at an approval prompt; after any other tool a waiting session waits for something else. */
const APPROVES = /^(Bash|Edit|MultiEdit|Write|NotebookEdit|WebFetch|WebSearch|mcp__.+)$/;

/** Hook events after which "working" stands for something the transcript cannot see (a handoff Fleet asked for). */
const TURN_END_EVENTS = new Set(["Stop", "StopFailure", "SessionEnd"]);

export function deriveStatus(s: Session, cfg: Pick<Config, "staleMinutes">, now: number): void {
  const h = s.hook;
  const mt = s.mtime || 0;
  s.lastActivity = Math.max(mt, h?.at || 0, s.lastTimestamp || 0, s.proc?.lastOutputAt || 0);
  let status: Status = "idle";
  let source: Session["statusSource"] = null;
  // A waiting approval holds while the transcript has not gone on: the app keeps writing bookkeeping lines
  // (queued messages, file history) that make the file newer without any progress of the session.
  const hookWaits = !!h && h.status === "needs_input" && s.turn === "tool_pending";
  // The hook missed the end of the turn: it saw no end, the transcript ended the turn after its last word. A
  // session without Fleet's Stop hook (only the app's own hooks ran) otherwise showed "working" for hours while
  // its closing question waited (fleet compat, 15 Oct). A Stop the hook saw (handoff, brake) keeps the hook's word.
  const missedStop =
    !!h &&
    h.status === "working" &&
    !TURN_END_EVENTS.has(h.event) &&
    s.turn === "done" &&
    (s.lastTimestamp || 0) > h.at;
  if (h && !missedStop && !answeredInTranscript(s) && (h.at >= mt - 15000 || h.status === "ended" || hookWaits)) {
    status = h.status;
    source = "hook";
  } else if (mt) {
    status = fromTranscript(s, now - Math.max(mt, s.lastTimestamp || 0));
    source = "transcript";
  }
  if (s.agent?.status && source !== "hook") {
    status = s.agent.status;
    source = "agent-view";
  }
  const fp = fromProcess(s, status, now);
  if (fp?.failure) {
    // A crash is certain: no transcript or hook guess on top of it.
    s.status = "error";
    s.statusSource = "process";
    s.failure = { ...fp.failure, text: describe(fp.failure, now) };
    s.ask = null;
    s.statusSince = fp.failure.at;
    s.detail = s.failure.text;
    return;
  }
  if (fp?.status === "idle") {
    s.status = "idle";
    s.statusSource = "process";
    s.failure = null;
    s.ask = null;
    s.statusSince = s.proc?.endedAt || s.lastActivity;
    s.detail = fp.detail || "";
    return;
  }
  const procAsk = fp?.ask || null;
  if (fp) {
    status = fp.status;
    source = "process";
  }
  const pendingTool =
    source === "hook"
      ? h?.event === "PreToolUse"
        ? String(h.lastTool || h.detail || "")
        : ""
      : s.turn === "tool_pending"
        ? String(s.lastTool || "")
        : "";
  // "New session or here?" blocks only as an offer; the hook and the transcript tell it from other initiations.
  const offerText =
    source === "hook"
      ? h?.event === "PreToolUse" && typeof h.offer === "string"
        ? h.offer.slice(0, 160)
        : null
      : s.turn === "tool_pending" && s.offer && typeof s.offer.text === "string"
        ? s.offer.text
        : null;
  const offer: Ask | null =
    status === "working" && offerText !== null
      ? {
          kind: "question",
          text: offerText
            ? tr(`Neue Session oder hier? ${offerText}`, `New session or here? ${offerText}`)
            : tr("Neue Session oder hier?", "New session or here?"),
        }
      : null;
  // The hook keeps the tool's question through a permission request and the app's notification after it.
  const hookTool = source === "hook" && typeof h?.toolAsk === "string" && INTERACTIVE.test(String(h.lastTool || ""));
  const asksYou =
    !offer && ((status === "working" && INTERACTIVE.test(pendingTool)) || (status === "needs_input" && hookTool));
  const tool = hookTool ? String(h?.lastTool || "") : pendingTool;
  const toolText = asksYou
    ? hookTool
      ? String(h?.toolAsk || "")
      : source !== "hook" && s.toolAsk && s.toolAsk.tool === tool
        ? s.toolAsk.text
        : ""
    : "";
  const toolAsk: Ask | null = asksYou ? { kind: "question", text: toolWords(tool, toolText) } : null;
  if (asksYou || offer) status = "needs_input";

  // Claude Code's own word on its process (ccprocs.ts) settles what hooks and transcripts can only guess: a prompt in
  // the app the hook never reported, a long tool run that is no stall, a turn whose end the hook missed. What Fleet
  // already shows as waiting stays (its own questions hold the process busy; a closing question is idle).
  const cc = s.cc;
  let ccWaits = false;
  if (cc) {
    if (cc.status === "waiting" && status !== "needs_input") {
      status = "needs_input";
      source = "claude";
      ccWaits = true;
    } else if (cc.status === "idle" && (status === "working" || status === "stale")) {
      status = "waiting";
      source = "claude";
    } else if (
      cc.status === "busy" &&
      (status === "waiting" || status === "idle") &&
      cc.at > Math.max(h?.at || 0, s.lastTimestamp || 0)
    ) {
      status = "working";
      source = "claude";
    }
  }

  // The process is gone (its file stays, its pid is dead) and no SessionEnd came: a window closed or a crash (live
  // 16.10.2026: five killed test sessions stayed "wartet"; old probes "waited" 1649 min). A prompt only the hook held
  // and a turn still running cannot go on; a closing question in words can, after a resume, so that one stays.
  let gone = false;
  if (
    s.ccGone &&
    !cc &&
    // A process that just started may not have written its file yet: the last hook event is a few seconds old.
    now - Math.max(h?.at || 0, s.lastActivity || 0) > GONE_GRACE_MS &&
    ((status === "needs_input" && source === "hook" && !!h?.waitFor?.length) || status === "working")
  ) {
    status = "ended";
    source = "claude";
    gone = true;
  }

  // Error: the transcript knows more causes than the hook (no StopFailure for an expired login). Auth, limit and
  // spend outlast the end of the session, their one action still applies; a plain API error does not.
  let failure: Failure | null = null;
  const tf = transcriptFailure(s);
  if (tf && (status !== "ended" || tf.kind !== "api")) {
    status = "error";
    failure = { ...tf, text: describe(tf, now) };
  } else if (status === "error") {
    const kind = classifyHook(h?.detail);
    failure = { kind, text: describe({ kind, text: String(h?.detail || "") }, now), at: h?.at || s.lastActivity };
  }

  // Done, but the answer ends with a question or a request for a yes: that waits for you.
  // The hook's copy of the answer comes first: the transcript is written asynchronously and may lag behind.
  // The Desktop app's question box is a tool call: the hook holds its question from PreToolUse to the next prompt.
  let ask: Ask | null =
    procAsk ||
    offer ||
    toolAsk ||
    (ccWaits
      ? {
          kind: APPROVES.test(pendingTool) ? "approval" : "question",
          text: APPROVES.test(pendingTool)
            ? tr(`wartet in der App auf Freigabe für ${pendingTool}`, `waits in the app for approval of ${pendingTool}`)
            : tr("wartet in der App auf dich", "waits for you in the app"),
        }
      : null);
  if (gone) ask = null;
  if (status === "waiting" && s.turn !== "interrupted" && !fp?.answered) {
    const box = source === "hook" && typeof h?.boxAsk === "string" && h.boxAsk.trim() ? h.boxAsk.trim() : "";
    ask =
      (source === "hook" && h?.event === "Stop" ? detectAsk(h.lastAnswer) : null) ||
      (box ? { kind: "question", text: box.length > 200 ? `${box.slice(0, 199)}…` : box } : null) ||
      // The user's last turn ended with a question that no later event answered (injected turn, compaction).
      (source === "hook" && typeof h?.heldAnswer === "string" ? detectAsk(h.heldAnswer) : null) ||
      s.ask ||
      null;
    if (ask) status = "needs_input";
  }

  // A process Claude Code reports busy is alive and working, however long its tool runs.
  if (status === "working" && cc?.status !== "busy" && now - s.lastActivity > cfg.staleMinutes * 60e3) {
    status = "stale";
    const mins = Math.round((now - s.lastActivity) / 60e3);
    const tool = String(s.lastTool || "");
    failure = {
      kind: "stuck",
      text: tool
        ? tr(`seit ${mins} Min keine Rückmeldung (zuletzt ${tool})`, `no sign of life for ${mins} min (last ${tool})`)
        : tr(`seit ${mins} Min keine Rückmeldung`, `no sign of life for ${mins} min`),
      at: s.lastActivity,
    };
  }
  // Nothing stays an alarm for more than a day (ISA-18.2: stale alarms); older ones rest.
  if (
    (status === "waiting" || status === "needs_input" || status === "error" || status === "stale") &&
    now - s.lastActivity > DAY
  ) {
    status = "idle";
    failure = null;
    ask = null;
  }
  if (!KNOWN.includes(status)) status = "idle";
  s.status = status;
  s.statusSource = source;
  s.failure = failure;
  s.ask = ask;
  s.statusSince =
    h && h.status === status ? h.statusSince || h.at : failure && status === "error" ? failure.at : s.lastActivity;
  s.detail = gone
    ? tr("Prozess beendet, ohne sich abzumelden", "Process ended without signing off")
    : ask
      ? ask.text
      : failure
        ? failure.text
        : fp?.detail
          ? fp.detail
          : h && h.status === status
            ? h.detail
            : source === "transcript" && s.turn === "tool_pending" && s.lastTool
              ? tr(`führt ${s.lastTool} aus oder wartet auf Freigabe`, `runs ${s.lastTool} or waits for approval`)
              : s.agent?.waitingFor || "";
}

/**
 * Context window of a session. The status line delivers the real size; without it the model counts, and more
 * than 200k tokens only fit a one-million window.
 */
export function contextFor(
  tokens: number,
  model: string | null | undefined,
  cfg: Pick<Config, "contextWindow">,
  known?: number,
) {
  const size = cfg.contextWindow || known || contextSize(model, tokens);
  return { tokens, size, pct: Math.min(100, Math.round((1000 * tokens) / size) / 10) };
}
