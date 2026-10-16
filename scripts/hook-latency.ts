/**
 * Measures what the synchronous PreToolUse hook (the brake) costs per tool call when nothing calls for a pause.
 * Runs against a throwaway folder; never touches ~/.claude-fleet. Needs `pnpm build` first.
 *   pnpm hook-latency [count]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const n = Math.max(5, Number(process.argv[2]) || 30);
const hook = path.resolve(import.meta.dirname, "..", "dist", "hook.cjs");
if (!fs.existsSync(hook)) {
  console.error("dist/hook.cjs fehlt: erst pnpm build");
  process.exit(1);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-latency-"));
// Measured as sessions run it: through the guard and the tested copy (server/core/pinhook.ts).
process.env.CLAUDE_FLEET_HOME = home;
const { guardPath, pinHook } = await import("../server/core/pinhook");
const pin = pinHook(path.resolve(import.meta.dirname, ".."));
if (!pin.ok) {
  console.error(`Hook nicht eingerichtet: ${pin.message}`);
  process.exit(1);
}
const ms: number[] = [];
for (let i = 0; i < n; i++) {
  const ev = {
    hook_event_name: "PreToolUse",
    session_id: "latency",
    cwd: home,
    tool_name: "Read",
    tool_input: { file_path: `file-${i}.ts` },
    tool_use_id: `t${i}`,
  };
  const t0 = process.hrtime.bigint();
  execFileSync(process.execPath, [guardPath("hook")], {
    input: JSON.stringify(ev),
    env: { ...process.env, CLAUDE_FLEET_HOME: home },
  });
  ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
ms.sort((a, b) => a - b);
const q = (p: number) => (ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0).toFixed(0);
console.log(
  `PreToolUse without a reason to pause, through the guard, ${n} calls: median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${q(1)} ms (Node ${process.version})`,
);
fs.rmSync(home, { recursive: true, force: true });
