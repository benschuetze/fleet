import fs from "node:fs";
import path from "node:path";
import { dateTime } from "../../shared/dates";
import { repoKey, repoName } from "../../shared/repo";
import { nowForStream } from "../../shared/stream";
import type {
  Config,
  Decision,
  FleetEvent,
  GitInfo,
  Overview,
  Proc,
  Repo,
  Session,
  TerminalState,
} from "../../shared/types";
import { awaitingStart, freshPending, readConfig as handoffConfig, readHandoff, successors } from "../handoff";
import { advise, handoffPrompt } from "./advisor";
import * as brake from "./brake";
import { cacheState } from "./cache";
import { type CcProc, readClaudeProcs, stickyGone } from "./ccprocs";
import { compatWarning } from "./compat";
import { editedRelative, prConflicts, withConflicts } from "./conflict";
import * as desktop from "./desktop";
import * as git from "./git";
import { addHookOnly, findDuplicates, groupProjects, httpsUrl, markConflicts, str } from "./groups";
import { readHere } from "./here";
import { lang, locale, tr } from "./lang";
import * as launch from "./launch";
import { DEMO_PROJECTS, projectsDir } from "./newfolder";
import { fleetHome } from "./paths";
import { hookWarning } from "./pinhook";
import { attachProcs, updateWarning } from "./procs";
import * as providers from "./providers";
import { resultFor } from "./result";
import { scanSessions } from "./sessions";
import * as state from "./state";
import { contextFor, deriveStatus, waitsFor } from "./status";
import { swr } from "./swr";
import { buildTimeline } from "./timeline";
import { collectUsage, priceFor, type UsageData } from "./usage";

/**
 * Builds the overview for /api/overview: transcripts, hook states, agent view, git, PR/CI and usage are merged
 * per session and a status is derived. The sources are replaceable so tests and the demo mode work without a
 * real ~/.claude.
 */

// Usage is recomputed at most every 10 s (files are read incrementally anyway) and never awaited after the first
// time: a status change must not wait for a usage scan. A newer number simply comes with the next build.
const usageCached = swr(
  10e3,
  (_key: string, cfg: Config) =>
    collectUsage(cfg).catch((e: Error): UsageData => {
      console.error("[fleet] usage:", e.message);
      return { usage: null, perSession: {}, statusline: {} };
    }),
  { announce: false, max: 8 },
);
const usageData = (cfg: Config): Promise<UsageData> => usageCached(`${cfg.claudeHome}\u0000${cfg._fleetHome}`, cfg);

/** Real data sources; tests and the demo mode replace some of them. */
export const realSources = {
  readHookStates: state.readHookStates,
  scanSessions,
  readEvents: state.readEvents,
  usageData,
  getAgents: state.getAgents,
  readMeta: state.readMeta,
  repoRoot: (dir: string): Promise<string | null> => git.repoRoot(dir),
  gitInfo: git.gitInfo,
  ciFor: providers.get,
  prsFor: providers.openPrs,
  /** Probe merges between a repo's open PRs (key: the repo, root: the checkout to ask). */
  prConflicts,
  handoffFor: readHandoff,
  desktop: (): desktop.DesktopData => desktop.readDesktop(),
  /** Claude Code's own status of its running sessions (ccprocs.ts). */
  claudeProcs: (cfg: Pick<Config, "claudeHome">, gone?: Set<string>, living?: Set<string>): Map<string, CcProc> =>
    readClaudeProcs(cfg.claudeHome, undefined, gone, living),
  decisions: (): Decision[] => brake.list(),
  /** Fleet's own processes and whether its terminal works here; the server passes its process manager. */
  processes: (): Proc[] => [],
  terminal: (): TerminalState => ({ available: false, max: 0 }),
  result: resultFor as (
    root: string,
    shas: string[],
    times?: number[],
  ) => Promise<{ commits: number; last: string | null; files: number; add: number; del: number } | null>,
};
export type Sources = typeof realSources;

/**
 * Files each session edited, relative to its repo, for the conflict drawer. They stay on the server (the overview
 * strips them before it goes out) and live as long as the overview they belong to.
 */
