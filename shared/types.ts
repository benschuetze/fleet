/**
 * Data shapes shared by the server, the hook and the dashboard. Everything that crosses a process
 * or network boundary is described here once.
 */

export type Status = "working" | "stale" | "needs_input" | "waiting" | "error" | "idle" | "ended";

export type Provider = "github" | "gitlab" | "azure" | "bitbucket";

export interface Config {
  port: number;
  host: string;
  claudeHome: string;
  sessionMaxAgeDays: number;
  refreshSeconds: number;
  prRefreshSeconds: number;
  staleMinutes: number;
  useAgentView: boolean;
  extraRepos: string[];
  hiddenProjects: string[];
  hostMap: Record<string, Provider>;
  tokens: Record<string, string>;
  cloudSessions: CloudSessionConfig[];
  statsDays: number;
  contextWindow: number;
  prices: Record<string, { input?: number; output?: number; cacheRead?: number }>;
  /** Claude in Fleet's own window (server/process): limits and the permission mode per repo root. */
  terminal: TerminalConfig;
  /** Pro/Max plan: the limit counts and dollars appear only on the usage page. API: dollars as before. */
  billing: Billing;
  /** Where `:new <name>` creates a project folder; empty = the folder most known repos live in. */
  projectsDir: string;
  /** Sessions in their own git worktree (server/core/worktree.ts). */
  worktree: WorktreeConfig;
  _warnings: string[];
  _path: string;
  _fleetHome: string;
}

export type Billing = "subscription" | "api";

export interface TerminalConfig {
  enabled: boolean;
  /** Interactive sessions at the same time. */
  maxSessions: number;
  /** Output kept per process for re-attaching, in KB. */
  scrollbackKb: number;
  /** `--permission-mode` per repo root; missing = Claude Code's default. */
  permissionMode: Record<string, string>;
}

export interface WorktreeConfig {
  /** "second": once a session works or waits in the main folder; "always"; "off": only with `:wt`. */
  auto: "second" | "always" | "off";
  /** `git fetch` before a worktree starts from origin's default branch. */
  fetch: boolean;
  /** Per repo root: a setup command run in the new worktree, and ignored files copied into it. */
  repos: Record<string, { setup: string; include: string[] }>;
}

export interface CloudSessionConfig {
  title?: unknown;
  url?: unknown;
  repo?: unknown;
  branch?: unknown;
}

export interface Remote {
  provider: Provider | "unknown";
  trusted: boolean;
  guess?: Provider | null;
  host: string;
  owner?: string;
  repo: string;
  path: string;
  webUrl: string;
  org?: string;
  project?: string;
}

export type CiState = "success" | "failure" | "running" | "pending" | "none";

export interface PullRequest {
  number: number | string;
  title: string;
  url: string | null;
  state: "open" | "draft" | "merged" | "closed";
  review: "approved" | "changes" | "pending" | null;
  ci: CiState;
}

export interface CiResult {
  pr?: PullRequest;
  ci?: { state: CiState; url?: string | null; name?: string; id?: number };
  error?: string;
  hint?: string;
  skipped?: boolean;
  loading?: boolean;
  retryAt?: number;
  fetchedAt?: number;
  /** PR known only from the desktop app (its snapshot, not queried live). */
  prSource?: "desktop";
}

