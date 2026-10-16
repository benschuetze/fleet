import type { RepoEntry } from "../../shared/repobar";
import { useFleet } from "./fleet";
import { useKeys } from "./keyboard";
import { useNow } from "./use-now";
import { type NowView, nowView } from "./view";

/**
 * What "Now" shows (`nowView`), derived in one place so the alarm zone and the tiles of the middle see the same
 * (plan 3.3); ticking every second for expiring approvals. Null while there is no overview yet.
 */
export function useNowView(repo: RepoEntry | null): NowView | null {
  const { data, query } = useFleet();
  const { filter, muted } = useKeys();
  const now = useNow(1000);
  return data ? nowView(data, { query, filter, muted, repo, now }) : null;
}
