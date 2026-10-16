import { windowOver } from "./limits";
import type { Balance, Decision, Overview, PullRequest, Repo, Session, Usage } from "./types";

/**
 * One source for all counters and groups of the dashboard: header, alarm zone, watch board and tab badges read
 * only from here, so the same numbers stand everywhere.
 *
 * Session status and repo status are separate: "needs you" only means a session waits for an answer or an
 * approval. Red CI belongs to the repo and branch, not to every session that once worked there.
 */

export interface CiCard {
  key: string;
  root: string;
  repo: string;
  branch: string | null;
  pr: PullRequest | null;
  run: NonNullable<Session["ci"]>["ci"] | null;
  /** The branch the red run belongs to, also for a PR card (whose `branch` stays empty). */
  head: string | null;
  /** A working session on that branch: then the red run is being fixed and is no alarm. */
  fixedBy: string | null;
}

/** A rate limit at or above ALARM_LIMIT percent, or a reported hit that has not reset yet. */
export interface LimitAlarm {
  kind: "five_hour" | "seven_day";
  /** Only from the status line; null when only the hit is known. */
  pct: number | null;
  /** ms */
  resetsAt: number | null;
  hit: boolean;
}

export interface Inbox {
  decisions: Decision[];
  needs: Session[];
  errors: Session[];
  working: Session[];
  done: Session[];
  /** Still open, nothing happens: folded on "Now". */
  resting: Session[];
  /** Closed, or archived in the desktop app: on "Now" only through the search. */
  archive: Session[];
  /** Replaced by a successor that is in the list: only in the history and the search. */
  replaced: Session[];
  /** Red and nobody works on its branch: an alarm. */
  ciRed: CiCard[];
  /** Red, but a working session is on its branch: shown at that session, not as an alarm. */
  ciFixing: CiCard[];
  ciRunning: CiCard[];
  limit: LimitAlarm | null;
  /** Fleet cost more than it saved over three days (spec: "Fleet-Bilanz negativ"). */
  balance: NonNullable<Balance["alarm"]> | null;
  counts: { needs: number; errors: number; ciRed: number; working: number; done: number };
}

/** From this share of a rate limit on, the limit is an alarm (spec: "Limit > 90 %"). */
export const ALARM_LIMIT = 90;

const base = (p: string) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const ARCHIVE_GROUP = /^(archiv|archive|archived)$/i;

/** Closed sessions and those the desktop app keeps in its archive (flag or a sidebar group named so). */
export const archived = (s: Session) =>
  s.status === "ended" || !!s.desktop?.archived || ARCHIVE_GROUP.test(String(s.group?.name || "").trim());

