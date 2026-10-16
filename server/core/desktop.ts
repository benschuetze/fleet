import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validBranch } from "./git";

/**
 * What the Claude desktop app knows about its code sessions. It keeps one small JSON file per session
 * (`claude-code-sessions/<org>/<account>/local_<id>.json`). Fleet reads from it:
 *  - which CLI session currently runs in which desktop session and which ran before (after /clear or a
 *    fresh start the same desktop session gets a new CLI session id),
 *  - the PRs the session opened, even if it is on another branch by now,
 *  - the link with which the app opens exactly this session.
 *
 * The format is internal and may change: everything is checked and capped, errors mean "no desktop
 * data", never a crash. Fleet only reads there, it never writes.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 2 * 1024 * 1024;
const GROUP_ID = /^[\w-]{1,100}$/;

export interface DesktopPr {
  number: number;
  repo: string;
  host: string;
  url: string | null;
  branch: string | null;
  state: "open" | "draft" | "merged" | "closed";
}

export interface DesktopSession {
  desktopId: string;
  /** current CLI session */
  cliSessionId: string;
  /** earlier CLI sessions of the same desktop session, oldest first */
  prior: string[];
  title: string | null;
  model: string | null;
  archived: boolean;
  lastActivityAt: number;
  prs: DesktopPr[];
  /** group in the app's sidebar */
  group?: { id: string; name: string } | null;
}

