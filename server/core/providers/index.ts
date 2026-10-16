import type { CiResult, Config, OpenPrs, Remote } from "../../../shared/types";
import { run, validBranch } from "../git";
import { tr } from "../lang";
import { azure } from "./azure";
import { bitbucket } from "./bitbucket";
import { ghEnv, github, githubOpenPrs } from "./github";
import { gitlab } from "./gitlab";
import { blockedUntil, clock, RetryError } from "./http";

export { ghReview, ghRunState, rollup, toOpenPrs } from "./github";
export { glState } from "./gitlab";

/**
 * PR/MR and CI status per (remote, branch) for GitHub, GitLab, Azure DevOps and Bitbucket Cloud.
 * Results are cached and refreshed in the background (stale-while-revalidate), so the dashboard never
 * waits for a slow API.
 *
 * Security:
 *  - Only trusted hosts are queried (and get a token): github.com, gitlab.com, bitbucket.org,
 *    dev.azure.com or hosts listed in config.hostMap. A repo with origin "https://github.evil.example/…"
 *    never receives your GitHub token.
 *  - Redirects are not followed (tokens in custom headers would travel along).
 *  - Responses are size-limited; branch and path values are validated and encoded.
 */

type Cfg = Pick<Config, "tokens" | "prRefreshSeconds">;

const cache = new Map<string, { at: number; ttl: number; value: CiResult; inflight: boolean; used: number }>();
const queue: (() => Promise<void>)[] = [];
let active = 0;
const MAX_PARALLEL = 4;
const MAX_ENTRIES = 400;

const key = (remote: Remote, branch: string) => `${remote.provider}|${remote.host}|${remote.path}|${branch}`;

export function get(remote: Remote | null | undefined, branch: string | null | undefined, cfg: Cfg): CiResult | null {
  if (!remote || !branch || !validBranch(branch)) return null;
  if (remote.provider === "unknown" || !remote.trusted) {
    return remote.guess
      ? {
          skipped: true,
          hint: tr(
            `${remote.host} ist nicht freigegeben. Für PR/CI in config.hostMap eintragen, z.B. {"${remote.host}": "${remote.guess}"}`,
            `${remote.host} is not allowed. For PR/CI add it to config.hostMap, e.g. {"${remote.host}": "${remote.guess}"}`,
          ),
        }
      : null;
  }
  const k = key(remote, branch);
  const c = cache.get(k);
  if (c) c.used = Date.now();
  if (!c || (!c.inflight && Date.now() - c.at > c.ttl)) schedule(k, remote, branch, cfg);
  return c ? c.value : { loading: true };
}

const prLists = new Map<string, { at: number; value: OpenPrs; inflight: boolean }>();

/**
 * All open PRs of a repo (GitHub, via gh), cached like the CI status: the dashboard gets the last value at once
 * and a refresh runs in the background. Running checks are asked again sooner.
 */
export function openPrs(remote: Remote | null | undefined, cfg: Cfg): OpenPrs | null {
  if (remote?.provider !== "github" || !remote.trusted) return null;
  const k = `prs|${remote.host}|${remote.path}`;
  const c = prLists.get(k);
  const busy = c?.value.prs?.some((p) => p.ci === "running" || p.ci === "pending");
  const ttl = c?.value.error ? cfg.prRefreshSeconds * 2000 : busy ? 20e3 : cfg.prRefreshSeconds * 1000;
  if (!c || (!c.inflight && Date.now() - c.at > ttl)) {
    const entry = c || { at: 0, value: { loading: true }, inflight: true };
    entry.inflight = true;
    prLists.set(k, entry);
    queue.push(async () => {
      let value: OpenPrs;
      try {
        value = { prs: await githubOpenPrs(remote) };
      } catch (e) {
        value = { ...entry.value, loading: undefined, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
      }
      value.fetchedAt = Date.now();
      prLists.set(k, { at: Date.now(), value, inflight: false });
    });
    pump();
  }
  return c ? c.value : { loading: true };
}

/** Refresh interval by state: running CI often, finished things rarely. */
export function ttlFor(value: CiResult, base: number): number {
  if (value.retryAt) return Math.max(15e3, value.retryAt - Date.now());
  if (value.error) return base * 2;
  const states = [value.ci?.state, value.pr?.ci];
  if (states.some((s) => s === "running" || s === "pending")) return Math.max(20e3, base / 3);
  if (value.pr && (value.pr.state === "merged" || value.pr.state === "closed")) return Math.min(base * 5, 30 * 60e3);
  return base;
}

function schedule(k: string, remote: Remote, branch: string, cfg: Cfg) {
  const c = cache.get(k) || { at: 0, ttl: 0, value: { loading: true }, inflight: true, used: Date.now() };
  c.inflight = true;
  cache.set(k, c);
  queue.push(async () => {
    let value: CiResult;
    const until = blockedUntil.get(remote.host) || 0;
    if (until > Date.now()) {
      value = {
        ...c.value,
        loading: undefined,
        error: tr(`Rate-Limit – weiter ab ${clock(until)}`, `Rate limit, resuming at ${clock(until)}`),
        retryAt: until,
      };
    } else {
      try {
        value = await lookup(remote, branch, cfg);
      } catch (e) {
        value = {
          error: String(e instanceof Error ? e.message : e).slice(0, 200),
          retryAt: e instanceof RetryError ? e.retryAt : undefined,
        };
      }
    }
    value.fetchedAt = Date.now();
    cache.set(k, {
      at: Date.now(),
      ttl: ttlFor(value, cfg.prRefreshSeconds * 1000),
      value,
      inflight: false,
      used: c.used,
    });
    evict();
  });
  pump();
}

function evict() {
  if (cache.size <= MAX_ENTRIES) return;
  const old = [...cache.entries()].filter(([, v]) => !v.inflight).sort((a, b) => a[1].used - b[1].used);
  for (const [k] of old.slice(0, cache.size - MAX_ENTRIES)) cache.delete(k);
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (!job) break;
    active++;
    job()
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}

function lookup(remote: Remote, branch: string, cfg: Cfg): Promise<CiResult> {
  switch (remote.provider) {
    case "github":
      return github(remote, branch, cfg);
    case "gitlab":
      return gitlab(remote, branch, cfg);
    case "azure":
      return azure(remote, branch, cfg);
    case "bitbucket":
      return bitbucket(remote, branch, cfg);
    default:
      return Promise.resolve({});
  }
}

/**
 * Squash-merges a PR (GitHub only, via gh) and drops the repo's cache so the new state shows at once.
 * `admin` merges although required checks did not run; only used when CI could not start at all
 * (e.g. the Actions spending limit), after the user confirmed it in the dashboard.
 */
export async function mergePr(
  remote: Remote,
  number: number,
  { admin = false } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (remote.provider !== "github" || !Number.isInteger(number) || number <= 0) {
    return { ok: false, error: tr("nur GitHub-PRs", "GitHub PRs only") };
  }
  const args = [
    "pr",
    "merge",
    String(number),
    "-R",
    remote.path,
    "--squash",
    "--delete-branch",
    ...(admin ? ["--admin"] : []),
  ];
  const r = await run("gh", args, undefined, 60000, ghEnv(remote.host));
  for (const k of [...cache.keys()]) if (k.includes(remote.path)) cache.delete(k);
  for (const k of [...prLists.keys()]) if (k.endsWith(`|${remote.path}`)) prLists.delete(k);
  return r.ok
    ? { ok: true }
    : {
        ok: false,
        error: (r.err.split("\n").find(Boolean) || tr("gh pr merge fehlgeschlagen", "gh pr merge failed")).slice(
          0,
          300,
        ),
      };
}
