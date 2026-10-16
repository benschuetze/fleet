/**
 * Runs open steps in its own detached process (started by launch.runDetached). Reason: the hook exits right
 * away with process.exit; delayed steps (VS Code: folder first, then the session) would never run. Writes the
 * outcome to ~/.claude-fleet/launch.log.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "../server/core/paths";

const log = (line: string) => {
  try {
    fs.appendFileSync(path.join(fleetHome(), "launch.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // no log, no harm
  }
};

let steps: { cmd: string; args: string[]; cwd?: string; delayMs?: number }[] = [];
try {
  steps = JSON.parse(process.argv[2] || "[]");
} catch {
  steps = [];
}

const next = (i: number) => {
  const s = steps[i];
  if (!s || typeof s.cmd !== "string" || !Array.isArray(s.args)) return;
  setTimeout(
    () => {
      execFile(s.cmd, s.args.map(String), { cwd: s.cwd, windowsHide: true, timeout: 15000 }, (err) => {
        log(
          `${err ? "ERROR" : "ok"} ${s.cmd} ${s.args.join(" ").slice(0, 300)}${err ? ` – ${String(err.message).split("\n")[0]}` : ""}`,
        );
        next(i + 1);
      });
    },
    Math.max(0, Math.min(10000, Number(s.delayMs) || 0)),
  );
};
next(0);
