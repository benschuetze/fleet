import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config, Session } from "../../shared/types";
import { git } from "./git";

/**
 * Sessions in their own git worktree (release 6.1.0, plan T1): a second session in a repo starts next to the
 * first one instead of on top of it. Fleet makes the worktree itself (`git worktree add`), so it knows the folder
 * before Claude starts: transcript, resume and diff need no special case.
 *  - next to the repo, never inside it: `<parent>/<repo>.wt/<name>` (inside, Biome, Vitest and watchers read it)
 *  - setup and extra files only from the user's config; a repo's `.worktreeinclude` is a file list, never a command
 *  - removing only the safe way: `git worktree remove` without --force, `git branch -d`, never with changes
 */

export const BRANCH_PREFIX = "fleet/";
const NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;
const MAX_INCLUDE = 50;
const MAX_INCLUDE_BYTES = 1024 * 1024;
/** A session in the main folder with one of these statuses makes the next one go to a worktree. */
export const BUSY = new Set(["working", "stale", "needs_input", "waiting"]);

export type WorktreeConfig = Config["worktree"];

export interface WorktreePlan {
  name: string;
  dir: string;
  branch: string;
}

/** The task's first words as a folder name: lower case, a–z 0–9 and dashes, at most 32 characters. */
export function slug(task: string): string {
  return task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Name, folder and branch of a new worktree; `hex` makes two worktrees for the same task distinct. */
export function planWorktree(root: string, task: string, hex = crypto.randomBytes(2).toString("hex")): WorktreePlan {
  const name = `${slug(task) || "session"}-${hex}`;
  return {
    name,
    dir: path.join(path.dirname(root), `${path.basename(root)}.wt`, name),
    branch: `${BRANCH_PREFIX}${name}`,
  };
}

/** The same folder, however written (trailing slash, `C:/` from git against `C:\` from Node). */
export const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const within = (d: string, top: string) => samePath(d, top) || path.resolve(d).startsWith(path.resolve(top) + path.sep);

/**
 * Where a new session in `root` starts. `explicit` (`:wt`) always gets a worktree; otherwise the config decides:
 * "off" never, "always" always, "second" (the default) once a session in the main folder works or waits there.
 */
export function wantsWorktree(
  root: string,
  sessions: Pick<Session, "cwd" | "status">[],
  liveCwds: string[],
  cfg: Pick<WorktreeConfig, "auto">,
  explicit: boolean,
): boolean {
  if (explicit || cfg.auto === "always") return true;
  if (cfg.auto === "off") return false;
  const same = (d: string | null | undefined) => !!d && samePath(d, root);
  return liveCwds.some(same) || sessions.some((s) => same(s.cwd) && BUSY.has(String(s.status)));
}

/**
 * The main folder of the repo `dir` belongs to: for a worktree the folder of the shared `.git`. A session in a
 * worktree shows its worktree as a repo too; new worktrees and the list of finished ones always start from here.
 */
export async function mainRoot(dir: string): Promise<string> {
  const r = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (!r.ok || !r.out) return dir;
  const common = path.resolve(r.out);
  return path.basename(common) === ".git" ? path.dirname(common) : dir;
}

/** The branch a worktree starts from: origin's default branch, else a local main/master. Never fetches by itself. */
export async function baseRef(root: string, fetch = false): Promise<string | null> {
  if (fetch) await git(["fetch", "--quiet", "origin"], root, 60e3);
  const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root);
  const cands = [...(head.ok && head.out ? [head.out] : []), "origin/main", "origin/master", "main", "master"];
  for (const c of cands) if ((await git(["rev-parse", "--verify", "--quiet", `${c}^{commit}`], root)).ok) return c;
  return null;
}

export type Made = { ok: true; plan: WorktreePlan; base: string } | { ok: false; error: string };

export async function createWorktree(root: string, plan: WorktreePlan, base: string): Promise<Made> {
  if (!NAME_RE.test(plan.name)) return { ok: false, error: `name ${plan.name}` };
  if (fs.existsSync(plan.dir)) return { ok: false, error: `${plan.dir} exists` };
  // --no-track: with origin/main as the start the branch would track main, and a plain `git push` could go there.
  const r = await git(["worktree", "add", "--quiet", "--no-track", "-b", plan.branch, plan.dir, base], root, 60e3);
  return r.ok ? { ok: true, plan, base } : { ok: false, error: r.err.split("\n").pop() || "git worktree add failed" };
}

