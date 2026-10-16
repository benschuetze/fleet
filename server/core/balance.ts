import type { Balance, BalanceSum, Config, FleetTurnKind, Usage, UsageEntry } from "../../shared/types";
import type { Successor, TurnWindow } from "./fleetturns";
import { costOf, priceFor } from "./prices";

/**
 * The Fleet balance: does Fleet save more than it costs? Only from realised calls in the transcripts.
 *
 *  - Unit: tokens = input + cache write + cache read + output of a call. The saving comes almost only from smaller
 *    cache reads, so leaving them out of the cost side (as the usage page's "tokens" do) would tilt the balance.
 *    Dollars at list prices are the second number.
 *  - Cost: every call inside a Fleet window (fleetturns.ts), counted once even where windows overlap (a job that
 *    writes a handoff also carries a hook mark).
 *  - Saving per measure: (prompt tokens per call old − new) × realised calls of the successor, never below zero
 *    per call; a merge compares with the smallest predecessor. A rebuilt cache the successor avoided costs the
 *    same tokens (already counted above) and only more money: it shows as count and dollars.
 *  - Not counted: Haiku instead of Opus, the brake, loop stops, less lost context. Any number there would be a
 *    projection, not a realised call.
 *  - Against /compact (independent review: "a saving /compact would not have reached as well"): a compaction at
 *    the same point reads the old context once and writes a summary (COMPACT_OUT, measured), after which the session
 *    goes on with a context about as small as the successor's. So the honest comparison is that one compaction
 *    call against writing the handoff, in dollars; the work after it is the same either way.
 */

/** Output of a /compact summary: median of 6 real compactions on Ben's machine (15 Oct 2026), ≈ 5,000 tokens. */
export const COMPACT_OUT = 5_000;

export type BalanceEntry = Pick<UsageEntry, "t" | "model" | "i" | "o" | "cw" | "cr" | "cw1h" | "side"> & {
  sid: string;
  cost: number;
};

const DAY = 24 * 3600e3;
export const BALANCE_DAYS = 7;
/** Three days negative, and Fleet spent at least this much in them: a single small job must not flap the alarm. */
export const ALARM_MIN_COST = 50_000;
const ALARM_DAYS = 3;
// Which window owns a call where windows overlap: the exactly logged job first.
const RANK: FleetTurnKind[] = ["job", "handoff", "merge", "continue", "fix", "brief"];

const all = (e: BalanceEntry) => e.i + e.cw + e.cr + e.o;
const prompt = (e: Pick<BalanceEntry, "i" | "cw" | "cr">) => e.i + e.cw + e.cr;
const sum = (): BalanceSum => ({ tok: 0, cost: 0, n: 0 });

