import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenTarget } from "../../shared/types";
import { desktopLink, UUID } from "./desktop";
import { tr } from "./lang";
import { APP_DIR } from "./paths";
import { bundledClaude, findExecutable } from "./toolpath";

/**
 * Opens a session where one wants to continue: desktop app, VS Code/Cursor or a terminal. The browser
 * must not start programs and foreign URL schemes would be an attack surface; so the server starts the
 * programs itself, without a shell, with a checked session id and a folder it knows from its own
 * overview (never from the request).
 *
 * The links come from the programs themselves:
 *  - Desktop app: claude://claude.ai/epitaxy/<local_…> opens an app session,
 *    claude://resume?session=<uuid> takes a terminal session into the app.
 *  - VS Code/Cursor (extension anthropic.claude-code): <scheme>://anthropic.claude-code/open?session=<uuid>
 *  - Terminal: `claude --resume <uuid>` in the project folder.
 */

export type Target = OpenTarget["id"];
export interface Step {
  cmd: string;
  args: string[];
  cwd?: string;
  delayMs?: number;
}
/** What is installed on this machine (replaceable in tests). */
export interface Env {
  platform: NodeJS.Platform;
  desktopApp: boolean;
  /** path of the app or the `code` command, if the extension is installed */
  vscode: string | null;
  cursor: string | null;
  /** path of the Claude CLI */
  claude: string | null;
  /** Windows Terminal */
  wt: string | null;
  linuxTerminal: string | null;
}

/** No CLI anywhere: neither on PATH nor in the desktop app's folder (toolpath.ts `bundledClaude`). */
export const NO_CLI = {
  de: "Claude-CLI (claude) nicht gefunden (weder im PATH noch in der Desktop-App)",
  en: "Claude CLI (claude) not found (neither on PATH nor in the desktop app)",
};

// Getters: the names follow the UI language at the moment they are read (practical test 15 Oct: "Fleet-Terminal" and
// "Desktop-App" stood in the English UI).
export const LABELS: Record<Target, string> = {
  // Fleet's own window (server/process); not started from here, plan() and planNew() leave it out.
  get fleet() {
    return tr("Fleet-Terminal", "Fleet terminal");
  },
  get desktop() {
    return tr("Desktop-App", "Desktop app");
  },
  vscode: "VS Code",
  cursor: "Cursor",
  terminal: "Terminal",
};
export const isTarget = (v: unknown): v is Target => typeof v === "string" && Object.hasOwn(LABELS, v);

const hasExtension = (dir: string) => {
  try {
    return fs.readdirSync(dir).some((f) => f.startsWith("anthropic.claude-code"));
  } catch {
    return false;
  }
};
const firstExisting = (list: string[]) =>
  list.find((p) => {
    try {
      fs.statSync(p);
      return true;
    } catch {
      return false;
    }
  }) || null;

let detected: { at: number; env: Env } | null = null;

/** What is installed? Checked again once a minute. */
export function detect(): Env {
  const now = Date.now();
  if (detected && now - detected.at < 60e3) return detected.env;
  const home = os.homedir();
  const p = process.platform;
  const apps = (name: string) => [path.join("/Applications", name), path.join(home, "Applications", name)];
  const local = process.env.LOCALAPPDATA || "";
  const env: Env = {
    platform: p,
    desktopApp: !!(p === "darwin"
      ? firstExisting(apps("Claude.app"))
      : p === "win32"
        ? firstExisting([path.join(local, "AnthropicClaude"), path.join(local, "Programs", "Claude")])
        : null),
    vscode: hasExtension(path.join(home, ".vscode", "extensions"))
      ? p === "darwin"
        ? firstExisting(apps("Visual Studio Code.app"))
        : findExecutable("code")
      : null,
    cursor: hasExtension(path.join(home, ".cursor", "extensions"))
      ? p === "darwin"
        ? firstExisting(apps("Cursor.app"))
        : findExecutable("cursor")
      : null,
    // No CLI installed: the one that ships with the desktop app.
    claude: findExecutable("claude") || bundledClaude(p),
    wt: p === "win32" ? findExecutable("wt") : null,
    linuxTerminal:
      p === "linux"
        ? findExecutable("x-terminal-emulator") || findExecutable("gnome-terminal") || findExecutable("konsole")
        : null,
  };
  detected = { at: now, env };
  return env;
}