export const editedFiles = new WeakMap<Overview, Map<string, string[]>>();
/** Files a session edited outside its repo (absolute), for the files view of release 6; also only on the server. */
export const editedOutside = new WeakMap<Overview, Map<string, string[]>>();

/** Absolute paths each session edited outside its repo root (memory notes, a sibling folder). */
function outsideOf(sessions: Session[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of sessions) {
    const root = s.repoRoot || s.cwd;
    if (!s.edited?.length) continue;
    const far = s.edited.filter((f) => path.isAbsolute(f) && (!root || path.relative(root, f).startsWith("..")));
    if (far.length) out.set(s.id, [...new Set(far)].slice(0, 100));
  }
  return out;
}

/** A new session could not be opened: show it instead of letting the user wonder. */
function launchWarning(now: number): string | null {
  try {
    const lines = fs.readFileSync(path.join(fleetHome(), "launch.log"), "utf8").trim().split("\n").slice(-10);
    const bad = lines.filter((l) => / (FEHLER|ERROR) /.test(l) && now - Date.parse(l.slice(0, 24)) < 15 * 60e3);
    const last = bad[bad.length - 1];
    if (!last) return null;
    return tr(
      `Eine neue Session ließ sich nicht öffnen (${last.split(" – ")[1] || "unbekannter Fehler"}). Die Übergabe liegt bereit, unter „Bereit zum Weitermachen“.`,
      `A new session could not be opened (${last.split(" – ")[1] || "unknown error"}). The handoff is ready under "Ready to continue".`,
    );
  } catch {
    return null;
  }
}

/**
 * One PR, one place: only the youngest visible session of a PR keeps its PR and CI state (badge, merge button,
 * red card); older sessions that once worked on the same PR (also in other worktrees) carry nothing of it.
 */
export function onePrSignal(sessions: Session[]): void {
  const keep = new Map<string, Session>();
  const key = (s: Session) =>
    s.ci?.pr && s.remote
      ? `${s.remote.host}/${s.remote.path}#${s.ci.pr.number}`
      : s.ci?.pr
        ? `${s.repoRoot}#${s.ci.pr.number}`
        : null;
  for (const s of sessions) {
    const k = key(s);
    if (!k || s.meta?.hidden) continue;
    const cur = keep.get(k);
    if (!cur || (s.lastActivity || 0) > (cur.lastActivity || 0)) keep.set(k, s);
  }
  for (const s of sessions) {
    const k = key(s);
    if (k && keep.has(k) && keep.get(k) !== s) s.ci = null;
  }
}

