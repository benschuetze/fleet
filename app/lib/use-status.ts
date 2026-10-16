import { useMemo } from "react";
import { inbox, type Place, places, waitKind } from "../../shared/inbox";
import type { Session } from "../../shared/types";
import { useFleet } from "./fleet";
import { useI18n } from "./i18n";
import { lastActiveOf, placeLabel } from "./session";

/** Where every session stands on Now, once per overview: the one source for status words in every view. */
export function usePlaces(): Map<string, Place> {
  const { data } = useFleet();
  return useMemo(() => (data ? places(inbox(data)) : new Map<string, Place>()), [data]);
}

/** When a session was last active: the same time in every view (`lastActiveOf`). */
export function useLastActive(): (s: Pick<Session, "id" | "lastActivity">) => number {
  const { data } = useFleet();
  return useMemo(() => (data ? lastActiveOf(data) : (s) => s.lastActivity || 0), [data]);
}

/** A session's status word and tone, the same as on Now (Repos, usage, drawers, the board). */
export function useStatus(): (s: Pick<Session, "id" | "status">) => ReturnType<typeof placeLabel> {
  const where = usePlaces();
  const { data, sessionById } = useFleet();
  const { t } = useI18n();
  return (s) => {
    // A session without a place on Now (hidden, filtered out) that waits still says "waits · <why>" (round 7: Repos
    // read "wartet auf dich" where every other view reads "wartet").
    const place = where.get(s.id) ?? (s.status === "needs_input" ? "needs" : undefined);
    if (place !== "needs" && place !== "decision") return placeLabel(place, s, t);
    const d = (data?.decisions || []).find((x) => x.sessionId === s.id && x.status === "open") || null;
    return placeLabel(place, s, t, waitKind(sessionById.get(s.id) || {}, d));
  };
}
