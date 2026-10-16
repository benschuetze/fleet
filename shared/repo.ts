import type { Session } from "./types";

/**
 * One repo, however many checkouts: worktrees of the same remote share a lane in the timeline and a line in the
 * week report. Without a remote the checkout itself is the repo.
 */
export const repoKey = (s: Pick<Session, "remote" | "repoRoot" | "project">): string =>
  s.remote ? `${s.remote.host}/${s.remote.path}` : s.repoRoot || s.project || "—";

export const repoName = (s: Pick<Session, "remote" | "project">): string => s.remote?.repo || s.project || "—";

/**
 * A worktree Fleet made (`<parent>/<repo>.wt/<name>`, server/core/worktree.ts): its name, else null. Such a checkout
 * carries the repo's name, and the row shows the worktree as `⎇ <name>`.
 */
export function fleetWorktree(root: string | null | undefined): { repo: string; name: string } | null {
  const m = /([^\\/]+)\.wt[\\/]([^\\/]+)[\\/]?$/.exec(root || "");
  return m?.[1] && m[2] ? { repo: m[1], name: m[2] } : null;
}