export async function buildOverview(
  cfg: Config,
  { version, sources = {}, demo = false }: { version: string; sources?: Partial<Sources>; demo?: boolean },
): Promise<Overview> {
  const src = { ...realSources, ...sources };
  let dsk: desktop.DesktopData = { byCli: new Map(), successor: new Map() };
  try {
    dsk = src.desktop();
  } catch {
    // desktop data is optional
  }
  // Terminal sessions are unknown to the app: there the handoff that was passed on names the successor.
  const handedTo = demo ? new Map<string, string>() : successors();
  const awaiting = demo ? new Set<string>() : awaitingStart();
  const now = Date.now();
  const meta = src.readMeta(cfg).sessions;
  const [hooks, scanned, events, use] = await Promise.all([
    src.readHookStates(cfg),
    src.scanSessions(cfg),
    src.readEvents(cfg, 3000),
    src.usageData(cfg),
  ]);
  const agents = src.getAgents(cfg);
  const warnings = [...cfg._warnings];

  const sessions: Session[] = scanned.map((t) => ({ ...t, source: "local" as const }));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  addHookOnly(sessions, byId, hooks, now);
  const procs = src.processes();
  attachProcs(sessions, byId, hooks, procs);
  const terminal = src.terminal();
  // Background and remote agents from the agent view.
  for (const a of agents.list) {
    if (!a.sessionId) continue;
    const s = byId.get(a.sessionId);
    if (s) {
      s.agent = a;
      if (a.name && !s.title) s.title = a.name;
    } else {
      const n: Session = { id: a.sessionId, source: "agent-view", cwd: a.cwd, title: a.name, mtime: 0, agent: a };
      sessions.push(n);
      byId.set(n.id, n);
    }
  }
  const gone = new Set<string>();
  const living = new Set<string>();
  const cc = src.claudeProcs(cfg, gone, living);
  for (const sid of cc.keys()) living.add(sid);
  stickyGone(path.join(cfg._fleetHome, "gone.json"), gone, living, (sid) => hooks[sid]?.at || 0, now);
  for (const s of sessions) {
    s.hook = hooks[s.id] || null;
    s.cc = cc.get(s.id) || null;
    if (gone.has(s.id)) s.ccGone = true;
    // Live activity: the hook is newer than the transcript.
    if (s.hook && typeof s.hook.lastTool === "string" && s.hook.lastTool && (s.hook.at || 0) >= (s.lastTimestamp || 0))
      s.lastTool = s.hook.lastTool.slice(0, 120);
    deriveStatus(s, cfg, now);
    const waits = waitsFor(s);
    if (waits) s.waits = waits;
    else delete s.waits;
    s.meta = state.shownMeta(meta[s.id], s.lastActivity);
  }
  // Manually maintained cloud sessions.
  cfg.cloudSessions.forEach((c, i) => {
    const id = `cloud-${i}`;
    sessions.push({
      id,
      source: "cloud",
      title: str(c.title, 200) || httpsUrl(c.url) || tr("Cloud-Session", "Cloud session"),
      url: httpsUrl(c.url),
      status: "cloud",
      gitBranch: git.validBranch(c.branch) ? c.branch : null,
      remote: git.parseRemote(c.repo, cfg.hostMap),
      lastActivity: 0,
      meta: meta[id] || {},
    });
  });

  const hidden = cfg.hiddenProjects.map((h) => h.toLowerCase());
  const visible = sessions.filter((s) => !(s.cwd && hidden.some((h) => s.cwd?.toLowerCase().includes(h))));
  // Projects: desktop app groups. Their sessions often start in the parent folder and work in several repos
  // below; so the repos come from all working folders, not only the last one.
  for (const s of visible) s.group = dsk.byCli.get(s.id.toLowerCase())?.group || null;

  const dirs = [
    ...new Set(
      visible
        .map((s) => s.cwd)
        .filter((c): c is string => !!c)
        .concat(
          cfg.extraRepos,
          visible.flatMap((s) => s.dirs || []),
        ),
    ),
  ];
  const roots = new Map(
    await Promise.all(dirs.map(async (d) => [d, await src.repoRoot(d).catch(() => null)] as const)),
  );
  const rootSet = new Set([...roots.values()].filter((r): r is string => !!r));
  const repoList: Repo[] = (await Promise.all([...rootSet].map((r) => src.gitInfo(r, cfg).catch(() => null))))
    .filter((r): r is GitInfo => !!r)
    .map((r) => ({ ...r, sessions: [] }));
  const repos = new Map<string, Repo>(repoList.map((r) => [r.root, r]));

  for (const s of visible) {
    if (s.source === "cowork") {
      s.project = "Cowork";
      s.branch = null;
    } else if (s.source !== "cloud") {
      s.repoRoot =
        (s.cwd ? roots.get(s.cwd) : null) ||
        (s.dirs || [])
          .map((d) => roots.get(d))
          .filter(Boolean)
          .pop() ||
        null;
      const repo = s.repoRoot ? repos.get(s.repoRoot) : null;
      s.project = repo ? repo.name : s.cwd ? path.basename(s.cwd) : "—";
      s.remote = repo ? repo.remote : null;
      // Branch: the checked-out branch for running sessions, else the last one in the transcript.
      s.branch =
        ["working", "stale", "needs_input", "waiting"].includes(String(s.status)) &&
        repo?.branch &&
        repo.branch !== "HEAD"
          ? repo.branch
          : s.gitBranch || repo?.branch;
    } else {
      s.project = s.remote ? s.remote.repo : "Cloud";
      s.branch = s.gitBranch;
    }
    s.ci = s.remote && s.branch ? src.ciFor(s.remote, s.branch, cfg) : null;
    // Desktop app: which app session the CLI session belongs to, and where it continues.
    const d = dsk.byCli.get(s.id.toLowerCase());
    if (d)
      s.desktop = {
        id: d.desktopId,
        title: d.title,
        current: d.cliSessionId === s.id.toLowerCase(),
        ...(d.archived ? { archived: true } : {}),
      };
    const nx = dsk.successor.get(s.id.toLowerCase()) || handedTo.get(s.id);
    if (nx) s.next = { id: nx, title: byId.get(nx)?.title || d?.title || null };
    // Not on the PR branch anymore (merged, back on main): the app still knows the PR.
    if (d && s.remote && !s.ci?.pr) {
      const p = desktop.prFor(d.prs, s.remote, s.branch);
      if (p) {
        const live = p.branch && p.branch !== s.branch ? src.ciFor(s.remote, p.branch, cfg) : null;
        s.ci = live?.pr
          ? live
          : {
              ...(s.ci || {}),
              pr: { number: p.number, title: "", url: p.url, state: p.state, review: null, ci: "none" },
              prSource: "desktop",
            };
      }
    }
    s.title =
      s.title ||
      s.summary ||
      s.firstPrompt ||
      (s.source === "agent-view" ? tr("Hintergrund-Agent", "Background agent") : tr("Neue Session", "New session"));
    // Usage and context window.
    const u = use.perSession[s.id];
    s.usage = u
      ? {
          cost: u.cost,
          tok: u.tok,
          cr: u.cr,
          sub: u.sub,
          cacheRate: u.cacheRate ?? null,
          rebuilds: u.rebuilds || 0,
          rebuildCost: u.rebuildCost || 0,
        }
      : null;
    const sl = use.statusline[s.id];
    const hc = s.hook?.ctx; // Cowork plugin
    if (sl?.context?.size && (!s.ctx?.at || sl.at >= s.ctx.at - 5000)) {
      s.context = {
        tokens: sl.context.tokens || 0,
        size: sl.context.size,
        pct: sl.context.pct || 0,
        src: "statusline",
      };
    } else if (s.ctx || hc) {
      s.context = { ...contextFor(s.ctx?.tokens || hc?.tokens || 0, s.model, cfg, hc?.size), src: "transcript" };
    } else s.context = null;
    // The advisor needs the raw token numbers; only the recommendations reach the dashboard.
    s.advice =
      s.source === "local" || s.source === "demo"
        ? advise({
            model: s.model,
            stats: s.stats,
            usage: u,
            context: s.context,
            compactions: s.compactions,
            loop: s.loop,
          })
        : [];
    // Cache countdown only where it decides something: the session waits for you.
    s.cache =
      (s.status === "waiting" || s.status === "needs_input") && !s.next && s.ctx?.at
        ? cacheState({ ttl: s.cacheTtl, at: s.ctx.at, tokens: s.context?.tokens || s.ctx.tokens, model: s.model })
        : null;
    // Starting fresh pays off once every call re-reads a lot of context (same threshold as the automatic handoff).
    if (s.source === "local" || s.source === "demo") {
      const mark = demo ? null : freshPending(s.id);
      const big = !!s.context && s.context.tokens >= handoffConfig().clearMinTokens;
      // Only for sessions being worked with; a resting one only costs when it is resumed.
      const live =
        ["working", "stale", "needs_input", "waiting"].includes(String(s.status)) && !s.next && !awaiting.has(s.id);
      if ((big && live) || mark)
        s.fresh = {
          pending: !!mark,
          target: mark ? mark.target : null,
          perCall: s.context ? Math.round((s.context.tokens * priceFor(s.model).cr) / 1e4) / 100 : 0,
        };
    }
    // Trail of the last tool calls for the tile (errors marked).
    s.trail = (s.recent || []).slice(-10).map((r) => ({ tool: r.tool, err: r.err }));
    s.repoRoots = [
      ...new Set([s.repoRoot, ...(s.dirs || []).map((d) => roots.get(d))].filter((r): r is string => !!r)),
    ];
  }
  // Result line for finished sessions (git runs in parallel, cached per repo, start and HEAD). A session can
  // commit in several repos: ask each repo for its own commits.
  await Promise.all(
    visible
      // A finished answer that ends with a question has a result as well.
      .filter((s) => (s.status === "waiting" || s.status === "needs_input") && !s.next && s.repoRoot)
      .map(async (s) => {
        const parts = (
          await Promise.all(
            (s.repoRoots || []).map((r) => src.result(r, s.commits || [], s.commitAt || []).catch(() => null)),
          )
        ).filter((x) => !!x);
        const g = parts.length
          ? parts.reduce((a, b) => ({
              commits: a.commits + b.commits,
              last: b.last || a.last,
              files: a.files + b.files,
              add: a.add + b.add,
              del: a.del + b.del,
            }))
          : null;
        const t = s.testRun && s.testRun.ok !== null ? { cmd: s.testRun.cmd, ok: s.testRun.ok } : null;
        if (g || t) s.result = { ...(g || { commits: 0, last: null, files: 0, add: 0, del: 0 }), test: t };
      }),
  );
  onePrSignal(visible);
  markConflicts(visible, now);
  for (const r of repoList) {
    r.ci = r.remote && r.branch && r.branch !== "HEAD" ? src.ciFor(r.remote, r.branch, cfg) : null;
    r.prs = src.prsFor(r.remote, cfg);
    if (r.prs?.prs?.length)
      r.prs = withConflicts(
        r.prs,
        src.prConflicts(r.remote ? `${r.remote.host}/${r.remote.path}` : r.root, r.root, r.prs.prs),
      );
    r.sessions = visible.filter((s) => s.repoRoot === r.root).map((s) => s.id);
    // Handoff of the last 7 days: what to do next in this repo.
    const h = src.handoffFor(r.root);
    r.handoff = h && now - h.at < 7 * 86400e3 ? h : null;
  }
  // Before the start time is appended to equal titles: the same task is a reason for "duplicate".
  const duplicates = findDuplicates(visible, repos, now, awaiting);
  // Same titles in the same project: append the start time, otherwise two identical rows stand there.
  const sameTitle = new Map<string, Session[]>();
  for (const s of visible) {
    const k = `${s.project}\u0000${s.title}`;
    sameTitle.set(k, [...(sameTitle.get(k) || []), s]);
  }
  for (const list of sameTitle.values()) {
    if (list.length < 2) continue;
    for (const s of list) {
      const at = s.startedAt ? dateTime(s.startedAt, locale()) : s.id.slice(0, 6);
      s.title = `${s.title} · ${at}`;
    }
  }
  const projects = groupProjects(visible, repos);

  // Brake: decisions with project and session title (only known, visible sessions).
  let decisions: Decision[] = [];
  try {
    decisions = src.decisions();
  } catch {
    // no decisions
  }
  const visibleIds = new Set(visible.map((s) => s.id));
  decisions = decisions
    .filter((d) => visibleIds.has(d.sessionId))
    .map((d) => {
      const s = byId.get(d.sessionId);
      return { ...d, cwd: "", project: s?.project || "—", sessionTitle: String(s?.title || "") };
    });

  if (!demo) {
    const w = launchWarning(now);
    if (w) warnings.push(w);
    const u = updateWarning(now);
    if (u) warnings.push(u);
    const h = hookWarning(now);
    if (h) warnings.push(h);
    const c = compatWarning();
    if (c) warnings.push(c);
  }
  if (!Object.keys(hooks).length) {
    warnings.push(
      tr(
        "Noch keine Hook-Daten – Status wird nur aus Transcripts geschätzt. Einmalig „node dist/fleet.cjs setup“ ausführen.",
        'No hook data yet: the status is only guessed from transcripts. Run "node dist/fleet.cjs setup" once.',
      ),
    );
  }
  if (agents.error && cfg.useAgentView)
    warnings.push(`${agents.error} ${tr("(optional, wird ignoriert)", "(optional, ignored)")}`);

  // Internal fields never reach the browser: paths of edited files, raw transcript state, hook data.
  const edited = editedRelative(visible);
  const outside = outsideOf(visible);
  for (const s of visible) {
    for (const k of [
      "hook",
      "file",
      "mtime",
      "gitBranch",
      "summary",
      "recent",
      "pending",
      "dirs",
      "repoRoots",
      "testRun",
      "commits",
      "commitCall",
      "commitAt",
      "edited",
      "ctx",
      "cacheTtl",
    ] as const)
      delete s[k];
  }
  const ah = handoffConfig();
  const nowNow = nowEvents(events, { sessions: visible, repos: repoList, decisions }, now);
  const out: Overview = {
    version,
    demo,
    language: lang(),
    handoffPrompt: handoffPrompt(),
    autoHandoff: { enabled: ah.enabled, limitPercent: ah.limitPercent, contextPercent: ah.contextPercent },
    platform: process.platform,
    // Where sessions can be opened; in demo mode all of them (nothing is started there).
    openTargets: demo
      ? launch.targets(
          {
            platform: process.platform,
            desktopApp: true,
            vscode: "demo",
            cursor: null,
            claude: "claude",
            wt: "wt",
            linuxTerminal: "x-terminal-emulator",
          },
          terminal,
        )
      : launch.targets(launch.detect(), terminal),
    refreshSeconds: cfg.refreshSeconds,
    configPath: cfg._path,
    sessions: visible,
    decisions,
    brake: { enabled: (demo ? brake.DEFAULTS : brake.readConfig()).enabled },
    usage: use.usage,
    repos: repoList,
    projects,
    duplicates,
    // The state Now shows is the newest line of the history too (round 6: the history said "waits" at 22:56, the
    // stream and the timeline from 23:35, when Fleet asked).
    events: [...nowNow, ...events].sort((a, b) => b.at - a.at).slice(0, 150),
    // One lane per repo. Sessions Fleet does not know (hidden, deleted, test runs) show no nameless lane; their
    // time stays in the totals.
    timeline: buildTimeline([...events, ...nowNow], {
      now,
      // Every repo of a busy day (round 4: the eleventh, analytics with an error, fell off at ten); the tile scrolls.
      maxLanes: 16,
      laneOf: (id) => {
        const s = byId.get(id);
        return s ? { key: repoKey(s), name: repoName(s) } : null;
      },
    }),
    warnings,
    // The working folder stays on the server; the root is what the dashboard knows anyway.
    processes: procs.map((p) => ({ ...p, cwd: p.root })),
    terminal,
    billing: cfg.billing,
    here: demo ? null : readHere(now),
    projectsDir: demo
      ? DEMO_PROJECTS
      : projectsDir(
          cfg.projectsDir,
          repoList.map((r) => r.root),
        ),
  };
  editedFiles.set(out, edited);
  editedOutside.set(out, outside);
  return out;
}

