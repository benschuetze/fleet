import fs from "node:fs";
import path from "node:path";
import { APP_DIR, fleetHome } from "../core/paths";

/**
 * Settings of the automatic handoff from config.json (app folder or ~/.claude-fleet), read without the
 * full config loader because the hook needs them on every event.
 *
 * largeContextTokens: from here on every call re-reads so much that a fresh session pays off after two
 * or three calls (Opus 5.5: 400k × $0.20/M = $0.08 per call).
 * clearMinTokens: only from this context size on is a fresh session worth it after the handoff.
 * archivePredecessor: the session that receives the handoff archives the one(s) it replaces in the desktop
 * app, so the sidebar does not fill up with finished predecessors.
 */
export const DEFAULTS = {
  enabled: true,
  limitPercent: 85,
  contextPercent: 85,
  largeContextTokens: 400000,
  clearAfter: true,
  clearMinTokens: 150000,
  archivePredecessor: true,
};
export type HandoffConfig = typeof DEFAULTS;

export function readConfig(): HandoffConfig {
  const cfg = { ...DEFAULTS };
  for (const p of [path.join(APP_DIR, "config.json"), path.join(fleetHome(), "config.json")]) {
    try {
      const a = JSON.parse(fs.readFileSync(p, "utf8"))?.autoHandoff;
      if (a && typeof a === "object") {
        if (typeof a.enabled === "boolean") cfg.enabled = a.enabled;
        for (const k of ["clearAfter", "archivePredecessor"] as const) if (typeof a[k] === "boolean") cfg[k] = a[k];
        for (const k of ["largeContextTokens", "clearMinTokens"] as const)
          if (Number.isFinite(a[k])) cfg[k] = Math.max(20000, Number(a[k]));
        for (const k of ["limitPercent", "contextPercent"] as const)
          if (Number.isFinite(a[k])) cfg[k] = Math.min(100, Math.max(10, Number(a[k])));
      }
      break;
    } catch {
      // no or broken config: defaults
    }
  }
  return cfg;
}
