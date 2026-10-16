import type { Overview, PullRequest } from "./types";

/**
 * Every open PR Fleet knows, once (`remote#number`): the repos' lists of open PRs (all of them, also without a
 * session) and the PR of each branch a session or repo stands on. The header and Repos & PRs count from here
 * (practical test 15 Oct: the header said 5, Repos said 7).
 */
export function openPrKeys(data: Pick<Overview, "sessions" | "repos">): Set<string> {
  const keys = new Set<string>();
  const add = (pr: PullRequest | undefined, where: string | null | undefined) => {
    if (pr && where && (pr.state === "open" || pr.state === "draft")) keys.add(`${where}#${pr.number}`);
  };
  for (const r of data.repos) {
    const where = r.remote?.path || r.root;
    for (const p of r.prs?.prs || []) keys.add(`${where}#${p.number}`);
    add(r.ci?.pr, where);
  }
  for (const s of data.sessions) if (!s.meta?.hidden) add(s.ci?.pr, s.remote?.path || s.repoRoot);
  return keys;
}
