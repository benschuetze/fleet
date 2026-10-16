import path from "node:path";
import type {
  ConflictHunks,
  ConflictSide,
  ConflictView,
  OpenPr,
  OpenPrs,
  PrConflict,
  Session,
} from "../../shared/types";
import { git, validBranch } from "./git";
import { tr } from "./lang";

/*
 * What two sessions or PRs of one repo both change (spec, Konflikt-Visualisierung), all local and without tokens:
 *  - sessions: the files their transcripts edited (the overview keeps them on the server)
 *  - PRs: `git diff --name-only base...head` of the branch Fleet finds locally
 *  - real conflicts: `git merge-tree --write-tree` (Git 2.38+), a probe merge without checkout; it only writes
 *    objects, never the index, a ref or the working tree, so it never gets in the way of a session
 * Fleet never fetches: a PR whose branch is not in the checkout stays without a probe, and the drawer says why.
 * Branch names are checked, then resolved to SHAs; only SHAs and checked paths reach git, paths after `--` and as
 * literal pathspecs.
 */

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_FILES = 300;
const MAX_LINES = 300;
const MAX_CHARS = 30_000;

/** A branch as a commit: the remote one first for PRs (what GitHub merges), the local one for sessions. */
export async function resolveRef(root: string, branch: unknown, prefer: "remote" | "local"): Promise<string | null> {
  if (!validBranch(branch)) return null;
  const refs = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
  for (const ref of prefer === "remote" ? refs : refs.reverse()) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root, 4000);
    if (r.ok && SHA.test(r.out)) return r.out;
  }
  return null;
}

/** The branch PRs go into: origin's HEAD, else main or master. */
export async function defaultBase(root: string): Promise<{ name: string; sha: string } | null> {
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root, 4000);
  const named = head.ok ? head.out.replace(/^refs\/remotes\/origin\//, "") : "";
  for (const name of [named, "main", "master"].filter(Boolean)) {
    const sha = await resolveRef(root, name, "remote");
    if (sha) return { name, sha };
  }
  return null;
}

export type Probe = { files: string[] } | { error: string };

/** Probe merge of two commits: the files git cannot merge on its own, [] when clean. */
export async function mergeProbe(root: string, a: string, b: string): Promise<Probe> {
  if (!SHA.test(a) || !SHA.test(b)) return { error: "ref" };
  const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b], root, 15_000);
  // Exit code 1 with a tree id first means: merged with conflicts; the conflicted paths follow.
  const parts = r.out.split("\0").filter(Boolean);
  if (parts[0] && SHA.test(parts[0].trim())) return r.ok ? { files: [] } : { files: [...new Set(parts.slice(1))] };
  return {
    error: /write-tree|unknown option|usage:/i.test(r.err)
      ? tr("Probe-Merge braucht Git 2.38 oder neuer", "The probe merge needs Git 2.38 or newer")
      : r.err.slice(0, 200) || "merge-tree",
  };
}

/** Files a branch changes since it left the base (three dots: the merge base, not the base's tip). */
export async function changedFiles(root: string, base: string, head: string): Promise<string[] | null> {
  if (!SHA.test(base) || !SHA.test(head)) return null;
  const r = await git(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], root, 8000);
  return r.ok ? r.out.split("\0").filter(Boolean).slice(0, MAX_FILES) : null;
}

function clip(out: string): { text: string; cut: boolean } {
  const lines = out.split("\n");
  let text = lines.slice(0, MAX_LINES).join("\n");
  let cut = lines.length > MAX_LINES;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    cut = true;
  }
  return { text, cut };
}

/**
 * One file's diff on one side. A PR: its branch against the merge base. A session: its working tree against the
 * merge base of its checkout, so uncommitted edits count as well.
 */
