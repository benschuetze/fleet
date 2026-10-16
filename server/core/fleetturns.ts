import fs from "node:fs";
import path from "node:path";
import type { FleetTurnKind, FleetTurnMark } from "../../shared/types";
import { fleetHome } from "./paths";

/**
 * Marks for the turns Fleet caused, the basis of Fleet's own cost in the balance (server/core/balance.ts).
 *
 * The hook appends a `begin` line to ~/.claude-fleet/fleet-turns.jsonl the moment Fleet asks a session for
 * something (a handoff, the first turn of a session it started) and an `end` line at that session's next Stop.
 * Which turn is open lives in a tiny file per session (turns/<id>), so a Stop costs one failed stat when nothing
 * is open. Headless jobs need no mark: jobs.jsonl has their exact start and end.
 *
 * Loaded by the hook: only fs and path, never throws.
 */

export const KINDS: readonly FleetTurnKind[] = ["handoff", "job", "continue", "merge", "fix", "brief"];
const SID = /^[\w.-]{1,128}$/;
const MAX_BYTES = 1024 * 1024;
/** A begin without an end (hook missing at Stop, crash) counts this long, like an open handoff request. */
export const OPEN_WINDOW = 30 * 60e3;
/** An end this long after its begin is no longer believed: the hook was missing in between. */
export const MAX_WINDOW = 3 * 3600e3;

const file = () => path.join(fleetHome(), "fleet-turns.jsonl");
const openFile = (sid: string) => path.join(fleetHome(), "turns", sid);

export const isKind = (v: unknown): v is FleetTurnKind => typeof v === "string" && KINDS.includes(v as FleetTurnKind);

function append(m: FleetTurnMark): void {
  const f = file();
  try {
    if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, `${f}.old`);
  } catch {
    // no log yet
  }
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.appendFileSync(f, `${JSON.stringify(m)}\n`, { mode: 0o600 });
}

/** Fleet asked this session for a turn now. A turn that is still open ends here (the new one takes over). */
export function beginTurn(sid: string, kind: FleetTurnKind, at: number, prev?: string[]): void {
  if (!SID.test(sid) || !isKind(kind)) return;
  try {
    endTurn(sid, at);
    const p = (prev || []).filter((x) => typeof x === "string" && SID.test(x) && x !== sid).slice(0, 8);
    append({ phase: "begin", sessionId: sid, kind, at, ...(p.length ? { prev: p } : {}) });
    fs.mkdirSync(path.dirname(openFile(sid)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(openFile(sid), kind, { mode: 0o600 });
  } catch {
    // a missing mark costs accuracy, never the session
  }
}

/** At Stop: closes the session's open Fleet turn, if any. */
export function endTurn(sid: string, at: number): void {
  if (!SID.test(sid)) return;
  try {
    const kind = fs.readFileSync(openFile(sid), "utf8").trim();
    fs.rmSync(openFile(sid), { force: true });
    if (isKind(kind)) append({ phase: "end", sessionId: sid, kind, at });
  } catch {
    // nothing open
  }
}

function readLines(f: string): string[] {
  try {
    const st = fs.statSync(f);
    // Rotation keeps each file near 1 MB; anything far bigger is not ours.
    if (st.size > 4 * MAX_BYTES) return [];
    return fs.readFileSync(f, "utf8").split("\n");
  } catch {
    return [];
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** One mark from an untrusted line, or null. */
export function parseMark(line: string): FleetTurnMark | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  if ((o.phase !== "begin" && o.phase !== "end") || typeof o.sessionId !== "string" || !SID.test(o.sessionId))
    return null;
  if (!isKind(o.kind) || !finite(o.at)) return null;
  const prev = Array.isArray(o.prev)
    ? o.prev.filter((x): x is string => typeof x === "string" && SID.test(x)).slice(0, 8)
    : [];
  return { phase: o.phase, sessionId: o.sessionId, kind: o.kind, at: o.at, ...(prev.length ? { prev } : {}) };
}

/** Marks since `sinceMs`, oldest first (the rotated file too). */
export function readMarks(home: string, sinceMs: number): FleetTurnMark[] {
  const f = path.join(home, "fleet-turns.jsonl");
  const out: FleetTurnMark[] = [];
  for (const l of [...readLines(`${f}.old`), ...readLines(f)]) {
    const m = l ? parseMark(l) : null;
    if (m && m.at >= sinceMs) out.push(m);
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface JobSpan {
  sessionId: string;
  from: number;
  to: number;
  /** Exact tokens from Claude Code's result, for the cross-check only; the balance counts from the transcript. */
  tokens: number | null;
}

/** Fleet's headless jobs from jobs.jsonl (server/process/jobs.ts). */
export function readJobs(home: string, sinceMs: number): JobSpan[] {
  const f = path.join(home, "jobs.jsonl");
  const out: JobSpan[] = [];
  for (const l of [...readLines(`${f}.old`), ...readLines(f)]) {
    if (!l) continue;
    try {
      const o = JSON.parse(l);
      const sid = typeof o?.result?.sessionId === "string" && SID.test(o.result.sessionId) ? o.result.sessionId : o?.id;
      if (typeof sid !== "string" || !SID.test(sid) || !finite(o.startedAt) || !finite(o.endedAt)) continue;
      if (o.endedAt < o.startedAt || o.endedAt < sinceMs) continue;
      const t = o.result?.tokens;
      const tokens =
        t && typeof t === "object"
          ? [t.input, t.output, t.cacheRead, t.cacheWrite].reduce((a: number, v: unknown) => a + (finite(v) ? v : 0), 0)
          : null;
      out.push({ sessionId: sid, from: o.startedAt, to: o.endedAt, tokens });
    } catch {
      // broken line
    }
  }
  return out;
}

export interface TurnWindow {
  sessionId: string;
  kind: FleetTurnKind;
  from: number;
  to: number;
}

/** Successor of a handoff: from `at` on, each of its calls replaces one of a predecessor's. */
export interface Successor {
  sessionId: string;
  kind: "continue" | "merge";
  at: number;
  prev: string[];
}

/** Pairs begin and end per session; a job is a window of its own. Overlaps stay, the balance counts each call once. */
export function windows(
  marks: FleetTurnMark[],
  jobs: JobSpan[],
  now: number,
): { windows: TurnWindow[]; successors: Successor[] } {
  const out: TurnWindow[] = [];
  const successors: Successor[] = [];
  const open = new Map<string, FleetTurnMark>();
  const close = (b: FleetTurnMark, end: number | null) => {
    const to = end !== null && end >= b.at && end - b.at <= MAX_WINDOW ? end : Math.min(b.at + OPEN_WINDOW, now);
    out.push({ sessionId: b.sessionId, kind: b.kind, from: b.at, to });
  };
  for (const m of marks) {
    const cur = open.get(m.sessionId);
    if (m.phase === "begin") {
      // A new begin ends the one before (beginTurn does the same in the hook).
      if (cur) close(cur, Math.min(m.at, cur.at + OPEN_WINDOW));
      open.set(m.sessionId, m);
      if ((m.kind === "continue" || m.kind === "merge") && m.prev?.length)
        successors.push({ sessionId: m.sessionId, kind: m.kind, at: m.at, prev: m.prev });
    } else if (cur) {
      close(cur, m.at);
      open.delete(m.sessionId);
    }
  }
  for (const b of open.values()) close(b, null);
  for (const j of jobs) out.push({ sessionId: j.sessionId, kind: "job", from: j.from, to: j.to });
  return { windows: out, successors };
}
