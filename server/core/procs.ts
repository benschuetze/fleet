import fs from "node:fs";
import path from "node:path";
import type { HookState, Proc, Session, SessionProc } from "../../shared/types";
import { tr } from "./lang";
import { fleetHome } from "./paths";

/** The supervisor holds a new version back while sessions run in Fleet's window (server/cli/launcher.ts). */
export function updateWarning(now: number): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(fleetHome(), "update-pending.json"), "utf8"));
    const n = Number(j.sessions);
    if (!Number.isInteger(n) || n < 1 || now - Number(j.at) > 60e3) return null;
    return tr(
      `Update wartet auf ${n} laufende Session${n === 1 ? "" : "s"} im Fleet-Terminal`,
      `Update waits for ${n} running session${n === 1 ? "" : "s"} in the Fleet terminal`,
    );
  } catch {
    return null;
  }
}

/**
 * Links Fleet's processes to sessions: first by the id Fleet passed with --session-id (or resumed), then by the
 * hook's CLAUDE_FLEET_PROC mark, in case Claude Code chose another id. A process without a transcript yet gets a
 * row of its own ("starting …"), like a session only the hook knows.
 */

const project = (p: Proc): SessionProc => ({
  mode: p.mode,
  status: p.status,
  screen: p.screen ?? null,
  job: p.job ?? null,
  exitCode: p.exitCode ?? null,
  endedAt: p.endedAt ?? null,
  startedAt: p.startedAt,
  lastOutputAt: p.lastOutputAt,
  lastInputAt: p.lastInputAt,
  lastInputEsc: p.lastInputEsc,
});

export function attachProcs(
  sessions: Session[],
  byId: Map<string, Session>,
  hooks: Record<string, HookState>,
  procs: Proc[],
): void {
  const byMark = new Map<string, string>();
  for (const h of Object.values(hooks))
    if (typeof h.proc === "string" && h.proc !== h.sessionId) byMark.set(h.proc, h.sessionId);
  for (const p of procs) {
    const s = byId.get(p.id) || byId.get(byMark.get(p.id) || "");
    if (s) {
      s.proc = project(p);
      continue;
    }
    // A job always runs in an existing session; only interactive ones may lack a transcript yet.
    if (p.kind !== "session" || p.status === "exited") continue;
    const n: Session = {
      id: p.id,
      source: "local",
      cwd: p.cwd,
      title: p.title || null,
      firstPrompt: p.title || null,
      startedAt: p.startedAt,
      mtime: 0,
      detail: tr("startet …", "starting …"),
      proc: project(p),
    };
    sessions.push(n);
    byId.set(n.id, n);
  }
}
