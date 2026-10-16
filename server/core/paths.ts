import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where things live. The bundled build runs from dist/, the TypeScript sources (tests, `pnpm dev`)
 * from server/core/; both resolve to the same application folder.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
// A session runs a tested copy of the hook under ~/.claude-fleet/hook/<id>/ (pinhook.ts); its guard names the folder
// the copy came from, so config.json and launch-run.cjs are still found there.
const pinned = process.env.CLAUDE_FLEET_APP;
export const APP_DIR =
  pinned && path.isAbsolute(pinned)
    ? path.resolve(pinned)
    : process.env.FLEET_BUNDLED
      ? path.resolve(here, "..")
      : path.resolve(here, "..", "..");

/** Fleet's own state (hook states, events, decisions, handoff registry). Read on every call: tests override it. */
export function fleetHome(): string {
  return process.env.CLAUDE_FLEET_HOME || path.join(os.homedir(), ".claude-fleet");
}

/** Session ids, as Claude Code writes them; everything else is rejected before it reaches a path. */
export const ID_RE = /^[\w.-]{1,128}$/;

/**
 * One file per transcript. A moved project leaves its transcripts in two project folders, the old name's and the
 * new one's (<projects>/<old>/<id>.jsonl and <projects>/<new>/<id>.jsonl): counting both doubled sessions, usage and
 * `fleet audit`. Keeps the newest copy of every path below its project folder (ties: the larger file), in order.
 * Callers filter afterwards (age, size), so a stale copy never stands in for a new one they skip. Nulls (files that
 * could not be read) are dropped; files directly in <projects> are never merged.
 */
export function newestCopies<T extends { file: string; st: { mtimeMs: number; size: number } }>(
  projects: string,
  all: (T | null)[],
): T[] {
  const items = all
    .filter((it): it is T => !!it)
    .map((it) => {
      const rel = path.relative(projects, it.file).split(path.sep);
      return { it, key: rel.length > 1 ? rel.slice(1).join("/") : `/${rel[0]}` };
    });
  const best = new Map<string, T>();
  for (const { it, key } of items) {
    const b = best.get(key);
    if (!b || it.st.mtimeMs > b.st.mtimeMs || (it.st.mtimeMs === b.st.mtimeMs && it.st.size > b.st.size))
      best.set(key, it);
  }
  return items.filter(({ it, key }) => best.get(key) === it).map(({ it }) => it);
}