/** Relative paths only, inside the repo, no `..`; one per line in `.worktreeinclude`, `#` starts a comment. */
export function includeList(cfgInclude: string[], fileText: string): string[] {
  const lines = fileText.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim());
  const all = [...cfgInclude, ...lines].filter(Boolean);
  const ok = all.filter((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."));
  return [...new Set(ok)].slice(0, MAX_INCLUDE);
}

/**
 * Copies the ignored files a worktree needs (local config and the like): regular files up to 1 MB, no links, and
 * only when the real paths on both sides stay inside the repo and the worktree (a linked folder on the way counts).
 */
export async function seedWorktree(root: string, dir: string, include: string[]): Promise<string[]> {
  let text = "";
  try {
    text = await fsp.readFile(path.join(root, ".worktreeinclude"), "utf8");
  } catch {
    // no list in the repo
  }
  const copied: string[] = [];
  for (const rel of includeList(include, text)) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    try {
      const st = await fsp.lstat(from);
      if (!st.isFile() || st.size > MAX_INCLUDE_BYTES || fs.existsSync(to)) continue;
      if (!within(await fsp.realpath(from), await fsp.realpath(root))) continue;
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (!within(await fsp.realpath(path.dirname(to)), await fsp.realpath(dir))) continue;
      await fsp.copyFile(from, to);
      copied.push(rel);
    } catch {
      // missing or unreadable: the worktree works without it
    }
  }
  return copied;
}

/**
 * The setup command from the user's config (e.g. `pnpm install --frozen-lockfile`), in the background; output to
 * `log`. False when it could not start; the worktree and the session go on without it.
 */
export function runSetup(dir: string, cmd: string, log: string): boolean {
  let out: number;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    out = fs.openSync(log, "a");
  } catch {
    return false;
  }
  let closed = false;
  const end = (line: string) => {
    if (closed) return;
    closed = true;
    try {
      fs.writeSync(out, `\n[fleet] ${line}\n`);
      fs.closeSync(out);
    } catch {
      // the log is a courtesy
    }
  };
  try {
    const p = spawn(cmd, { cwd: dir, shell: true, stdio: ["ignore", out, out], windowsHide: true });
    p.on("error", () => end(`setup did not start: ${cmd}`));
    p.on("close", (code) => end(`setup ended with ${code}`));
    return true;
  } catch {
    end(`setup did not start: ${cmd}`);
    return false;
  }
}

export interface Worktree {
  dir: string;
  branch: string;
}

/** Fleet's own worktrees of a repo (branch `fleet/…`); the main folder and worktrees made by hand are never listed. */
export async function fleetWorktrees(root: string): Promise<Worktree[]> {
  const r = await git(["worktree", "list", "--porcelain"], root);
  if (!r.ok) return [];
  const out: Worktree[] = [];
  for (const block of r.out.split(/\n\n+/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    // git writes `C:/…` on Windows; Node and the overview write `C:\…`.
    if (dir && branch?.startsWith(BRANCH_PREFIX) && !/^locked/m.test(block))
      out.push({ dir: path.resolve(dir), branch });
  }
  return out;
}

/** An ignored path in the worktree that may go with it: a folder the main folder has too, or a file equal to its copy. */
async function sameAsMain(root: string, dir: string, rel: string): Promise<boolean> {
  try {
    const mine = await fsp.lstat(path.join(dir, rel));
    const main = await fsp.lstat(path.join(root, rel));
    if (mine.isDirectory()) return main.isDirectory();
    if (!mine.isFile() || !main.isFile() || mine.size !== main.size || mine.size > MAX_INCLUDE_BYTES) return false;
    const [a, b] = await Promise.all([fsp.readFile(path.join(dir, rel)), fsp.readFile(path.join(root, rel))]);
    return a.equals(b);
  } catch {
    return false;
  }
}

/**
 * Whether a worktree may go: no session lives in it, nothing uncommitted or untracked, no ignored file of its own
 * (`git worktree remove` would delete it silently: a local config edited there, notes, a database), and its branch is
 * part of the base (merged, or never got a commit). Ignored files that are the same as in the main folder (the
 * seeded copies) and ignored folders the main folder has too (dependencies, build output) may go with it. A
 * squash-merged branch is not offered: `git branch -d` would refuse it.
 */
export async function removable(
  root: string,
  wt: Worktree,
  base: string,
  liveCwds: string[],
): Promise<{ ok: true } | { ok: false; why: string }> {
  if (liveCwds.some((d) => within(d, wt.dir))) return { ok: false, why: "a session runs there" };
  const st = await git(["status", "--porcelain", "--ignored", "-z"], wt.dir);
  if (!st.ok) return { ok: false, why: "git status failed" };
  for (const entry of st.out.split("\0").filter(Boolean)) {
    if (!entry.startsWith("!! ")) return { ok: false, why: "uncommitted changes" };
    const rel = entry.slice(3);
    if (!(await sameAsMain(root, wt.dir, rel))) return { ok: false, why: `ignored file ${rel.replace(/\/$/, "")}` };
  }
  const merged = await git(["merge-base", "--is-ancestor", wt.branch, base], root);
  return merged.ok ? { ok: true } : { ok: false, why: "branch not merged" };
}

export async function removeWorktree(root: string, wt: Worktree): Promise<{ ok: true } | { ok: false; error: string }> {
  const rm = await git(["worktree", "remove", wt.dir], root, 30e3);
  if (!rm.ok) return { ok: false, error: rm.err.split("\n").pop() || "git worktree remove failed" };
  const br = await git(["branch", "-d", wt.branch], root);
  return br.ok ? { ok: true } : { ok: false, error: br.err.split("\n").pop() || "git branch -d failed" };
}
