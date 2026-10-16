import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, Provider } from "../../shared/types";
import { APP_DIR, fleetHome } from "./paths";

type BaseConfig = Omit<Config, "_warnings" | "_path" | "_fleetHome">;

function defaults(): BaseConfig {
  return {
    port: 4777,
    host: "127.0.0.1",
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
    sessionMaxAgeDays: 14, // older transcripts are ignored
    refreshSeconds: 5, // UI polling fallback; hook changes arrive by push
    prRefreshSeconds: 90, // base interval for PR/CI per branch, adapted to the state
    staleMinutes: 20, // "working" without a sign of life becomes "stuck?"
    useAgentView: true, // also read `claude agents --json --all`
    extraRepos: [], // additional repo paths, even without a Claude session
    hiddenProjects: [], // path substrings to hide
    hostMap: {}, // e.g. { "git.company.com": "gitlab" }; only hosts listed here receive tokens
    tokens: {}, // github, gitlab, azureDevOps, bitbucketUser, bitbucketToken
    cloudSessions: [], // manual: [{ title, url, repo, branch }]
    statsDays: 30, // period for usage and cost (7-90 days)
    contextWindow: 0, // force a context window size (0 = automatic)
    prices: {}, // own prices: { "opus-5": { input, output, cacheRead } } (USD per million)
    // Claude in Fleet's window: at most 8 interactive sessions, 256 KB output each for re-attaching.
    terminal: { enabled: true, maxSessions: 8, scrollbackKb: 256, permissionMode: {} },
    // Most users have a Pro/Max plan: the limit counts, not the dollar value at list prices.
    billing: "subscription",
    // `:new <name>` creates the folder here; empty: where most known repos live (server/core/newfolder.ts).
    projectsDir: "",
    // A second session in a repo starts in its own worktree next to it; `:wt` always does.
    worktree: { auto: "second", fetch: false, repos: {} },
  };
}

/** The permission modes Claude Code knows; anything else would make `claude` refuse to start. */
export const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

function terminalConfig(v: unknown, cfg: BaseConfig["terminal"], warnings: string[]): BaseConfig["terminal"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return cfg;
  const t = v as Record<string, unknown>;
  const out = { ...cfg, permissionMode: {} as Record<string, string> };
  if (typeof t.enabled === "boolean") out.enabled = t.enabled;
  if ("maxSessions" in t) out.maxSessions = num(t.maxSessions, cfg.maxSessions, [1, 16]);
  if ("scrollbackKb" in t) out.scrollbackKb = num(t.scrollbackKb, cfg.scrollbackKb, [16, 4096]);
  if (t.permissionMode && typeof t.permissionMode === "object" && !Array.isArray(t.permissionMode)) {
    for (const [root, mode] of Object.entries(t.permissionMode)) {
      if (typeof mode === "string" && PERMISSION_MODES.has(mode)) out.permissionMode[expandHome(root.trim())] = mode;
      else
        warnings.push(
          `config.terminal.permissionMode["${root}"]="${mode}" unknown (allowed: ${[...PERMISSION_MODES].join(", ")})`,
        );
    }
  }
  return out;
}

function worktreeConfig(v: unknown, cfg: BaseConfig["worktree"], warnings: string[]): BaseConfig["worktree"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return cfg;
  const w = v as Record<string, unknown>;
  const out = { ...cfg, repos: {} as BaseConfig["worktree"]["repos"] };
  if ("auto" in w) {
    if (w.auto === "second" || w.auto === "always" || w.auto === "off") out.auto = w.auto;
    else warnings.push(`config.worktree.auto=${JSON.stringify(w.auto)} unknown (allowed: second, always, off)`);
  }
  if (typeof w.fetch === "boolean") out.fetch = w.fetch;
  if (w.repos && typeof w.repos === "object" && !Array.isArray(w.repos)) {
    for (const [root, r] of Object.entries(w.repos)) {
      const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const setup = typeof o.setup === "string" ? o.setup.trim() : "";
      out.repos[expandHome(root.trim())] = { setup, include: strList(o.include) };
    }
  }
  return out;
}

// Bounds against accidental busy loops and nonsense values.
const LIMITS = {
  port: [1, 65535],
  sessionMaxAgeDays: [1, 365],
  refreshSeconds: [2, 3600],
  prRefreshSeconds: [15, 86400],
  staleMinutes: [1, 1440],
  statsDays: [7, 90],
  contextWindow: [0, 10000000],
} as const satisfies Record<string, readonly [number, number]>;
type LimitKey = keyof typeof LIMITS;

const PROVIDERS = new Set<Provider>(["github", "gitlab", "azure", "bitbucket"]);
export const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

let cache: Config | null = null;
let cacheKey = "";

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function configPath(): string {
  const local = path.join(APP_DIR, "config.json");
  if (fs.existsSync(local)) return local;
  return path.join(fleetHome(), "config.json");
}

