import { conflictSummary } from "../../shared/conflict";
import type { ConflictHunks, ConflictSide, ConflictView, OpenPr, Session } from "../../shared/types";

type T = (de: string, en: string) => string;

/** The sentence on top of the drawer, e.g. "3 files in server/http/ changed by both, 1 real merge conflict in security.ts." */
export function conflictSentence(v: Pick<ConflictView, "shared" | "conflicts">, t: T): string {
  const s = conflictSummary(v.shared, v.conflicts);
  const files = s.shared === 1 ? t("1 Datei", "1 file") : t(`${s.shared} Dateien`, `${s.shared} files`);
  const where = s.dir ? ` in ${s.dir}` : "";
  const bad = !s.conflicts
    ? null
    : s.conflicts === 1
      ? t(`1 echter Merge-Konflikt in ${s.first}`, `1 real merge conflict in ${s.first}`)
      : t(
          `${s.conflicts} echte Merge-Konflikte, zuerst in ${s.first}`,
          `${s.conflicts} real merge conflicts, first in ${s.first}`,
        );
  if (!s.shared)
    return bad
      ? t(`Keine Datei von beiden bearbeitet, aber ${bad}.`, `No file edited by both, but ${bad}.`)
      : t(
          "Parallel, ohne Überschneidung: keine Datei von beiden geändert.",
          "Parallel, without overlap: no file changed by both.",
        );
  const head = t(`${files}${where} von beiden geändert`, `${files}${where} changed by both`);
  if (bad) return `${head}, ${bad}.`;
  return s.conflicts === 0
    ? t(`${head}, git führt sie ohne Konflikt zusammen.`, `${head}; git merges them without a conflict.`)
    : `${head}.`;
}

/**
 * The conflict drawer's data from /api/conflict, checked field by field like every server answer (app/lib/run.ts):
 * an odd field costs a line, never the drawer.
 */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const paths = (v: unknown, max = 300): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 1000).slice(0, max) : [];

function side(v: unknown, fallback: string): ConflictSide {
  const o = obj(v);
  return {
    kind: o.kind === "pr" ? "pr" : "session",
    ref: str(o.ref, 200),
    label: str(o.label, 200) || fallback,
    branch: typeof o.branch === "string" ? o.branch.slice(0, 250) : null,
    files: paths(o.files),
    ...(typeof o.status === "string" ? { status: o.status.slice(0, 20) as Session["status"] } : {}),
  };
}

export function parseConflict(raw: unknown): ConflictView | { error: string } {
  const o = obj(raw);
  if (typeof o.error === "string") return { error: o.error.slice(0, 300) };
  return {
    root: str(o.root, 1000),
    repo: str(o.repo, 200),
    a: side(o.a, "A"),
    b: side(o.b, "B"),
    shared: paths(o.shared),
    conflicts: Array.isArray(o.conflicts) ? paths(o.conflicts) : null,
    why: typeof o.why === "string" ? o.why.slice(0, 300) : null,
  };
}

export function parseHunks(raw: unknown): ConflictHunks | { error: string } {
  const o = obj(raw);
  if (typeof o.error === "string") return { error: o.error.slice(0, 300) };
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 40_000) : null);
  return { file: str(o.file, 1000), a: text(o.a), b: text(o.b), truncated: o.truncated === true };
}

const query = (root: string, a: string, b: string) =>
  `root=${encodeURIComponent(root)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;

export async function fetchConflict(root: string, a: string, b: string): Promise<ConflictView | { error: string }> {
  const res = await fetch(`/api/conflict?${query(root, a, b)}`);
  return parseConflict(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
}

export async function fetchHunks(
  root: string,
  a: string,
  b: string,
  file: string,
): Promise<ConflictHunks | { error: string }> {
  const res = await fetch(`/api/conflict/hunks?${query(root, a, b)}&file=${encodeURIComponent(file)}`);
  return parseHunks(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
}

/** What the conflict drawer opens on: two sides of one repo, `s:<session id>` or `pr:<number>`. */
export interface ConflictPair {
  root: string;
  a: string;
  b: string;
  title: string;
}

type PrOf = (root: string, n: number) => Pick<OpenPr, "number" | "conflicts"> | undefined;

/**
 * Every conflict of a session, the way the buttons name them: files it shares with another session first (they
 * collide now), then the open PRs git cannot merge with its PR. `g k` opens the first; the drawer's title says which.
 */
export function conflictsOf(s: Session, prOf: PrOf): ConflictPair[] {
  const root = s.repoRoot;
  if (!root) return [];
  const out: ConflictPair[] = (s.conflict?.with || []).map((w) => ({
    root,
    a: `s:${s.id}`,
    b: `s:${w.id}`,
    title: `${s.title || s.project} ↔ ${w.title}`,
  }));
  const nr = Number(s.ci?.pr?.number);
  for (const c of (nr && prOf(root, nr)?.conflicts) || [])
    out.push({ root, a: `pr:${nr}`, b: `pr:${c.with}`, title: `#${nr} ↔ #${c.with}` });
  return out;
}

/** All known conflicts of the overview, each pair once, for the palette's `conflict` without both sides. */
export function allConflicts(
  sessions: Session[],
  repos: { root: string; prs?: { prs?: Pick<OpenPr, "number" | "conflicts">[] } | null }[],
): ConflictPair[] {
  const seen = new Set<string>();
  const out: ConflictPair[] = [];
  const add = (p: ConflictPair) => {
    const key = [p.root, ...[p.a, p.b].sort()].join("|");
    if (!seen.has(key) && seen.add(key)) out.push(p);
  };
  for (const s of sessions) if (s.repoRoot) for (const p of conflictsOf(s, () => undefined)) add(p);
  for (const r of repos)
    for (const p of r.prs?.prs || [])
      for (const c of p.conflicts || [])
        add({ root: r.root, a: `pr:${p.number}`, b: `pr:${c.with}`, title: `#${p.number} ↔ #${c.with}` });
  return out;
}
