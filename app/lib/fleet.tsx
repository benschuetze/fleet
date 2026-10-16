import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { JobResult, OpenTarget, Overview, Repo, Session } from "../../shared/types";
import { LANG_CHANGED } from "./i18n";
import { watchPresence } from "./presence";
import { load, save } from "./store";
import { subscribe } from "./stream";
import { jobDone } from "./terminal";
import { focusTile } from "./tiles";
import { nextExpiry } from "./view";

/**
 * The dashboard's data: /api/overview with an ETag, refreshed on every push from the server (server-sent
 * events, the hooks write state files and the server watches them) and by polling as a fallback. Plus the
 * small per-browser preferences and the last action's result for the status line.
 */

export interface Prefs {
  openTarget: string;
  notify: boolean;
  inactive: boolean;
}

interface FleetCtx {
  data: Overview | null;
  offline: boolean;
  /** The server answered 401: this browser has no token cookie yet (server/http/token.ts). */
  unpaired: boolean;
  /** Load now; `fresh` drops the ETag so the server answers in full. */
  reload: (fresh?: boolean) => void;
  sessionById: Map<string, Session>;
  repoByRoot: Map<string, Repo>;
  query: string;
  setQuery: (q: string) => void;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
  /** Targets that work on this machine, the preferred one first. */
  targets: OpenTarget[];
  preferred: OpenTarget | null;
  /** The last action and its result; stays in the status line until the next one. */
  toast: string;
  toastAt: number;
  /** The result is a hint (a key found nothing to act on): the status line drops it at the next key or focus change. */
  toastHint: boolean;
  showToast: (msg: string, hint?: boolean) => void;
  /** The one terminal attached in the drawer (the browser allows only six connections per host). */
  drawer: Drawer | null;
  openDrawer: (d: Drawer) => void;
  closeDrawer: () => void;
  /**
   * Focus back to where the drawer was opened from; the drawer stays open. Returns that element: under 100 columns
   * its tile stands behind the drawer, and the caller brings it forward.
   */
  leaveDrawer: () => HTMLElement | null;
  /** A job started from this page: its result goes to the status line once it is done. */
  watchJob: (id: string, label: (r: JobResult) => string) => void;
}

/**
 * What the drawer on the right shows (spec, Grundaufbau: L3): the terminal of a Fleet session, a session's
 * details, or a repo (architecture, sessions, PRs, usage, tools). One at a time.
 */
export type Drawer =
  | TermDrawer
  | SessionDrawer
  | RepoDrawer
  | ConflictDrawer
  | HandoffDrawer
  | DecisionDrawer
  | CiDrawer;

/** A pipeline of the alarm zone: its jobs, failed tests, the log excerpt and every action (stage 12.6). */
export interface CiDrawer {
  kind: "ci";
  /** The card's key (`CiCard.key`, shared/inbox.ts). */
  id: string;
  title: string;
}

/** Fleet's own question (a paused loop, a forwarded approval) with every answer it offers. */
export interface DecisionDrawer {
  kind: "decision";
  /** The decision's id. */
  id: string;
  title: string;
}

/** A handoff nobody continues yet (its row on the board): next steps, open points, where to continue. */
export interface HandoffDrawer {
  kind: "handoff";
  root: string;
  /** The repo's name. */
  title: string;
}

export interface TermDrawer {
  kind?: "term";
  /** Process id (the session id of a Fleet session). */
  id: string;
  title: string;
  /** The session may still run elsewhere: the drawer asks before continuing here. */
  confirm?: { session: string; text: string } | null;
  /** The terminal takes the keys as it opens (release 6: jumped into with `i`, or just started). */
  focus?: boolean;
}
export interface SessionDrawer {
  kind: "session";
  id: string;
  title: string;
  /** Opened by a click on another row: that row keeps the focus (round 7). */
  keep?: boolean;
}
export type RepoTab = "arch" | "sessions" | "prs" | "usage" | "tools";
export interface RepoDrawer {
  kind: "repo";
  /** The repo's name in the repo bar (shared/repobar.ts). */
  name: string;
  title: string;
  tab?: RepoTab;
}
/** Two sessions or PRs of one repo side by side (spec, Konflikt-Visualisierung). */
export interface ConflictDrawer {
  kind: "conflict";
  root: string;
  /** `s:<session id>` or `pr:<number>`. */
  a: string;
  b: string;
  title: string;
  /** Opened from a duplicate on the board: the group (its sessions, merging them) stands on top. */
  dup?: boolean;
}

