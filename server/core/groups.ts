import path from "node:path";
import { repoKey } from "../../shared/repo";
import type { Duplicate, GitInfo, Project, Session } from "../../shared/types";

/** Pieces of the overview: sessions only hooks know, conflicts, duplicates and desktop app groups as projects. */

export const httpsUrl = (u: unknown) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
export const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
export const ACTIVE = ["working", "stale", "needs_input"];
export const isActive = (s: Pick<Session, "status">) => ACTIVE.includes(String(s.status));

/** Sessions known only from hooks (just started, no transcript yet) and Cowork sessions (no local transcript at all). */
export function addHookOnly(
  sessions: Session[],
  byId: Map<string, Session>,
  hooks: Record<string, NonNullable<Session["hook"]>>,
  now: number,
) {
  // Cowork: the same session (same link) may exist under an older id: show only the newest.
  const newestByUrl = new Map<string, NonNullable<Session["hook"]>>();
  for (const h of Object.values(hooks)) {
    const cur = h.url ? newestByUrl.get(h.url) : undefined;
    if (h.source === "cowork" && h.url && (!cur || cur.at < h.at)) newestByUrl.set(h.url, h);
  }
  for (const h of Object.values(hooks)) {
    if (h.source === "cowork" && h.url && newestByUrl.get(h.url) !== h) continue;
    const cowork = h.source === "cowork";
    if (byId.has(h.sessionId) || (!cowork && h.status === "ended") || now - h.at >= (cowork ? 3 * 86400e3 : 6 * 3600e3))
      continue;
    const s: Session = cowork
      ? {
          id: h.sessionId,
          source: "cowork",
          cwd: null,
          title: str(h.title, 200),
          url: httpsUrl(h.url),
          lastPrompt: str(h.lastPrompt, 200),
          firstPrompt: str(h.title || h.lastPrompt, 160),
          lastAssistant: str(h.lastAnswer, 400),
          lastTool: str(h.lastTool, 80),
          startedAt: h.startedAt,
          model: str(h.model, 80),
          mtime: 0,
        }
      : {
          id: h.sessionId,
          source: "local",
          cwd: str(h.cwd, 1000),
          lastPrompt: str(h.lastPrompt, 200),
          firstPrompt: str(h.lastPrompt, 160),
          mtime: 0,
        };
    sessions.push(s);
    byId.set(s.id, s);
  }
}

/**
 * Conflicts: active sessions in the same repo that edited the same files. The same branch alone is no conflict
 * (spec, Konflikt-Visualisierung: only a non-empty file intersection counts); it is named when both apply.
 */
export function markConflicts(visible: Session[], now: number) {
  const busy = visible.filter(
    (s) =>
      s.repoRoot && !s.next && (isActive(s) || (s.status === "waiting" && now - (s.lastActivity || 0) < 30 * 60e3)),
  );
  // Files relative to each session's checkout: a session in a worktree (release 6.1.0) and one in the main folder
  // edit the same file under two paths. Checkouts of one remote are one repo (repoKey).
  const rel = (s: Session) =>
    new Set(
      (s.edited || [])
        .map((f) =>
          path
            .relative(s.repoRoot as string, f)
            .split(path.sep)
            .join("/"),
        )
        .filter((f) => f && !f.startsWith("../") && !path.isAbsolute(f)),
    );
  const files = new Map(busy.map((s) => [s, rel(s)]));
  for (const s of busy) {
    const mine = files.get(s) as Set<string>;
    const others = busy.filter((o) => o !== s && repoKey(o) === repoKey(s));
    const shared = others
      .map((o) => ({ o, files: [...(files.get(o) as Set<string>)].filter((f) => mine.has(f)) }))
      .filter((x) => x.files.length);
    if (shared.length) {
      s.conflict = {
        with: shared.map((x) => ({ id: x.o.id, title: String(x.o.title || "") })),
        sameBranch: shared.some((x) => !!s.branch && x.o.branch === s.branch),
        files: [...new Set(shared.flatMap((x) => x.files))].slice(0, 5),
      };
    }
  }
}

// Fleet itself renames a session it replaced (see handoff/start.ts). The name is the one trace that survives when
// the stored link is gone (handoffs from before 3.0, or a registry that was reset).
// A session nobody touched for an hour is parked, not juggled: it shows under "Ruht", not as a duplicate.
const IN_USE = 60 * 60e3;
const REPLACED_TITLE = /\s·\s(abgelöst|replaced|zusammengefasst|merged)\b/i;

