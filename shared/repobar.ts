import type { Inbox } from "./inbox";
import { repoKey, repoName } from "./repo";
import type { CiState, PrConflict, Repo, Session } from "./types";

/**
 * The repo bar on "Now" (spec, Grundaufbau: L2): one entry per repo with its local state, open PRs and its
 * sessions as small counters, read from the same inbox as the alarm zone and the watch board.
 *
 * A repo is its remote: worktrees of the same remote are one entry, so a PR stands there once. Repos without a
 * remote are their folder.
 */

export interface RepoPr {
  number: number;
  title: string;
  url: string | null;
  ci: CiState;
  draft: boolean;
  /** Other open PRs it cannot be merged with cleanly (probe merge); missing while unknown. */
  conflicts?: PrConflict[];
}

export interface RepoEntry {
  /** Remote (host/path) or, without a remote, the folder. */
  key: string;
  /** What the bar shows and the URL filter names (`/?repo=<name>`). */
  name: string;
  /** Every checkout of the repo (main folder and worktrees). */
  roots: string[];
  /** The checkout actions and the drawer use: the main folder when Fleet knows it, else the first one. */
  root: string;
  /** Changed files over all checkouts; null when git did not say for any of them. */
  dirty: number | null;
  prs: RepoPr[];
  /** Sessions per group of the inbox; a session counts in exactly one. */
  counts: { needs: number; errors: number; working: number; done: number; resting: number };
  /** Nothing open: no session outside the archive and no open PR. Folded below the bar. */
  quiet: boolean;
}

// The same key and name as the timeline and the week report (shared/repo.ts), so one repo is one repo everywhere.
const keyOf = (r: Pick<Repo, "root" | "remote" | "name">) =>
  repoKey({ remote: r.remote, repoRoot: r.root, project: r.name });
const nameOf = (r: Pick<Repo, "name" | "remote">) => repoName({ remote: r.remote, project: r.name });

export function repoBar(repos: Repo[], ib: Inbox): RepoEntry[] {
  const groups = new Map<string, Repo[]>();
  for (const r of repos) groups.set(keyOf(r), [...(groups.get(keyOf(r)) || []), r]);
  const out: RepoEntry[] = [];
  for (const [key, list] of groups) {
    const name = nameOf(list[0] as Repo);
    const roots = list.map((r) => r.root);
    const inRepo = (s: Session) => !!s.repoRoot && roots.includes(s.repoRoot);
    const n = (ss: Session[]) => ss.filter(inRepo).length;
    // Fleet's own questions wait for you too; their sessions are in no other group.
    const asking = ib.decisions.filter((d) => list.some((r) => r.sessions.includes(d.sessionId))).length;
    const counts = {
      needs: n(ib.needs) + asking,
      errors: n(ib.errors),
      working: n(ib.working),
      done: n(ib.done),
      resting: n(ib.resting),
    };
    const prs = new Map<number, RepoPr>();
    for (const r of list)
      for (const p of r.prs?.prs || [])
        if (!prs.has(p.number))
          prs.set(p.number, {
            number: p.number,
            title: p.title,
            url: p.url,
            ci: p.ci,
            draft: p.draft,
            ...(p.conflicts ? { conflicts: p.conflicts } : {}),
          });
    const dirt = list.map((r) => r.dirty).filter((d): d is number => typeof d === "number");
    // The main folder carries the repo's own name; a worktree folder is named after its branch.
    const main = list.find((r) => r.name === name) || (list[0] as Repo);
    out.push({
      key,
      name,
      roots,
      root: main.root,
      dirty: dirt.length ? dirt.reduce((a, b) => a + b, 0) : null,
      prs: [...prs.values()].sort((a, b) => a.number - b.number),
      counts,
      quiet: !Object.values(counts).some(Boolean) && !prs.size,
    });
  }
  // Decision first, then work in progress; within a rank by name, so the bar does not jump with every update.
  const rank = (e: RepoEntry) =>
    e.counts.needs + e.counts.errors ? 0 : e.counts.working ? 1 : e.counts.done ? 2 : e.quiet ? 4 : 3;
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The entry a `?repo=` value names; unknown names filter nothing (an old link must not empty the page). */
export const findRepo = (entries: RepoEntry[], name: string | null | undefined): RepoEntry | null =>
  (name && entries.find((e) => e.name === name)) || null;

/** Whether a session belongs to the chosen repo; without a choice every session does. */
export const inRepo = (e: RepoEntry | null, s: Pick<Session, "repoRoot">): boolean =>
  !e || (!!s.repoRoot && e.roots.includes(s.repoRoot));

/** The inbox narrowed to one repo, for the watch board. The alarm zone keeps the whole inbox: an alarm elsewhere must stay visible. */
export function narrow(ib: Inbox, e: RepoEntry | null): Inbox {
  if (!e) return ib;
  const f = (ss: Session[]) => ss.filter((s) => inRepo(e, s));
  return {
    ...ib,
    working: f(ib.working),
    done: f(ib.done),
    resting: f(ib.resting),
    archive: f(ib.archive),
    replaced: f(ib.replaced),
    ciFixing: ib.ciFixing.filter((c) => e.roots.includes(c.root)),
  };
}

/** The repo a folder belongs to: a checkout equal to it or containing it, the deepest one (`fleet` in a folder). */
export function repoForDir<T extends { roots: string[] }>(entries: T[], dir: string): T | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  let best: T | null = null;
  let len = -1;
  for (const e of entries)
    for (const r of e.roots) {
      const root = norm(r);
      if ((d === root || d.startsWith(`${root}/`)) && root.length > len) {
        best = e;
        len = root.length;
      }
    }
  return best;
}