const Ctx = createContext<FleetCtx | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Overview | null>(null);
  const [offline, setOffline] = useState(false);
  const [unpaired, setUnpaired] = useState(false);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<Prefs>(() => ({
    openTarget: load<string>("openTarget") || "",
    notify: !!load<boolean>("notify"),
    inactive: !!load<boolean>("inactive"),
  }));
  const [toast, setToast] = useState("");
  const [toastAt, setToastAt] = useState(0);
  const [toastHint, setToastHint] = useState(false);
  const etag = useRef("");
  const loading = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dataRef = useRef<Overview | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const showToast = useCallback((msg: string, hint = false) => {
    setToast(msg);
    setToastHint(hint);
    setToastAt(Date.now());
  }, []);

  const [drawer, setDrawer] = useState<Drawer | null>(null);
  // Focus goes back where the drawer was opened from (WCAG 2.4.3).
  const opener = useRef<HTMLElement | null>(null);
  const openDrawer = useCallback((d: Drawer) => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && !a.closest(".drawer")) opener.current = a;
    setDrawer(d);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawer(null);
    const back = opener.current;
    setTimeout(() => {
      // Only when the focus went down with the drawer: one already moved on (a key, the command line) stays.
      const now = document.activeElement;
      if (now && now !== document.body && now.isConnected) return;
      // Where it was opened from, if that is in sight; else into the watch board (spec rule 10).
      if (back?.isConnected && back.getClientRects().length) back.focus();
      else focusTile("board");
    }, 0);
  }, []);
  const leaveDrawer = useCallback(() => {
    const back = opener.current?.isConnected ? opener.current : null;
    back?.focus();
    return back;
  }, []);
  const jobs = useRef(new Map<string, (r: JobResult) => string>());
  const watchJob = useCallback((id: string, label: (r: JobResult) => string) => {
    jobs.current.set(id, label);
  }, []);
  useEffect(() => {
    for (const [id, label] of jobs.current) {
      const r = jobDone(data?.processes, id);
      if (!r) continue;
      jobs.current.delete(id);
      showToast(label(r));
    }
  }, [data, showToast]);

  const load_ = useCallback(async (fresh = false) => {
    if (fresh) etag.current = "";
    if (loading.current) {
      again.current = true;
      return;
    }
    loading.current = true;
    clearTimeout(timer.current);
    try {
      const res = await fetch("/api/overview", {
        cache: "no-store",
        headers: etag.current ? { "If-None-Match": etag.current } : {},
      });
      if (res.status !== 304) {
        setUnpaired(res.status === 401);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as Overview;
        etag.current = res.headers.get("ETag") || "";
        notifyChanges(dataRef.current, d, prefsRef.current.notify);
        dataRef.current = d;
        setData(d);
      }
      setOffline(false);
    } catch {
      etag.current = "";
      setOffline(true);
    } finally {
      loading.current = false;
      const base = (dataRef.current?.refreshSeconds || 5) * 1000;
      // In the background poll rarely, unless notifications are on.
      const every = document.hidden && !prefsRef.current.notify ? Math.max(base, 60e3) : base;
      // A question of Fleet's that runs out is asked for again at once, not one refresh later (round 5).
      const end = nextExpiry(dataRef.current?.decisions || [], Date.now());
      timer.current = setTimeout(() => load_(), end === null ? every : Math.min(every, end - Date.now() + 300));
      if (again.current) {
        again.current = false;
        load_();
      }
    }
  }, []);

  useEffect(() => {
    load_();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => load_(), 100);
    });
    const vis = () => {
      if (!document.hidden) load_();
    };
    document.addEventListener("visibilitychange", vis);
    const lang = () => load_(true);
    window.addEventListener(LANG_CHANGED, lang);
    const unwatch = watchPresence();
    return () => {
      unwatch();
      unsubscribe();
      clearTimeout(debounce);
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener(LANG_CHANGED, lang);
    };
  }, [load_]);

  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    save(k, v);
    setPrefs((p) => ({ ...p, [k]: v }));
  }, []);

  const value = useMemo<FleetCtx>(() => {
    const targets = (data?.openTargets || []).filter((t) => t.ok);
    return {
      data,
      offline,
      unpaired,
      reload: load_,
      sessionById: new Map((data?.sessions || []).map((s) => [s.id, s])),
      repoByRoot: new Map((data?.repos || []).map((r) => [r.root, r])),
      query,
      setQuery,
      prefs,
      setPref,
      targets,
      preferred: targets.find((t) => t.id === prefs.openTarget) || targets[0] || null,
      toast,
      toastAt,
      toastHint,
      showToast,
      drawer,
      openDrawer,
      closeDrawer,
      leaveDrawer,
      watchJob,
    };
  }, [
    data,
    offline,
    unpaired,
    load_,
    query,
    prefs,
    setPref,
    toast,
    toastAt,
    toastHint,
    showToast,
    drawer,
    openDrawer,
    closeDrawer,
    leaveDrawer,
    watchJob,
  ]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFleet(): FleetCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFleet outside FleetProvider");
  return v;
}

