import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHooks } from "../core/install";
import { tr } from "../core/lang";
import { APP_DIR } from "../core/paths";
import { ensureHooks } from "../core/selfheal";
import { launcher } from "./launcher";
import { installShim } from "./shim";

/**
 * Setup in one step (can run any number of times, repairs whatever is needed): hooks, autostart at login
 * (Windows: startup folder, macOS: LaunchAgent, Linux: systemd --user), a desktop shortcut on Windows, then
 * Fleet starts in the background and opens in the browser.
 *   fleet setup [--no-open] [--no-autostart] [--no-command] [--uninstall]
 */

const NODE = process.execPath;
const CLI = path.join(APP_DIR, "dist", "fleet.cjs");
const VBS = path.join(APP_DIR, "autostart", "claude-fleet-windows.vbs");
const say = (m: string) => console.log(m);

function run(cmd: string, a: string[]) {
  const r = spawnSync(cmd, a, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0)
    throw new Error((r.stderr || r.stdout || r.error?.message || "error").trim().split("\n")[0]);
  return r.stdout;
}

const psQuote = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

/** Windows: shortcuts to wscript + VBS start without a console window. The node path is passed absolute. */
function winShortcuts(remove: boolean) {
  const ps = `
$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$items = @(
  @{ Dir = [Environment]::GetFolderPath('Startup'); Args = '--no-open' },
  @{ Dir = [Environment]::GetFolderPath('Desktop'); Args = '' }
)
foreach ($i in $items) {
  $lnk = Join-Path $i.Dir 'Claude Fleet.lnk'
  if (${remove ? "$true" : "$false"}) { if (Test-Path $lnk) { Remove-Item $lnk -Force }; continue }
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'
  $s.Arguments = '"' + ${psQuote(VBS)} + '" "' + ${psQuote(NODE)} + '" ' + $i.Args
  $s.WorkingDirectory = ${psQuote(APP_DIR)}
  $s.Description = 'Claude Fleet'
  $s.IconLocation = ${psQuote(NODE)} + ',0'
  $s.Save()
}
`;
  // -EncodedCommand (UTF-16LE, Base64): no trouble with quotes or umlauts in paths.
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(ps, "utf16le").toString("base64"),
  ]);
}

const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "com.claude-fleet.plist");
function macAutostart(remove: boolean) {
  try {
    run("launchctl", ["unload", PLIST]);
  } catch {
    // not loaded
  }
  if (remove) {
    try {
      fs.unlinkSync(PLIST);
    } catch {
      // not there
    }
    return;
  }
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-fleet</string>
  <key>ProgramArguments</key><array><string>${esc(NODE)}</string><string>${esc(CLI)}</string><string>supervise</string></array>
  <key>WorkingDirectory</key><string>${esc(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
  );
  run("launchctl", ["load", PLIST]);
}

const UNIT = path.join(os.homedir(), ".config", "systemd", "user", "claude-fleet.service");
function linuxAutostart(remove: boolean) {
  if (remove) {
    try {
      run("systemctl", ["--user", "disable", "--now", "claude-fleet"]);
    } catch {
      // not installed
    }
    try {
      fs.unlinkSync(UNIT);
    } catch {
      // not there
    }
    return;
  }
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  fs.writeFileSync(
    UNIT,
    `[Unit]\nDescription=Claude Fleet Dashboard\n\n[Service]\nWorkingDirectory=${APP_DIR}\nExecStart=${q(NODE)} ${q(CLI)} supervise\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
  );
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "claude-fleet"]);
}

function autostart(remove: boolean) {
  try {
    if (process.platform === "win32") winShortcuts(remove);
    else if (process.platform === "darwin") macAutostart(remove);
    else linuxAutostart(remove);
    say(
      remove
        ? tr("✔ Autostart entfernt.", "✔ Autostart removed.")
        : process.platform === "win32"
          ? tr(
              "✔ Autostart beim Anmelden + Desktop-Verknüpfung „Claude Fleet“ eingerichtet.",
              '✔ Autostart at login and the desktop shortcut "Claude Fleet" set up.',
            )
          : tr("✔ Autostart beim Anmelden eingerichtet.", "✔ Autostart at login set up."),
    );
  } catch (e) {
    say(`${tr("⚠ Autostart nicht möglich:", "⚠ Autostart not possible:")} ${e instanceof Error ? e.message : e}`);
  }
}

export async function setup(args: string[]): Promise<number> {
  if (args.includes("--uninstall")) {
    await launcher("stop", []);
    autostart(true);
    say(installHooks({ uninstall: true }).message);
    say(installShim(true));
    return 0;
  }
  say(tr("Claude Fleet wird eingerichtet …", "Setting up Claude Fleet …"));
  say(ensureHooks() || tr("✔ Hooks sind aktuell.", "✔ Hooks are up to date."));
  if (!args.includes("--no-autostart")) autostart(false);
  if (!args.includes("--no-command")) say(installShim());
  // Start, or replace an outdated instance, then open.
  return launcher("start", args.includes("--no-open") ? ["--no-open"] : []);
}
