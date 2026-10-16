import fs from "node:fs";
import path from "node:path";
import { UUID } from "../core/desktop";
import { fleetHome } from "../core/paths";

/**
 * ~/.claude-fleet/processes.json: the interactive sessions Fleet runs. Written atomically on every start and
 * exit; read once at start, so a session cut off by a Fleet restart or crash stands as "interrupted" with a way
 * to continue instead of vanishing.
 */

export interface Stored {
  id: string;
  root: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  title?: string | null;
}

const file = () => path.join(fleetHome(), "processes.json");

export function writeStore(list: Stored[]): void {
  try {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    const f = file();
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error("[fleet] processes.json:", (e as Error).message);
  }
}

/** The stored entries, checked field by field (the file is ours, but a broken one must not stop the server). */
export function readStore(): Stored[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 64)
    .filter(
      (e): e is Stored =>
        !!e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        UUID.test(e.id) &&
        typeof e.root === "string" &&
        path.isAbsolute(e.root) &&
        typeof e.cwd === "string" &&
        path.isAbsolute(e.cwd) &&
        Number.isFinite(e.startedAt),
    )
    .map((e) => ({
      id: e.id,
      root: e.root.slice(0, 1000),
      cwd: e.cwd.slice(0, 1000),
      startedAt: Number(e.startedAt),
      pid: Number.isInteger(e.pid) ? e.pid : null,
      title: typeof e.title === "string" ? e.title.slice(0, 200) : null,
    }));
}

/** Is the process still there? (EPERM: it exists, it is just not ours.) */
export function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
