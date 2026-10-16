import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "../core/paths";
import { SID } from "./registry";

/**
 * "Start fresh" marks: the dashboard sets one, the hook consumes it at the session's next prompt or turn
 * end. `target` is where the new session should open.
 */

const TARGETS = ["fleet", "desktop", "vscode", "cursor", "terminal"];
const freshFile = (sid: string) => path.join(fleetHome(), "fresh", sid);

export function setFresh(sid: string, on: boolean, target: string | null = null): boolean {
  if (!SID.test(sid)) return false;
  try {
    if (on) {
      fs.mkdirSync(path.dirname(freshFile(sid)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        freshFile(sid),
        JSON.stringify({ at: Date.now(), target: target && TARGETS.includes(target) ? target : null }),
        { mode: 0o600 },
      );
    } else fs.rmSync(freshFile(sid), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Reads the mark (older form: only the timestamp). */
function readFresh(sid: string): { at: number; target: string | null } | null {
  try {
    const raw = fs.readFileSync(freshFile(sid), "utf8");
    const j = /^\d+$/.test(raw.trim())
      ? { at: Number(raw), target: null }
      : (JSON.parse(raw) as { at: unknown; target: unknown });
    return Number.isFinite(j.at)
      ? { at: Number(j.at), target: typeof j.target === "string" && TARGETS.includes(j.target) ? j.target : null }
      : null;
  } catch {
    return null;
  }
}

/** Pending, and where to. */
export function freshPending(sid: string): { at: number; target: string | null } | null {
  return SID.test(sid) ? readFresh(sid) : null;
}

/** Consumes the mark; marks older than a day no longer count (the session is long elsewhere). */
export function takeFresh(sid: unknown): { target: string | null } | null {
  if (typeof sid !== "string" || !SID.test(sid)) return null;
  const m = readFresh(sid);
  try {
    fs.rmSync(freshFile(sid), { force: true });
  } catch {
    // already gone
  }
  return m && Date.now() - m.at < 86400e3 ? m : null;
}
