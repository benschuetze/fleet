import type { ReadyRepo } from "~/components/drawer/handoff-panel";
import { alarmRows, type CiCard, type Inbox, inbox } from "../../shared/inbox";
import { narrow, type RepoEntry } from "../../shared/repobar";
import type { Decision, Duplicate, Overview, Session } from "../../shared/types";
import { clearKey, type StatusFilter } from "./keymap";
import { matches } from "./session";

/**
 * What "Now" shows under a status filter (Alt+1–5) and with muted alarms (key `s`). Pure, so the promise holds
 * in a test: a filter only takes rows away, it never moves a session to another place, and a muted alarm leaves
 * the alarm zone for its hour without turning up anywhere else (one place per session).
 */

export const MUTE_MS = 60 * 60e3;

/** The key a muted alarm row is remembered by. */
export const alarmKey = {
  session: (id: string) => `s:${id}`,
  ci: (key: string) => `ci:${key}`,
  decision: (id: string) => `d:${id}`,
  limit: (kind: string) => `limit:${kind}`,
  // Per three-day window: a balance that turns negative again on later days is a new alarm.
  balance: (since: string) => `balance:${since}`,
};

/**
 * The German pronoun for a muted alarm in "u holt … zurück" (round 7: "Freigabe …: stumm – u holt ihn zurück"):
 * the limit is a "Limit" (es), everything else a feminine noun (Freigabe, Frage, CI, Session, Bilanz).
 */
export function muteBack(key: string): "sie" | "es" {
  return key.startsWith("limit:") ? "es" : "sie";
}

export function liveMutes(muted: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(muted).filter(([k, until]) => typeof k === "string" && Number.isFinite(until) && until > now),
  );
}

export function applyView(
  ib: Inbox,
  decisions: Decision[],
  filter: StatusFilter | null,
  muted: Record<string, number>,
  now: number,
): { ib: Inbox; decisions: Decision[]; mutedCount: number } {
  const on = liveMutes(muted, now);
  const loud = <T>(list: T[], key: (x: T) => string) => list.filter((x) => !on[key(x)]);
  const out: Inbox = {
    ...ib,
    errors: loud(ib.errors, (s) => alarmKey.session(s.id)),
    needs: loud(ib.needs, (s) => alarmKey.session(s.id)),
    ciRed: loud(ib.ciRed, (c) => alarmKey.ci(c.key)),
    limit: ib.limit && !on[alarmKey.limit(ib.limit.kind)] ? ib.limit : null,
    balance: ib.balance && !on[alarmKey.balance(ib.balance.since)] ? ib.balance : null,
  };
  let ds = loud(decisions, (d) => alarmKey.decision(d.id));
  const mutedCount =
    ib.errors.length -
    out.errors.length +
    ib.needs.length -
    out.needs.length +
    ib.ciRed.length -
    out.ciRed.length +
    (ib.limit && !out.limit ? 1 : 0) +
    (ib.balance && !out.balance ? 1 : 0) +
    decisions.length -
    ds.length;
  if (!filter) return { ib: out, decisions: ds, mutedCount };
  // A filter is about sessions: pipelines, the limit and the balance step aside; Fleet's own questions count as waiting.
  const keep = (k: StatusFilter) => filter === k;
  if (!keep("needs")) ds = [];
  return {
    ib: {
      ...out,
      needs: keep("needs") ? out.needs : [],
      errors: keep("errors") ? out.errors : [],
      working: keep("working") ? out.working : [],
      done: keep("done") ? out.done : [],
      resting: keep("resting") ? out.resting : [],
      archive: [],
      replaced: [],
      ciRed: [],
      ciFixing: keep("working") ? out.ciFixing : [],
      ciRunning: [],
      limit: null,
      balance: null,
    },
    decisions: ds,
    mutedCount,
  };
}

/** What "Now" shows, derived once: the alarm zone and the tiles of the middle see the same (plan 3.3). */
export interface NowView {
  /** The sessions the search leaves, without hidden ones. */
  all: Session[];
  /** Under the status filter and without muted alarms: the alarm zone's inbox, never narrowed by the repo. */
  ib: Inbox;
  decisions: Decision[];
  mutedCount: number;
  /** Alarm rows the status filter or the search takes away (muted ones have their own count). */
  hiddenAlarms: number;
  /** The same, narrowed to the repo chosen in the repo bar: the watch board's. */
  mine: Inbox;
  /** Handoffs nobody continues yet, those opened in a new session first. */
  ready: ReadyRepo[];
  dups: Duplicate[];
  running: CiCard[];
}

