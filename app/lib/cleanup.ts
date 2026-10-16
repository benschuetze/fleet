import type { Proc, Session } from "../../shared/types";

/**
 * `:cleanup` and `:stop` (release 6, plan R5 and R6) as pure functions: which sessions leave "Now" and which of
 * Fleet's processes end. Clearing away is hiding (the search finds them, `u` brings them back), never deleting.
 */

/** Without a sign of life for this long, a session that does not work is old: 14 h old alarms helped nobody. */
export const CLEANUP_HOURS = 8;

const live = (p: Pick<Proc, "status">) => p.status === "starting" || p.status === "running";

/** When the session last showed a sign of life (activity or a status change), in ms. */
export const lastSign = (s: Session) => Math.max(s.lastActivity || 0, s.statusSince || 0);

/**
 * Sessions `:cleanup` hides: shown on "Now", not pinned, not working, not running in Fleet's window, and quiet for
 * longer than `hours`. A session that works or still runs in Fleet's window is never old, whatever its clock says.
 */
export function cleanupCandidates(sessions: Session[], procs: Proc[], now: number, hours = CLEANUP_HOURS): Session[] {
  const running = new Set(procs.filter((p) => p.kind === "session" && live(p)).map((p) => p.id));
  const limit = now - hours * 3600e3;
  return sessions.filter(
    (s) =>
      !s.meta?.hidden &&
      !s.meta?.pinned &&
      s.status !== "working" &&
      !running.has(s.id) &&
      lastSign(s) > 0 &&
      lastSign(s) < limit,
  );
}

/** Fleet's interactive sessions that still run: what `:stop` ends. Jobs finish on their own and are left alone. */
export const stoppable = (procs: Proc[]) => procs.filter((p) => p.kind === "session" && live(p));
