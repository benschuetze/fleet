import type { CiResult, CiState, Config, PullRequest, Remote } from "../../../shared/types";
import { token } from "../config";
import { tr } from "../lang";
import { encPath, http, type Json, safeUrl } from "./http";

type Cfg = Pick<Config, "tokens" | "prRefreshSeconds">;
type Review = PullRequest["review"];

/** Bitbucket Cloud: pull requests and commit statuses. */
function bbState(statuses: Json[] | null | undefined): CiState {
  if (!statuses?.length) return "none";
  if (statuses.some((s) => s.state === "FAILED" || s.state === "STOPPED")) return "failure";
  if (statuses.some((s) => s.state === "INPROGRESS")) return "running";
  return "success";
}

export async function bitbucket(remote: Remote, branch: string, cfg: Cfg): Promise<CiResult> {
  if (remote.host !== "bitbucket.org")
    return {
      hint: tr(
        "Bitbucket Server/Data Center wird noch nicht unterstützt",
        "Bitbucket Server/Data Center is not supported yet",
      ),
    };
  const user = token(cfg, "bitbucketUser", "BITBUCKET_USER");
  const tok = token(cfg, "bitbucketToken", "BITBUCKET_TOKEN", "BITBUCKET_APP_PASSWORD");
  const h: Record<string, string> = !tok
    ? {}
    : user
      ? { Authorization: `Basic ${Buffer.from(`${user}:${tok}`).toString("base64")}` }
      : { Authorization: `Bearer ${tok}` };
  const api = `https://api.bitbucket.org/2.0/repositories/${encPath(remote.path)}`;
  const out: CiResult = {};
  const q = encodeURIComponent(`source.branch.name="${branch.replace(/["\\]/g, "\\$&")}"`);
  const prs = await http(
    `${api}/pullrequests?q=${q}&state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=1`,
    h,
  );
  const p = prs.values?.[0] as Json | undefined;
  if (p) {
    let ci: CiState = "none";
    let review: Review = null;
    if (p.state === "OPEN") {
      try {
        ci = bbState((await http(`${api}/pullrequests/${Number(p.id)}/statuses?pagelen=50`, h)).values);
      } catch {
        // optional
      }
      const parts: Json[] = p.participants || [];
      if (parts.some((x) => x.state === "changes_requested")) review = "changes";
      else if (parts.some((x) => x.approved)) review = "approved";
      else if (parts.some((x) => x.role === "REVIEWER")) review = "pending";
    }
    out.pr = {
      number: Number(p.id),
      title: String(p.title || "").slice(0, 300),
      url: safeUrl(p.links?.html?.href),
      state: p.state === "MERGED" ? "merged" : p.state === "DECLINED" ? "closed" : p.draft ? "draft" : "open",
      review,
      ci,
    };
  }
  try {
    const br = await http(`${api}/refs/branches/${encodeURIComponent(branch)}`, h);
    const st = await http(
      `${api}/commit/${encodeURIComponent(br.target.hash)}/statuses?pagelen=50&sort=-updated_on`,
      h,
    );
    const v: Json[] = st.values || [];
    out.ci = { state: bbState(v), url: safeUrl(v[0]?.url), name: v[0]?.name };
  } catch {
    out.ci = { state: "none" };
  }
  return out;
}
