import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { tr } from "../core/lang";
import { APP_DIR } from "../core/paths";

/**
 * Starts a child for the process manager, in a pseudo terminal or with plain pipes.
 *
 * Claude Code's interface needs a real terminal, which Node cannot create with built-ins alone. So the pty
 * module is an optional dependency, loaded at run time from node_modules and never bundled: without it
 * dist/*.cjs still starts with Node built-ins only, and everything but the terminal in the window works.
 * CLAUDE_FLEET_PTY=pipe uses pipes instead (tests and the headless jobs), =off switches the terminal off.
 */

export interface Child {
  pid: number | null;
  write(data: string | Buffer): void;
  /** Closes stdin (pipes only): a headless run then never waits for input. */
  end(): void;
  resize(cols: number, rows: number): void;
  kill(signal: "SIGINT" | "SIGTERM"): void;
  onData(cb: (d: Buffer) => void): void;
  onExit(cb: (code: number | null, error?: string) => void): void;
}

export interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

/** The part of node-pty's API Fleet uses. */
interface IPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    o: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): IPty;
}

export const PTY_PACKAGE = "@lydell/node-pty";

let loaded: { mod: PtyModule | null; why: string } | null = null;

/** The pty module, or why there is none. Loaded once; a wrong Node ABI fails here, not later. */
function load(): { mod: PtyModule | null; why: string } {
  if (loaded) return loaded;
  try {
    // Resolved from Fleet's folder at run time, so esbuild leaves it out of dist/fleet.cjs.
    const req = createRequire(path.join(APP_DIR, "package.json"));
    loaded = { mod: req(PTY_PACKAGE) as PtyModule, why: "" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    loaded = {
      mod: null,
      why:
        code === "MODULE_NOT_FOUND"
          ? tr("pty-Modul fehlt – pnpm install", "pty module missing: pnpm install")
          : tr(
              `pty-Modul lädt nicht (${String((e as Error).message)
                .split("\n")[0]
                ?.slice(0, 120)})`,
              `pty module does not load (${String((e as Error).message)
                .split("\n")[0]
                ?.slice(0, 120)})`,
            ),
    };
  }
  return loaded;
}

export type PtyMode = "pty" | "pipe" | null;

/** How interactive sessions run here: a real pty, pipes (test mode), or not at all, with the reason. */
export function ptyMode(): { mode: PtyMode; why: string } {
  const env = process.env.CLAUDE_FLEET_PTY;
  if (env === "off") return { mode: null, why: tr("Terminal abgeschaltet", "Terminal switched off") };
  if (env === "pipe") return { mode: "pipe", why: "" };
  const l = load();
  return l.mod ? { mode: "pty", why: "" } : { mode: null, why: l.why };
}

/**
 * The command to run. A test double written in JavaScript runs with this very Node, so tests behave the same
 * on every system (a script is no executable on Windows).
 */
export function command(file: string, args: string[]): { file: string; args: string[] } {
  return /\.(c|m)?js$/.test(file) ? { file: process.execPath, args: [file, ...args] } : { file, args };
}

export function spawnChild(mode: "pty" | "pipe", file: string, args: string[], o: SpawnOpts): Child {
  const c = command(file, args);
  if (mode === "pty") {
    const mod = load().mod;
    if (!mod) throw new Error(load().why);
    const p = mod.spawn(c.file, c.args, { name: "xterm-256color", cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
    return {
      pid: p.pid,
      write: (d) => p.write(typeof d === "string" ? d : d.toString("utf8")),
      end: () => {},
      resize: (cols, rows) => {
        try {
          p.resize(cols, rows);
        } catch {
          // the process just ended
        }
      },
      // Windows' pty knows no signals; the process ends either way.
      kill: (sig) => {
        try {
          p.kill(process.platform === "win32" ? undefined : sig);
        } catch {
          // gone already
        }
      },
      onData: (cb) => p.onData((d) => cb(Buffer.from(d, "utf8"))),
      onExit: (cb) => p.onExit((e) => cb(e.signal ? null : e.exitCode)),
    };
  }
  const p = spawn(c.file, c.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exits: ((code: number | null, error?: string) => void)[] = [];
  let ended = false;
  const end = (code: number | null, error?: string) => {
    if (ended) return;
    ended = true;
    for (const cb of exits) cb(code, error);
  };
  p.on("error", (e) => end(null, e.message));
  p.on("exit", (code) => end(code));
  p.stdin.on("error", () => {});
  return {
    pid: p.pid ?? null,
    write: (d) => {
      if (p.stdin.writable) p.stdin.write(d);
    },
    end: () => p.stdin.end(),
    resize: () => {},
    kill: (sig) => {
      try {
        p.kill(sig);
      } catch {
        // gone already
      }
    },
    onData: (cb) => {
      p.stdout.on("data", (d: Buffer) => cb(d));
      p.stderr.on("data", (d: Buffer) => cb(d));
    },
    onExit: (cb) => {
      exits.push(cb);
    },
  };
}
