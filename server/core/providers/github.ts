import type { CiResult, CiState, Config, OpenPr, PullRequest, Remote } from "../../../shared/types";
import { token } from "../config";
import { run } from "../git";
import { tr } from "../lang";
import { encPath, http, type Json, safeUrl } from "./http";

type Cfg = Pick<Config, "tokens" | "prRefreshSeconds">;
type Review = PullRequest["review"];

// gh can be installed or logged in later: check again after 10 minutes.
let ghAvailable: { ok: boolean; at: number } | null = null;

/** GitHub: REST API with a token, otherwise the gh CLI if it is logged in. */
export function rollup(items: Json[] | null | undefined): CiState {
  if (!items?.length) return "none";
  let pending = false;
  for (const i of items) {
    const concl = String(i.conclusion || i.state || "").toUpperCase();
    const status = String(i.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(concl))
      return "failure";
    if (status && status !== "COMPLETED") pending = true;
    if (concl === "PENDING" || concl === "EXPECTED") pending = true;
  }
  return pending ? "running" : "success";
}

export function ghRunState(r: Json | null | undefined): NonNullable<CiResult["ci"]> {
  if (!r) return { state: "none" };
  const s = String(r.status || "").toLowerCase();
  const c = String(r.conclusion || "").toLowerCase();
  let state: CiState = "success";
  if (s && s !== "completed") {
    state = s === "queued" || s === "waiting" || s === "pending" || s === "requested" ? "pending" : "running";
  } else if (["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(c)) state = "failure";
  const id = Number(r.databaseId || r.id);
  return { state, url: safeUrl(r.url || r.html_url), name: r.workflowName || r.name, ...(id > 0 ? { id } : {}) };
}

export function ghReview(reviews: Json[] | null, requested: boolean): Review {
  const last = new Map<unknown, string>();
  for (const r of reviews || []) {
    if (r.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.user.id, r.state);
  }
  const v = [...last.values()];
  if (v.includes("CHANGES_REQUESTED")) return "changes";
  if (requested) return "pending";
  if (v.includes("APPROVED")) return "approved";
  return null;
}

export async function github(remote: Remote, branch: string, cfg: Cfg): Promise<CiResult> {
  const tok = token(cfg, "github", "GITHUB_TOKEN", "GH_TOKEN");
  const repoArg = remote.host === "github.com" ? remote.path : `${remote.host}/${remote.path}`;
  if (!tok) {
    if (!ghAvailable || (!ghAvailable.ok && Date.now() - ghAvailable.at > 10 * 60e3)) {
      ghAvailable = { ok: (await run("gh", ["--version"], undefined, 4000)).ok, at: Date.now() };
    }
    if (ghAvailable.ok) return githubCli(repoArg, branch, remote.host);
  }
  const api = remote.host === "github.com" ? "https://api.github.com" : `https://${remote.host}/api/v3`;
  const repo = `${api}/repos/${encPath(remote.path)}`;
  const h: Record<string, string> = tok ? { Authorization: `Bearer ${tok}`, "X-GitHub-Api-Version": "2022-11-28" } : {};
  const out: CiResult = {};
  const owner = String(remote.owner).split("/")[0];
  const prs = await http(
    `${repo}/pulls?state=all&sort=updated&direction=desc&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    h,
  );
  if (Array.isArray(prs) && prs[0]) {
    const p = prs[0] as Json;
    const open = p.state === "open";
    const [cr, rv] = await Promise.all([
      open
        ? http(`${repo}/commits/${encodeURIComponent(p.head.sha)}/check-runs?per_page=100`, h).catch(() => null)
        : null,
      open ? http(`${repo}/pulls/${p.number}/reviews?per_page=100`, h).catch(() => null) : null,
    ]);
    out.pr = {
      number: p.number,
      title: String(p.title || "").slice(0, 300),
      url: safeUrl(p.html_url),
      state: p.merged_at ? "merged" : p.state === "closed" ? "closed" : p.draft ? "draft" : "open",
      review: open
        ? ghReview(
            Array.isArray(rv) ? rv : null,
            (p.requested_reviewers || []).length + (p.requested_teams || []).length > 0,
          )
        : null,
      ci: cr ? rollup(cr.check_runs) : "none",
    };
  }
  try {
    const runs = await http(`${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`, h);
    out.ci = ghRunState(runs.workflow_runs?.[0]);
  } catch {
    out.ci = { state: "none" };
  }
  if (!tok)
    out.hint = tr(
      "Ohne Token/gh-CLI nur öffentliche Repos und 60 Anfragen/Stunde",
      "Without a token or the gh CLI: public repos only, 60 requests per hour",
    );
  return out;
}

const RED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/** Review decision of `gh pr list` as Fleet's review state. */
const ghDecision = (d: unknown): PullRequest["review"] =>
  d === "APPROVED" ? "approved" : d === "CHANGES_REQUESTED" ? "changes" : d ? "pending" : null;

/**
 * Open PRs from `gh pr list --json …` as the list in "Repos & PRs". A PR whose base is not the default branch
 * builds on another one; if that one is open, its number is shown, so the lower PR is merged first.
 */
export function toOpenPrs(list: Json[] | null | undefined, defaultBranch: string): OpenPr[] {
  if (!Array.isArray(list)) return [];
  const rows = list.filter((p) => p && Number.isInteger(p.number) && p.number > 0).slice(0, 30);
  const byHead = new Map(rows.map((p) => [String(p.headRefName || ""), Number(p.number)]));
  return rows.map((p) => {
    const base = String(p.baseRefName || "").slice(0, 200);
    const checks: Json[] = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
    const failed = checks
      .filter((c) => RED.includes(String(c?.conclusion || c?.state || "").toUpperCase()))
      .map((c) => String(c.name || c.context || "?").slice(0, 80))
      .slice(0, 5);
    const onDefault = !!defaultBranch && base === defaultBranch;
    return {
      number: Number(p.number),
      title: String(p.title || "").slice(0, 300),
      url: safeUrl(p.url),
      draft: p.isDraft === true,
      base,
      head: String(p.headRefName || "").slice(0, 200),
      ci: rollup(checks),
      failed,
      review: ghDecision(p.reviewDecision),
      onDefault,
      stackedOn: onDefault ? null : byHead.get(base) || null,
      // For the merge question ("PR #14 (3 commits) into main?"); unknown stays unknown, merging still works.
      commits: Array.isArray(p.commits) ? Math.min(p.commits.length, 10000) : null,
    };
  });
}

/** Open PRs of a GitHub repo via the gh CLI (the same login Fleet uses for merging). */
export async function githubOpenPrs(remote: Remote): Promise<OpenPr[]> {
  const repoArg = remote.host === "github.com" ? remote.path : `${remote.host}/${remote.path}`;
  const env = ghEnv(remote.host);
  const [list, repo] = await Promise.all([
    run(
      "gh",
      [
        "pr",
        "list",
        "-R",
        repoArg,
        "--state",
        "open",
        "-L",
        "30",
        "--json",
        "number,title,url,isDraft,baseRefName,headRefName,reviewDecision,statusCheckRollup,commits",
      ],
      undefined,
      15000,
      env,
    ),
    run("gh", ["repo", "view", repoArg, "--json", "defaultBranchRef"], undefined, 15000, env),
  ]);
  if (!list.ok) throw new Error(`gh: ${(list.err.split("\n")[0] || "").slice(0, 160)}`);
  let def = "";
  try {
    def = String((JSON.parse(repo.out || "{}") as Json).defaultBranchRef?.name || "");
  } catch {
    def = "";
  }
  return toOpenPrs(JSON.parse(list.out || "[]") as Json[], def);
}

export const ghEnv = (host: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  if (host && host !== "github.com") env.GH_HOST = host;
  return env;
};

async function githubCli(repoArg: string, branch: string, host: string): Promise<CiResult> {
  const out: CiResult = {};
  const env = ghEnv(host);
  const pr = await run(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repoArg,
      "--head",
      branch,
      "--state",
      "all",
      "-L",
      "1",
      "--json",
      "number,title,url,state,isDraft,reviewDecision,statusCheckRollup",
    ],
    undefined,
    15000,
    env,
  );
  if (!pr.ok) throw new Error(`gh: ${(pr.err.split("\n")[0] || "").slice(0, 160)}`);
  const list = JSON.parse(pr.out || "[]") as Json[];
  const p = list[0];
  if (p) {
    const st = String(p.state || "").toUpperCase();
    out.pr = {
      number: p.number,
      title: String(p.title || "").slice(0, 300),
      url: safeUrl(p.url),
      state: st === "MERGED" ? "merged" : st === "CLOSED" ? "closed" : p.isDraft ? "draft" : "open",
      review:
        p.reviewDecision === "APPROVED"
          ? "approved"
          : p.reviewDecision === "CHANGES_REQUESTED"
            ? "changes"
            : p.reviewDecision
              ? "pending"
              : null,
      ci: rollup(p.statusCheckRollup),
    };
  }
  const runs = await run(
    "gh",
    ["run", "list", "-R", repoArg, "-b", branch, "-L", "1", "--json", "databaseId,status,conclusion,url,workflowName"],
    undefined,
    15000,
    env,
  );
  try {
    out.ci = runs.ok ? ghRunState((JSON.parse(runs.out || "[]") as Json[])[0]) : { state: "none" };
  } catch {
    out.ci = { state: "none" };
  }
  return out;
}