export function inbox(
  data: Pick<Overview, "sessions" | "repos"> & { decisions?: Decision[]; usage?: Usage | null },
  now = Date.now(),
): Inbox {
  const ss = data.sessions.filter((s) => !s.meta?.hidden);
  const known = new Set(data.sessions.map((s) => s.id));
  const decisions = (data.decisions || []).filter((d) => d.status === "open");
  const deciding = new Set(decisions.map((d) => d.sessionId));
  // Replaced sessions (there is a newer one) wait for nobody anymore and are never an alarm, not even an error.
  const alarm = (s: Session) => !deciding.has(s.id) && !s.next;
  const needs = ss.filter((s) => s.status === "needs_input" && alarm(s));
  // A session without a sign of life for staleMinutes is an error too (turn without an end, process gone).
  const errors = ss.filter((s) => (s.status === "error" || s.status === "stale") && alarm(s));
  const working = ss.filter((s) => s.status === "working" && !deciding.has(s.id));
  const done = ss.filter((s) => s.status === "waiting" && !s.next);
  const grouped = new Set([...needs, ...errors, ...working, ...done]);
  const left = ss.filter((s) => !grouped.has(s) && !deciding.has(s.id));
  // Only hidden once the successor is really there; otherwise the old one is the only way back to the work.
  const replaced = left.filter((s) => s.next && known.has(s.next.id));
  const archive = left.filter((s) => !replaced.includes(s) && archived(s));
  const resting = left.filter((s) => !replaced.includes(s) && !archive.includes(s));

  const repos: Repo[] = data.repos || [];
  const nameOf = (root: string) => repos.find((r) => r.root === root)?.name || null;
  const red = new Map<string, CiCard>();
  const add = (
    root: string,
    branch: string | null,
    c: NonNullable<Session["ci"]>,
    name: string | null,
    remote: Repo["remote"] | undefined,
  ) => {
    // A merged or closed PR is done; the red run on the branch still counts.
    const pr = c.pr && !["merged", "closed"].includes(c.pr.state) ? c.pr : null;
    if (!((c.ci && c.ci.state === "failure") || (pr && pr.ci === "failure"))) return;
    // A PR is one card even when several checkouts (worktrees) of its repo know it.
    const key = pr ? `${remote ? `${remote.host}/${remote.path}` : root}#${pr.number}` : `${root}|${branch}`;
    // With a PR the session's branch is not the PR's: then none is named.
    if (!red.has(key))
      red.set(key, {
        key,
        root,
        repo: name || base(root),
        branch: pr ? null : branch,
        pr,
        run: c.ci || null,
        head: branch,
        fixedBy: null,
      });
  };
  // Running pipelines per repo and branch (for the live run display).
  const live = new Map<string, CiCard>();
  const addLive = (root: string, branch: string | null, c: NonNullable<Session["ci"]>, name: string | null) => {
    const st = c.ci?.state;
    if (st !== "running" && st !== "pending") return;
    const key = `${root}|${branch}`;
    if (!live.has(key))
      live.set(key, {
        key,
        root,
        repo: name || base(root),
        branch,
        pr: c.pr || null,
        run: c.ci || null,
        head: branch,
        fixedBy: null,
      });
  };
  const remoteOf = new Map<string, string>();
  for (const r of repos) if (r.remote) remoteOf.set(r.root, `${r.remote.host}/${r.remote.path}`);
  for (const s of ss) if (s.repoRoot && s.remote) remoteOf.set(s.repoRoot, `${s.remote.host}/${s.remote.path}`);
  for (const r of repos) {
    if (!r.ci) continue;
    add(r.root, r.branch, r.ci, r.name, r.remote);
    addLive(r.root, r.branch, r.ci, r.name);
  }
  for (const s of ss) if (s.ci && s.repoRoot) addLive(s.repoRoot, s.branch || null, s.ci, nameOf(s.repoRoot));
  for (const s of ss) if (s.ci && s.repoRoot) add(s.repoRoot, s.branch || null, s.ci, nameOf(s.repoRoot), s.remote);
  // Same repo means the same checkout or another worktree of the same remote.
  const sameRepo = (a: string, b: string) => a === b || (!!remoteOf.get(a) && remoteOf.get(a) === remoteOf.get(b));
  for (const c of red.values()) {
    const fixer = c.head
      ? working.find((s) => s.repoRoot && s.branch === c.head && sameRepo(s.repoRoot, c.root))
      : undefined;
    c.fixedBy = fixer?.id || null;
  }
  const allRed = [...red.values()];
  const ciRed = allRed.filter((c) => !c.fixedBy);
  const ciFixing = allRed.filter((c) => c.fixedBy);
  const ciRunning = [...live.values()];
  return {
    decisions,
    needs,
    errors,
    working,
    done,
    resting,
    archive,
    replaced,
    ciRed,
    ciFixing,
    ciRunning,
    limit: limitAlarm(data.usage, now),
    balance: balanceAlarm(data.usage),
    counts: {
      needs: needs.length + decisions.length,
      errors: errors.length,
      ciRed: ciRed.length,
      working: working.length,
      done: done.length,
    },
  };
}

/** One row of the alarm zone, in the order it stands on screen. */
export type AlarmRow =
  | { kind: "decision"; d: Decision }
  | { kind: "needs"; s: Session }
  | { kind: "errors"; s: Session }
  | { kind: "ci"; c: CiCard }
  | { kind: "limit"; l: LimitAlarm }
  | { kind: "balance"; b: NonNullable<Inbox["balance"]> };

const newestFirst = (x: Session, y: Session) => (y.statusSince || 0) - (x.statusSince || 0);

/**
 * The order of the alarm zone (B14): everything that waits for you first, so a small window never hides a request
 * below old errors. Fleet's own questions by expiry (the one answered for you soonest on top), then sessions waiting
 * for you, then errors, each newest first; then red CI, the limit and the balance. Row numbers follow this order.
 */
