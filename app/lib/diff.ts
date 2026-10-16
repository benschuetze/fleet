import type { DiffFile, DiffLine, DiffView, FileView } from "../../shared/types";

/**
 * The diff view's answers, checked like every input (CLAUDE.md): a broken field costs a line or a file, never the
 * view. Sizes are capped again here.
 */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const STATUS = new Set(["M", "A", "D", "R", "U", "E"]);
const KINDS = new Set(["+", "-", " "]);

function line(v: unknown): DiffLine | null {
  const o = obj(v);
  if (!KINDS.has(o.t as string)) return null;
  return { t: o.t as DiffLine["t"], a: num(o.a), b: num(o.b), text: str(o.text, 2000) };
}

function file(v: unknown): DiffFile | null {
  const o = obj(v);
  const path = str(o.path, 1024);
  if (!path || !STATUS.has(o.status as string)) return null;
  const hunks = (Array.isArray(o.hunks) ? o.hunks : []).slice(0, 2000).map((h) => {
    const x = obj(h);
    return {
      header: str(x.header, 500),
      lines: (Array.isArray(x.lines) ? x.lines : [])
        .slice(0, 5000)
        .map(line)
        .filter((l): l is DiffLine => !!l),
    };
  });
  return {
    path,
    old: typeof o.old === "string" ? str(o.old, 1024) : null,
    status: o.status as DiffFile["status"],
    add: num(o.add) ?? 0,
    del: num(o.del) ?? 0,
    mine: o.mine === true,
    binary: o.binary === true,
    cut: o.cut === true,
    hunks,
  };
}

export function parseDiffView(raw: unknown): DiffView | null {
  const o = obj(raw);
  if (!Array.isArray(o.files)) return null;
  return {
    root: str(o.root, 1024),
    branch: typeof o.branch === "string" ? str(o.branch, 300) : null,
    base: str(o.base, 300),
    files: o.files
      .slice(0, 300)
      .map(file)
      .filter((f): f is DiffFile => !!f),
    cut: o.cut === true,
    error: typeof o.error === "string" ? str(o.error, 300) : null,
  };
}

export function parseFileView(raw: unknown): FileView | null {
  const o = obj(raw);
  if (typeof o.path !== "string") return null;
  return {
    path: str(o.path, 1024),
    text: str(o.text, 600_000),
    binary: o.binary === true,
    cut: o.cut === true,
    missing: o.missing === true,
    size: num(o.size) ?? 0,
  };
}

/** Indexes of the first line of every run of changed lines in a file: where `n` jumps. */
export function changeStarts(lines: DiffLine[]): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.t !== " " && (i === 0 || lines[i - 1]?.t === " ")) out.push(i);
  });
  return out;
}

/** The status letter in words, for the file list's label. */
export const STATUS_WORD: Record<DiffFile["status"], [string, string]> = {
  M: ["geändert", "changed"],
  A: ["neu", "added"],
  D: ["gelöscht", "deleted"],
  R: ["umbenannt", "renamed"],
  U: ["neu, nicht in Git", "new, untracked"],
  E: ["außerhalb des Repos bearbeitet", "edited outside the repo"],
};
