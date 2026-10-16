import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config, Usage, UsageDay, UsageEntry, UsageTotals } from "../../shared/types";
import { type BalanceEntry, computeBalance, computeOverage, dayKey } from "./balance";
import { readJobs, readMarks, windows } from "./fleetturns";
import { recordDays } from "./ledger";
import { newestCopies } from "./paths";
import { costOf, priceFor } from "./prices";
import { COWORK, readStatuslines, type StatuslineState, scanCowork } from "./usage-sources";

export type { StatuslineState };
export { costOf, priceFor };

/**
 * Usage: tokens and estimated cost from the transcripts (including subagents) and from Cowork reports
 * (~/.claude-fleet/usage-cowork.jsonl), plus limits from the status line.
 *
 *  - each file is read once completely and afterwards only incrementally
 *  - streaming often writes one answer several times: per message.id only the last state counts
 *  - cost = list prices (an estimate, not the bill); overridable via config "prices"
 */

type Hit = { kind: "five_hour" | "seven_day"; reset: number; at: number };
interface FileRec {
  size: number;
  mtime: number;
  offset: number;
  msgs: Map<string, UsageEntry>;
  cwd: string | null;
  sid: string;
  compacted?: boolean;
  hits?: Map<string, Hit>;
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const BLOCK = 5 * HOUR;
const CHUNK = 8 * 1024 * 1024;

/* ---------- Finding files ---------- */

async function listJsonl(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  let ents: import("node:fs").Dirent[] = [];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) await listJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Which main session a file belongs to (subagents: <session>/subagents/agent-x.jsonl). */
export function sessionOf(file: string, root: string): string {
  const rel = path.relative(root, file).split(path.sep);
  if (rel.length >= 3 && rel[1]) return rel[1];
  return path.basename(file, ".jsonl");
}

/* ---------- Per-file cache ---------- */

const files = new Map<string, FileRec>();

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// biome-ignore lint/suspicious/noExplicitAny: transcript lines are untrusted JSON; every field is checked where it is read
type Line = Record<string, any>;

export function entryOf(o: Line): UsageEntry | null {
  const m = o.message;
  const u = m?.usage;
  if (!u || typeof u !== "object") return null;
  const t = Date.parse(o.timestamp);
  if (!t) return null;
  const cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  return {
    t,
    model: typeof m.model === "string" ? m.model : "?",
    i: num(u.input_tokens),
    o: num(u.output_tokens),
    cw: num(u.cache_creation_input_tokens),
    cr: num(u.cache_read_input_tokens),
    cw1h: cc ? num(cc.ephemeral_1h_input_tokens) : 0,
    side: !!o.isSidechain,
  };
}

function noteLimitHit(rec: FileRec, line: string) {
  let o: Line;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const q = o.quotaLimits || o.message?.rate_limit_info || o.rate_limit_info;
  const t = Date.parse(o.timestamp);
  const kind = q?.rateLimitType;
  if ((kind !== "five_hour" && kind !== "seven_day") || q.status !== "rejected" || !Number.isFinite(q.resetsAt) || !t)
    return;
  const hits = rec.hits || new Map<string, Hit>();
  rec.hits = hits;
  const reset = Number(q.resetsAt) * 1000;
  const k = `${kind}:${reset}`;
  const old = hits.get(k);
  if (!old || t < old.at) hits.set(k, { kind, reset, at: t });
}

async function readNew(file: string, rec: FileRec, st: Stats) {
  let pos = rec.offset;
  while (pos < st.size) {
    const len = Math.min(CHUNK, st.size - pos);
    const fh = await fsp.open(file, "r");
    let buf: Buffer;
    try {
      buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) break; // incomplete line: continue later
    for (const line of buf
      .subarray(0, last + 1)
      .toString("utf8")
      .split("\n")) {
      if (!line) continue;
      if (!rec.cwd && line.includes('"cwd"')) {
        try {
          const o = JSON.parse(line) as Line;
          if (typeof o.cwd === "string") rec.cwd = o.cwd;
        } catch {
          // ignore
        }
      }
      if (line.includes('"compact_boundary"')) {
        rec.compacted = true;
        continue;
      }
      // Limit reached: the desktop app knows no percentage, only this hit with its reset time.
      if (line.includes('"rateLimitType"')) {
        noteLimitHit(rec, line);
        continue;
      }
      if (!line.includes('"usage"')) continue;
      let o: Line;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "assistant") continue;
      const e = entryOf(o);
      if (!e || e.model === "<synthetic>") continue;
      const id = o.message?.id || o.requestId || o.uuid || String(e.t);
      const prev = rec.msgs.get(id);
      if (rec.compacted || prev?.afterCompact) {
        e.afterCompact = true;
        rec.compacted = false;
      }
      rec.msgs.set(id, e); // a later line of the same answer replaces the earlier one
    }
    pos += last + 1;
  }
  rec.offset = pos;
}

