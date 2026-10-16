import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "./paths";

/**
 * Which of Fleet's features are really used (independent review: "33,000 lines to maintain"; scope freeze after
 * 6.0.0). Counts per feature key and local day in ~/.claude-fleet/feature-use.json, on this machine only, never
 * text: API endpoints (`api:/api/diff`), views (`view:/usage`), commands (`cmd:merge`) and key actions
 * (`key:hide`). `fleet scope` reads it after the test weeks: what nobody used is the first thing to cut.
 */

export const USE_RE = /^(api|view|cmd|key):[\w:/.-]{1,60}$/;
type Counts = Record<string, Record<string, number>>;
const file = () => path.join(fleetHome(), "feature-use.json");
let counts: Counts | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function readUse(): Counts {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function flushUse(): void {
  if (!dirty || !counts) return;
  dirty = false;
  try {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(counts), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    dirty = true; // next time
  }
}

/** Counts a use; writes a few seconds later, so a burst of keys is one write. */
export function noteUse(key: string, n = 1, now = Date.now()): void {
  if (!USE_RE.test(key) || !(n > 0)) return;
  counts ??= readUse();
  const k = counts[key] || {};
  counts[key] = k;
  const d = day(now);
  k[d] = (k[d] || 0) + Math.min(Math.floor(n), 1000);
  dirty = true;
  if (!timer)
    timer = setTimeout(() => {
      timer = null;
      flushUse();
    }, 5000);
  timer.unref?.();
}

/** Uses per key since `from` (a local day, inclusive). */
export function usesSince(c: Counts, from: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, days] of Object.entries(c))
    for (const [d, n] of Object.entries(days)) if (d >= from) out[k] = (out[k] || 0) + n;
  return out;
}

/** API calls that are polling or typing, not a decision to use a feature. */
export const NOT_COUNTED = new Set([
  "/api/overview",
  "/api/stream",
  "/api/health",
  "/api/presence",
  // Sent by the dashboard itself when its language differs from the server's: no use of a feature.
  "/api/language",
  "/api/use",
  "/api/term/stream",
  "/api/term/input",
  "/api/term/resize",
]);
