import type { CiResult, CiState, Config, Remote } from "../../../shared/types";
import { token } from "../config";
import { tr } from "../lang";
import { http, type Json, safeUrl } from "./http";

type Cfg = Pick<Config, "tokens" | "prRefreshSeconds">;

/** Azure DevOps: pull requests and builds. */
const azRepoIds = new Map<string, string>();

function azBuildState(b: Json | null | undefined): NonNullable<CiResult["ci"]> {
  if (!b) return { state: "none" };
  let state: CiState = "success";
  if (b.status !== "completed") state = b.status === "inProgress" ? "running" : "pending";
  else if (b.result === "failed" || b.result === "canceled" || b.result === "partiallySucceeded") state = "failure";
  return { state, url: safeUrl(b._links?.web?.href), name: b.definition?.name };
}

export async function azure(remote: Remote, branch: string, cfg: Cfg): Promise<CiResult> {
  const pat = token(cfg, "azureDevOps", "AZURE_DEVOPS_PAT", "AZURE_DEVOPS_EXT_PAT");
  if (!pat)
    return { hint: tr("Azure-DevOps-PAT fehlt (tokens.azureDevOps)", "Azure DevOps PAT missing (tokens.azureDevOps)") };
  const h = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}` };
  const base = `https://dev.azure.com/${encodeURIComponent(String(remote.org))}/${encodeURIComponent(String(remote.project))}/_apis`;
  const v = "api-version=7.0";
  let repoId = azRepoIds.get(remote.path);
  if (!repoId) {
    const r = await http(`${base}/git/repositories/${encodeURIComponent(remote.repo)}?${v}`, h);
    if (!r || typeof r.id !== "string") throw new Error(tr("Repo nicht gefunden", "Repo not found"));
    repoId = r.id as string;
    azRepoIds.set(remote.path, repoId);
  }
  const rid = encodeURIComponent(repoId);
  const out: CiResult = {};
  const prs = await http(
    `${base}/git/repositories/${rid}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=1&${v}`,
    h,
  );
  const p = prs.value?.[0] as Json | undefined;
  if (p) {
    const votes: number[] = (p.reviewers || []).map((r: Json) => r.vote);
    let ci: CiState = "none";
    if (p.status === "active") {
      try {
        const b = await http(
          `${base}/build/builds?repositoryId=${rid}&repositoryType=TfsGit&branchName=${encodeURIComponent(`refs/pull/${Number(p.pullRequestId)}/merge`)}&$top=1&queryOrder=queueTimeDescending&${v}`,
          h,
        );
        ci = azBuildState(b.value?.[0]).state;
      } catch {
        // optional
      }
    }
    out.pr = {
      number: Number(p.pullRequestId),
      title: String(p.title || "").slice(0, 300),
      url: `${remote.webUrl}/pullrequest/${Number(p.pullRequestId)}`,
      state: p.status === "completed" ? "merged" : p.status === "abandoned" ? "closed" : p.isDraft ? "draft" : "open",
      review: votes.some((x) => x < 0)
        ? "changes"
        : votes.some((x) => x >= 5)
          ? "approved"
          : votes.length
            ? "pending"
            : null,
      ci,
    };
  }
  try {
    const b = await http(
      `${base}/build/builds?repositoryId=${rid}&repositoryType=TfsGit&branchName=${encodeURIComponent(`refs/heads/${branch}`)}&$top=1&queryOrder=queueTimeDescending&${v}`,
      h,
    );
    out.ci = azBuildState(b.value?.[0]);
  } catch {
    out.ci = { state: "none" };
  }
  return out;
}
