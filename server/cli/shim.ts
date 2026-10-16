import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tr } from "../core/lang";
import { APP_DIR } from "../core/paths";

/**
 * The `fleet` command on PATH, so typing `fleet` in any folder opens Fleet for that folder. `fleet setup` writes a
 * tiny script that runs this Fleet's dist/fleet.cjs with the absolute node path; it never replaces a `fleet` of
 * another tool (the marker line tells ours apart) and `setup --uninstall` removes only ours.
 */

const MARK = "claude-fleet shim";
const onPath = (dir: string, env = process.env) =>
  String(env.PATH || "")
    .split(path.delimiter)
    .some((p) => p && path.resolve(p) === path.resolve(dir));

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the command goes: a folder on PATH the user can write, preferring ~/.local/bin. */
export function shimDir(
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
): {
  dir: string;
  onPath: boolean;
} {
  if (platform === "win32") {
    // On PATH by default for every Windows user.
    const dir = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "WindowsApps");
    return { dir, onPath: true };
  }
  const local = path.join(home, ".local", "bin");
  for (const d of [local, path.join(home, "bin"), "/usr/local/bin", "/opt/homebrew/bin"])
    if (onPath(d, env) && (fs.existsSync(d) ? writable(d) : d === local)) return { dir: d, onPath: true };
  return { dir: local, onPath: false };
}

export function shimFile(dir: string, platform = process.platform): string {
  return path.join(dir, platform === "win32" ? "fleet.cmd" : "fleet");
}

export function shimText(node: string, cli: string, platform = process.platform): string {
  return platform === "win32"
    ? `@echo off\r\nrem ${MARK}\r\n"${node}" "${cli}" %*\r\n`
    : `#!/bin/sh\n# ${MARK} (node dist/fleet.cjs setup), runs ${cli}\nexec "${node}" "${cli}" "$@"\n`;
}

const ours = (f: string) => {
  try {
    return fs.readFileSync(f, "utf8").includes(MARK);
  } catch {
    return false;
  }
};

/** Installs or removes the `fleet` command. Returns the line for the setup output. */
export function installShim(remove = false): string {
  const node = process.execPath;
  const cli = path.join(APP_DIR, "dist", "fleet.cjs");
  const { dir, onPath: found } = shimDir();
  const file = shimFile(dir);
  try {
    if (remove) {
      if (ours(file)) fs.rmSync(file);
      return tr("✔ Befehl fleet entfernt", "✔ fleet command removed");
    }
    if (/["\r\n%$`]/.test(node + cli))
      return tr(
        `⚠ Befehl fleet nicht eingerichtet: Pfad mit Sonderzeichen (${cli})`,
        `⚠ fleet command not set up: path with special characters (${cli})`,
      );
    if (fs.existsSync(file) && !ours(file))
      return tr(
        `⚠ ${file} gehört einem anderen Programm – Befehl fleet nicht eingerichtet`,
        `⚠ ${file} belongs to another program; fleet command not set up`,
      );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, shimText(node, cli), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    const hint = found
      ? ""
      : tr(
          `\n  ${dir} steht noch nicht im PATH. Einmal: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc und ein neues Terminal öffnen.`,
          `\n  ${dir} is not on PATH yet. Once: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc and open a new terminal.`,
        );
    return tr(
      `✔ Befehl fleet eingerichtet (${file}): in jedem Ordner „fleet“ tippen öffnet Fleet für diesen Ordner.${hint}`,
      `✔ fleet command set up (${file}): type "fleet" in any folder to open Fleet for that folder.${hint}`,
    );
  } catch (e) {
    return `⚠ ${tr("Befehl fleet nicht eingerichtet", "fleet command not set up")}: ${e instanceof Error ? e.message : e}`;
  }
}
