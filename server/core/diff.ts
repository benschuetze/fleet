import fs from "node:fs";
import path from "node:path";
import type { DiffFile, DiffHunk, DiffView, FileView } from "../../shared/types";
import { defaultBase } from "./conflict";
import { git } from "./git";

/**
 * What a session changed in its checkout (release 6, plan R9, R10): the diff of the working tree against where the
 * branch left the default branch (merge base), with uncommitted and untracked files, plus the files the session
 * edited outside git's view. Read only: never fetch, never write the index, a ref or the working tree; no external
 * diff or text conversion; paths only from git's own lists and the session's edit list.
 */

const SHA = /^[0-9a-f]{40,64}$/;
/** git's empty tree: the base of a repo without a commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const MAX_FILES = 300;
const MAX_FILE_LINES = 3000;
const MAX_TOTAL_CHARS = 2_000_000;
export const MAX_FILE_BYTES = 512 * 1024;
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/** The commit the branch is compared to: merge base with the default branch, else HEAD, else the empty tree. */
export async function diffBase(root: string): Promise<{ sha: string; label: string }> {
  const def = await defaultBase(root);
  if (def) {
    const mb = await git(["merge-base", "HEAD", def.sha], root, 4000);
    if (mb.ok && SHA.test(mb.out)) return { sha: mb.out, label: def.name };
  }
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root, 4000);
  if (head.ok && SHA.test(head.out)) return { sha: head.out, label: "HEAD" };
  return { sha: EMPTY_TREE, label: "∅" };
}

