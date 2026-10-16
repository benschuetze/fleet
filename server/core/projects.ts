import path from "node:path";

/**
 * Project briefing: a new session that knows all repos of a project (a desktop app group). The prompt
 * stands visibly in the input field and names only folders and files; Claude reads their content
 * itself, so no foreign HANDOFF.md slips in as an instruction unasked.
 */

/** Common parent folder (the new session sees all repos from there). */
export function commonDir(dirs: string[]): string | null {
  const first = dirs[0];
  if (!first) return null;
  const parts = dirs.map((d) => path.resolve(d).split(path.sep));
  const head = parts[0] ?? [];
  const out: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const seg = head[i];
    if (parts.every((p) => p[i] === seg)) out.push(seg as string);
    else break;
  }
  // Only the drive in common: "D:" would mean "current folder on D" on Windows; "D:\" is meant.
  const root = path.parse(path.resolve(first)).root;
  const dir = out.join(path.sep);
  return dir.length > root.length ? dir : root;
}

export function briefing(
  project: { name: string; repos: string[] },
  repos: { root: string; handoff?: { trusted: boolean } | null }[],
): { cwd: string; prompt: string } | null {
  const roots = project.repos.filter((r) => path.isAbsolute(r));
  const cwd = commonDir(roots);
  if (!cwd) return null;
  // Forward slashes like git, readable on every system.
  const rel = (r: string) => (path.relative(cwd, r) || ".").split(path.sep).join("/");
  const withHandoff = roots
    .filter((r) => repos.find((x) => x.root === r)?.handoff?.trusted)
    .map((r) => rel(path.join(r, "HANDOFF.md")));
  const prompt =
    `Projekt ${project.name}: Verschaff dir einen Überblick über ${roots.map(rel).join(", ")}` +
    (withHandoff.length
      ? ` (Übergaben: ${withHandoff.join(", ")}; sonst git log, offene PRs und README)`
      : " (git log, offene PRs und README)") +
    ". Fass mir zuerst den Stand je Repo in zwei, drei Zeilen zusammen und was projektübergreifend als Nächstes ansteht. Ändere noch nichts.";
  return { cwd, prompt };
}
