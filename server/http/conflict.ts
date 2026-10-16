import type { Overview } from "../../shared/types";
import { conflictHunks, conflictView, type SideIn } from "../core/conflict";
import { demoConflictHunks, demoConflictView } from "../core/demo-conflict";
import { tr } from "../core/lang";
import { editedFiles } from "../core/overview";
import { ID_RE } from "../core/paths";
import type { Handler } from "./api";
import { HttpError, send } from "./security";

/**
 * The conflict drawer: two sides of one repo, each a session (`s:<id>`) or an open PR (`pr:<number>`). The request
 * only names them; repo, folders, branches and files come from Fleet's own overview.
 */

const key = (x: { remote?: { host: string; path: string } | null }, root: string) =>
  x.remote ? `${x.remote.host}/${x.remote.path}` : root;

function sideOf(data: Overview, root: string, ref: unknown): SideIn {
  if (typeof ref !== "string" || ref.length > 200)
    throw new HttpError(400, tr("Seite fehlt oder ungültig", "side missing or invalid"));
  const repo = data.repos.find((r) => r.root === root);
  if (!repo) throw new HttpError(404, tr("Repo nicht gefunden", "repo not found"));
  const sid = /^s:(.+)$/.exec(ref)?.[1];
  if (sid !== undefined) {
    if (!ID_RE.test(sid)) throw new HttpError(400, tr("id ungültig", "id invalid"));
    const s = data.sessions.find((x) => x.id === sid);
    // A session of the same repo, also from another worktree of it.
    if (!s?.repoRoot || key(s, s.repoRoot) !== key(repo, repo.root))
      throw new HttpError(404, tr("Session nicht gefunden", "session not found"));
    return {
      kind: "session",
      ref,
      label: String(s.title || s.project || sid).slice(0, 200),
      branch: s.branch || null,
      dir: s.repoRoot,
      files: editedFiles.get(data)?.get(s.id) || [],
      status: s.status,
    };
  }
  const n = /^pr:(\d{1,7})$/.exec(ref)?.[1];
  if (n === undefined) throw new HttpError(400, tr("Seite ungültig", "side invalid"));
  const pr = repo.prs?.prs?.find((p) => p.number === Number(n));
  if (!pr) throw new HttpError(404, tr("kein offener PR mit dieser Nummer", "no open PR with this number"));
  return { kind: "pr", ref, label: `#${pr.number} ${pr.title}`.slice(0, 200), branch: pr.head, base: pr.base };
}

async function sides(ctx: Parameters<Handler>[3], url: URL) {
  const data = (await ctx.overview()).data;
  const root = url.searchParams.get("root") || "";
  const a = sideOf(data, root, url.searchParams.get("a"));
  const b = sideOf(data, root, url.searchParams.get("b"));
  if (a.ref === b.ref) throw new HttpError(400, tr("zweimal dieselbe Seite", "the same side twice"));
  const repo = data.repos.find((r) => r.root === root);
  return { root, name: repo?.name || root, a, b };
}

export const CONFLICT_GET: Record<string, Handler> = {
  "/api/conflict": async (_req, res, url, ctx) => {
    const { root, name, a, b } = await sides(ctx, url);
    send(res, 200, ctx.demo ? demoConflictView(root, name, a, b) : await conflictView(root, name, a, b));
  },
  "/api/conflict/hunks": async (_req, res, url, ctx) => {
    const { root, a, b } = await sides(ctx, url);
    const file = url.searchParams.get("file") || "";
    if (!file || file.length > 1000) throw new HttpError(400, tr("Datei fehlt", "file missing"));
    const h = ctx.demo ? demoConflictHunks(a, b, file) : await conflictHunks(root, a, b, file);
    if (!h)
      return send(res, 404, { error: tr("Datei gehört zu keiner der beiden Seiten", "file belongs to neither side") });
    send(res, 200, h);
  },
};