/**
 * The state Now shows, as one more event per session where it differs from its last hook event (round 4: mobile-app
 * waited for Fleet's question while its lane stood still; analytics' error, known only from its transcript, had no
 * lane). The stream ends the same way (shared/stream.ts).
 */
function nowEvents(events: FleetEvent[], o: Parameters<typeof nowForStream>[0], now: number): FleetEvent[] {
  const last = new Map<string, FleetEvent>();
  for (const e of events) {
    const l = last.get(e.sessionId);
    if (!l || e.at > l.at) last.set(e.sessionId, e);
  }
  const out: FleetEvent[] = [];
  for (const n of nowForStream(o)) {
    const status = n.status === "stale" ? "error" : n.status;
    const since = Number(n.statusSince);
    if ((status !== "needs_input" && status !== "error") || !Number.isFinite(since) || since > now) continue;
    const l = last.get(n.id);
    if (l?.status === status) continue;
    // A later hook event (the session ended) does not end the state Now shows: it goes on from there.
    // An error says why (round 7: "ERROR" beside crm-sync with no reason).
    const detail = status === "error" ? String(n.failure?.text || n.detail || "") : "";
    out.push({ at: l ? Math.max(since, l.at + 1) : since, sessionId: n.id, event: "Now", status, detail });
  }
  return out;
}