export async function fileDiff(
  dir: string,
  file: string,
  from: { base: string; head: string } | { base: string; worktree: true },
): Promise<{ text: string; cut: boolean } | null> {
  if (!SHA.test(from.base) || !file || file.startsWith("-")) return null;
  let range: string[];
  if ("head" in from) {
    if (!SHA.test(from.head)) return null;
    range = [`${from.base}...${from.head}`];
  } else {
    const mb = await git(["merge-base", from.base, "HEAD"], dir, 4000);
    if (!mb.ok || !SHA.test(mb.out)) return null;
    range = [mb.out];
  }
  const r = await git(
    ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", ...range, "--", file],
    dir,
    8000,
  );
  return r.ok && r.out ? clip(r.out) : null;
}

/** Files each session edited, relative to its repo; files outside the repo are left out. */
export function editedRelative(sessions: Session[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of sessions) {
    const root = s.repoRoot;
    if (!root || !s.edited?.length) continue;
    const rel = s.edited
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((f) => f && f !== ".." && !f.startsWith("../") && !path.isAbsolute(f));
    out.set(s.id, rel);
  }
  return out;
}

/** The probe result on the PR list; new objects, because the list is the provider's cached one. */
export function withConflicts(prs: OpenPrs, probed: Record<number, PrConflict[]> | null): OpenPrs {
  if (!probed || !prs.prs) return prs;
  return { ...prs, prs: prs.prs.map((p) => (p.number in probed ? { ...p, conflicts: probed[p.number] } : p)) };
}

/* ---------- Open PRs of a repo, pairwise, every five minutes ---------- */

const EVERY = 5 * 60e3;
const MAX_PRS = 12;
const probes = new Map<
  string,
  { at: number; set: string; value: Record<number, PrConflict[]> | null; busy: boolean }
>();
let chain: Promise<void> = Promise.resolve();

/**
 * Conflicts between the open PRs of one repo, from the last probe; starts the next one in the background when the
 * set of PRs changed or five minutes passed. `key` is the repo (worktrees of one remote share it), `root` the
 * checkout to ask. Null until the first probe is done.
 */
export function prConflicts(key: string, root: string, prs: OpenPr[]): Record<number, PrConflict[]> | null {
  const list = prs.slice(0, MAX_PRS);
  const set = list.map((p) => `${p.number}:${p.head}:${p.base}`).join(",");
  const c = probes.get(key);
  if (list.length > 1 && (!c || (!c.busy && (c.set !== set || Date.now() - c.at > EVERY)))) {
    const entry = { at: c?.at || 0, set, value: c?.value || null, busy: true };
    probes.set(key, entry);
    // One probe at a time across all repos: git stays a background job.
    chain = chain.then(async () => {
      let value: Record<number, PrConflict[]> | null = null;
      try {
        value = await probePrs(root, list);
      } catch {
        // stays unknown
      }
      probes.set(key, { at: Date.now(), set, value, busy: false });
    });
  }
  return c?.value || null;
}

/** Every pair of PRs whose branches are in the checkout; a PR without a local branch is left out. */
export async function probePrs(root: string, prs: OpenPr[]): Promise<Record<number, PrConflict[]>> {
  const heads = await Promise.all(prs.map(async (p) => ({ p, sha: await resolveRef(root, p.head, "remote") })));
  const known = heads.filter((h): h is { p: OpenPr; sha: string } => !!h.sha);
  const out: Record<number, PrConflict[]> = {};
  for (const h of known) out[h.p.number] = [];
  for (let i = 0; i < known.length; i++) {
    for (const o of known.slice(i + 1)) {
      const x = known[i] as { p: OpenPr; sha: string };
      if (x.sha === o.sha) continue;
      const r = await mergeProbe(root, x.sha, o.sha);
      if ("error" in r) return {};
      if (!r.files.length) continue;
      const files = r.files.slice(0, 5);
      out[x.p.number]?.push({ with: o.p.number, files });
      out[o.p.number]?.push({ with: x.p.number, files });
    }
  }
  return out;
}

/* ---------- The view for the drawer ---------- */