/**
 * Which targets exist here, with the reason why one is missing. Fleet's own terminal comes first when it is
 * known (the overview passes its state): it is the preferred way, the programs stay in the menu.
 */
export function targets(env: Env, fleet?: { available: boolean; why?: string }): OpenTarget[] {
  const out: OpenTarget[] = [];
  if (fleet)
    out.push(
      fleet.available
        ? { id: "fleet", label: LABELS.fleet, ok: true }
        : { id: "fleet", label: LABELS.fleet, ok: false, why: fleet.why || "" },
    );
  out.push(
    env.desktopApp
      ? { id: "desktop", label: LABELS.desktop, ok: true }
      : {
          id: "desktop",
          label: LABELS.desktop,
          ok: false,
          why: tr("Claude-Desktop-App nicht gefunden", "Claude desktop app not found"),
        },
  );
  out.push(
    env.vscode
      ? { id: "vscode", label: LABELS.vscode, ok: true }
      : {
          id: "vscode",
          label: LABELS.vscode,
          ok: false,
          why: tr(
            "VS Code mit der Claude-Code-Erweiterung nicht gefunden",
            "VS Code with the Claude Code extension not found",
          ),
        },
  );
  if (env.cursor) out.push({ id: "cursor", label: LABELS.cursor, ok: true });
  const term = !!env.claude && (env.platform === "darwin" || env.platform === "win32" || !!env.linuxTerminal);
  out.push(
    term
      ? { id: "terminal", label: LABELS.terminal, ok: true }
      : {
          id: "terminal",
          label: LABELS.terminal,
          ok: false,
          why: env.claude
            ? tr("Kein Terminal-Programm gefunden", "No terminal program found")
            : tr(NO_CLI.de, NO_CLI.en),
        },
  );
  return out;
}

