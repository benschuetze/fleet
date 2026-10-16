import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fleet usually runs as a background service (LaunchAgent, systemd, autostart) with a minimal PATH,
 * not the one of the login shell. Tools like `gh` or `claude` often live in ~/.local/bin or Homebrew;
 * without them Fleet would query GitHub anonymously and miss PRs of private repos. So the server adds
 * the usual locations at start.
 */
export function candidates(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env = process.env,
): string[] {
  if (platform === "win32") {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, "GitHub CLI"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "GitHub CLI"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "GitHub CLI"),
      path.join(home, ".local", "bin"),
      env.APPDATA && path.join(env.APPDATA, "npm"),
    ].filter((p): p is string => !!p);
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/snap/bin",
  ];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Appends existing, missing locations to PATH (appended: what the user set wins). */
export function extendPath(
  current: string | undefined,
  dirs: string[],
  exists: (p: string) => boolean = isDir,
): string {
  const parts = String(current || "")
    .split(path.delimiter)
    .filter(Boolean);
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const have = new Set(parts.map(norm));
  for (const d of dirs) {
    if (!have.has(norm(d)) && exists(d)) {
      parts.push(d);
      have.add(norm(d));
    }
  }
  return parts.join(path.delimiter);
}

/** For the server process: extend PATH once. */
export function augmentPath(): void {
  const key =
    process.platform === "win32" ? Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "Path" : "PATH";
  process.env[key] = extendPath(process.env[key], candidates());
}

/** Finds an executable on PATH (no shell, no `which`). */
export function findExecutable(
  name: string,
  pathVar: string | undefined = process.env.PATH || process.env.Path,
): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of String(pathVar || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, name + e);
      try {
        if (fs.statSync(p).isFile()) {
          if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Where the desktop app keeps its own Claude CLI: claude-code/ in the app's data folder (Electron's userData), one
 * folder per version with one per build inside.
 */
export function bundledRoot(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude-code");
  if (platform === "win32")
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude-code");
  // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : "";
  return path.join(xdg || path.join(home, ".config"), "Claude", "claude-code");
}

const BINARY: Partial<Record<NodeJS.Platform, { rel: string[]; magic: (b: Buffer) => boolean }>> = {
  // Mach-O 64-bit little endian, or a universal (fat) binary.
  darwin: {
    rel: ["claude.app", "Contents", "MacOS", "claude"],
    magic: (b) => b.readUInt32LE(0) === 0xfeedfacf || b.readUInt32BE(0) === 0xcafebabe,
  },
  win32: { rel: ["claude.exe"], magic: (b) => b[0] === 0x4d && b[1] === 0x5a },
  linux: { rel: ["claude"], magic: (b) => b.readUInt32BE(0) === 0x7f454c46 },
};

const versionNumbers = (v: string) => v.split(".").map(Number);
function newerFirst(a: string, b: string): number {
  const x = versionNumbers(a);
  const y = versionNumbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

/**
 * Is this the app's binary, ready to run? A regular file inside the app folder (no link out of it), executable,
 * and with the header of a native binary for this system: while the app downloads an update the newest folder can
 * hold an empty or half-written file, and nothing else in there should ever be started.
 */
function realBinary(file: string, rootReal: string, magic: (b: Buffer) => boolean, platform: NodeJS.Platform): boolean {
  try {
    const real = fs.realpathSync.native(file);
    if (!real.startsWith(rootReal + path.sep) || fs.lstatSync(file).isSymbolicLink()) return false;
    if (!fs.statSync(real).isFile()) return false;
    if (platform !== "win32" && process.platform !== "win32") fs.accessSync(real, fs.constants.X_OK);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(real, "r");
    try {
      if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    } finally {
      fs.closeSync(fd);
    }
    return magic(head);
  } catch {
    return false;
  }
}

/**
 * The Claude CLI that ships with the desktop app, for when none is installed on PATH (BUGANALYSE B2). The app
 * updates it on its own and keeps older versions next to it, so the newest version with a usable binary counts.
 */
export function bundledClaude(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = bundledRoot(platform, home, env);
  const bin = BINARY[platform];
  if (!bin) return null;
  let rootReal: string;
  let versions: string[];
  try {
    rootReal = fs.realpathSync.native(root);
    versions = fs.readdirSync(root).filter((v) => /^\d{1,6}(\.\d{1,6}){0,3}$/.test(v));
  } catch {
    return null;
  }
  for (const v of versions.sort(newerFirst)) {
    let builds: string[];
    try {
      builds = fs.readdirSync(path.join(root, v)).sort();
    } catch {
      continue;
    }
    for (const b of builds) {
      const file = path.join(root, v, b, ...bin.rel);
      if (realBinary(file, rootReal, bin.magic, platform)) return file;
    }
  }
  return null;
}
