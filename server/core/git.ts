import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fleetWorktree } from "../../shared/repo";
import type { Config, GitInfo, Provider, Remote } from "../../shared/types";
import { swr } from "./swr";

/*
 * Git runs in folders that come from transcripts. Therefore:
 *  - only execFile (no shell), arguments never assembled from unchecked strings
 *  - --no-optional-locks / GIT_OPTIONAL_LOCKS=0: `git status` writes no index.lock, so it never collides
 *    with commits Claude is making in the same repo right now
 *  - core.fsmonitor off: a repo could otherwise make git run arbitrary commands
 *  - never interactive (no password prompt)
 */
// Without GIT_DIR and friends: Fleet started from a Git hook (or a test run from one) must not act on that repo
// instead of the folder it names (16.10.2026: a test's `git init` set core.bare on the real repo).
const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, ...PARENT_ENV } =
  process.env;
const GIT_ENV = {
  ...PARENT_ENV,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  LC_ALL: "C",
};
const GIT_SAFE = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks"];

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export function run(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  timeout = 8000,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || err?.message || "").trim() });
    });
  });
}

export const git = (args: string[], cwd: string, timeout?: number) =>
  run("git", [...GIT_SAFE, ...args], cwd, timeout, GIT_ENV);

/** Cache with a TTL that also shares running queries (no duplicate processes). */
export function memo<A extends unknown[], R>(
  ttlMs: number,
  fn: (key: string, ...a: A) => Promise<R> | R,
  max = 500,
): (key: string, ...a: A) => Promise<R> {
  const m = new Map<string, { at: number; p: Promise<R> }>();
  return (key, ...a) => {
    const c = m.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.p;
    const p = Promise.resolve().then(() => fn(key, ...a));
    m.set(key, { at: Date.now(), p });
    p.catch(() => m.delete(key));
    const oldest = m.keys().next().value;
    if (m.size > max && oldest !== undefined) m.delete(oldest);
    return p;
  };
}

