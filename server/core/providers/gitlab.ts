import type { CiResult, CiState, Config, PullRequest, Remote } from "../../../shared/types";
import { token } from "../config";
import { tr } from "../lang";
import { http, type Json, safeUrl } from "./http";

type Cfg = Pick<Config, "tokens" | "prRefreshSeconds">;
type Review = PullRequest["review"];

/** GitLab (gitlab.com or a host from hostMap): merge requests and pipelines. */
export function glState(v: unknown): CiState {
  const s = String(v || "").toLowerCase();
  if (s === "success") return "success";
  if (s === "failed" || s === "canceled") return "failure";
  if (s === "running") return "running";
  if (["pending", "created", "waiting_for_resource", "preparing", "scheduled", "manual"].includes(s)) return "pending";
  return "none";
}

export async function gitlab(remote: Remote, branch: string, cfg: Cfg): Promise<CiResult> {
  const tok = token(cfg, "gitlab", "GITLAB_TOKEN");
  const api = `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}`;
  const h: Record<string, string> = tok ? { "PRIVATE-TOKEN": tok } : {};
  const out: CiResult = {};
  const mrs = await http(
    `${api}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at&per_page=1`,
    h,
  );
  if (Array.isArray(mrs) && mrs[0]) {
    const m = mrs[0] as Json;
    const open = m.state === "opened";
    let ci: CiState = "none";
    let review: Review = null;
    if (open) {
      const [d, ap] = await Promise.all([
        http(`${api}/merge_requests/${m.iid}`, h).catch(() => null),
        http(`${api}/merge_requests/${m.iid}/approvals`, h).catch(() => null),
      ]);
      if (d) ci = glState(d.head_pipeline?.status);
      if (ap) {
        review = ap.approved
          ? "approved"
          : ap.approvals_required || ap.approvals_left
            ? "pending"
            : (ap.approved_by || []).length
              ? "approved"
              : null;
      }
      if (d && d.detailed_merge_status === "requested_changes") review = "changes";
    }
    out.pr = {
      number: `!${m.iid}`,
      title: String(m.title || "").slice(0, 300),
      url: safeUrl(m.web_url),
      state:
        m.state === "merged"
          ? "merged"
          : m.state === "closed"
            ? "closed"
            : m.draft || m.work_in_progress
              ? "draft"
              : "open",
      review,
      ci,
    };
  }
  try {
    const p = await http(`${api}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`, h);
    const first = Array.isArray(p) ? (p[0] as Json | undefined) : undefined;
    out.ci = first
      ? { state: glState(first.status), url: safeUrl(first.web_url), name: `Pipeline #${Number(first.id)}` }
      : { state: "none" };
  } catch {
    out.ci = { state: "none" };
  }
  if (!tok) out.hint = tr("Ohne GitLab-Token nur öffentliche Projekte", "Without a GitLab token: public projects only");
  return out;
}
