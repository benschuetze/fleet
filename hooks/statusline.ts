/**
 * Status line for Claude Code (installed by `fleet setup`). Reads the JSON Claude Code sends on stdin and keeps
 * for the dashboard: context window, session cost and the limits (five hours, week). Output: an own status line
 * installed before is passed through unchanged, otherwise a short line. Always ends quickly and without error.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { locale, tr } from "../server/core/lang";
import { fleetHome } from "../server/core/paths";

const HOME = fleetHome();
const DIR = path.join(HOME, "statusline");
const CHAIN = path.join(HOME, "statusline-chain.json");

// biome-ignore lint/suspicious/noExplicitAny: input from Claude Code, checked field by field
type Input = Record<string, any>;

const n = (v: unknown): number | null => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

function save(j: Input) {
  const sid = typeof j.session_id === "string" ? j.session_id : "";
  if (!/^[\w.-]{1,128}$/.test(sid)) return;
  const cw = j.context_window || {};
  const cu = cw.current_usage || null;
  const tokens = cu
    ? (n(cu.input_tokens) || 0) + (n(cu.cache_creation_input_tokens) || 0) + (n(cu.cache_read_input_tokens) || 0)
    : null;
  const rl = j.rate_limits && typeof j.rate_limits === "object" ? j.rate_limits : null;
  const win = (w: Input | undefined) =>
    w && n(w.used_percentage) !== null
      ? { used_percentage: n(w.used_percentage), resets_at: n(w.resets_at) }
      : undefined;
  const state = {
    sessionId: sid,
    at: Date.now(),
    model: (j.model && (j.model.id || j.model.display_name)) || null,
    context: n(cw.context_window_size) ? { size: n(cw.context_window_size), pct: n(cw.used_percentage), tokens } : null,
    cost: j.cost ? n(j.cost.total_cost_usd) : null,
    rateLimits: rl
      ? { five_hour: win(rl.five_hour), seven_day: win(rl.seven_day), spend_limit: win(rl.spend_limit) }
      : null,
  };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const f = path.join(DIR, `${sid}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Passes on an own status line installed before (null = none). */
function chained(input: string): string | null {
  let c: { command?: unknown } | null = null;
  try {
    c = JSON.parse(fs.readFileSync(CHAIN, "utf8"));
  } catch {
    return null;
  }
  if (!c || typeof c.command !== "string" || !c.command.trim()) return null;
  // The user's own command, as they configured it in Claude Code; it needs a shell like there.
  const r = spawnSync(c.command, { input, shell: true, encoding: "utf8", timeout: 2000, windowsHide: true });
  return r.stdout || "";
}

function ownLine(j: Input): string {
  const parts: string[] = [];
  if (j.model?.display_name) parts.push(String(j.model.display_name));
  const pct = n(j.context_window?.used_percentage);
  if (pct !== null) parts.push(`${tr("Kontext", "Context")} ${Math.round(pct)} %`);
  const cost = j.cost ? n(j.cost.total_cost_usd) : null;
  if (cost !== null)
    parts.push(`${cost.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);
  const rl = j.rate_limits || {};
  const five = rl.five_hour ? n(rl.five_hour.used_percentage) : null;
  if (five !== null) {
    const r = n(rl.five_hour.resets_at);
    const t = r ? new Date(r * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "";
    parts.push(`5 h ${Math.round(five)} %${t ? ` ${tr("bis", "until")} ${t}` : ""}`);
  }
  const week = rl.seven_day ? n(rl.seven_day.used_percentage) : null;
  if (week !== null) parts.push(`${tr("Woche", "Week")} ${Math.round(week)} %`);
  return parts.join(" · ");
}

let raw = "";
const finish = () => {
  let j: Input = {};
  try {
    j = JSON.parse(raw || "{}") || {};
  } catch {
    // keep {}
  }
  try {
    save(j);
  } catch {
    // the line is still printed
  }
  let out: string | null = null;
  try {
    out = chained(raw);
  } catch {
    // fall back to our own line
  }
  process.stdout.write(out ?? ownLine(j));
  process.exit(0);
};
setTimeout(finish, 2500).unref();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  if (raw.length < 4e6) raw += d;
});
process.stdin.on("end", finish);
process.stdin.on("error", finish);
