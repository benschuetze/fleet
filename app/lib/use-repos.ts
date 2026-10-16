import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { findRepo, type RepoEntry, repoBar, repoForDir } from "../../shared/repobar";
import { useFleet } from "./fleet";
import { useKeys } from "./keyboard";
import { loudInbox } from "./view";

/** The repo bar's entries, computed once per overview for everyone who needs them (bar, drawer, stream). */
export function useRepos(): RepoEntry[] {
  const { data } = useFleet();
  // A muted alarm leaves the bar's counts like the header's (round 7: header ?6, mobile-app still ?1).
  const { muted } = useKeys();
  return useMemo(() => (data ? repoBar(data.repos, loudInbox(data, muted, Date.now())) : []), [data, muted]);
}

/**
 * The chosen repo: in the URL (`/?repo=<name>`), so a reload, the back button and a link from "Repos & PRs" keep
 * it. Choosing the chosen one again clears it.
 */
export function useRepoFilter(entries: RepoEntry[]): {
  repo: RepoEntry | null;
  choose: (name: string | null) => void;
} {
  const [params, setParams] = useSearchParams();
  const repo = findRepo(entries, params.get("repo"));
  const choose = (name: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (name && name !== repo?.name) next.set("repo", name);
        else next.delete("repo");
        return next;
      },
      { preventScrollReset: true },
    );
  return { repo, choose };
}

const HERE_SEEN = "fleet.hereSeen";
const seen = (at: number) => {
  try {
    return sessionStorage.getItem(HERE_SEEN) === String(at);
  } catch {
    return false;
  }
};
export const markHereSeen = (at: number) => {
  try {
    sessionStorage.setItem(HERE_SEEN, String(at));
  } catch {
    // shown again after a reload, harmless
  }
};

/**
 * `fleet` typed in a folder (server/core/here.ts): once per call, its repo becomes the chosen one. A folder without
 * a repo is offered in the message row instead (`MessageRow`, `:here`).
 */
export function useHere(entries: RepoEntry[], repo: RepoEntry | null, choose: (name: string | null) => void): void {
  const { data } = useFleet();
  const here = data?.here;
  useEffect(() => {
    if (!here || seen(here.at)) return;
    const e = repoForDir(entries, here.dir);
    if (!e) return;
    markHereSeen(here.at);
    if (repo?.name !== e.name) choose(e.name);
  }, [here, entries, repo, choose]);
}