/** Opens a URL with the system's default program. */
function opener(platform: NodeJS.Platform, url: string): Step {
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/** For AppleScript in "…": escape backslash and quotes. */
const appleStr = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** For the shell in '…'. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const absDir = (dir: string | null | undefined, env: Env) =>
  dir && (env.platform === "win32" ? path.win32 : path.posix).isAbsolute(dir) && !/[\0\r\n]/.test(dir) ? dir : null;

/** The steps to open a session in a target. Pure (starts nothing), so it is testable. Empty if not possible. */
export function plan(
  target: Target,
  s: { id: string; cwd: string | null; desktopId?: string | null },
  env: Env,
): Step[] {
  if (!UUID.test(s.id)) return [];
  const cwd = absDir(s.cwd, env);
  if (target === "desktop") {
    const url = env.desktopApp ? desktopLink(s.desktopId, s.id) : null;
    return url ? [opener(env.platform, url)] : [];
  }
  if (target === "vscode" || target === "cursor") {
    const app = env[target];
    if (!app || !cwd) return [];
    const url = `${target}://anthropic.claude-code/open?session=${s.id}`;
    // Open the project folder first: the extension opens the session in the window that is in front.
    const folder = env.platform === "darwin" ? { cmd: "open", args: ["-a", app, cwd] } : { cmd: app, args: [cwd] };
    return [folder, { ...opener(env.platform, url), delayMs: 1500 }];
  }
  if (target === "terminal") {
    if (!env.claude || !cwd) return [];
    if (env.platform === "darwin") {
      const line = `cd ${shQuote(cwd)} && ${shQuote(env.claude)} --resume ${s.id}`;
      return [
        {
          cmd: "osascript",
          args: [
            "-e",
            `tell application "Terminal" to do script "${appleStr(line)}"`,
            "-e",
            'tell application "Terminal" to activate',
          ],
        },
      ];
    }
    if (env.platform === "win32") {
      if (env.wt) return [{ cmd: env.wt, args: ["-d", cwd, env.claude, "--resume", s.id] }];
      // cmd /c start parses the line itself: reject folders with cmd syntax characters.
      if (/["&|<>^%!]/.test(cwd) || /["&|<>^%!]/.test(env.claude)) return [];
      return [{ cmd: "cmd.exe", args: ["/c", "start", '""', "/D", cwd, env.claude, "--resume", s.id] }];
    }
    if (!env.linuxTerminal) return [];
    return [{ cmd: env.linuxTerminal, args: ["-e", env.claude, "--resume", s.id], cwd }];
  }
  return [];
}

/**
 * Starts a new session in a folder with a prompt (e.g. "continue with the handoff").
 * Desktop app: claude://code/new?q=…&folder=… only pre-fills the prompt (the app has no way to send it);
 * VS Code: folder, then …/open?prompt=…; Terminal: `claude "<prompt>"` starts right away.
 */
export function planNew(target: Target, cwd: string, prompt: string, env: Env): Step[] {
  const dir = absDir(cwd, env);
  const q = String(prompt)
    .replace(/[\0\r\n]+/g, " ")
    .slice(0, 500);
  if (!dir || !q) return [];
  if (target === "desktop") {
    return env.desktopApp
      ? [opener(env.platform, `claude://code/new?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(dir)}`)]
      : [];
  }
  if (target === "vscode" || target === "cursor") {
    const app = env[target];
    if (!app) return [];
    const folder = env.platform === "darwin" ? { cmd: "open", args: ["-a", app, dir] } : { cmd: app, args: [dir] };
    return [
      folder,
      {
        ...opener(env.platform, `${target}://anthropic.claude-code/open?prompt=${encodeURIComponent(q)}`),
        delayMs: 1500,
      },
    ];
  }
  if (target === "terminal") {
    if (!env.claude) return [];
    if (env.platform === "darwin") {
      const line = `cd ${shQuote(dir)} && ${shQuote(env.claude)} ${shQuote(q)}`;
      return [
        {
          cmd: "osascript",
          args: [
            "-e",
            `tell application "Terminal" to do script "${appleStr(line)}"`,
            "-e",
            'tell application "Terminal" to activate',
          ],
        },
      ];
    }
    if (env.platform === "win32") return env.wt ? [{ cmd: env.wt, args: ["-d", dir, env.claude, q] }] : [];
    return env.linuxTerminal ? [{ cmd: env.linuxTerminal, args: ["-e", env.claude, q], cwd: dir }] : [];
  }
  return [];
}

/**
 * What is installed; with CLAUDE_FLEET_LAUNCH_LOG (tests) a fixed desktop environment, so tests behave
 * the same on every machine and never open real programs.
 */
export function env(): Env {
  if (process.env.CLAUDE_FLEET_LAUNCH_LOG) {
    return {
      platform: process.platform,
      desktopApp: true,
      vscode: null,
      cursor: null,
      claude: process.env.FLEET_TEST_CLAUDE || null,
      wt: null,
      linuxTerminal: null,
    };
  }
  return detect();
}

function logSteps(steps: Step[]): boolean {
  const log = process.env.CLAUDE_FLEET_LAUNCH_LOG;
  if (!log) return false;
  try {
    fs.appendFileSync(log, `${JSON.stringify(steps)}\n`);
  } catch {
    // test log only
  }
  return true;
}

/** Runs the steps one after another, without a shell. With CLAUDE_FLEET_LAUNCH_LOG only records them. */
export function run(steps: Step[]): void {
  if (logSteps(steps)) return;
  const [first, ...rest] = steps;
  if (!first) return;
  setTimeout(() => {
    try {
      execFile(first.cmd, first.args, { cwd: first.cwd, windowsHide: true, timeout: 15000 }, (err) => {
        if (err) console.error("[fleet] open:", err.message.split("\n")[0]);
      }).on("error", () => {});
    } catch (e) {
      console.error("[fleet] open:", e instanceof Error ? e.message : e);
    }
    run(rest);
  }, first.delayMs || 0);
}

/**
 * Like run, but in a detached process: for the hook, which exits right afterwards (a timer in the hook
 * would never fire). With CLAUDE_FLEET_LAUNCH_LOG (tests) only records the steps.
 */
export function runDetached(steps: Step[]): boolean {
  if (!steps.length) return false;
  if (logSteps(steps)) return true;
  try {
    const c = spawn(process.execPath, [path.join(APP_DIR, "dist", "launch-run.cjs"), JSON.stringify(steps)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    c.on("error", () => {});
    c.unref();
    return true;
  } catch {
    return false;
  }
}
