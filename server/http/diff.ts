import path from "node:path";
import type { Overview, Session } from "../../shared/types";
import { demoDiff, demoFile } from "../core/demo-diff";
import { changedNames, diffView, readFileView } from "../core/diff";
import { tr } from "../core/lang";
import { editedFiles, editedOutside } from "../core/overview";
import { ID_RE } from "../core/paths";
import type { Handler } from "./api";
import { HttpError, send } from "./security";

/**
 * The diff and files view (release 6, plan R9, R10). The request names a session and, for one file, a path; the
 * folder comes from the overview, the path must be one of git's changed files or the session's own edits.
 */

function sessionOf(data: Overview, url: URL): Session {
  const id = url.searchParams.get("id") || "";
  if (!ID_RE.test(id)) throw new HttpError(400, tr("id fehlt oder ungültig", "id missing or invalid"));
  const s = data.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, tr("Session nicht gefunden", "session not found"));
  return s;
}

const rootOf = (s: Session) => (s.repoRoot && path.isAbsolute(s.repoRoot) ? s.repoRoot : null);

export const DIFF_GET: Record<string, Handler> = {
  "/api/diff": async (_req, res, url, ctx) => {
    const data = (await ctx.overview()).data;
    const s = sessionOf(data, url);
    if (ctx.demo) return send(res, 200, demoDiff(s), undefined, { "Cache-Control": "no-store" });
    const outside = editedOutside.get(data)?.get(s.id) || [];
    const root = rootOf(s);
    if (!root)
      return send(res, 200, {
        root: s.cwd || "",
        branch: null,
        base: "—",
        files: outside.map((p) => ({
          path: p,
          old: null,
          status: "E",
          add: 0,
          del: 0,
          mine: true,
          binary: false,
          cut: false,
          hunks: [],
        })),
        cut: false,
        error: tr("Kein Git-Repo – nur die bearbeiteten Dateien", "No git repo: only the edited files"),
      });
    const view = await diffView(root, s.branch || null, editedFiles.get(data)?.get(s.id) || [], outside);
    send(res, 200, view, undefined, { "Cache-Control": "no-store" });
  },
  "/api/file": async (_req, res, url, ctx) => {
    const data = (await ctx.overview()).data;
    const s = sessionOf(data, url);
    const p = url.searchParams.get("path") || "";
    if (!p || p.length > 1024 || p.includes("\0")) throw new HttpError(400, tr("Pfad ungültig", "invalid path"));
    if (ctx.demo) {
      const f = demoFile(p, s || undefined);
      return f ? send(res, 200, f) : send(res, 404, { error: tr("Datei nicht in der Liste", "file not in the list") });
    }
    const root = rootOf(s);
    const allowed = new Set([
      ...(root ? await changedNames(root) : []),
      ...(editedFiles.get(data)?.get(s.id) || []),
      ...(editedOutside.get(data)?.get(s.id) || []),
    ]);
    const f = readFileView(root || "/", p, allowed);
    if (!f) return send(res, 404, { error: tr("Datei nicht in der Liste", "file not in the list") });
    send(res, 200, f, undefined, { "Cache-Control": "no-store" });
  },
};
