import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_WAIT } from "./brake";
import { tr } from "./lang";
import { fleetHome } from "./paths";
import { guardPath, hookDir, pinHook } from "./pinhook";

/**
 * Writes the Claude Fleet hooks into ~/.claude/settings.json (user level, applies to all projects).
 * A backup settings.json.bak-fleet-<time> is made before every change (the newest five stay). Hooks of
 * other tools stay untouched. The file is written atomically, so it is never half written.
 */

export const MARK = "--claude-fleet";
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
];
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
// The brake: PreToolUse runs synchronously so Fleet can pause mid-turn and wait for your decision. Without a
// reason the hook ends after ~40 ms; the long timeout only applies while waiting.
export const BRAKE_TIMEOUT = MAX_WAIT + 30;

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
// settings.json runs the guards in ~/.claude-fleet/hook/, never dist/ directly (pinhook.ts).
export const hookScript = () => guardPath("hook");
export const statusScript = () => guardPath("statusline");

export interface InstallOptions {
  uninstall?: boolean;
  /** without tool events: less overhead, coarser status */
  light?: boolean;
  /** tool events synchronously (default: in the background, "async") */
  sync?: boolean;
  /** "node" from PATH instead of the absolute path */
  nodeCmd?: string;
  noStatusline?: boolean;
  noBrake?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: settings.json is a foreign format, touched defensively
type Settings = Record<string, any>;

export function installHooks(o: InstallOptions = {}): { ok: boolean; message: string } {
  const settingsPath = path.join(claudeHome(), "settings.json");
  const home = fleetHome();
  const chainFile = path.join(home, "statusline-chain.json");
  const optOutFile = path.join(home, "statusline-off");
  // Absolute node path: Claude Code started from a GUI or IDE (macOS above all) often has no Homebrew/nvm on
  // PATH. After moving Node, run setup again; --node-cmd=node uses PATH instead.
  const nodeCmd = (o.nodeCmd || process.execPath).replace(/\\/g, "/");
  const hook = hookScript();
  for (const p of [hook, nodeCmd]) {
    if (/["`$\r\n]/.test(p)) {
      return {
        ok: false,
        message: tr(
          `Der Pfad enthält Zeichen, die im Hook-Befehl nicht sicher sind: ${p}. Bitte an einen anderen Ort verschieben.`,
          `The path contains characters that are not safe in a hook command: ${p}. Please move it elsewhere.`,
        ),
      };
    }
  }
  // Sessions run only a build that passed its self-test (pinhook.ts); without one nothing is changed.
  if (!o.uninstall) {
    const pin = pinHook();
    if (!pin.ok) return { ok: false, message: pin.message };
  }
  const command = `"${nodeCmd}" "${hook}" ${MARK}`;
  const statusCommand = `"${nodeCmd}" "${statusScript()}" ${MARK}`;

  let settings: Settings = {};
  if (fs.existsSync(settingsPath)) {
    const txt = fs.readFileSync(settingsPath, "utf8");
    try {
      settings = txt.trim() ? JSON.parse(txt) : {};
    } catch (e) {
      return {
        ok: false,
        message: `${tr(
          `${settingsPath} ist kein gültiges JSON – bitte erst reparieren.`,
          `${settingsPath} is not valid JSON; please repair it first.`,
        )} ${e instanceof Error ? e.message : e}`,
      };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      return {
        ok: false,
        message: tr(`${settingsPath} ist kein JSON-Objekt.`, `${settingsPath} is not a JSON object.`),
      };
    fs.writeFileSync(`${settingsPath}.bak-fleet-${new Date().toISOString().replace(/[:.]/g, "-")}`, txt, {
      mode: 0o600,
    });
    try {
      const dir = path.dirname(settingsPath);
      const base = `${path.basename(settingsPath)}.bak-fleet-`;
      for (const f of fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base))
        .sort()
        .reverse()
        .slice(5))
        fs.unlinkSync(path.join(dir, f));
    } catch {
      // old backups stay
    }
  } else fs.mkdirSync(claudeHome(), { recursive: true });

  if (
    settings.hooks !== undefined &&
    (typeof settings.hooks !== "object" || Array.isArray(settings.hooks) || settings.hooks === null)
  ) {
    return {
      ok: false,
      message: tr(
        '"hooks" in settings.json hat ein unerwartetes Format – bitte prüfen.',
        '"hooks" in settings.json has an unexpected format; please check it.',
      ),
    };
  }
  settings.hooks = settings.hooks || {};
  // Remove old Fleet entries (also when the folder moved); other formats stay untouched.
  for (const ev of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : null;
    if (!groups) continue;
    const cleaned = groups
      .map((g: Settings) =>
        g && Array.isArray(g.hooks)
          ? {
              ...g,
              hooks: g.hooks.filter((h: Settings) => !(h && typeof h.command === "string" && h.command.includes(MARK))),
            }
          : g,
      )
      .filter((g: Settings) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (cleaned.length) settings.hooks[ev] = cleaned;
    else delete settings.hooks[ev];
  }

  const brakeOn = !o.noBrake;
  if (!o.uninstall) {
    const add = (ev: string, matcher: string | undefined, isAsync: boolean, timeout = 5) => {
      const h: Settings = { type: "command", command, timeout };
      if (isAsync) h.async = true;
      const group: Settings = { hooks: [h] };
      if (matcher !== undefined) group.matcher = matcher;
      settings.hooks[ev] = settings.hooks[ev] || [];
      settings.hooks[ev].push(group);
    };
    for (const ev of EVENTS) add(ev, undefined, false, ev === "PermissionRequest" && brakeOn ? BRAKE_TIMEOUT : 5);
    // Tool events come twice per tool call; in the background they never block Claude. The hook discards
    // late events by their timestamp. Claude Code versions without "async" ignore the field.
    if (!o.light) {
      for (const ev of TOOL_EVENTS) {
        if (ev === "PreToolUse" && brakeOn) add(ev, "*", false, BRAKE_TIMEOUT);
        else add(ev, "*", !o.sync);
      }
    }
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  // Status line: gives the dashboard context window and limits. An own status line stays: it is remembered
  // and shown on.
  let statusMsg = "";
  const sl = settings.statusLine;
  const ours = sl && typeof sl.command === "string" && sl.command.includes(MARK);
  const readChain = () => {
    try {
      return JSON.parse(fs.readFileSync(chainFile, "utf8"));
    } catch {
      return null;
    }
  };
  if (o.uninstall || o.noStatusline) {
    if (ours) {
      const c = readChain();
      if (c?.statusLine) settings.statusLine = c.statusLine;
      else delete settings.statusLine;
      statusMsg = tr("Statuszeile entfernt", "Status line removed");
    }
    try {
      fs.unlinkSync(chainFile);
    } catch {
      // no chain
    }
    if (o.noStatusline && !o.uninstall) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(optOutFile, "1");
    }
  } else {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      fs.unlinkSync(optOutFile);
    } catch {
      // not opted out
    }
    if (sl && !ours && sl.type === "command" && typeof sl.command === "string") {
      fs.writeFileSync(chainFile, JSON.stringify({ command: sl.command, statusLine: sl }), { mode: 0o600 });
      statusMsg = tr(
        "Statuszeile eingetragen – deine bisherige wird weiter angezeigt",
        "Status line added; your previous one is still shown",
      );
    } else if (!ours) statusMsg = tr("Statuszeile eingetragen", "Status line added");
    settings.statusLine = {
      ...(sl && !ours && sl.padding !== undefined ? { padding: sl.padding } : {}),
      type: "command",
      command: statusCommand,
      refreshInterval: 60,
    };
  }

  // Brake deselected: remember it so self-healing does not add it again.
  try {
    const off = path.join(home, "brake-off");
    if (!brakeOn && !o.uninstall) {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(off, "1");
    } else fs.unlinkSync(off);
  } catch {
    // no file
  }

  const tmp = `${settingsPath}.fleet-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, settingsPath);
  if (o.uninstall) fs.rmSync(hookDir(), { recursive: true, force: true });
  return {
    ok: true,
    message: o.uninstall
      ? tr(`Claude-Fleet-Hooks aus ${settingsPath} entfernt.`, `Claude Fleet hooks removed from ${settingsPath}.`)
      : `${tr(`Hooks installiert in ${settingsPath}`, `Hooks installed in ${settingsPath}`)}${statusMsg ? ` · ${statusMsg}` : ""}`,
  };
}