/**
 * What "Now" shows for an overview. The search and the status filter take rows away; the repo chosen in the repo
 * bar narrows the board, the handoffs, duplicates and pipelines, never the alarm zone: an alarm elsewhere must stay
 * in sight.
 */
export function nowView(
  data: Overview,
  o: { query: string; filter: StatusFilter | null; muted: Record<string, number>; repo: RepoEntry | null; now: number },
): NowView {
  const { query, filter, muted, repo, now } = o;
  const all = data.sessions.filter((s) => matches(s, query) && !s.meta?.hidden);
  // Expired approvals disappear at once: then the app asks itself and an answer here would go nowhere.
  // The search narrows every row, not only sessions (round 4): Fleet's questions, CI, the limit, handoffs, pairs.
  const kept = new Set(all.map((s) => s.id));
  const found = (...parts: unknown[]) => found_(query, parts);
  const live = data.decisions.filter(
    (d) =>
      (d.status === "open" && d.expiresAt > now) ||
      // Run out but not yet marked by the server: it "carried on" until the next overview says more (round 5:
      // the row vanished for up to 13 s and every row number below it moved up and back).
      // An approval too (round 6): it shows "abgelaufen" without its button until the server marks it.
      d.status === "open" ||
      (d.status === "expired" && d.kind !== "permission" && now - d.createdAt < 30 * 60e3),
  );
  const asked = live.filter(
    (d) => !query || kept.has(d.sessionId) || found(d.project, d.sessionTitle, d.title, d.text),
  );
  // The status filter (Alt+1–5) and muted alarms first, then the repo bar narrows what is not an alarm.
  const view = applyView(inbox({ ...data, sessions: all }), asked, filter, muted, now);
  const ci = (c: CiCard) => found(c.repo, c.branch, c.head, c.pr?.title, c.pr ? `#${c.pr.number}` : "");
  const ib: Inbox = query
    ? {
        ...view.ib,
        ciRed: view.ib.ciRed.filter(ci),
        ciRunning: view.ib.ciRunning.filter(ci),
        ciFixing: view.ib.ciFixing.filter(ci),
        limit: null,
        balance: null,
      }
    : view.ib;
  const unfiltered =
    filter || query
      ? applyView(inbox({ ...data, sessions: data.sessions.filter((s) => !s.meta?.hidden) }), live, null, muted, now)
      : view;
  const hiddenAlarms = alarmRows(unfiltered.ib, unfiltered.decisions).length - alarmRows(ib, view.decisions).length;
  const ofRepo = (root: string) => !repo || repo.roots.includes(root);
  // Only handoffs nobody continues: not passed on, and the session that wrote it is not running anymore. An
  // emergency handoff of a failing session stands there once: its error row is the one place to act.
  const busy = new Set(
    data.sessions.filter((x) => ["working", "stale", "needs_input"].includes(String(x.status))).map((x) => x.id),
  );
  const failing = new Set(ib.errors.map((x) => x.id));
  const ready = data.repos
    .filter(
      (r): r is ReadyRepo =>
        !!r.handoff &&
        !r.handoff.delivered &&
        ofRepo(r.root) &&
        !busy.has(String(r.handoff.session)) &&
        !(r.handoff.origin === "emergency" && failing.has(String(r.handoff.session))) &&
        found(r.name, r.branch, r.handoff.session && kept.has(String(r.handoff.session)) ? query : ""),
    )
    .sort((x, y) => Number(!!y.handoff.opened) - Number(!!x.handoff.opened) || y.handoff.at - x.handoff.at);
  return {
    all,
    ib,
    decisions: view.decisions,
    mutedCount: view.mutedCount,
    hiddenAlarms,
    mine: narrow(ib, repo),
    ready,
    dups: data.duplicates.filter(
      (d) => ofRepo(d.root) && found(d.repo, d.branch, ...d.files, ...d.sessions.map((x) => x.title)),
    ),
    running: ib.ciRunning.filter((c) => ofRepo(c.root)),
  };
}