/** A path git quotes ("a\tb", octal for non-ASCII) back to its text. */
export function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const n = s[i + 1] || "";
    if (/[0-7]/.test(n)) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(({ t: 9, n: 10, r: 13, '"': 34, "\\": 92 } as Record<string, number>)[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const side = (line: string, prefix: string) => {
  const v = unquote(line.slice(4).trim());
  if (v === "/dev/null") return null;
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
};

/** `git diff` output as files with hunks and numbered lines; long files are cut, with a mark. */
export function parseDiff(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: DiffHunk | null = null;
  let a = 0;
  let b = 0;
  let lines = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      f = {
        // A first guess; the `+++`/`rename to` lines below name it exactly.
        path: m ? (m[2] as string) : line.slice(11),
        old: null,
        status: "M",
        add: 0,
        del: 0,
        mine: false,
        binary: false,
        cut: false,
        hunks: [],
      };
      files.push(f);
      h = null;
      lines = 0;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith("new file mode")) f.status = "A";
      else if (line.startsWith("deleted file mode")) f.status = "D";
      else if (line.startsWith("rename from ")) {
        f.status = "R";
        f.old = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) f.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ")) f.binary = true;
      else if (line.startsWith("--- ")) {
        const p = side(line, "a/");
        if (p && f.status !== "R") f.path = f.path || p;
      } else if (line.startsWith("+++ ")) {
        const p = side(line, "b/");
        if (p) f.path = p;
      }
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hm) {
      a = Number(hm[1]);
      b = Number(hm[2]);
      h = { header: line, lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const t = line[0];
    if (t !== "+" && t !== "-" && t !== " ") continue;
    if (t === "+") f.add++;
    if (t === "-") f.del++;
    if (lines >= MAX_FILE_LINES) {
      f.cut = true;
      continue;
    }
    lines++;
    h.lines.push({
      t,
      a: t === "+" ? null : a,
      b: t === "-" ? null : b,
      text: line.slice(1),
    });
    if (t !== "+") a++;
    if (t !== "-") b++;
  }
  return files;
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/** A new file git does not track yet, as an added file with all its lines. */
function untracked(root: string, rel: string): DiffFile {
  const f: DiffFile = {
    path: rel,
    old: null,
    status: "U",
    add: 0,
    del: 0,
    mine: false,
    binary: false,
    cut: false,
    hunks: [],
  };
  try {
    const full = path.join(root, rel);
    const st = fs.lstatSync(full);
    if (!st.isFile()) return f;
    if (st.size > MAX_FILE_BYTES) {
      f.cut = true;
      return f;
    }
    const buf = fs.readFileSync(full);
    if (isBinary(buf)) {
      f.binary = true;
      return f;
    }
    const all = buf.toString("utf8").replace(/\n$/, "").split("\n");
    const shown = all.slice(0, MAX_FILE_LINES);
    f.add = all.length;
    f.cut = all.length > shown.length;
    f.hunks = [
      {
        header: `@@ -0,0 +1,${all.length} @@`,
        lines: shown.map((text, i) => ({ t: "+" as const, a: null, b: i + 1, text })),
      },
    ];
  } catch {
    // gone in the meantime: an empty entry still says it was there
  }
  return f;
}

/** The changed files' names only: what /api/file may read. */
export async function changedNames(root: string): Promise<string[]> {
  const base = await diffBase(root);
  const [d, u] = await Promise.all([
    git(["diff", "--name-only", "-z", "--no-renames", base.sha, "--"], root, 15_000),
    git(["ls-files", "--others", "--exclude-standard", "-z"], root, 15_000),
  ]);
  return [...d.out.split("\0"), ...u.out.split("\0")].filter(Boolean);
}

/**
 * The session's changes: every changed and untracked file of its checkout, the ones it edited itself marked and first;
 * files it edited outside the repo follow as their own entries (`E`, content only).
 */
export async function diffView(
  root: string,
  branch: string | null,
  edited: string[],
  outside: string[],
): Promise<DiffView> {
  const base = await diffBase(root);
  const [d, u] = await Promise.all([
    git(["diff", ...DIFF, base.sha, "--"], root, 20_000),
    git(["ls-files", "--others", "--exclude-standard", "-z"], root, 15_000),
  ]);
  let files = parseDiff(d.out);
  for (const rel of u.out.split("\0").filter(Boolean)) files.push(untracked(root, rel));
  const mine = new Set(edited);
  for (const f of files) f.mine = mine.has(f.path);
  for (const p of outside)
    files.push({ path: p, old: null, status: "E", add: 0, del: 0, mine: true, binary: false, cut: false, hunks: [] });
  // The session's own files first, then by path.
  files.sort((x, y) => Number(y.mine) - Number(x.mine) || x.path.localeCompare(y.path));
  let cut = files.length > MAX_FILES;
  files = files.slice(0, MAX_FILES);
  let chars = 0;
  for (const f of files) {
    for (const h of f.hunks) for (const l of h.lines) chars += l.text.length;
    if (chars > MAX_TOTAL_CHARS) {
      f.hunks = [];
      f.cut = true;
      cut = true;
    }
  }
  return { root, branch, base: base.label, files, cut, error: d.ok ? null : d.err.slice(0, 300) || "git diff" };
}

/**
 * One file's text for the files view: only a path from `allowed` (git's changed files, the session's edits), inside
 * the root unless it is one of the session's own edits outside it; no links, no binaries, at most MAX_FILE_BYTES.
 */
export function readFileView(root: string, p: string, allowed: Set<string>): FileView | null {
  if (!allowed.has(p)) return null;
  const full = path.isAbsolute(p) ? p : path.join(root, p);
  if (!path.isAbsolute(p) && path.relative(root, full).startsWith("..")) return null;
  try {
    // A link in a folder on the way could lead out of the repo (audit L3): the real path must stay inside the real root.
    if (!path.isAbsolute(p)) {
      const real = fs.realpathSync(full);
      const rel = path.relative(fs.realpathSync(root), real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    }
    const st = fs.lstatSync(full);
    if (!st.isFile()) return { path: p, text: "", binary: false, cut: false, missing: true, size: 0 };
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (isBinary(buf)) return { path: p, text: "", binary: true, cut: false, missing: false, size: st.size };
      return {
        path: p,
        text: buf.toString("utf8"),
        binary: false,
        cut: st.size > MAX_FILE_BYTES,
        missing: false,
        size: st.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { path: p, text: "", binary: false, cut: false, missing: true, size: 0 };
  }
}
