import { inbox, places } from "./inbox";
import type { Decision, FleetEvent, Overview, Status } from "./types";

/**
 * The event stream on "Now" (spec, Brainstorming: Ereignisstrom): only changes of state, like a ticker. The
 * hook logs every event (new task, permission, stop, compaction, subagents …); here a session shows up again only
 * when its status really changed. Events come from events.jsonl and are unchecked input.
 */

export interface StreamItem {
  at: number;
  sessionId: string;
  status: StreamStatus;
  /** Cut to 200 characters. */
  detail: string;
  cwd: string | null;
}

export type StreamStatus = Exclude<Status, "idle">;
const KNOWN = new Set<string>(["working", "stale", "needs_input", "waiting", "error", "ended"]);
const ID = /^[\w.-]{1,128}$/;

/** A session as the overview sees it now: its status may come from the transcript, where the hook logged nothing. */
export interface StreamNow {
  id: string;
  status?: string;
  statusSince?: number;
  detail?: string;
  cwd?: string | null;
  failure?: { text?: string } | null;
}

/**
 * Newest first, at most `max`. A session's first event in the window counts as a change: the stream starts somewhere.
 * When a session's status now differs from its last event (a question at the end of a turn, an API error only the
 * transcript knows), the stream ends with that status at `statusSince`: it never contradicts the alarm zone
 * (practical test 15 Oct: the newest line said ✓ while the session waited).
 */
export function stateChanges(events: FleetEvent[], max = 40, now: StreamNow[] = []): StreamItem[] {
  const ok = (events || []).filter(
    (e) =>
      e &&
      typeof e.at === "number" &&
      Number.isFinite(e.at) &&
      typeof e.sessionId === "string" &&
      ID.test(e.sessionId) &&
      KNOWN.has(String(e.status)),
  );
  const last = new Map<string, string>();
  const out: StreamItem[] = [];
  for (const e of ok.slice().sort((a, b) => a.at - b.at)) {
    if (last.get(e.sessionId) === e.status) continue;
    last.set(e.sessionId, e.status);
    out.push({
      at: e.at,
      sessionId: e.sessionId,
      status: e.status as StreamStatus,
      detail: typeof e.detail === "string" ? e.detail.slice(0, 200) : "",
      cwd: typeof e.cwd === "string" ? e.cwd.slice(0, 1000) : null,
    });
  }
  for (const n of now) {
    const st = String(n.status || "");
    const at = Number(n.statusSince);
    if (!KNOWN.has(st) || !ID.test(String(n.id)) || !Number.isFinite(at) || !last.has(n.id) || last.get(n.id) === st)
      continue;
    last.set(n.id, st);
    out.push({
      at,
      sessionId: n.id,
      status: st as StreamStatus,
      detail: typeof n.detail === "string" ? n.detail.slice(0, 200) : "",
      cwd: typeof n.cwd === "string" ? n.cwd.slice(0, 1000) : null,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out.reverse().slice(0, Math.max(0, max));
}

/**
 * The sessions as Now places them, for the end of the stream (round 4: data-pipeline waited for an approval in the
 * alarm zone while the stream's newest line said ●): a session that waits there, also for one of Fleet's own
 * questions, ends with "waits"; a session in the errors keeps its error.
 */
export function nowForStream(o: Pick<Overview, "sessions" | "repos"> & { decisions?: Decision[] }): StreamNow[] {
  const where = places(inbox(o));
  return o.sessions.map((s) => {
    const p = where.get(s.id);
    if (p !== "needs" && p !== "decision") return s;
    const asked = (o.decisions || []).find((d) => d.sessionId === s.id && d.status === "open");
    const since = Math.max(Number(s.statusSince) || 0, asked?.createdAt || 0);
    return { ...s, status: "needs_input", statusSince: since || s.statusSince };
  });
}