function num(v: unknown, def: number, [min, max]: readonly [number, number]): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());

/** Validates and normalises the user config. Invalid values fall back to the default, with a warning. */
export function normalize(user: Record<string, unknown>, warnings: string[]): BaseConfig {
  const cfg = defaults();
  for (const k of Object.keys(LIMITS) as LimitKey[]) {
    if (k in user) {
      cfg[k] = num(user[k], cfg[k], LIMITS[k]);
      if (cfg[k] !== Number(user[k])) {
        warnings.push(`config.${k}=${JSON.stringify(user[k])} invalid or outside [${LIMITS[k]}] → ${cfg[k]}`);
      }
    }
  }
  if (typeof user.host === "string") {
    const h = user.host.trim().toLowerCase();
    if (LOOPBACK.has(h)) cfg.host = h;
    else
      warnings.push(
        `config.host="${user.host}" ignored: Claude Fleet only listens on 127.0.0.1 (no login, the data contains prompts and paths).`,
      );
  }
  if (typeof user.claudeHome === "string" && user.claudeHome.trim()) cfg.claudeHome = user.claudeHome.trim();
  if (typeof user.useAgentView === "boolean") cfg.useAgentView = user.useAgentView;
  cfg.extraRepos = strList(user.extraRepos).map(expandHome);
  if (typeof user.projectsDir === "string" && user.projectsDir.trim()) {
    const dir = expandHome(user.projectsDir.trim());
    if (path.isAbsolute(dir)) cfg.projectsDir = dir;
    else warnings.push(`config.projectsDir="${user.projectsDir}" ignored: needs an absolute path or ~/…`);
  }
  cfg.hiddenProjects = strList(user.hiddenProjects);
  if (user.hostMap && typeof user.hostMap === "object") {
    for (const [h, p] of Object.entries(user.hostMap)) {
      const prov = String(p || "").toLowerCase() as Provider;
      if (PROVIDERS.has(prov)) cfg.hostMap[String(h).trim().toLowerCase()] = prov;
      else warnings.push(`config.hostMap["${h}"]="${p}" unknown (allowed: ${[...PROVIDERS].join(", ")})`);
    }
  }
  if (user.tokens && typeof user.tokens === "object") {
    for (const [k, v] of Object.entries(user.tokens)) if (typeof v === "string" && v.trim()) cfg.tokens[k] = v.trim();
  }
  if (user.prices && typeof user.prices === "object" && !Array.isArray(user.prices)) {
    cfg.prices = user.prices as Config["prices"];
  }
  cfg.cloudSessions = (Array.isArray(user.cloudSessions) ? user.cloudSessions : []).filter(
    (c): c is Config["cloudSessions"][number] => !!c && typeof c === "object",
  );
  cfg.terminal = terminalConfig(user.terminal, cfg.terminal, warnings);
  cfg.worktree = worktreeConfig(user.worktree, cfg.worktree, warnings);
  if ("billing" in user) {
    if (user.billing === "subscription" || user.billing === "api") cfg.billing = user.billing;
    else warnings.push(`config.billing=${JSON.stringify(user.billing)} unknown (allowed: subscription, api)`);
  }
  cfg.claudeHome = expandHome(cfg.claudeHome);
  return cfg;
}

/** A file holding tokens must not be readable by others (only checkable on POSIX). */
function permissionWarning(p: string, cfg: Pick<Config, "tokens">): string | null {
  if (process.platform === "win32" || !Object.keys(cfg.tokens).length) return null;
  try {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode & 0o077) {
      return `${p} contains tokens and is readable by others (mode ${mode.toString(8)}); "chmod 600" recommended.`;
    }
  } catch {
    // no file, nothing to warn about
  }
  return null;
}

export function loadConfig(): Config {
  const p = configPath();
  let mtime = 0;
  try {
    mtime = fs.statSync(p).mtimeMs;
  } catch {
    // no config file: defaults
  }
  const key = `${p}:${mtime}:${fleetHome()}`;
  if (cache && key === cacheKey) return cache;
  const warnings: string[] = [];
  let user: Record<string, unknown> = {};
  if (mtime) {
    try {
      const j: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) user = j as Record<string, unknown>;
      else warnings.push("config.json is not an object; using defaults");
    } catch (e) {
      warnings.push(`config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const base = normalize(user, warnings);
  const pw = mtime ? permissionWarning(p, base) : null;
  if (pw) warnings.push(pw);
  for (const w of warnings) console.warn(`[fleet] ${w}`);
  cache = { ...base, _warnings: warnings, _path: p, _fleetHome: fleetHome() };
  cacheKey = key;
  return cache;
}

/** Token from config.tokens[name] or from environment variables. */
export function token(cfg: Pick<Config, "tokens">, name: string, ...envs: string[]): string {
  if (cfg.tokens?.[name]) return cfg.tokens[name];
  for (const e of envs) {
    const v = process.env[e];
    if (v) return v.trim();
  }
  return "";
}
