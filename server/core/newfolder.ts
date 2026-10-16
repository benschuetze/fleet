import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git";

/**
 * A new project folder for `:new <name>` (release 6, plan R7): Fleet starts Claude where no repo is yet. The request
 * names only the folder; the path is built here from the projects folder, so nothing outside it is ever touched.
 */

/** A folder name: letters, digits, dot, dash, underscore; no path, no leading dot, at most 64 characters. */
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Where the demo pretends its projects live: no real path in screenshots. */
export const DEMO_PROJECTS = "/home/demo/projects";

const worktree = (p: string) => /[\\/]\.claude[\\/]worktrees[\\/]/.test(p);

/**
 * The projects folder: the config's `projectsDir`, else the folder most known repos live in (their common parent),
 * else ~/Projects. Worktrees Claude makes inside a repo do not count, they would vote for the repo itself.
 */
export function projectsDir(configured: string, repoRoots: string[], home = os.homedir()): string {
  if (configured) return path.resolve(configured);
  const votes = new Map<string, number>();
  for (const r of repoRoots) {
    if (!path.isAbsolute(r) || worktree(r)) continue;
    const parent = path.dirname(r);
    if (parent === r || parent === path.parse(parent).root) continue;
    votes.set(parent, (votes.get(parent) || 0) + 1);
  }
  let best = "";
  let n = 0;
  for (const [p, v] of votes)
    if (v > n) {
      best = p;
      n = v;
    }
  return best || path.join(home, "Projects");
}

export type FolderResult = { ok: true; dir: string; created: boolean } | { ok: false; status: number; error: string };

/**
 * The folder for `name` under `base`: created with `git init` when new, taken as it is when it exists and is a real
 * folder (no link: a link could lead anywhere). `base` is created if it is missing.
 */
export async function makeFolder(
  base: string,
  name: string,
  msg: (de: string, en: string) => string,
): Promise<FolderResult> {
  if (!FOLDER_RE.test(name))
    return {
      ok: false,
      status: 400,
      error: msg(
        "Ordnername: Buchstaben, Ziffern, . _ -, höchstens 64 Zeichen",
        "Folder name: letters, digits, . _ -, at most 64 characters",
      ),
    };
  const dir = path.join(base, name);
  if (path.dirname(dir) !== path.resolve(base))
    return { ok: false, status: 400, error: msg("Ordnername ungültig", "Invalid folder name") };
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory())
      return {
        ok: false,
        status: 409,
        error: msg(`${dir} gibt es schon und ist kein Ordner`, `${dir} exists and is no folder`),
      };
    return { ok: true, dir, created: false };
  } catch {
    // missing: create it below
  }
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(dir);
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: `${msg("Ordner anlegen ging nicht", "Could not create the folder")}: ${e instanceof Error ? e.message : e}`,
    };
  }
  // A repo from the start: the repo bar shows it and the diff view has a base. Without git it stays a folder.
  await git(["init", "-q"], dir);
  return { ok: true, dir, created: true };
}
