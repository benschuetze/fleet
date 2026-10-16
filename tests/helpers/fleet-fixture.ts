import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An invented, realistic machine for load tests: many sessions with long transcripts in several real git repos and
 * worktrees, plus hook states. Nothing here comes from a real ~/.claude; names, prompts and paths are made up.
 * Used by tests/latency.test.ts, tests/e2e/latency.spec.ts and scripts/overview-latency.ts.
 */

export interface FleetFixture {
  root: string;
  claudeHome: string;
  fleetHome: string;
  /** Session ids, oldest first. */
  ids: string[];
  /** Working folders (repo roots and worktrees). */
  dirs: string[];
  /** Writes a hook state the way the hook does (tmp + rename). */
  writeHook(id: string, status: string, detail?: string): void;
}

const WORDS = ["export", "parser", "dashboard", "login", "cache", "billing", "report", "upload", "search", "theme"];
const line = (o: object) => `${JSON.stringify(o)}\n`;

function git(args: string[], cwd: string) {
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A transcript of `turns` turns with tool calls; `pad` bytes of tool output per call make it long. */
function transcript(
  id: string,
  n: number,
  cwd: string,
  branch: string,
  start: number,
  turns: number,
  pad: number,
): string {
  const out: string[] = [];
  let t = start;
  const iso = () => {
    t += 7000;
    return new Date(t).toISOString();
  };
  const filler = "x".repeat(pad);
  for (let i = 0; i < turns; i++) {
    const w = WORDS[(i + id.length) % WORDS.length];
    out.push(
      line({
        type: "user",
        sessionId: id,
        cwd,
        gitBranch: branch,
        timestamp: iso(),
        // The first prompt is the title: unique per session, so tests can find one.
        message: {
          role: "user",
          content: i ? `Weiter mit ${w} (Schritt ${i + 1})` : `Aufgabe ${n}: ${w} überarbeiten`,
        },
      }),
    );
    out.push(
      line({
        type: "assistant",
        sessionId: id,
        cwd,
        gitBranch: branch,
        timestamp: iso(),
        message: {
          id: `${id}-m${i}`,
          role: "assistant",
          model: "claude-sonnet-5-5",
          stop_reason: "tool_use",
          usage: { input_tokens: 20, output_tokens: 400, cache_read_input_tokens: 30000 + i * 200 },
          content: [{ type: "tool_use", id: `${id}-t${i}`, name: "Bash", input: { command: `pnpm test -- ${w}` } }],
        },
      }),
    );
    out.push(
      line({
        type: "user",
        sessionId: id,
        cwd,
        timestamp: iso(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${id}-t${i}`, content: filler }] },
        toolUseResult: { stdout: "ok", stderr: "", interrupted: false },
      }),
    );
    out.push(
      line({
        type: "assistant",
        sessionId: id,
        cwd,
        timestamp: iso(),
        message: {
          id: `${id}-a${i}`,
          role: "assistant",
          model: "claude-sonnet-5-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 120, cache_read_input_tokens: 31000 + i * 200 },
          content: [{ type: "text", text: `${w} ist erledigt.` }],
        },
      }),
    );
  }
  return out.join("");
}

export function makeFleetFixture({
  sessions = 150,
  repos = 5,
  worktrees = 3,
  longEvery = 8,
}: {
  sessions?: number;
  repos?: number;
  worktrees?: number;
  longEvery?: number;
} = {}): FleetFixture {
  // realpath: on the Windows runner os.tmpdir() is an 8.3 short path, git reports the long one.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-load-")));
  const claudeHome = path.join(root, "claude");
  const fleetHome = path.join(root, "fleet");
  fs.mkdirSync(path.join(fleetHome, "state"), { recursive: true });
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false }));

  // Repos, the first two with worktrees on their own branches.
  const dirs: { cwd: string; branch: string }[] = [];
  for (let r = 0; r < repos; r++) {
    const dir = path.join(root, "work", `projekt-${r + 1}`);
    fs.mkdirSync(dir, { recursive: true });
    git(["init", "-q", "-b", "main"], dir);
    fs.writeFileSync(path.join(dir, "README.md"), `# Projekt ${r + 1}\n`);
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "chore: start"], dir);
    dirs.push({ cwd: dir, branch: "main" });
    if (r < 2)
      for (let w = 0; w < worktrees; w++) {
        const branch = `feature/${WORDS[w]}`;
        const wt = path.join(root, "work", `projekt-${r + 1}-wt${w + 1}`);
        git(["worktree", "add", "-q", "-b", branch, wt], dir);
        dirs.push({ cwd: wt, branch });
      }
  }

  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < sessions; i++) {
    const id = `load${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const d = dirs[i % dirs.length] as { cwd: string; branch: string };
    const project = path.join(claudeHome, "projects", d.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    // Older sessions first; every `longEvery`-th one is long (a few MB, more than the 1 MB tail the parser reads).
    const long = i % longEvery === 0;
    const turns = long ? 400 : 40;
    // Each turn spans 4 lines of 7 s; the transcript ends in the past, so a new hook state is newer.
    const start = Math.min(now - (sessions - i) * 20 * 60e3 - 3600e3, now - turns * 28e3 - 120e3);
    const file = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(file, transcript(id, i, d.cwd, d.branch, start, turns, long ? 8000 : 1500));
    const mt = new Date(start + turns * 28e3);
    fs.utimesSync(file, mt, mt);
    ids.push(id);
  }

  const writeHook = (id: string, status: string, detail = "") => {
    const i = ids.indexOf(id);
    const d = dirs[(i < 0 ? 0 : i) % dirs.length] as { cwd: string };
    const at = Date.now();
    const p = path.join(fleetHome, "state", `${id}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        sessionId: id,
        status,
        event: status === "needs_input" ? "PermissionRequest" : "PostToolUse",
        detail,
        at,
        cwd: d.cwd,
        startedAt: at - 3600e3,
        statusSince: at,
      }),
    );
    fs.renameSync(tmp, p);
  };
  // The newest third has hook states, as on a busy machine.
  for (const id of ids.slice(-Math.floor(sessions / 3))) writeHook(id, "waiting");

  return { root, claudeHome, fleetHome, ids, dirs: dirs.map((d) => d.cwd), writeHook };
}