export interface Todo {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

export type TurnState = "done" | "tool_pending" | "running" | "interrupted";

export interface SessionStats {
  prompts: number;
  promptChars: number;
  tools: number;
  edits: number;
  reads: number;
  shells: number;
  errors: number;
  subagents: number;
}

export interface LoopSignal {
  kind: "repeat" | "errors";
  tool: string;
  count: number;
}

/** What is read from one transcript. */
export interface TranscriptData {
  id: string;
  file: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  summary: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  lastTool: string | null;
  model: string | null;
  todos: Todo[] | null;
  startedAt: number | null;
  lastTimestamp: number | null;
  ctx: { tokens: number; at: number | null } | null;
  compactions: number;
  /** How the last turn ended; lets the status be guessed even without hooks. */
  turn?: TurnState | null;
  /** Ids of tool calls without a result yet (for `turn`). */
  pending?: string[];
  /** Signs of a stuck agent (same call in a loop, a run of errors). */
  loop?: LoopSignal | null;
  /** Last test run (a Bash command like pnpm test) and whether it passed; ok=null: still running. */
  testRun?: { id: string; cmd: string; ok: boolean | null; at: number | null } | null;
  /** Recently edited files (absolute paths). */
  edited?: string[];
  /** Commits the session made itself (from the output of git commit). */
  commits?: string[];
  commitCall?: string | null;
  /** Times of successful `git commit` calls without a visible id (git commit -q). */
  commitAt?: number[];
  /** Prompt cache lifetime of the last writing call. */
  cacheTtl?: "5m" | "1h" | null;
  /** Folders the session worked in (for projects across several repos). */
  dirs?: string[];
  /** The latest tool calls (for `loop`). */
  recent?: { id: string; sig: string; tool: string; err: boolean }[];
  /** Work profile for the efficiency advisor. */
  stats?: SessionStats;
  /** The last finished turn ends with a question or an approval request. */
  ask?: Ask | null;
  /** The Desktop app's question box (`wrap_up` with `ask`) of the current turn; held until the next prompt. */
  boxAsk?: Ask | null;
  /** A `start_session` offer card that waits for the user's pick (no tool_result yet). */
  offer?: { id: string; text: string } | null;
  /** A tool that waits in the app (AskUserQuestion, plan, folder, access) and its question, until its tool_result. */
  toolAsk?: { id: string; tool: string; text: string } | null;
  /** The question a turn of the user ended with, held through turns the app injects until the user's next prompt. */
  heldAsk?: Ask | null;
  /** The last turn broke off with an API error; cleared as soon as the session goes on. */
  failure?: Failure | null;
  mtime?: number;
}

/** A question or approval the last assistant turn ends with: then the session waits for you, it is not done. */
export interface Ask {
  kind: "question" | "approval";
  /** The asking sentence, at most 200 characters. */
  text: string;
}

/** Why a session stopped: the cause decides the one action that helps. */
export type FailureKind = "auth" | "limit" | "spend" | "api" | "stuck" | "crash";
export interface Failure {
  kind: FailureKind;
  /** The cause in one sentence, at most 200 characters. */
  text: string;
  at: number;
  /** kind=limit: when the limit frees up again (ms), as Claude Code reported it. */
  resetsAt?: number | null;
  /** kind=spend: where to raise the limit (only https://claude.ai/…). */
  url?: string | null;
}

export interface Advice {
  kind: "model" | "handoff" | "cache";
  level: "ok" | "info" | "warn";
  title: string;
  text: string;
  /** kind=model: suggested model and how to switch. */
  model?: string;
  how?: string;
  /** Estimated saving (positive) or extra cost (negative) in USD for this session. */
  saving?: number;
}

/** What hook.ts writes per session to ~/.claude-fleet/state. */
export interface HookState {
  sessionId: string;
  status: Status;
  event: string;
  detail: string;
  at: number;
  cwd?: string;
  startedAt: number;
  statusSince: number;
  lastPrompt?: string;
  lastTool?: string;
  source?: "cowork";
  url?: string;
  title?: string;
  lastAnswer?: string;
  /** The question of the Desktop app's box (`wrap_up` `ask`) in this turn, from PreToolUse until the next prompt. */
  boxAsk?: string;
  /** Title of a `start_session` offer card that blocks the turn, from its PreToolUse until the next event. */
  offer?: string;
  /** A tool that waits in the app (AskUserQuestion, plan, folder, access): its question, from PreToolUse through
   * the permission request and notification that may follow, until the next other event. */
  toolAsk?: string;
  /** The end of the last answer to the user's own turn, held through injected turns, compaction and resume until
   * the user's next prompt: its closing question still waits. */
  heldAnswer?: string;
  /** The current turn was started by a prompt the app injected. */
  injectedTurn?: boolean;
  /** Permission requests the app shows right now (only while `needs_input`): tool events of parallel calls and of
   * other subagents do not answer them, only their own result, the end of their turn or the user's next prompt. */
  waitFor?: WaitFor[];
  /** While `waitFor` holds the session at needs_input: the status the main thread would have without it. */
  underWait?: Status;
  model?: string;
  ctx?: { tokens: number; size: number };
  /** Fleet process that runs this session (CLAUDE_FLEET_PROC), the second link besides --session-id. */
  proc?: string;
}

/** One waiting permission request: its tool call (`id` when the hook saw its PreToolUse), tool and input as `key`,
 * and the subagent it runs in (`agent`, none for the main thread). */
export interface WaitFor {
  id?: string;
  key: string;
  agent?: string;
  since: number;
}

export interface FleetEvent {
  at: number;
  sessionId: string;
  event: string;
  status: Status;
  detail: string;
  cwd?: string;
  /** PermissionRequest: what it waits for, by its tool (an answer in words or a yes). Older lines lack it. */
  waits?: "approval" | "question";
}

export interface Agent {
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  status: Status;
  rawState: string | null;
  waitingFor: string | null;
}

export interface Meta {
  pinned?: boolean;
  hidden?: boolean;
  /** When it was hidden (ms): a session that works again after that shows again (release 6, server/core/state.ts). */
  hiddenAt?: number;
  note?: string;
}

export interface Handoff {
  file: string;
  at: number;
  trusted: boolean;
  /** Already handed to a new session or opened by Fleet in one. */
  delivered?: boolean;
  /** New session opened but not sent yet (the app only pre-fills the prompt). */
  opened?: { at: number; target: string | null } | null;
  /** Session that wrote the handoff. */
  session?: string | null;
  /** Written by Claude when asked, or built by Fleet from the transcript after a turn broke off. */
  origin?: "claude" | "emergency";
  reason: string | null;
  title: string;
  open: string[];
  next: string[];
  done: string[];
}

export interface GitInfo {
  root: string;
  name: string;
  branch: string | null;
  dirty: number | null;
  remote: Remote | null;
  lastCommit: { hash: string; at: number; subject: string } | null;
  behind: number | null;
  ahead: number | null;
  hasUpstream: boolean;
}

/** An open PR of a repo, for the PR list under "Repos & PRs" (GitHub only). */
export interface OpenPr {
  number: number;
  title: string;
  url: string | null;
  draft: boolean;
  base: string;
  head: string;
  ci: CiState;
  /** Names of the red checks, at most five. */
  failed: string[];
  review: PullRequest["review"];
  /** Targets the default branch; only then Fleet offers to merge. */
  onDefault: boolean;
  /** Builds on this open PR (its base is that PR's branch). */
  stackedOn: number | null;
  /** Number of commits; null when the host did not say. */
  commits?: number | null;
  /**
   * Other open PRs of the repo this one cannot be merged with cleanly (probe merge with `git merge-tree`, every
   * five minutes). Missing while nothing was probed yet (no local branch, git too old); an empty list is a clean
   * result.
   */
  conflicts?: PrConflict[];
}

export interface PrConflict {
  with: number;
  /** Files git cannot merge on its own, relative to the repo, at most five. */
  files: string[];
}

/** One side of the conflict drawer: a session (the files it edited) or an open PR (its branch against the base). */
export interface ConflictSide {
  kind: "session" | "pr";
  /** `s:<session id>` or `pr:<number>`, as the drawer asks for it. */
  ref: string;
  label: string;
  branch: string | null;
  /** Changed files relative to the repo, at most 300. */
  files: string[];
  status?: Session["status"];
}

/** What two sessions or PRs of one repo both change, and where git cannot merge them (server/core/conflict.ts). */
export interface ConflictView {
  root: string;
  repo: string;
  a: ConflictSide;
  b: ConflictSide;
  /** Files both sides changed. */
  shared: string[];
  /** Files with a real merge conflict; null when no probe merge was possible (see `why`). */
  conflicts: string[] | null;
  /** Why there was no probe merge, in one sentence. */
  why: string | null;
}

/** One file of the conflict drawer: each side's diff against the base, cut to a few hundred lines. */
export interface ConflictHunks {
  file: string;
  a: string | null;
  b: string | null;
  truncated: boolean;
}

export interface OpenPrs {
  prs?: OpenPr[];
  loading?: boolean;
  error?: string;
  fetchedAt?: number;
}

export interface Repo extends GitInfo {
  ci?: CiResult | null;
  prs?: OpenPrs | null;
  sessions: string[];
  handoff?: Handoff | null;
}

export interface SessionUsage {
  cost: number;
  tok: number;
  cr: number;
  sub: number;
  cacheRate?: number | null;
  rebuilds?: number;
  rebuildCost?: number;
}

/** A session as it reaches the dashboard. */
export interface Session extends Partial<Omit<TranscriptData, "ctx">> {
  id: string;
  source: "local" | "cowork" | "cloud" | "agent-view" | "demo";
  status?: Status | "cloud";
  statusSource?: "hook" | "transcript" | "agent-view" | "process" | "claude" | null;
  /** Claude Code's own status of the running process (server/core/ccprocs.ts); null when none runs. */
  cc?: { status: "idle" | "busy" | "waiting"; at: number; pid: number } | null;
  /** Claude Code's process for this session ended without a SessionEnd (its file names a dead pid). */
  ccGone?: boolean;
  statusSince?: number;
  detail?: string;
  /** While waiting: a tool call held for a yes, or an answer in words (server/core/status.ts waitsFor). */
  waits?: "approval" | "question";
  lastActivity?: number;
  url?: string | null;
  lastAnswer?: string | null;
  hook?: HookState | null;
  agent?: Agent;
  meta?: Meta;
  repoRoot?: string | null;
  project?: string;
  remote?: Remote | null;
  branch?: string | null;
  ci?: CiResult | null;
  usage?: SessionUsage | null;
  advice?: Advice[];
  trail?: { tool: string; err: boolean }[];
  context?: { tokens: number; size: number; pct: number; src: "statusline" | "transcript" } | null;
  ctx?: TranscriptData["ctx"];
  /** Matching desktop app session; current=false means a newer one runs there now; archived in the app's sidebar. */
  desktop?: { id: string; title: string | null; current: boolean; archived?: boolean };
  /** Starting fresh pays off: what each call costs right now, and whether it is already requested. */
  fresh?: { perCall: number; pending: boolean; target?: string | null };
  /** Successor after /clear, a fresh start or a handoff. */
  next?: { id: string; title: string | null };
  /** Prompt cache of a waiting session: until when it holds and what rebuilding costs. */
  cache?: { ttl: "5m" | "1h"; until: number; rebuild: number } | null;
  /** Result of a finished session: commits and changes since it started, last test run. */
  result?: SessionResult | null;
  /** Other active sessions in the same repo: same branch or same files. */
  conflict?: { with: { id: string; title: string }[]; sameBranch: boolean; files: string[] } | null;
  /** Group in the desktop app sidebar. */
  group?: { id: string; name: string } | null;
  repoRoots?: string[];
  /** The session runs in a Fleet process (terminal in the window or a headless job); only a projection, no pid. */
  proc?: SessionProc | null;
}

/** Claude started by Fleet itself: interactive in a pty (terminal in the drawer) or headless (Fleet's own jobs). */
export type ProcMode = "pty" | "headless";
export type ProcStatus = "starting" | "running" | "exited" | "failed" | "interrupted";
export type JobKind = "handoff" | "fresh";

/** What the end of the terminal output shows (server/process/screen.ts). */
export interface Screen {
  /** "busy": the spinner of a turn at work; "unknown": nothing recognised (an interface Fleet does not know). */
  kind: "approval" | "question" | "prompt" | "busy" | "unknown";
  /** Since when the screen shows this (ms). */
  at: number;
  /** The asking sentence for approval and question, at most 200 characters. */
  text: string;
}

export interface Proc {
  /** Session id (uuid): Fleet passes it with --session-id, or resumes it. */
  id: string;
  kind: "session" | "job";
  job?: JobKind | null;
  mode: ProcMode;
  /** Repo root from the overview, never from a request. */
  root: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  status: ProcStatus;
  screen?: Screen | null;
  lastOutputAt: number;
  lastInputAt: number;
  /** The last input was a lone Esc: it cancels an open approval or question without any hook event. */
  lastInputEsc?: boolean;
  /** Title for a session that has no transcript yet (the task it was started with). */
  title?: string | null;
  result?: JobResult | null;
}

export interface JobResult {
  ok: boolean;
  sessionId: string | null;
  durationMs: number | null;
  /** Exact numbers from the stream-json result; null when Claude Code did not report them, never estimated. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  costUsd: number | null;
  /** Clipped to 400 characters. */
  text: string;
  error?: string | null;
}

export type SessionProc = Pick<
  Proc,
  | "mode"
  | "status"
  | "screen"
  | "job"
  | "exitCode"
  | "endedAt"
  | "startedAt"
  | "lastOutputAt"
  | "lastInputAt"
  | "lastInputEsc"
>;

export interface SessionResult {
  commits: number;
  last: string | null;
  files: number;
  add: number;
  del: number;
  test: { cmd: string; ok: boolean | null } | null;
}

/** A desktop app group as a project: its sessions and the repos they worked in. */
export interface Project {
  id: string;
  name: string;
  sessions: string[];
  repos: string[];
  active: number;
  cost: number;
  lastActivity: number;
}

export interface UsageEntry {
  t: number;
  model: string;
  i: number;
  o: number;
  cw: number;
  cr: number;
  cw1h: number;
  side?: boolean;
  sid?: string;
  /** First answer after a compaction (legitimately writes the new context to the cache). */
  afterCompact?: boolean;
}

export type BrakeAnswer = "rethink" | "escalate" | "handoff" | "continue" | "stop" | "allow" | "allow-session" | "deny";

/** The brake: Fleet paused a session and asks in the dashboard (server/core/brake.ts). */
export interface Decision {
  id: string;
  sessionId: string;
  cwd: string;
  kind: "loop" | "limit" | "permission";
  /** Permission: rules Claude Code suggests for "always allow" (permission_suggestions). */
  suggestions?: unknown[];
  title: string;
  text: string;
  options: { id: BrakeAnswer; label: string; hint?: string }[];
  recommended: BrakeAnswer;
  createdAt: number;
  /** The session waits for the answer until then. */
  expiresAt: number;
  status: "open" | "answered" | "applied" | "expired";
  answer?: BrakeAnswer;
  answeredAt?: number;
  appliedAt?: number;
  /** For display, added by the overview. */
  project?: string;
  sessionTitle?: string;
}

export type LaneStatus = "working" | "needs_input" | "waiting" | "error";
export interface Lane {
  id: string;
  segments: { from: number; to: number; status: LaneStatus }[];
  work: number;
  attention: number;
  done: number;
  project?: string;
  title?: string;
  /** Lane per repo: how many sessions worked in it during the window. */
  sessions?: number;
}
export interface Timeline {
  from: number;
  to: number;
  lanes: Lane[];
  totals: { work: number; attention: number; done: number };
}

export interface UsageDay {
  day: string;
  cost: number;
  tok: number;
  byModel: Record<string, { cost: number; tok: number }>;
  byProject: Record<string, { cost: number; tok: number }>;
}

export interface UsageTotals {
  n: number;
  cost: number;
  tok: number;
  i: number;
  o: number;
  cw: number;
  cr: number;
  prompt: number;
  cacheRate?: number | null;
}

export interface LimitWindow {
  used_percentage: number;
  resets_at?: number;
}

export interface Usage {
  days: UsageDay[];
  totals: { today: UsageTotals; d7: UsageTotals; d30: UsageTotals };
  block: { start: number; end: number; first: number; tok: number; cost: number; burnPerMin: number } | null;
  live: { minutes: number; end: number; bySession: Record<string, { tok: number[]; cost: number[] }> };
  /** A limit hit Claude Code wrote to a transcript (the only certain limit signal without a status line). */
  limitHit: { kind: "five_hour" | "seven_day"; at: number; resetsAt: number } | null;
  /** Percentages only from the status line or the Cowork plugin; never estimated. */
  limits: { five_hour?: LimitWindow; seven_day?: LimitWindow; spend_limit?: LimitWindow; at?: number } | null;
  statsDays: number;
  hasData: boolean;
  priced: string;
  /** What Fleet cost and saved in the last seven days (server/core/balance.ts); null without data. */
  balance?: Balance | null;
  /** After a limit hit, sessions went on: what has run on extra usage since (realised calls only). */
  overage?: { since: number; tok: number; cost: number; n: number } | null;
}

/** Turns Fleet caused: the handoff it asked for, its headless job, the first turn of a session it started. */
export type FleetTurnKind = "handoff" | "job" | "continue" | "merge" | "fix" | "brief";

/** One line of ~/.claude-fleet/fleet-turns.jsonl: written by the hook (and the server for a job's handoff). */
export interface FleetTurnMark {
  phase: "begin" | "end";
  sessionId: string;
  kind: FleetTurnKind;
  at: number;
  /** begin of continue/merge: the sessions whose handoff this one received. */
  prev?: string[];
}

/** Tokens = everything a call reads and writes (input + cache write + cache read + output); cost in USD at list prices. */
export interface BalanceSum {
  tok: number;
  cost: number;
  n: number;
}

export interface Balance {
  days: number;
  /** Tokens of Fleet's own turns; byKind for the breakdown. */
  cost: BalanceSum & { byKind: Partial<Record<FleetTurnKind, BalanceSum>> };
  /** Estimates against a case that did not happen, from realised calls only. */
  saved: BalanceSum & {
    /** n = successors, calls = their realised calls. */
    fresh: BalanceSum & { calls: number };
    merge: BalanceSum & { calls: number };
    /** n = avoided full cache rewrites. */
    rebuild: BalanceSum;
  };
  net: { tok: number; cost: number };
  /** Tokens per local day, oldest first, without gaps; the same in dollars, plus the /compact comparison. */
  daily: {
    day: string;
    cost: number;
    saved: number;
    costUsd: number;
    savedUsd: number;
    /** What /compact at the same points would have cost (fresh starts whose successor began that day). */
    compactUsd: number;
    /** What writing Fleet's handoffs cost that day. */
    freshUsd: number;
  }[];
  /**
   * Fresh starts against /compact at the same point, in dollars: `compact` = the compaction calls, `fleet` = writing
   * the handoffs; `net` > 0 means Fleet was cheaper than compacting.
   */
  vsCompact: { n: number; compact: number; fleet: number; net: number };
  /** Successors whose predecessor is older than the usage window: no comparison, not counted. */
  unmatched: number;
  /** Rolling three-day balance negative with real Fleet activity; the alarm zone shows it. */
  alarm: { net: number; cost: number; since: string } | null;
  /** Jobs ran, but no hook mark exists: handoffs and first turns are missing from the count. */
  incomplete: boolean;
}

export type OpenTargetId = "fleet" | "desktop" | "vscode" | "cursor" | "terminal";
export interface OpenTarget {
  id: OpenTargetId;
  label: string;
  ok: boolean;
  why?: string;
}

export interface Duplicate {
  root: string;
  repo: string;
  busy: boolean;
  /** The strongest reason in the group: shared edited files, the same branch, or the same task title. */
  reason: "files" | "branch" | "title";
  /**
   * The sessions edited the same files: only then it is "Doppelt". Without (same branch or task, different files)
   * they run in parallel without overlap and show grey.
   */
  overlap: boolean;
  /** Shared files relative to the repo, at most five. */
  files: string[];
  /** The pairs that share files, for the conflict drawer. */
  pairs: [string, string][];
  branch: string | null;
  sessions: { id: string; title: string; status: Session["status"]; cwd: string | null }[];
}

export interface Overview {
  version: string;
  demo: boolean;
  /** Language of the texts the server wrote; the dashboard starts with it. */
  language: "de" | "en";
  handoffPrompt: string;
  autoHandoff: { enabled: boolean; limitPercent: number; contextPercent: number };
  platform: NodeJS.Platform;
  openTargets: OpenTarget[];
  refreshSeconds: number;
  configPath: string;
  sessions: Session[];
  decisions: Decision[];
  brake: { enabled: boolean };
  usage: Usage | null;
  repos: Repo[];
  projects: Project[];
  duplicates: Duplicate[];
  events: FleetEvent[];
  timeline: Timeline | null;
  warnings: string[];
  /** Fleet's own processes (without folders beyond the repo root). */
  processes: Proc[];
  /** Can Fleet run Claude in its own window here, and if not, why. */
  terminal: TerminalState;
  /** Where `:new <name>` creates a new project folder (release 6). */
  /** The folder `fleet` was last typed in (server/core/here.ts), for 12 h; null in the demo. */
  here?: { dir: string; at: number } | null;
  projectsDir?: string;
  /** subscription: tokens and the limit everywhere, dollars only on the usage page (grey). */
  billing?: Billing;
}

/**
 * The week report (spec: "Analyse-Export"): small enough to hand to a Claude session, under 5,000 tokens. Names
 * only, never paths; numbers only where Fleet measured them.
 */
export interface WeekReport {
  schema: "claude-fleet/week-report";
  version: 1;
  generatedAt: string;
  language: "de" | "en";
  /** The seven days; `eventsFrom` is the oldest event Fleet still had (alarms only count from there). */
  period: { from: string; to: string; eventsFrom: string | null };
  /** Sessions active in the period, per repo and status group of "Now". */
  repos: {
    repo: string;
    sessions: number;
    needs: number;
    errors: number;
    working: number;
    done: number;
    resting: number;
    archive: number;
  }[];
  usage: { tokens7d: number | null; apiValueUsd7d: number | null; weekLimitPct: number | null };
  /** Fleet's own balance (stage 5); null while Fleet does not count it. */
  fleetBalance: null;
  /** Bad actors: the sessions that raised the most alarms (waiting for you, error) in the period. */
  alarms: { repo: string; session: string; waiting: number; errors: number }[];
  /** Open PRs nobody worked on for three days or more; `lastSession` null means no session ever did. */
  stalePrs: {
    repo: string;
    number: number;
    title: string;
    draft: boolean;
    ci: CiState;
    lastSession: string | null;
  }[];
  cacheRebuilds: { repo: string; session: string; rebuilds: number; apiValueUsd: number | null }[];
  /** Sessions the advisor finds light enough for Haiku; the saving is its estimate at API prices. */
  haiku: { sessions: number; estimatedSavingUsd: number; examples: { repo: string; session: string }[] };
  duplicates: { repo: string; reason: Duplicate["reason"]; sessions: string[]; files: string[] }[];
  /** Lists were cut to stay under the size limit. */
  truncated: boolean;
}

export interface TerminalState {
  available: boolean;
  why?: string;
  /** Switched off on purpose (config): nothing to report in the message row. */
  off?: boolean;
  max: number;
}

/** A repo's architecture notes for the repo drawer (server/core/architecture.ts); plain Markdown, never HTML. */
export interface ArchDoc {
  /** Relative to the repo root; null when the repo has none of the known files. */
  file: string | null;
  text: string | null;
  /** Cut at the size limit. */
  truncated: boolean;
  /** The interactive Architekturmappe (.architektur/mappe.html) exists next to it. */
  mappe: boolean;
}

/** Details of one pipeline run (GitHub Actions). */
export type RunState = CiState | "skipped";
export interface RunDetails {
  id: number;
  url: string | null;
  title: string;
  workflow: string;
  sha: string | null;
  branch: string | null;
  state: RunState;
  jobs: {
    id: number;
    name: string;
    state: RunState;
    current: string | null;
    steps: { name: string; state: RunState }[];
    /** GitHub's own reason for a failed job (annotations), e.g. "job was not started: spending limit". */
    notes: string[];
  }[];
  tests: string[];
  log: string | null;
}

/**
 * One step of one session in the log view (spec, "Log-Sicht (Shift+L)"): a tool call with its file or command, the
 * first line of an assistant text, the start of a prompt, or an error. Read from the transcripts, every session.
 */
export interface LogLine {
  /** Order in which the server read the line; `?after=` asks for newer ones. */
  seq: number;
  /** ms */
  at: number;
  session: string;
  kind: "tool" | "text" | "prompt" | "error";
  /** The tool's name for a tool call or a failed tool result. */
  tool: string | null;
  /** One line, paths relative to the session's folder. */
  text: string;
}

/** /api/log: the newest lines (at most LOG_MAX), names for their sessions and which of them wait for you now. */
export interface LogPage {
  /** Changes when the server restarted: the client then drops what it has, the seq numbers start over. */
  epoch: string;
  seq: number;
  lines: LogLine[];
  sessions: Record<string, { name: string | null; project: string | null }>;
  /** Sessions that wait for an answer or an approval (from shared/inbox.ts): their newest line is the signal. */
  waiting: string[];
}

/**
 * One entry of a session's conversation in its drawer: what you wrote, what Claude answered, each tool call and
 * each failure, in transcript order.
 */
export interface ChatEntry {
  /** ms */
  at: number;
  kind: "you" | "claude" | "tool" | "error";
  /** Tool name for `tool` and for an `error` of a tool. */
  tool: string | null;
  text: string;
  /** For a tool call: no result yet, so this is what the session does right now. */
  open?: boolean;
}

/** /api/chat?session=: one session's conversation, newest last (at most CHAT_MAX entries). */
export interface ChatPage {
  session: string;
  entries: ChatEntry[];
  /** Older entries exist in the transcript than the ones sent. */
  more: boolean;
}

/** One line of a diff (release 6, the diff view): kind, old and new line number, text. */
export interface DiffLine {
  t: "+" | "-" | " ";
  a: number | null;
  b: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/**
 * A file in the diff view. M changed, A added, D deleted, R renamed (from `old`), U new and untracked, E edited by the
 * session outside the repo (content only). `mine`: the session itself edited it. `cut`: too long, shortened.
 */
export interface DiffFile {
  path: string;
  old: string | null;
  status: "M" | "A" | "D" | "R" | "U" | "E";
  add: number;
  del: number;
  mine: boolean;
  binary: boolean;
  cut: boolean;
  hunks: DiffHunk[];
}

/** /api/diff: what a session changed, against `base` (the default branch it left, HEAD, or ∅). */
export interface DiffView {
  root: string;
  branch: string | null;
  base: string;
  files: DiffFile[];
  cut: boolean;
  error: string | null;
}

/** /api/file: one changed file's text for the files view. */
export interface FileView {
  path: string;
  text: string;
  binary: boolean;
  cut: boolean;
  missing: boolean;
  size: number;
}