async function scanTranscripts(root: string, sinceMs: number) {
  const projects = path.join(root, "projects");
  const list = await listJsonl(projects);
  const stats = await Promise.all(
    list.map(async (file) => {
      try {
        return { file, st: await fsp.stat(file) };
      } catch {
        return null;
      }
    }),
  );
  const found = newestCopies(projects, stats).filter(({ st }) => st.mtimeMs >= sinceMs && st.size > 0);
  const seen = new Set<string>();
  await Promise.all(
    found.map(async ({ file, st }) => {
      seen.add(file);
      let rec = files.get(file);
      if (!rec || st.size < rec.offset) {
        rec = { size: 0, mtime: 0, offset: 0, msgs: new Map(), cwd: null, sid: sessionOf(file, projects) };
        files.set(file, rec);
      }
      if (rec.size === st.size && rec.mtime === st.mtimeMs) return;
      try {
        await readNew(file, rec, st);
      } catch {
        // locked or broken file
      }
      rec.size = st.size;
      rec.mtime = st.mtimeMs;
    }),
  );
  for (const k of files.keys()) if (k.startsWith(projects) && !seen.has(k)) files.delete(k);
}

/* ---------- Evaluation ---------- */

export { dayKey };

export const familyOf = (m: unknown): string => {
  const s = String(m || "").toLowerCase();
  const x = /(opus|sonnet|haiku|fable|mythos)[-_]?(\d+)(?:[-.](\d))?(?!\d)/.exec(s);
  if (!x?.[1]) return s || "?";
  const name = x[1].charAt(0).toUpperCase() + x[1].slice(1);
  return `${name} ${x[2]}${x[3] ? `.${x[3]}` : ""}`;
};

export interface SessionSum extends UsageTotals {
  sub: number;
  mn: number;
  mo: number;
  rebuilds: number;
  rebuildCost: number;
}

export interface UsageData {
  usage: Usage | null;
  perSession: Record<string, SessionSum>;
  statusline: Record<string, StatuslineState>;
}

const zero = (): UsageTotals => ({ cost: 0, tok: 0, cr: 0, n: 0, prompt: 0, i: 0, o: 0, cw: 0 });