// Stale-while-revalidate: a hook event never waits for git once a folder or repo is known (swr.ts).
export const repoRoot = swr(60e3, async (dir: string): Promise<string | null> => {
  if (!dir || typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = await git(["rev-parse", "--show-toplevel"], dir, 4000);
  return r.ok && r.out ? path.resolve(r.out) : null;
});

/* ---------- Remote URL -> provider ---------- */

// Only these hosts count as trusted without an entry in hostMap. Tokens go to trusted hosts only.
export const KNOWN_HOSTS: Record<string, Provider> = {
  "github.com": "github",
  "ssh.github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};
const SEG = /^[A-Za-z0-9_.~-]+$/;
const validPath = (p: string) => !!p && p.split("/").every((s) => SEG.test(s) && s !== "." && s !== "..");

function azure(org?: string, project?: string, repo?: string): Remote | null {
  let o: string;
  let p: string;
  let r: string;
  try {
    o = decodeURIComponent(org || "");
    p = decodeURIComponent(project || "");
    r = decodeURIComponent(repo || "");
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in paths are exactly what is rejected
  if (!o || !p || !r || [o, p, r].some((x) => /[/\\\u0000-\u001f]/.test(x) || x === ".." || x === ".")) return null;
  return {
    provider: "azure",
    trusted: true,
    host: "dev.azure.com",
    org: o,
    project: p,
    repo: r,
    path: `${o}/${p}/${r}`,
    webUrl: `https://dev.azure.com/${encodeURIComponent(o)}/${encodeURIComponent(p)}/_git/${encodeURIComponent(r)}`,
  };
}

export function parseRemote(url: unknown, hostMap: Record<string, Provider> = {}): Remote | null {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  let host: string;
  let p: string;
  const scp = u.includes("://") ? null : u.match(/^[\w.-]+@([^:/\s]+):(?:\d+\/)?(.+)$/);
  const web = scp ? null : u.match(/^[a-z+]+:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i);
  const m = scp || web;
  if (!m?.[1] || !m[2]) return null;
  host = m[1].toLowerCase();
  p = m[2]
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");

  // Azure DevOps (Microsoft domains only)
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com" || host.endsWith(".vs-ssh.visualstudio.com")) {
    const [, org, project, repo] = p.split("/"); // v3/org/project/repo
    return azure(org, project, repo);
  }
  if (host === "dev.azure.com") {
    const parts = p.split("/"); // org/project/_git/repo
    const gi = parts.indexOf("_git");
    return gi > 0 ? azure(parts[0], parts[gi - 1], parts[gi + 1]) : null;
  }
  if (host.endsWith(".visualstudio.com")) {
    const org = host.split(".")[0];
    const parts = p.split("/").filter((x) => x !== "DefaultCollection");
    const gi = parts.indexOf("_git");
    return gi >= 0 ? azure(org, gi > 0 ? parts[gi - 1] : parts[gi + 1], parts[gi + 1]) : null;
  }

  if (!validPath(p) || !p.includes("/")) return null;
  if (host === "ssh.github.com") host = "github.com";
  const known = hostMap[host] || KNOWN_HOSTS[host] || null;
  let guess: Provider | null = null;
  if (!known) {
    // Only a hint: without a hostMap entry nothing is queried and no token is sent.
    guess = /gitlab/.test(host)
      ? "gitlab"
      : /github/.test(host)
        ? "github"
        : /bitbucket/.test(host)
          ? "bitbucket"
          : null;
  }
  const parts = p.split("/");
  return {
    provider: known || "unknown",
    trusted: !!known,
    guess,
    host,
    owner: parts.slice(0, -1).join("/"),
    repo: parts[parts.length - 1] || "",
    path: p,
    webUrl: `https://${host}/${p}`,
  };
}

/** Checks branch names from transcripts or config (prevents option injection like "--foo"). */
export function validBranch(b: unknown): b is string {
  return (
    typeof b === "string" &&
    b.length > 0 &&
    b.length <= 250 &&
    b !== "HEAD" &&
    !b.startsWith("-") &&
    !b.includes("..") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: git forbids control characters in branch names, so do we
    !/[\u0000- ~^:?*[\\\u007f]/.test(b) &&
    !b.endsWith("/") &&
    !b.endsWith(".lock")
  );
}

/* ---------- Git status ---------- */

export function parseStatusV2(out: string) {
  const r: {
    branch: string | null;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    dirty: number;
  } = {
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: 0,
  };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const h = line.slice(14);
      r.branch = h === "(detached)" ? "HEAD" : h;
    } else if (line.startsWith("# branch.upstream ")) r.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        r.ahead = Number(m[1]);
        r.behind = Number(m[2]);
      }
    } else if (!line.startsWith("#")) r.dirty++;
  }
  return r;
}

const remoteUrl = memo(5 * 60e3, async (root: string) => {
  const r = await git(["remote", "get-url", "origin"], root, 4000);
  return r.ok ? r.out : null;
});

const gitInfoCached = swr(8000, async (root: string, cfg: Pick<Config, "hostMap">): Promise<GitInfo> => {
  // Three processes instead of five: status v2 gives branch, upstream, ahead/behind and changes in one call.
  const [st, log, url] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch"], root),
    git(["log", "-1", "--format=%h%x09%ct%x09%s"], root, 4000),
    remoteUrl(root),
  ]);
  const s = st.ok ? parseStatusV2(st.out) : null;
  const info: GitInfo = {
    root,
    name: fleetWorktree(root)?.repo || path.basename(root),
    branch: s?.branch || null,
    dirty: s ? s.dirty : null,
    remote: url ? parseRemote(url, cfg.hostMap) : null,
    lastCommit: null,
    behind: s ? s.behind : null,
    ahead: s ? s.ahead : null,
    hasUpstream: !!s?.upstream,
  };
  if (log.ok && log.out) {
    const [hash = "", ts, ...subj] = log.out.split("\t");
    info.lastCommit = { hash, at: Number(ts) * 1000, subject: subj.join("\t").slice(0, 300) };
  }
  return info;
});

export const gitInfo = (root: string, cfg: Pick<Config, "hostMap">) => gitInfoCached(root, cfg);
