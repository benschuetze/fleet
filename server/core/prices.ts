import type { Config, UsageEntry } from "../../shared/types";

type Prices = Config["prices"];

/** List prices in USD per million tokens (October 2026) and the cost of one answer. An estimate, not the bill. */
// [pattern, input, output, cache read]; cache write = 1.25x input (5 min) or 2x (1 h)
const PRICES: [RegExp, number, number, number][] = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-4-1|opus-4-2025|opus-4@|opus-4$|claude-3-opus/, 15, 75, 1.5],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-3-5|3-5-haiku/, 0.8, 4, 0.08],
  [/haiku/, 1, 5, 0.1],
];
const FALLBACK = { i: 5, o: 25, cr: 0.5 };

export function priceFor(model: unknown, custom?: Prices): { i: number; o: number; cr: number } {
  // Status lines report display names ("Opus 5.5"), transcripts ids ("claude-opus-5-5").
  const m = String(model || "")
    .toLowerCase()
    .replace(/[\s.]+/g, "-");
  if (custom && typeof custom === "object") {
    for (const [k, p] of Object.entries(custom)) {
      const i = Number(p?.input);
      const o = Number(p?.output);
      const cr = Number(p?.cacheRead);
      if (m.includes(k.toLowerCase()) && Number.isFinite(i) && Number.isFinite(o)) {
        return { i, o, cr: Number.isFinite(cr) ? cr : i * 0.1 };
      }
    }
  }
  const row = PRICES.find((r) => r[0].test(m));
  return row ? { i: row[1], o: row[2], cr: row[3] } : FALLBACK;
}

const hasCustom = (model: unknown, custom?: Prices) =>
  !!custom && Object.keys(custom).some((k) => String(model).toLowerCase().includes(k.toLowerCase()));

export function costOf(
  u: Pick<UsageEntry, "i" | "o" | "cw" | "cr"> & { cw1h?: number },
  model: unknown,
  custom?: Prices,
): number {
  let p = priceFor(model, custom);
  // Haiku 5.5 has two price tiers: prompts above 100k tokens cost five times as much.
  if (/haiku-5/.test(String(model).toLowerCase()) && !hasCustom(model, custom) && u.i + u.cw + u.cr > 100000) {
    p = { i: 0.5, o: 2.5, cr: 0.05 };
  }
  const cw5 = u.cw1h ? u.cw - u.cw1h : u.cw;
  return (u.i * p.i + u.o * p.o + cw5 * p.i * 1.25 + (u.cw1h || 0) * p.i * 2 + u.cr * p.cr) / 1e6;
}
