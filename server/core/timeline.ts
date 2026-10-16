import type { FleetEvent, Lane, LaneStatus, Timeline } from "../../shared/types";

/**
 * Timeline of the last hours, built from the hook events. Answers at a glance who worked when and how long work
 * waited for you. With `laneOf` one lane per repo (spec: "Lane je Repo"), otherwise one per session.
 */
const SHOWN = new Set<string>(["working", "needs_input", "waiting", "error"]);
/** Several sessions of a repo at the same time: the lane shows the state that matters most. */
const RANK: Record<LaneStatus, number> = { error: 4, needs_input: 3, working: 2, waiting: 1 };

type Segment = Lane["segments"][number];

export function buildTimeline(
  events: FleetEvent[],
  {
    now,
    spanMs = 3 * 3600e3,
    maxLanes = 8,
    laneOf,
  }: {
    now: number;
    spanMs?: number;
    maxLanes?: number;
    /** The repo of a session; null leaves the session out of the lanes (its time still counts in the totals). */
    laneOf?: (sessionId: string) => { key: string; name: string } | null;
  },
): Timeline {
  const from = now - spanMs;
  const bySession = new Map<string, FleetEvent[]>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!e || typeof e.sessionId !== "string" || !Number.isFinite(e.at) || e.at > now) continue;
    const list = bySession.get(e.sessionId) || [];
    list.push(e);
    bySession.set(e.sessionId, list);
  }
  const lanes: (Lane & { last: number })[] = [];
  const totals = { work: 0, attention: 0, done: 0 };
  const groups = new Map<
    string,
    { name: string; segments: Segment[]; last: number; sessions: number; work: number; attention: number; done: number }
  >();
  for (const [id, list] of bySession) {
    const segments = segmentsOf(list, from, now);
    if (!segments.length) continue;
    const last = list[list.length - 1]?.at ?? 0;
    const lane = { id, segments, ...sums(segments), last };
    if (!laneOf) {
      lanes.push(lane);
      continue;
    }
    // Per repo the totals are the sessions' sum: two sessions waiting ten minutes each waited twenty minutes.
    totals.work += lane.work;
    totals.attention += lane.attention;
    totals.done += lane.done;
    const repo = laneOf(id);
    if (!repo) continue;
    const g = groups.get(repo.key) || {
      name: repo.name,
      segments: [],
      last: 0,
      sessions: 0,
      work: 0,
      attention: 0,
      done: 0,
    };
    g.segments.push(...segments);
    g.last = Math.max(g.last, last);
    g.sessions++;
    // The lane's minutes are its sessions' sum, like the totals; only the drawing overlays them (practical test
    // 15 Oct: the header said 323 min waited, the lanes added up to 306).
    g.work += lane.work;
    g.attention += lane.attention;
    g.done += lane.done;
    groups.set(repo.key, g);
  }
  for (const [key, g] of groups) {
    const segments = overlay(g.segments);
    lanes.push({
      id: key,
      segments,
      work: g.work,
      attention: g.attention,
      done: g.done,
      last: g.last,
      project: g.name,
      sessions: g.sessions,
    });
  }
  // Ordered by the last event: running work all ends "now".
  lanes.sort((a, b) => b.last - a.last);
  const shown: Lane[] = lanes.slice(0, maxLanes).map(({ last: _last, ...l }) => l);
  if (!laneOf) {
    for (const l of shown) {
      totals.work += l.work;
      totals.attention += l.attention;
      totals.done += l.done;
    }
  }
  return { from, to: now, lanes: shown, totals };
}

/** One session's events (sorted) as status segments inside the window. */
function segmentsOf(list: FleetEvent[], from: number, now: number): Segment[] {
  const segments: Segment[] = [];
  list.forEach((e, i) => {
    const nextAt = list[i + 1]?.at;
    const end = nextAt ?? (e.status === "ended" ? e.at : now);
    if (!SHOWN.has(e.status)) return;
    const status = e.status as LaneStatus;
    const a = Math.max(e.at, from);
    const b = Math.min(end, now);
    if (b - a < 1000) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.status === status && a - prev.to < 1000) prev.to = b;
    else segments.push({ from: a, to: b, status });
  });
  return segments;
}

/** Segments of several sessions laid over each other: per moment the highest-ranking state, equal ones merged. */
export function overlay(segs: Segment[]): Segment[] {
  const cuts = [...new Set(segs.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    let best: LaneStatus | null = null;
    for (const s of segs) {
      if (s.from <= a && s.to >= b && (!best || RANK[s.status] > RANK[best])) best = s.status;
    }
    if (!best) continue;
    const prev = out[out.length - 1];
    if (prev && prev.status === best && prev.to === a) prev.to = b;
    else out.push({ from: a, to: b, status: best });
  }
  return out;
}

function sums(segments: Segment[]) {
  const sum = (st: LaneStatus[]) =>
    segments.filter((s) => st.includes(s.status)).reduce((t, s) => t + s.to - s.from, 0);
  return { work: sum(["working"]), attention: sum(["needs_input", "error"]), done: sum(["waiting"]) };
}