/** Every word of the search in one of the parts (as `matches` for sessions). */
function found_(query: string, parts: unknown[]): boolean {
  if (!query) return true;
  const hay = parts
    .filter((x) => typeof x === "string" || typeof x === "number")
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

type T = (de: string, en: string) => string;
const WORD: Record<StatusFilter, [string, string]> = {
  needs: ["die auf dich warten", "waiting for you"],
  errors: ["mit Fehler", "with an error"],
  working: ["die arbeiten", "working"],
  done: ["die fertig sind", "done"],
  resting: ["die ruhen", "resting"],
};

/**
 * What the empty watch board says (release 6, Ben's finding): under the filters "waiting" and "error" the board is
 * empty by design, because those sessions stand in the alarm zone; it says so and how many, instead of "no session
 * is working", which reads as a contradiction to the alarms right above it.
 */
export function boardEmpty(ib: Inbox, decisions: number, filter: StatusFilter | null, t: T): string {
  if (filter === "needs" || filter === "errors") {
    const n = filter === "needs" ? ib.needs.length + decisions : ib.errors.length;
    const [de, en] = WORD[filter];
    return n
      ? t(
          `${n} ${n === 1 ? "Session" : "Sessions"} ${de} – sie stehen oben in der Alarmzone (1).`,
          `${n} ${n === 1 ? "session" : "sessions"} ${en}: they stand in the alarm zone above (1).`,
        )
      : t(`Keine Session ${de}.`, `No session ${en}.`);
  }
  if (filter) {
    const [de, en] = WORD[filter];
    return t(`Keine Session ${de}.`, `No session ${en}.`);
  }
  const alarms = ib.needs.length + ib.errors.length + decisions;
  return alarms
    ? t(
        "Keine Session ohne Alarm – alle stehen oben in der Alarmzone.",
        "No session without an alarm: all stand in the alarm zone above.",
      )
    : t("Gerade arbeitet keine Session.", "No session is working right now.");
}

/**
 * What the empty alarm zone says (round 3): with alarms hidden by the status filter or the search it says how many and
 * how to get them back, never "nothing to do" while the header counts alarms.
 */
export function alarmEmpty(hidden: number, filter: StatusFilter | null, t: T): string {
  const n = `${hidden} ${hidden === 1 ? "Alarm" : "Alarme"}`;
  const en = `${hidden} ${hidden === 1 ? "alarm" : "alarms"}`;
  if (hidden > 0 && filter)
    return t(
      `Der Filter verbirgt ${n} – ${clearKey()} zeigt alle.`,
      `The filter hides ${en}: ${clearKey()} shows all.`,
    );
  if (hidden > 0) return t(`Die Suche verbirgt ${n}.`, `The search hides ${en}.`);
  return t(
    "Nichts zu tun – keine Session wartet auf dich, nichts ist fehlgeschlagen, keine CI ist rot.",
    "Nothing to do: no session waits for you, nothing failed, no CI is red.",
  );
}

/** Sessions a status filter leaves on "Now" (alarm zone and board): the event stream follows the same filter. */
export function filteredIds(ib: Inbox, decisions: Decision[], filter: StatusFilter | null): Set<string> | null {
  if (!filter) return null;
  const ids = [...ib.needs, ...ib.errors, ...ib.working, ...ib.done, ...ib.resting].map((s) => s.id);
  if (filter === "needs") ids.push(...decisions.map((d) => d.sessionId));
  return new Set(ids);
}

/** When the next of Fleet's open questions runs out, so the dashboard asks for the overview right then; null without. */
export function nextExpiry(decisions: Decision[], now: number): number | null {
  const open = decisions.filter((d) => d.status === "open");
  // One that already ran out: ask again past the server's one-second cache, so the new question comes in at once.
  if (open.some((d) => d.expiresAt <= now)) return now + 1100;
  const ends = open.map((d) => d.expiresAt);
  return ends.length ? Math.min(...ends) : null;
}

/**
 * The header's counters: what the alarm zone shows without filter and search, so a muted alarm leaves the count as
 * it leaves the zone (round 6: "CI 3" stayed after muting one; a hidden session already left both).
 */
/**
 * The inbox with muted alarms left out, for every count beside the header: the tab title and the repo bar say what
 * the header says (round 7: header ?6, tab "(7)", repo bar ?1 after a mute).
 */
export function loudInbox(data: Overview, muted: Record<string, number>, now: number): Inbox {
  const ib = inbox(data, now);
  const v = applyView(ib, ib.decisions, null, muted, now);
  return { ...v.ib, decisions: v.decisions, counts: headerCounts(data, muted, now) };
}

export function headerCounts(data: Overview, muted: Record<string, number>, now: number): Inbox["counts"] {
  const ib = inbox(data, now);
  const open = (data.decisions || []).filter((d) => d.status === "open");
  const v = applyView(ib, open, null, muted, now);
  return {
    needs: v.ib.needs.length + v.decisions.length,
    errors: v.ib.errors.length,
    ciRed: v.ib.ciRed.length,
    working: ib.counts.working,
    done: ib.counts.done,
  };
}
