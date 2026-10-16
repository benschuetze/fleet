import { priceFor } from "./usage";

/**
 * Prompt cache of a waiting session: how long the context stays cached and what it costs once it
 * expires. The lifetime (5 minutes or 1 hour) is in the transcript (usage.cache_creation); every call
 * that reads or writes the cache restarts it.
 */
export const TTL = { "5m": 5 * 60e3, "1h": 3600e3 } as const;

export function cacheState({
  ttl,
  at,
  tokens,
  model,
}: {
  ttl: "5m" | "1h" | null | undefined;
  at: number | null | undefined;
  tokens: number;
  model: string | null | undefined;
}): { ttl: "5m" | "1h"; until: number; rebuild: number } | null {
  if (!at || !tokens) return null;
  const t = ttl === "1h" ? "1h" : "5m";
  // Writing again costs 1.25x (5 min) or 2x (1 h) the input price.
  const rebuild = Math.round((tokens * priceFor(model).i * (t === "1h" ? 2 : 1.25)) / 1e4) / 100;
  return { ttl: t, until: at + TTL[t], rebuild };
}