/** A side as the API resolved it from the overview; folders and files never come from the request. */
export type SideIn =
  | {
      kind: "session";
      ref: string;
      label: string;
      branch: string | null;
      dir: string;
      files: string[];
      status?: ConflictSide["status"];
    }
  | { kind: "pr"; ref: string; label: string; branch: string; base: string };

interface Resolved {
  side: ConflictSide;
  /** The commit for the probe merge; null without own branch. */
  sha: string | null;
  dir: string;
  diff: { base: string; head: string } | { base: string; worktree: true } | null;
}

async function resolve(root: string, s: SideIn, base: { name: string; sha: string } | null): Promise<Resolved> {
  if (s.kind === "pr") {
    const head = await resolveRef(root, s.branch, "remote");
    const from = (s.base !== base?.name && (await resolveRef(root, s.base, "remote"))) || base?.sha || null;
    const files = head && from ? await changedFiles(root, from, head) : null;
    return {
      side: { kind: "pr", ref: s.ref, label: s.label, branch: s.branch, files: files || [] },
      sha: head,
      dir: root,
      diff: head && from ? { base: from, head } : null,
    };
  }
  // A session on its own branch can be probed with what it committed; on the base branch it has nothing to merge.
  const own = s.branch && s.branch !== base?.name ? await resolveRef(s.dir, s.branch, "local") : null;
  return {
    side: {
      kind: "session",
      ref: s.ref,
      label: s.label,
      branch: s.branch,
      files: s.files.slice(0, MAX_FILES),
      status: s.status,
    },
    sha: own,
    dir: s.dir,
    diff: base ? { base: base.sha, worktree: true } : null,
  };
}

export const SAME_COMMIT = () =>
  tr(
    "Beide stehen auf demselben Branch und Commit – kein Git-Merge nötig, nur der Dateischnitt zählt",
    "Both are on the same branch and commit: no git merge to check, only the shared files count",
  );

async function both(root: string, a: SideIn, b: SideIn) {
  const base = await defaultBase(root);
  return { base, ra: await resolve(root, a, base), rb: await resolve(root, b, base) };
}

export async function conflictView(root: string, repo: string, a: SideIn, b: SideIn): Promise<ConflictView> {
  const { base, ra, rb } = await both(root, a, b);
  const inB = new Set(rb.side.files);
  const shared = ra.side.files.filter((f) => inB.has(f));
  let conflicts: string[] | null = null;
  let why: string | null = null;
  if (!base) why = tr("Kein Hauptbranch im Checkout gefunden", "No default branch found in the checkout");
  else if (!ra.sha || !rb.sha)
    why =
      (a.kind === "pr" && !ra.sha) || (b.kind === "pr" && !rb.sha)
        ? tr(
            "Der PR-Branch liegt nicht im Checkout – nach „git fetch“ prüft Fleet auch den Merge",
            'The PR branch is not in the checkout; after "git fetch" Fleet checks the merge as well',
          )
        : tr(
            "Ohne eigenen Branch gibt es keinen Git-Merge zu prüfen – nur der Dateischnitt zählt",
            "Without an own branch there is no git merge to check; only the shared files count",
          );
  else if (ra.sha === rb.sha) why = SAME_COMMIT();
  else {
    const p = await mergeProbe(root, ra.sha, rb.sha);
    if ("error" in p) why = p.error;
    else conflicts = p.files;
  }
  return { root, repo, a: ra.side, b: rb.side, shared, conflicts, why };
}

/** The diffs of one file on both sides; the file must be one the view lists. */
export async function conflictHunks(root: string, a: SideIn, b: SideIn, file: string): Promise<ConflictHunks | null> {
  const { ra, rb } = await both(root, a, b);
  if (!ra.side.files.includes(file) && !rb.side.files.includes(file)) return null;
  const one = (r: Resolved) => (r.diff && r.side.files.includes(file) ? fileDiff(r.dir, file, r.diff) : null);
  const [da, db] = await Promise.all([one(ra), one(rb)]);
  return { file, a: da?.text ?? null, b: db?.text ?? null, truncated: !!(da?.cut || db?.cut) };
}
