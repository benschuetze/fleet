import fs from "node:fs";
import path from "node:path";
import { claudeHome, hookScript, installHooks, MARK, statusScript } from "./install";
import { tr } from "./lang";
import { fleetHome } from "./paths";
import { pinHook } from "./pinhook";

/**
 * Self-healing: checks at start whether the hooks are still right (folder moved, Node updated, hooks deleted,
 * an older Fleet version) and repairs them silently. Also writes runtime.json (current port) so launchers and
 * shortcuts find a running instance.
 */

const CORE_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification"];
const norm = (p: unknown) =>
  String(p || "")
    .replace(/\\/g, "/")
    .toLowerCase();

/** Reads node path and hook path from a Fleet hook command: "node" "hook.cjs" --claude-fleet */
export function parseCommand(cmd: unknown): { node: string; hook: string } | null {
  const m = /^"([^"]+)"\s+"([^"]+)"\s+--claude-fleet\s*$/.exec(String(cmd || "").trim());
  return m?.[1] && m[2] ? { node: m[1], hook: m[2] } : null;
}

// biome-ignore lint/suspicious/noExplicitAny: settings.json is a foreign format
type Settings = any;

export function checkHooks(
  settings: Settings,
  hook: string,
  exists: (p: string) => boolean = fs.existsSync,
  status: string | null = null,
): { ok: boolean; reason: string; light: boolean } {
  const hooks = settings && typeof settings === "object" ? settings.hooks : null;
  if (!hooks || typeof hooks !== "object")
    return { ok: false, reason: tr("keine Hooks eingetragen", "no hooks installed"), light: false };
  const ours = (ev: string) =>
    (Array.isArray(hooks[ev]) ? hooks[ev] : [])
      .flatMap((g: Settings) => (g && Array.isArray(g.hooks) ? g.hooks : []))
      .filter((h: Settings) => h && typeof h.command === "string" && h.command.includes(MARK));
  const light = ours("PreToolUse").length === 0;
  const brakeOff = fs.existsSync(path.join(fleetHome(), "brake-off"));
  for (const ev of CORE_EVENTS) {
    const first = ours(ev)[0];
    if (!first) return { ok: false, reason: tr(`Hook für ${ev} fehlt`, `hook for ${ev} missing`), light };
    const p = parseCommand(first.command);
    if (!p) return { ok: false, reason: tr("Hook-Befehl unbekannt", "unknown hook command"), light };
    if (norm(p.hook) !== norm(hook))
      return {
        ok: false,
        reason: tr("Fleet-Ordner oder Version hat sich geändert", "Fleet folder or version changed"),
        light,
      };
    if (!exists(p.node))
      return { ok: false, reason: tr("Node-Pfad existiert nicht mehr", "node path no longer exists"), light };
  }
  // The brake needs a synchronous PreToolUse hook with a long timeout (older setups: async, 5 s).
  const pre = ours("PreToolUse")[0];
  if (pre && !brakeOff && (pre.async || !(pre.timeout >= 120)))
    return { ok: false, reason: tr("Bremse noch nicht eingerichtet", "brake not set up yet"), light };
  // Approvals in the dashboard: the PermissionRequest hook must be allowed to wait as well.
  const perm = ours("PermissionRequest")[0];
  if (perm && !brakeOff && (perm.async || !(perm.timeout >= 120)))
    return { ok: false, reason: tr("Freigaben noch nicht eingerichtet", "approvals not set up yet"), light };
  if (status) {
    const p = parseCommand(settings.statusLine?.command);
    if (!p) return { ok: false, reason: tr("Statuszeile fehlt", "status line missing"), light };
    if (norm(p.hook) !== norm(status))
      return {
        ok: false,
        reason: tr("Statuszeile zeigt auf alten Ordner", "status line points to an old folder"),
        light,
      };
  }
  return { ok: true, reason: "", light };
}

/** Checks and repairs the hooks. Never throws. Returns a message (or "" when all was fine). */
export function ensureHooks(): string {
  try {
    // A new build becomes the sessions' hook only after its self-test; a failing one leaves the last good one.
    // At start only a build from a clean, pushed main is taken over (pinhook.releaseProblem, audit M2).
    const pin = pinHook(undefined, { onlyRelease: true });
    if (!pin.ok)
      return `⚠ ${pin.message || tr("Hook nicht eingerichtet – erst bauen (pnpm build).", "Hook not set up; build first (pnpm build).")}`;
    const pinNote = pin.message ? `⚠ ${pin.message}` : "";
    const settingsPath = path.join(claudeHome(), "settings.json");
    let settings: Settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
      } catch {
        return tr(
          "⚠ ~/.claude/settings.json ist kein gültiges JSON – Hooks nicht geprüft.",
          "⚠ ~/.claude/settings.json is not valid JSON; hooks not checked.",
        );
      }
    }
    const optOut = fs.existsSync(path.join(fleetHome(), "statusline-off"));
    const r = checkHooks(settings, hookScript(), fs.existsSync, optOut ? null : statusScript());
    if (r.ok) return pinNote;
    const res = installHooks({
      light: r.light,
      noStatusline: optOut,
      noBrake: fs.existsSync(path.join(fleetHome(), "brake-off")),
    });
    return res.ok ? tr(`✔ Hooks repariert (${r.reason}).`, `✔ Hooks repaired (${r.reason}).`) : `⚠ ${res.message}`;
  } catch (e) {
    return (
      tr("⚠ Hooks konnten nicht automatisch eingetragen werden: ", "⚠ Hooks could not be installed automatically: ") +
      (e instanceof Error ? e.message.split("\n")[0] : String(e))
    );
  }
}

const runtimeFile = () => path.join(fleetHome(), "runtime.json");

export interface Runtime {
  port?: number;
  url?: string;
  pid?: number;
  version?: string;
  startedAt?: number;
  dir?: string;
  /** Fleet can run Claude in its own window: the hook may then hand a fresh start to it. */
  terminal?: boolean;
}

export function writeRuntime(data: Required<Runtime>): void {
  try {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    const f = runtimeFile();
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch {
    // launchers fall back to the default port
  }
}

export function readRuntime(): Runtime {
  try {
    const r = JSON.parse(fs.readFileSync(runtimeFile(), "utf8"));
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

/** Is this the user's real Fleet instance? A demo does not count: the launcher would otherwise take it for the running Fleet. */
export function isLiveFleet(health: unknown): boolean {
  const h = health as { app?: unknown; demo?: unknown } | null;
  return !!h && typeof h === "object" && h.app === "claude-fleet" && !h.demo;
}