export async function collectUsage(
  cfg: Pick<Config, "statsDays" | "claudeHome" | "_fleetHome" | "prices">,
): Promise<UsageData> {
  const days = Math.max(7, Math.min(90, cfg.statsDays || 30));
  const since = Date.now() - days * DAY;
  await Promise.all([scanTranscripts(cfg.claudeHome, since), scanCowork(cfg._fleetHome)]);
  const sl = await readStatuslines(cfg._fleetHome);

  // Project per session (subagent files often have no cwd: they inherit it from the main session).
  const projOf = new Map<string, string>();
  // Only files of this Claude folder (the cache survives if one process reads several).
  const prefix = path.join(cfg.claudeHome, "projects") + path.sep;
  const recs = [...files].filter(([f]) => f.startsWith(prefix)).map(([, rec]) => rec);
  for (const rec of recs) {
    if (rec.cwd && !projOf.has(rec.sid)) projOf.set(rec.sid, rec.cwd.split(/[\\/]/).filter(Boolean).pop() || "?");
  }
  const raw: (UsageEntry & { sid: string; proj: string })[] = [];
  for (const rec of recs) {
    const proj = projOf.get(rec.sid) || "?";
    for (const e of rec.msgs.values()) if (e.t >= since) raw.push({ ...e, sid: rec.sid, proj });
  }
  for (const e of COWORK.msgs.values()) if (e.t >= since) raw.push({ ...e, sid: e.sid || "?", proj: "Cowork" });
  raw.sort((a, b) => a.t - b.t);
  const entries = raw.map((e) => ({ ...e, cost: costOf(e, e.model, cfg.prices), tok: e.i + e.o + e.cw }));

  const perSession: Record<string, SessionSum> = {};
  const dayMap = new Map<string, UsageDay>();
  const totals = { today: zero(), d7: zero(), d30: zero() };
  const now = Date.now();
  const todayKey = dayKey(now);
  // prompt = all input tokens of a call (new + cache write + cache read)
  const add = (a: UsageTotals, e: (typeof entries)[number]) => {
    a.cost += e.cost;
    a.tok += e.tok;
    a.cr += e.cr;
    a.n++;
    a.prompt += e.i + e.cw + e.cr;
    a.i += e.i;
    a.o += e.o;
    a.cw += e.cw;
  };

  for (const e of entries) {
    const first = !perSession[e.sid];
    const s = perSession[e.sid] ?? { ...zero(), sub: 0, mn: 0, mo: 0, rebuilds: 0, rebuildCost: 0 };
    perSession[e.sid] = s;
    add(s, e);
    if (e.side) s.sub += e.cost;
    else {
      s.mn++;
      s.mo += e.o; // answers in the main conversation (without subagents) for the work profile
      // Mid-session nearly the whole context is written to the cache again while only the fixed start
      // (system prompt) is read: the cache had expired after a pause and the context was paid again.
      if (!first && !e.afterCompact && e.cw >= 50000 && e.cw > 2 * e.cr) {
        s.rebuilds++;
        s.rebuildCost += costOf({ i: 0, o: 0, cw: e.cw, cr: 0, cw1h: e.cw1h }, e.model, cfg.prices);
      }
    }
    const dk = dayKey(e.t);
    let d = dayMap.get(dk);
    if (!d) {
      d = { day: dk, cost: 0, tok: 0, byModel: {}, byProject: {} };
      dayMap.set(dk, d);
    }
    d.cost += e.cost;
    d.tok += e.tok;
    const fm = familyOf(e.model);
    const bm = d.byModel[fm] ?? { cost: 0, tok: 0 };
    d.byModel[fm] = bm;
    bm.cost += e.cost;
    bm.tok += e.tok;
    const bp = d.byProject[e.proj] ?? { cost: 0, tok: 0 };
    d.byProject[e.proj] = bp;
    bp.cost += e.cost;
    bp.tok += e.tok;
    if (dk === todayKey) add(totals.today, e);
    if (now - e.t < 7 * DAY) add(totals.d7, e);
    add(totals.d30, e);
  }

  // Live: tokens (without cache reads) and cost per minute of the last hour, per session.
  // Index 59 is the running minute. For the pulse chart.
  const LIVE_MIN = 60;
  const liveBy: Record<string, { tok: number[]; cost: number[] }> = {};
  for (const e of entries) {
    const age = Math.floor((now - e.t) / 60e3);
    if (age < 0 || age >= LIVE_MIN) continue;
    const l = liveBy[e.sid] ?? { tok: new Array(LIVE_MIN).fill(0), cost: new Array(LIVE_MIN).fill(0) };
    liveBy[e.sid] = l;
    const i = LIVE_MIN - 1 - age;
    l.tok[i] = (l.tok[i] ?? 0) + e.tok;
    l.cost[i] = (l.cost[i] ?? 0) + e.cost;
  }
  for (const l of Object.values(liveBy)) l.cost = l.cost.map((c) => Math.round(c * 1e4) / 1e4);

  // Five-hour blocks like ccusage: a block starts at the full hour of the first request and ends 5 h later.
  const blocks: { start: number; end: number; tok: number; cost: number; first: number; last: number }[] = [];
  for (const e of entries) {
    let b = blocks[blocks.length - 1];
    if (!b || e.t >= b.start + BLOCK) {
      const start = Math.floor(e.t / HOUR) * HOUR;
      b = { start, end: start + BLOCK, tok: 0, cost: 0, first: e.t, last: e.t };
      blocks.push(b);
    }
    b.tok += e.tok;
    b.cost += e.cost;
    b.last = e.t;
  }
  const lastBlock = blocks[blocks.length - 1];
  const cur = lastBlock && now < lastBlock.end ? lastBlock : null;

  // A limit hit stands with its reset time in the transcript: the only certain limit signal without a
  // status line. Percentages are deliberately not estimated; usage outside the transcripts (chat, Cowork,
  // extra usage credits) makes any projection unreliable. The week wins over five hours: whoever hit the
  // weekly limit is bound by the later reset.
  let limitHit: Usage["limitHit"] = null;
  for (const rec of recs) {
    for (const h of rec.hits?.values() ?? []) {
      if (
        h.reset > now &&
        (!limitHit || h.reset > limitHit.resetsAt || (h.reset === limitHit.resetsAt && h.at < limitHit.at))
      ) {
        limitHit = { kind: h.kind, at: h.at, resetsAt: h.reset };
      }
    }
  }
  // A newer status line below 100 % in the same window outranks an older hit (live 16.10.2026: a weekly "rejected"
  // from Wednesday kept "Weekly limit reached" up on Friday while the status line said 91 % and sessions worked).
  const reading = limitHit && sl.limits?.[limitHit.kind];
  if (
    limitHit &&
    reading &&
    typeof reading.used_percentage === "number" &&
    reading.used_percentage < 100 &&
    (sl.limits?.at ?? 0) > limitHit.at
  )
    limitHit = null;
  let block: Usage["block"] = null;
  if (cur) {
    const recent = entries.filter((e) => e.t >= Math.max(cur.start, now - HOUR));
    const span = Math.max(10 * 60e3, now - Math.max(cur.first, now - HOUR));
    const burn = recent.reduce((a, e) => a + e.tok, 0) / (span / 60e3); // tokens per minute
    block = {
      start: cur.start,
      end: cur.end,
      first: cur.first,
      tok: cur.tok,
      cost: cur.cost,
      burnPerMin: Math.round(burn),
    };
  }

  // Day series without gaps (including days without usage).
  const series: UsageDay[] = [];
  for (let t = now - (days - 1) * DAY; t <= now + 1; t += DAY) {
    const k = dayKey(t);
    series.push(dayMap.get(k) || { day: k, cost: 0, tok: 0, byModel: {}, byProject: {} });
  }
  const round = <T extends object>(o: T): T => {
    const r = o as Record<string, unknown>;
    for (const k of Object.keys(r)) if (typeof r[k] === "number") r[k] = Math.round((r[k] as number) * 1e4) / 1e4;
    return o;
  };
  for (const d of series) {
    round(d);
    for (const v of Object.values(d.byModel)) round(v);
    for (const v of Object.values(d.byProject)) round(v);
  }
  // Share of prompt tokens from the cache: the most important lever for an agent's cost.
  for (const v of [...Object.values(perSession), ...Object.values(totals)])
    v.cacheRate = v.prompt ? v.cr / v.prompt : null;
  for (const v of Object.values(perSession)) round(v);
  for (const v of Object.values(totals)) round(v);

  // Fleet's own turns and what they saved, from the same realised calls (Cowork has no Fleet turns).
  const local: BalanceEntry[] = entries.filter((e) => e.proj !== "Cowork");
  const marks = readMarks(cfg._fleetHome, now - 8 * DAY);
  const jobs = readJobs(cfg._fleetHome, now - 8 * DAY);
  const balance = computeBalance(local, windows(marks, jobs, now), {
    now,
    prices: cfg.prices,
    marks: marks.length,
    ends: marks.filter((m) => m.phase === "end").length,
    jobs: jobs.length,
  });
  // The days stay after they leave the window: weeks of balance for `fleet balance` (ledger.ts).
  if (balance) recordDays(balance.daily);

  // Earlier versions wrote an estimate here for the hook; it must not have any effect anymore.
  await fsp.rm(path.join(cfg._fleetHome, "limit-estimate.json"), { force: true }).catch(() => {});
  return {
    usage: {
      days: series,
      totals,
      block,
      live: { minutes: LIVE_MIN, end: now, bySession: liveBy },
      limitHit,
      limits: sl.limits || null,
      statsDays: days,
      hasData: entries.length > 0,
      priced: "list",
      balance,
      overage: computeOverage(entries, limitHit, now),
    },
    perSession,
    statusline: sl.bySession,
  };
}