/** Browser notifications when a session needs you, finished or failed. Decisions announce themselves too. */
const seenDecisions = new Set<string>();
function notifyChanges(before: Overview | null, after: Overview, on: boolean) {
  if (!on || !("Notification" in window) || Notification.permission !== "granted" || !before) {
    for (const d of after.decisions) seenDecisions.add(d.id);
    return;
  }
  const de = after.language === "de";
  const prev = new Map(before.sessions.map((s) => [s.id, s.status]));
  const send = (title: string, body: string, tag: string) => {
    try {
      new Notification(title, { body: body.slice(0, 200), tag });
    } catch {
      // e.g. Safari without permission
    }
  };
  for (const s of after.sessions) {
    const was = prev.get(s.id);
    if (!was || was === s.status || s.meta?.hidden) continue;
    if (s.status === "needs_input")
      send(`${s.project}: ${de ? "wartet auf dich" : "waits for you"}`, s.detail || String(s.title || ""), s.id);
    else if (s.status === "waiting" && ["working", "stale", "needs_input"].includes(String(was)))
      send(`${s.project}: ${de ? "fertig" : "done"}`, s.lastAssistant || String(s.title || ""), s.id);
    else if (s.status === "error" || s.status === "stale")
      send(`${s.project}: ${de ? "Fehler" : "error"}`, s.detail || String(s.title || ""), s.id);
  }
  for (const d of after.decisions) {
    if (d.status !== "open" || seenDecisions.has(d.id)) continue;
    seenDecisions.add(d.id);
    try {
      const n = new Notification(
        d.kind === "permission"
          ? `${d.project}: ${de ? "braucht eine Freigabe" : "needs an approval"}`
          : `${d.project}: ${de ? "Fleet hat angehalten" : "Fleet paused"}`,
        {
          body: (d.kind === "permission" ? `${d.title}: ${d.text}` : d.title).slice(0, 180),
          tag: `d-${d.id}`,
          requireInteraction: true,
        },
      );
      n.onclick = () => {
        window.focus();
        document.getElementById("decision")?.scrollIntoView({ block: "center" });
        n.close();
      };
    } catch {
      // no permission
    }
  }
}