export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function computeBalance(
  entries: BalanceEntry[],
  turns: { windows: TurnWindow[]; successors: Successor[] },
  o: { now: number; prices?: Config["prices"]; marks: number; ends: number; jobs: number },
): Balance | null {
  const since = o.now - BALANCE_DAYS * DAY;
  const days: string[] = [];
  for (let i = BALANCE_DAYS - 1; i >= 0; i--) days.push(dayKey(o.now - i * DAY));
  const daily = new Map(
    days.map((d) => [d, { day: d, cost: 0, saved: 0, costUsd: 0, savedUsd: 0, compactUsd: 0, freshUsd: 0 }]),
  );
  const bySid = new Map<string, BalanceEntry[]>();
  for (const e of entries) {
    const l = bySid.get(e.sid);
    if (l) l.push(e);
    else bySid.set(e.sid, [e]);
  }
  for (const l of bySid.values()) l.sort((a, b) => a.t - b.t);

  // Cost: each call at most once, to the highest-ranked window around it.
  const cost = { ...sum(), byKind: {} as Balance["cost"]["byKind"] };
  const used = new Set<TurnWindow>();
  const winBySid = new Map<string, TurnWindow[]>();
  for (const w of turns.windows) {
    const l = winBySid.get(w.sessionId);
    if (l) l.push(w);
    else winBySid.set(w.sessionId, [w]);
  }
  for (const [sid, ws] of winBySid) {
    ws.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind));
    for (const e of bySid.get(sid) || []) {
      if (e.t < since || e.t > o.now) continue;
      const w = ws.find((x) => e.t >= x.from && e.t <= x.to);
      if (!w) continue;
      used.add(w);
      const k = cost.byKind[w.kind] ?? sum();
      cost.byKind[w.kind] = k;
      k.tok += all(e);
      k.cost += e.cost;
      cost.tok += all(e);
      cost.cost += e.cost;
      const d = daily.get(dayKey(e.t));
      if (d) {
        d.cost += all(e);
        d.costUsd += e.cost;
        if (w.kind === "handoff") d.freshUsd += e.cost;
      }
    }
  }
  for (const w of used) {
    const k = cost.byKind[w.kind];
    if (k) k.n++;
  }
  cost.n = used.size;

  // Saving: each successor's realised calls against the last call of the session(s) it replaced.
  const saved = {
    ...sum(),
    fresh: { ...sum(), calls: 0 },
    merge: { ...sum(), calls: 0 },
    rebuild: sum(),
  };
  let unmatched = 0;
  const vsCompact = { n: 0, compact: 0, fleet: 0, net: 0 };
  const lastBefore = (sid: string, at: number) => {
    const l = (bySid.get(sid) || []).filter((e) => !e.side && e.t < at);
    return l[l.length - 1] || null;
  };
  for (const s of turns.successors) {
    const olds = s.prev.map((p) => lastBefore(p, s.at));
    if (!olds.length || olds.some((x) => !x)) {
      unmatched++;
      continue;
    }
    const known = olds as BalanceEntry[];
    // Every call of the new session replaces exactly one call of one of the old ones: the smallest is safe.
    const old = known.reduce((a, b) => (prompt(b) < prompt(a) ? b : a));
    const alt = prompt(old);
    const calls = (bySid.get(s.sessionId) || []).filter((e) => !e.side && e.t >= s.at);
    const m = s.kind === "merge" ? saved.merge : saved.fresh;
    m.n++;
    for (const e of calls) {
      if (e.t < since || e.t > o.now) continue;
      m.calls++;
      const diff = Math.max(0, alt - prompt(e));
      if (!diff) continue;
      // The avoided tokens would have been cache reads of the old context.
      const usd = costOf({ i: 0, o: 0, cw: 0, cr: diff }, e.model, o.prices);
      m.tok += diff;
      m.cost += usd;
      const d = daily.get(dayKey(e.t));
      if (d) {
        d.saved += diff;
        d.savedUsd += usd;
      }
    }
    // The same point with /compact: one call that reads the old context and writes the summary, which the next
    // call writes to the cache (fresh starts only; a merge has no single session to compact).
    const first0 = calls[0];
    if (s.kind !== "merge" && first0 && first0.t >= since && first0.t <= o.now) {
      const usd = costOf({ i: 0, o: COMPACT_OUT, cw: COMPACT_OUT, cr: alt }, old.model, o.prices);
      vsCompact.n++;
      vsCompact.compact += usd;
      const d = daily.get(dayKey(first0.t));
      if (d) d.compactUsd += usd;
    }
    // The pause really happened and the old cache had expired: its next call would have written it all again.
    const first = calls[0];
    if (first && first.t >= since) {
      const ttl = old.cw1h > 0 ? 3600e3 : 5 * 60e3;
      const lastOld = known.reduce((a, b) => (b.t > a.t ? b : a));
      const diff = Math.max(0, alt - first.cw);
      if (first.t - lastOld.t > ttl && diff > 0) {
        const p = priceFor(old.model, o.prices);
        const write = ttl === 3600e3 ? 2 : 1.25;
        const usd = (diff * p.i * write - diff * p.cr) / 1e6;
        saved.rebuild.n++;
        saved.rebuild.cost += usd;
        const d = daily.get(dayKey(first.t));
        if (d) d.savedUsd += usd;
      }
    }
  }
  saved.tok = saved.fresh.tok + saved.merge.tok;
  saved.cost = saved.fresh.cost + saved.merge.cost + saved.rebuild.cost;
  saved.n = saved.fresh.n + saved.merge.n;

  // Without any end mark the hook is missing: handoffs and first turns are not in the count.
  const incomplete = o.jobs > 0 && o.ends === 0;
  if (!cost.n && !saved.n && !unmatched && !o.marks && !o.jobs) return null;

  const series = [...daily.values()];
  const last = series.slice(-ALARM_DAYS);
  const c3 = last.reduce((a, d) => a + d.cost, 0);
  const net3 = last.reduce((a, d) => a + d.saved - d.cost, 0);
  const alarm =
    !incomplete && net3 < 0 && c3 >= ALARM_MIN_COST ? { net: net3, cost: c3, since: last[0]?.day || "" } : null;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  // Fleet's counterpart of the compaction call is writing the handoff. The successor's first turn is not: it does the
  // next piece of work, which the compacted session would have done just the same.
  vsCompact.fleet = cost.byKind.handoff?.cost || 0;
  vsCompact.net = vsCompact.compact - vsCompact.fleet;
  for (const k of ["compact", "fleet", "net"] as const) vsCompact[k] = r4(vsCompact[k]);
  for (const d of series) for (const k of ["costUsd", "savedUsd", "compactUsd", "freshUsd"] as const) d[k] = r4(d[k]);
  for (const k of Object.values(cost.byKind)) k.cost = r4(k.cost);
  for (const k of [saved.fresh, saved.merge, saved.rebuild]) k.cost = r4(k.cost);
  return {
    days: BALANCE_DAYS,
    cost: { ...cost, cost: r4(cost.cost) },
    saved: { ...saved, cost: r4(saved.cost) },
    net: { tok: saved.tok - cost.tok, cost: r4(saved.cost - cost.cost) },
    daily: series,
    vsCompact,
    unmatched,
    alarm,
    incomplete,
  };
}

/**
 * After a limit hit, sessions went on: that runs on extra usage. Every assistant call after the hit, account-wide
 * like the limit itself; realised calls only. Null when nothing ran since or the window has reset.
 */
export function computeOverage(
  entries: BalanceEntry[],
  hit: Usage["limitHit"],
  now: number,
): NonNullable<Usage["overage"]> | null {
  if (!hit || !(hit.resetsAt > now)) return null;
  let tok = 0;
  let cost = 0;
  let n = 0;
  for (const e of entries) {
    if (e.t <= hit.at || e.t > now) continue;
    tok += all(e);
    cost += e.cost;
    n++;
  }
  return n ? { since: hit.at, tok, cost: Math.round(cost * 1e4) / 1e4, n } : null;
}