/** Task title as a key: case, spacing and the suffixes Fleet appends (start time, "replaced …") do not count. */
export function titleKey(title: unknown): string {
  return String(title || "")
    .replace(/\s·\s(abgelöst|replaced|zusammengefasst|merged)\b.*$/i, "")
    .replace(/\s·\s\d{1,2}[./]\d{1,2}\.?,?\s+\d{1,2}:\d{2}\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const REASONS: Duplicate["reason"][] = ["files", "branch", "title"];

/**
 * Two sessions in the same checkout that get in each other's way: they edited the same files, work on the same
 * branch (commits of one invalidate the other's context), or carry the same task. Only shared files make it
 * "Doppelt" (`overlap`); branch or task alone stay a grey "parallel, without overlap" with the offer to merge.
 * Several sessions in one repo without any of that work in parallel and are not listed at all. Not counted: sessions Fleet replaced itself (successor
 * known, renamed as replaced, or handoff written and the new session about to start) – a fresh start must never
 * look like a duplicate.
 */
export function findDuplicates(
  visible: Session[],
  repos: Map<string, GitInfo>,
  now: number,
  handingOver: Set<string>,
): Duplicate[] {
  const byRoot = new Map<string, Session[]>();
  for (const s of visible) {
    if (
      s.source !== "local" ||
      !s.repoRoot ||
      s.next ||
      handingOver.has(s.id) ||
      REPLACED_TITLE.test(String(s.title || "")) ||
      s.meta?.hidden ||
      s.status === "ended" ||
      (!isActive(s) && now - (s.lastActivity || 0) > IN_USE)
    )
      continue;
    byRoot.set(s.repoRoot, [...(byRoot.get(s.repoRoot) || []), s]);
  }
  const out: Duplicate[] = [];
  for (const [root, list] of byRoot) {
    // Pairs with a reason, then the connected groups (A~B and B~C is one group).
    const pairs: { a: Session; b: Session; reason: Duplicate["reason"]; files: string[]; branch: string | null }[] = [];
    const parent = new Map<Session, Session>(list.map((s) => [s, s]));
    const find = (s: Session): Session => {
      let r = s;
      while (parent.get(r) !== r) r = parent.get(r) as Session;
      return r;
    };
    list.forEach((a, i) => {
      for (const b of list.slice(i + 1)) {
        const mine = new Set(a.edited || []);
        const files = (b.edited || []).filter((f) => mine.has(f));
        const branch = a.branch && a.branch === b.branch ? a.branch : null;
        const sameTitle = !!titleKey(a.title) && titleKey(a.title) === titleKey(b.title);
        const reason = files.length ? "files" : branch ? "branch" : sameTitle ? "title" : null;
        if (!reason) continue;
        pairs.push({ a, b, reason, files, branch });
        parent.set(find(b), find(a));
      }
    });
    const groups = new Map<Session, Session[]>();
    for (const s of list)
      if (pairs.some((p) => p.a === s || p.b === s)) groups.set(find(s), [...(groups.get(find(s)) || []), s]);
    for (const [r, ms] of groups) {
      const own = pairs.filter((p) => find(p.a) === r);
      const files = [...new Set(own.flatMap((p) => p.files))];
      out.push({
        root,
        repo: repos.get(root)?.name || path.basename(root),
        reason: REASONS.find((x) => own.some((p) => p.reason === x)) || "title",
        overlap: files.length > 0,
        files: files.slice(0, 5).map((f) => path.relative(root, f).split(path.sep).join("/")),
        pairs: own.filter((p) => p.files.length).map((p) => [p.a.id, p.b.id]),
        branch: own.find((p) => p.branch)?.branch || null,
        sessions: ms
          .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
          .map((x) => ({ id: x.id, title: String(x.title || ""), status: x.status, cwd: x.cwd || null })),
        busy: ms.some(isActive),
      });
    }
  }
  return out;
}

/** Projects: desktop app groups with their sessions and the repos they worked in. */
export function groupProjects(visible: Session[], repos: Map<string, GitInfo>): Project[] {
  const projects = new Map<string, Project>();
  for (const s of visible) {
    if (!s.group) continue;
    const p = projects.get(s.group.id) || {
      id: s.group.id,
      name: s.group.name,
      sessions: [],
      repos: [],
      active: 0,
      cost: 0,
      lastActivity: 0,
    };
    p.sessions.push(s.id);
    for (const r of s.repoRoots || []) if (!p.repos.includes(r)) p.repos.push(r);
    // Worktrees of the same repo count once; the main folder (shortest path) stays.
    const key = (r: string) => repos.get(r)?.remote?.webUrl || r;
    p.repos = [
      ...new Map(
        p.repos
          .slice()
          .sort((a, b) => b.length - a.length)
          .map((r) => [key(r), r]),
      ).values(),
    ].sort((a, b) => p.repos.indexOf(a) - p.repos.indexOf(b));
    if (isActive(s)) p.active++;
    p.cost += s.usage?.cost || 0;
    p.lastActivity = Math.max(p.lastActivity, s.lastActivity || 0);
    projects.set(s.group.id, p);
  }
  return [...projects.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}