/** Where the app keeps its sessions per system; CLAUDE_DESKTOP_SESSIONS_DIR overrides (tests, unusual installs). */
export function sessionsDir(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string | null {
  if (env.CLAUDE_DESKTOP_SESSIONS_DIR !== undefined) return env.CLAUDE_DESKTOP_SESSIONS_DIR || null;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
  if (platform === "win32") return env.APPDATA ? path.join(env.APPDATA, "Claude", "claude-code-sessions") : null;
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude-code-sessions");
}

/** The app's settings (they hold the sidebar groups). */
export function configFile(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string | null {
  if (env.CLAUDE_DESKTOP_CONFIG !== undefined) return env.CLAUDE_DESKTOP_CONFIG || null;
  const dir = sessionsDir(env, platform, home);
  return dir ? path.join(path.dirname(dir), "claude_desktop_config.json") : null;
}

const str = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

let groupCache: {
  file: string;
  mtime: number;
  size: number;
  groups: Map<string, { id: string; name: string }>;
} | null = null;

/**
 * Sidebar groups: desktop session id -> group. The app stores them per account under
 * preferences.epitaxyPrefs["dframe-group-scopes"] ({ groups: [{id, name}], assignments: { "code:local_…": id } }).
 */
export function readGroups(file: string | null = configFile()): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  if (!file) return out;
  try {
    const st = fs.statSync(file);
    // Size is part of the key: two changes within the same timestamp tick (coarse on Windows) would look equal.
    if (groupCache && groupCache.file === file && groupCache.mtime === st.mtimeMs && groupCache.size === st.size) {
      return groupCache.groups;
    }
    if (st.size > MAX_FILE) return out;
    const scopes: unknown = JSON.parse(fs.readFileSync(file, "utf8"))?.preferences?.epitaxyPrefs?.[
      "dframe-group-scopes"
    ];
    for (const sc of scopes && typeof scopes === "object" ? Object.values(scopes).slice(0, 20) : []) {
      const scope = sc as { groups?: unknown; assignments?: unknown } | null;
      const names = new Map<string, string>();
      for (const g of Array.isArray(scope?.groups) ? scope.groups.slice(0, 200) : []) {
        const name = str(g?.name, 200);
        if (typeof g?.id === "string" && GROUP_ID.test(g.id) && name) names.set(g.id, name);
      }
      const assignments = scope?.assignments && typeof scope.assignments === "object" ? scope.assignments : {};
      for (const [k, gid] of Object.entries(assignments).slice(0, 5000)) {
        const id = k.replace(/^code:/, "");
        const name = typeof gid === "string" ? names.get(gid) : undefined;
        if (DESKTOP_ID.test(id) && name && typeof gid === "string") out.set(id.toLowerCase(), { id: gid, name });
      }
    }
    groupCache = { file, mtime: st.mtimeMs, size: st.size, groups: out };
  } catch {
    // no or broken settings: no groups
  }
  return out;
}

function prState(v: unknown): DesktopPr["state"] {
  const s = String(v || "").toUpperCase();
  return s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : s === "DRAFT" ? "draft" : "open";
}

/** Brings one file of the app into the checked shape. */
// biome-ignore lint/suspicious/noExplicitAny: an app-internal file, checked field by field
export function parseSession(j: any): DesktopSession | null {
  if (!j || typeof j !== "object") return null;
  if (typeof j.sessionId !== "string" || !DESKTOP_ID.test(j.sessionId)) return null;
  if (typeof j.cliSessionId !== "string" || !UUID.test(j.cliSessionId)) return null;
  const prior: string[] = Array.isArray(j.priorCliSessionIds)
    ? j.priorCliSessionIds.filter((x: unknown): x is string => typeof x === "string" && UUID.test(x)).slice(-50)
    : [];
  const prs: DesktopPr[] = [];
  for (const p of Array.isArray(j.prs) ? j.prs.slice(-50) : []) {
    if (!p || typeof p !== "object" || !Number.isInteger(p.prNumber) || p.prNumber <= 0) continue;
    const repo = str(p.repo, 200);
    const host = str(p.host, 200);
    if (!repo || !host || !/^[\w.-]+(\/[\w.-]+)+$/.test(repo) || !/^[\w.-]+$/.test(host)) continue;
    const url = typeof p.url === "string" && /^https:\/\/[^\s"'<>]+$/.test(p.url) ? p.url.slice(0, 500) : null;
    prs.push({
      number: p.prNumber,
      repo,
      host: host.toLowerCase(),
      url,
      branch: validBranch(p.branch) ? p.branch : null,
      state: prState(p.state),
    });
  }
  return {
    desktopId: j.sessionId,
    cliSessionId: j.cliSessionId.toLowerCase(),
    prior: prior.map((x) => x.toLowerCase()),
    title: str(j.title, 200),
    model: str(j.model, 80),
    archived: j.isArchived === true,
    lastActivityAt: Number.isFinite(j.lastActivityAt) ? j.lastActivityAt : 0,
    prs,
  };
}

const cache = new Map<string, { mtime: number; s: DesktopSession | null }>();

export interface DesktopData {
  byCli: Map<string, DesktopSession>;
  /** earlier CLI session -> the next one in the same desktop session */
  successor: Map<string, string>;
}

/** All desktop sessions, findable by CLI session id (current and earlier ones). */
export function readDesktop(dir: string | null = sessionsDir(), cfgFile: string | null = configFile()): DesktopData {
  const groups = readGroups(cfgFile);
  const byCli = new Map<string, DesktopSession>();
  const successor = new Map<string, string>();
  if (!dir) return { byCli, successor };
  const files: string[] = [];
  try {
    for (const org of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      for (const acc of fs.readdirSync(path.join(dir, org.name), { withFileTypes: true })) {
        if (!acc.isDirectory()) continue;
        const d = path.join(dir, org.name, acc.name);
        for (const f of fs.readdirSync(d)) if (/^local_[\w-]+\.json$/.test(f)) files.push(path.join(d, f));
      }
    }
  } catch {
    return { byCli, successor };
  }
  const seen = new Set(files);
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  for (const f of files.slice(0, 2000)) {
    let c = cache.get(f);
    try {
      const st = fs.statSync(f);
      if (!c || c.mtime !== st.mtimeMs) {
        c = { mtime: st.mtimeMs, s: st.size > MAX_FILE ? null : parseSession(JSON.parse(fs.readFileSync(f, "utf8"))) };
        cache.set(f, c);
      }
    } catch {
      continue;
    }
    if (!c.s) continue;
    const s: DesktopSession = { ...c.s, group: groups.get(c.s.desktopId.toLowerCase()) || null };
    byCli.set(s.cliSessionId, s);
    const chain = [...s.prior, s.cliSessionId];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i] as string;
      if (!byCli.has(a)) byCli.set(a, s);
      successor.set(a, chain[i + 1] as string);
    }
  }
  return { byCli, successor };
}

/**
 * The best-matching PR of a desktop session for a repo: first the one of the branch, else the newest
 * open one, else the newest at all. The app appends PRs in the order they are created.
 */
export function prFor(
  prs: DesktopPr[],
  remote: { host: string; path: string },
  branch: string | null | undefined,
): DesktopPr | null {
  const mine = prs.filter(
    (p) => p.host === remote.host.toLowerCase() && p.repo.toLowerCase() === remote.path.toLowerCase(),
  );
  if (!mine.length) return null;
  return (
    mine.find((p) => branch && p.branch === branch) ||
    [...mine].reverse().find((p) => p.state === "open" || p.state === "draft") ||
    mine[mine.length - 1] ||
    null
  );
}

/** Link with which the app opens a session. Without a desktop entry it imports the CLI session. */
export function desktopLink(desktopId: string | null | undefined, cliSessionId: string): string | null {
  if (desktopId && DESKTOP_ID.test(desktopId)) return `claude://claude.ai/epitaxy/${desktopId}`;
  if (UUID.test(cliSessionId)) return `claude://resume?session=${cliSessionId}`;
  return null;
}
