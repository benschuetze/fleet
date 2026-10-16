import type { Session } from "../../shared/types";
import { useFleet } from "./fleet";

/**
 * With a Pro/Max plan the limit counts, not the dollar value at list prices: dollars then appear only on the usage
 * page (config "billing"). Everywhere else a component asks here whether it may show them.
 */
export function useDollars(): boolean {
  return useFleet().data?.billing === "api";
}

/** The context a session's next call reads (or writes again once the cache expired), in tokens; null when unknown. */
export function contextTokens(s: Session): number | null {
  const v = s.context?.tokens ?? s.ctx?.tokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
