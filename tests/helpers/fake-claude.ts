import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An invented `claude` for the process manager: logs its arguments, answers `auth status`, shows an invented
 * approval prompt and echoes stdin; with -p it prints stream-json with a result line. A JavaScript file, so it runs
 * with this Node on every system (server/process/pty.ts `command`). Nothing here comes from a real session.
 *
 * Input "exit3" ends with code 3, "exit0" with 0; SIGINT prints ^C and goes on, SIGTERM ends it.
 * FAKE_CLAUDE_HANG makes -p never finish (timeout), FAKE_CLAUDE_NO_USAGE leaves out usage and cost.
 * FAKE_CLAUDE_TICK redraws a spinner line every 500 ms, as a working Claude Code does.
 */
const SCRIPT = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
try {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), proc: process.env.CLAUDE_FLEET_PROC || null, turn: process.env.CLAUDE_FLEET_TURN || null, env: Object.keys(process.env).filter((k) => /^(CLAUDE|AI_AGENT|ANTHROPIC)/.test(k)).sort() }) + "\n");
} catch {}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: !process.env.FAKE_CLAUDE_LOGGED_OUT }));
  process.exit(0);
}
if (args.includes("-p")) {
  if (process.env.FAKE_CLAUDE_HANG) {
    setInterval(() => {}, 1000);
  } else {
    const sid = args[args.indexOf("--resume") + 1];
    console.log("not json at all");
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
    const result = { type: "result", subtype: "success", is_error: false, duration_ms: 1234, session_id: sid, result: "Übergabe geschrieben" };
    if (!process.env.FAKE_CLAUDE_NO_USAGE) {
      result.total_cost_usd = 0.0123;
      result.usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 };
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }
} else {
  // Handlers first: tests interrupt as soon as the prompt shows, and a SIGINT that arrives before its handler
  // ends the process (Node's default), so ^C never comes (seen on loaded CI runners).
  process.on("SIGINT", () => process.stdout.write("^C\n"));
  process.on("SIGTERM", () => process.exit(143));
  process.stdin.on("data", (d) => {
    const s = d.toString();
    process.stdout.write("echo:" + s);
    if (s.includes("exit3")) process.exit(3);
    if (s.includes("exit0")) process.exit(0);
  });
  if (process.env.FAKE_CLAUDE_TICK) {
    let n = 0;
    setInterval(() => process.stdout.write("\r✻ Erfundene Arbeit … " + ++n + "s (esc to interrupt)"), 500);
  }
  process.stdout.write("Erfundenes Claude\n\n Bash command\n   pnpm test\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n");
}
`;

export function fakeClaude(): {
  file: string;
  log: string;
  calls: () => { args: string[]; cwd: string; proc: string | null; turn: string | null; env: string[] }[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fake-claude-"));
  const file = path.join(dir, "claude.cjs");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(file, SCRIPT);
  return {
    file,
    log,
    calls: () => {
      try {
        return fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

export const waitFor = async (fn: () => boolean, ms = 5000, what = "condition") => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
