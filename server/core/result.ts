import type { SessionResult } from "../../shared/types";
import { git } from "./git";
import { swr } from "./swr";

/**
 * Result of a finished session, so it can be ticked off without opening it: commits since the start,
 * changed files and lines (from git) and the last test run (from the transcript, see sessions.ts testRun).
 */

/** Test commands whose result counts (exit code of the Bash call). */
export const TEST_RE =
  /(^|[\s;&|(])((pnpm|npm|yarn|bun)\s+(run\s+)?(test|check|e2e|test:\w+)|npx\s+(vitest|jest|playwright\s+test)|vitest|jest|pytest|playwright\s+test|go\s+test|cargo\s+test|node\s+--test)\b/;

/** Parses e.g. " 3 files changed, 40 insertions(+), 2 deletions(-)". */
export function parseShortstat(out: string) {
  const n = (re: RegExp) => Number(re.exec(out)?.[1] || 0);
  return { files: n(/(\d+) files? changed/), add: n(/(\d+) insertions?\(\+\)/), del: n(/(\d+) deletions?\(-\)/) };
}

export type GitResult = Omit<SessionResult, "test">;

/**
 * What the session's own commits changed together. Only commits of the session itself: by id from the
 * output of git commit, otherwise by time (a commit at most 60 s after a successful `git commit -q`).
 * Other sessions in the same repo do not count.
 */
const gitResult = swr(
  60e3,
  async (_key: string, root: string, shas: string[], times: number[]): Promise<GitResult | null> => {
    const ids = new Set(shas.filter((x) => /^[0-9a-f]{7,40}$/.test(x)));
    if (times.length) {
      const from = Math.floor(Math.min(...times) / 1000) - 60;
      const log = await git(["log", "--all", `--since=@${from}`, "--format=%H%x09%ct", "-n", "500"], root, 5000);
      for (const l of log.ok && log.out ? log.out.split("\n") : []) {
        const [sha, ct] = l.split("\t");
        const t = Number(ct) * 1000;
        if (sha && times.some((x) => t >= x - 60e3 && t <= x + 5e3)) ids.add(sha);
      }
    }
    const list = [...ids].slice(-30);
    const shows = await Promise.all(
      list.map((sha) => git(["show", "--shortstat", "--format=%H%x09%ct%x09%s", sha], root, 5000)),
    );
    // Short and long ids of the same commit only once; ordered by commit time.
    const seen = new Map<string, { at: number; subject: string; files: number; add: number; del: number }>();
    for (const r of shows) {
      if (!r.ok || !r.out) continue;
      const [head = "", ...rest] = r.out.split("\n");
      const [sha = "", ct, subject] = head.split("\t");
      if (!seen.has(sha)) seen.set(sha, { at: Number(ct), subject: subject || "", ...parseShortstat(rest.join("\n")) });
    }
    const found = [...seen.values()].sort((a, b) => a.at - b.at);
    const last = found[found.length - 1];
    if (!last) return null;
    const sum = { files: 0, add: 0, del: 0 };
    for (const c of found) {
      sum.files += c.files;
      sum.add += c.add;
      sum.del += c.del;
    }
    return { commits: found.length, last: last.subject.slice(0, 160), ...sum };
  },
);

/**
 * Never waits: a session that just finished has new commits, so its key is new, and the overview of that very
 * moment must not wait for git log and git show. The result arrives with the next build (swr.ts pushes it).
 */
export const resultFor = (root: string, shas: string[], times: number[] = []): Promise<GitResult | null> =>
  Promise.resolve(
    shas.length || times.length
      ? (gitResult.peek(`${root}|${shas.join(",")}|${times.join(",")}`, root, shas, times) ?? null)
      : null,
  );
