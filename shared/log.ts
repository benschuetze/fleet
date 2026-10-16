import type { LogLine } from "./types";

/**
 * Rules of the log view (spec, "Log-Sicht (Shift+L)") that server and browser share: how many lines stay, and which
 * line carries a signal. Signals follow the colour grammar of "Now": red for an error, orange for a session that
 * waits for you now, each exactly once.
 */

/** Lines kept, on the server and in the browser (spec: "Höchstens die letzten 500 Zeilen im Speicher"). */
export const LOG_MAX = 500;

export type LogSignal = "crit" | "warn" | null;

/**
 * The signal of each line, by `seq`. An error line is red: the failed tool result or the API error itself, never
 * also the call that led to it. A waiting session gets orange on its newest line only, and only while it waits; a
 * question it asked earlier and that was answered is history, not a signal. An error line stays red even when it is
 * the newest line of a waiting session: one line, one signal.
 */
export function signals(lines: LogLine[], waiting: Iterable<string>): Map<number, LogSignal> {
  const out = new Map<number, LogSignal>();
  const newest = new Map<string, LogLine>();
  for (const l of lines) {
    if (l.kind === "error") out.set(l.seq, "crit");
    const n = newest.get(l.session);
    if (!n || l.at > n.at || (l.at === n.at && l.seq > n.seq)) newest.set(l.session, l);
  }
  for (const id of waiting) {
    const l = newest.get(id);
    if (l && l.kind !== "error") out.set(l.seq, "warn");
  }
  return out;
}

/** Time order; lines of the same moment keep the order the server read them in. */
export const byTime = (a: LogLine, b: LogLine) => a.at - b.at || a.seq - b.seq;

/** Adds newer lines to what is there: every line once (by `seq`), in time order, the newest LOG_MAX. */
export function mergeLog(have: LogLine[], incoming: LogLine[], max = LOG_MAX): LogLine[] {
  if (!incoming.length) return have.length > max ? have.slice(-max) : have;
  const seen = new Set(have.map((l) => l.seq));
  const add = incoming.filter((l) => !seen.has(l.seq) && !!seen.add(l.seq));
  return [...have, ...add].sort(byTime).slice(-max);
}