export function alarmRows(ib: Inbox, decisions: Decision[]): AlarmRow[] {
  return [
    ...decisions
      .slice()
      .sort((x, y) => x.expiresAt - y.expiresAt)
      .map((d) => ({ kind: "decision" as const, d })),
    ...ib.needs
      .slice()
      .sort(newestFirst)
      .map((s) => ({ kind: "needs" as const, s })),
    ...ib.errors
      .slice()
      .sort(newestFirst)
      .map((s) => ({ kind: "errors" as const, s })),
    ...ib.ciRed.map((c) => ({ kind: "ci" as const, c })),
    ...(ib.limit ? [{ kind: "limit" as const, l: ib.limit }] : []),
    ...(ib.balance ? [{ kind: "balance" as const, b: ib.balance }] : []),
  ];
}

/** How many numbered rows the alarm zone has; the watch board numbers on from there. */
export const alarmCount = (ib: Inbox, decisions: Decision[]) => alarmRows(ib, decisions).length;

/** Rows that wait for your answer: Fleet's questions and sessions waiting for you. */
export const waitingRows = (ib: Inbox, decisions: Decision[]) => decisions.length + ib.needs.length;

/**
 * The five status pictures (spec, "Symbole mit festem Vokabular"): waiting for you, working, done, error, resting.
 * A session's picture follows the place where it stands on "Now", never its raw status: a replaced session that
 * ended in an error is no alarm, so it does not get the red ship either (one signal, one place).
 */
/**
 * Why a waiting session waits, the same word in every view (practical test 15 Oct: a tool approval said "Waiting", a
 * question in the text said "Your yes"). An approval is a tool call the app holds for a yes: the hook's open
 * permission request or the screen of Fleet's own window (`s.waits`, server/core/status.ts), or Fleet forwarding it. Fleet's other questions
 * are "fleet"; everything else waits for an answer in words.
 */
export type WaitKind = "approval" | "question" | "fleet";
export function waitKind(s: Pick<Session, "waits">, decision?: Pick<Decision, "kind"> | null): WaitKind {
  if (decision) return decision.kind === "permission" ? "approval" : "fleet";
  return s.waits === "approval" ? "approval" : "question";
}

export type Glyph = "waiting" | "working" | "done" | "error" | "resting";
export type Place = "decision" | "needs" | "errors" | "working" | "done" | "resting" | "archive" | "replaced";

export const GLYPH: Record<Place, Glyph> = {
  decision: "waiting",
  needs: "waiting",
  errors: "error",
  working: "working",
  done: "done",
  resting: "resting",
  archive: "resting",
  replaced: "resting",
};

/** Where each visible session stands; a session waiting on a Fleet decision stands at the decision only. */
export function places(ib: Inbox): Map<string, Place> {
  const m = new Map<string, Place>();
  for (const k of ["needs", "errors", "working", "done", "resting", "archive", "replaced"] as const)
    for (const s of ib[k]) m.set(s.id, k);
  for (const d of ib.decisions) m.set(d.sessionId, "decision");
  return m;
}

/** The server decides (balance.ts); here only a shape check, a broken field must not raise an alarm. */
function balanceAlarm(usage: Usage | null | undefined): Inbox["balance"] {
  const b = usage?.balance;
  const a = b?.alarm;
  if (!a || b.incomplete || !Number.isFinite(a.net) || a.net >= 0 || !Number.isFinite(a.cost)) return null;
  return a;
}

/** Only certain numbers: a percentage from the status line, or the hit Claude Code reported; never an estimate. */
function limitAlarm(usage: Usage | null | undefined, now: number): LimitAlarm | null {
  const hit = usage?.limitHit;
  if (hit && Number.isFinite(hit.resetsAt) && hit.resetsAt > now)
    return { kind: hit.kind, pct: null, resetsAt: hit.resetsAt, hit: true };
  const l = usage?.limits;
  let best: LimitAlarm | null = null;
  for (const kind of ["five_hour", "seven_day"] as const) {
    const w = l?.[kind];
    const pct = typeof w?.used_percentage === "number" ? w.used_percentage : Number.NaN;
    if (!Number.isFinite(pct) || pct < ALARM_LIMIT || (best?.pct ?? -1) >= pct) continue;
    const reset = typeof w?.resets_at === "number" ? w.resets_at * 1000 : null;
    // A window that has already reset says nothing about now.
    if (windowOver(w, now)) continue;
    best = { kind, pct: Math.min(100, pct), resetsAt: reset, hit: pct >= 100 };
  }
  return best;
}
