/**
 * The folder tree of the conflict drawer (spec, Konflikt-Visualisierung): side A left, side B right, one tree of
 * the files either changed in the middle. Only folders with a file both changed are open; the rest stays folded
 * with its count. Pure, so the browser and the tests share it.
 */

export interface TreeFile {
  name: string;
  path: string;
  a: boolean;
  b: boolean;
  conflict: boolean;
}

export interface TreeDir {
  name: string;
  path: string;
  open: boolean;
  /** Files below, all levels. */
  count: number;
  both: number;
  dirs: TreeDir[];
  files: TreeFile[];
}

export function conflictTree(a: string[], b: string[], conflicts: string[] = []): TreeDir {
  const inA = new Set(a);
  const inB = new Set(b);
  const bad = new Set(conflicts);
  const root: TreeDir = { name: "", path: "", open: true, count: 0, both: 0, dirs: [], files: [] };
  for (const p of [...new Set([...a, ...b, ...conflicts])].sort()) {
    const parts = p.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let dir = root;
    const trail = [root];
    for (const seg of parts) {
      const at = dir.path ? `${dir.path}/${seg}` : seg;
      let next = dir.dirs.find((d) => d.name === seg);
      if (!next) {
        next = { name: seg, path: at, open: false, count: 0, both: 0, dirs: [], files: [] };
        dir.dirs.push(next);
      }
      dir = next;
      trail.push(dir);
    }
    const f: TreeFile = { name, path: p, a: inA.has(p), b: inB.has(p), conflict: bad.has(p) };
    dir.files.push(f);
    const hot = (f.a && f.b) || f.conflict;
    for (const d of trail) {
      d.count++;
      if (hot) {
        d.both++;
        d.open = true;
      }
    }
  }
  // A folder with a single subfolder and no files is one step: "server/http" instead of "server" › "http".
  const squash = (d: TreeDir): TreeDir => {
    d.dirs = d.dirs.map(squash);
    const only = d.dirs[0];
    if (d !== root && d.dirs.length === 1 && !d.files.length && only)
      return { ...only, name: `${d.name}/${only.name}` };
    return d;
  };
  return squash(root);
}

/**
 * The sentence on top: how many files both changed and where, how many git cannot merge. The folder is the
 * deepest one all shared files sit in ("server/http/"), null for the repo root.
 */
export function conflictSummary(shared: string[], conflicts: string[] | null) {
  const dirs = shared.map((f) => f.split("/").slice(0, -1));
  let common: string[] = dirs[0] || [];
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const base = (f: string) => f.split("/").pop() || f;
  return {
    shared: shared.length,
    dir: shared.length && common.length ? `${common.join("/")}/` : null,
    conflicts: conflicts ? conflicts.length : null,
    first: conflicts?.[0] ? base(conflicts[0]) : null,
  };
}
