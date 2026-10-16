/**
 * The Claude Fleet command line (dist/fleet.cjs). One file, Node built-ins only.
 *   fleet [folder]          open Fleet for this folder (or the one named): starts it if needed
 *   fleet setup [--no-open] [--no-autostart] [--no-command] [--uninstall]
 *   fleet start [--no-open] | open | status | stop [--force] | restart [--force]
 *   fleet serve [--demo] [--port N] [--open] [--no-repair]
 *   fleet install-hooks [--light] [--sync] [--node-cmd=node] [--no-statusline] [--no-brake] [--uninstall]
 *   fleet audit [--hours N] [--json]
 *   fleet hook [status|on|off]
 *   fleet compat [--hours 72] [--json] [--save]
 *   fleet balance [--json]
 *   fleet scope [--days 14] [--json]
 */
import fs from "node:fs";
import { writeHere } from "../core/here";
import { installHooks } from "../core/install";
import { tr } from "../core/lang";
import { currentId, hookOff, recentErrors, setHookOff } from "../core/pinhook";
import { audit } from "./audit";
import { balance } from "./balance";
import { compat } from "./compat";
import { launcher } from "./launcher";
import { scope } from "./scope";
import { serve } from "./serve";
import { setup } from "./setup";
import { version } from "./version";

const COMMANDS = new Set([
  "serve",
  "setup",
  "start",
  "open",
  "status",
  "stop",
  "restart",
  "supervise",
  "install-hooks",
  "audit",
  "compat",
  "balance",
  "scope",
  "hook",
  "here",
  "version",
  "--version",
  "help",
  "--help",
]);
// The only options `fleet [folder]` takes. Any other leading option must not start Fleet: `fleet --help` once
// opened the live Fleet instead of printing help.
const HERE_OPTIONS = new Set(["--no-open"]);
const ALIASES: Record<string, string> = { "-h": "help", "-v": "version" };
const argv = process.argv.slice(2);
// `fleet` alone, `fleet .`, `fleet ~/code/x` or `fleet --no-open`: Fleet for a folder (server/core/here.ts).
const first = argv[0] === undefined ? undefined : ALIASES[argv[0]] || argv[0];
const [cmd = "here", ...args] =
  first === undefined || HERE_OPTIONS.has(first) || (!COMMANDS.has(first) && !first.startsWith("-") && isDir(first))
    ? ["here", ...argv]
    : [first, ...argv.slice(1)];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `fleet --help`: every command with one line on what it does (practical test 15 Oct: one bare line was too little). */
function usage(): string {
  const rows: [string, string, string][] = [
    [
      "fleet [Ordner] [--no-open]",
      "Fleet für diesen Ordner öffnen, startet es bei Bedarf",
      "open Fleet for this folder, starts it if needed",
    ],
    [
      "fleet setup",
      "einrichten: Hooks, Autostart, Befehl fleet, Browser",
      "set up: hooks, autostart, the fleet command, browser",
    ],
    [
      "fleet start | open",
      "im Hintergrund starten | im Browser öffnen",
      "start in the background | open in the browser",
    ],
    ["fleet status", "läuft Fleet, welche Version, wo", "is Fleet running, which version, where"],
    [
      "fleet stop | restart [--force]",
      "anhalten | neu starten (beendet Sessions im Fenster)",
      "stop | restart (ends sessions in its window)",
    ],
    [
      "fleet serve [--demo] [--port N]",
      "im Vordergrund laufen, --demo mit erfundenen Daten",
      "run in the foreground, --demo with invented data",
    ],
    [
      "fleet install-hooks [--uninstall]",
      "Hook in ~/.claude/settings.json eintragen",
      "add the hook to ~/.claude/settings.json",
    ],
    ["fleet hook [status|on|off]", "Hook prüfen, ein- oder ausschalten", "check the hook, switch it on or off"],
    ["fleet audit [--hours N]", "hat Fleet jedes Warten erkannt (nur lesend)", "did Fleet see every wait (read only)"],
    [
      "fleet compat",
      "passt Fleet zur installierten Claude-Code-Version",
      "does Fleet fit the installed Claude Code version",
    ],
    ["fleet balance", "spart Fleet Geld (Wochenbilanz)", "does Fleet save money (weekly balance)"],
    ["fleet scope [--days 14]", "welche Funktionen genutzt werden", "which features are used"],
    ["fleet version", "Version dieser CLI", "version of this CLI"],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return [
    `Claude Fleet ${version()}`,
    "",
    tr("Befehle:", "Commands:"),
    ...rows.map(([cmd, de, en]) => `  ${cmd.padEnd(w)}  ${tr(de, en)}`),
    "",
    tr("Mehr: README.md", "More: README.md"),
  ].join("\n");
}

/** `fleet hook --help`: what the three words do. */
function hookUsage(): string {
  return [
    tr("Aufruf: fleet hook [status|on|off]", "Usage: fleet hook [status|on|off]"),
    "",
    `  status  ${tr("zeigt, ob der Hook an ist, den geprüften Build und die Abstürze der letzten Stunde (Standard)", "shows whether the hook is on, the tested build and the crashes of the last hour (default)")}`,
    `  off     ${tr("schaltet den Hook in allen Sessions aus, wirkt beim nächsten Ereignis", "switches the hook off in every session, takes effect with the next event")}`,
    `  on      ${tr("schaltet ihn wieder ein", "switches it back on")}`,
  ].join("\n");
}

async function main(): Promise<number> {
  // `fleet status --help` and the like: help, never the command (practical test 15 Oct: --help was ignored).
  if (cmd !== "here" && (args.includes("--help") || args.includes("-h"))) {
    // The help of the command asked about (round 7: `fleet hook --help` printed the general help).
    console.log(cmd === "hook" ? hookUsage() : usage());
    return 0;
  }
  switch (cmd) {
    case "serve":
      serve(args);
      return -1; // keeps running
    case "setup":
      return setup(args);
    case "open": // starts Fleet if needed and opens it in a paired browser (token.ts)
      return launcher("start", args);
    case "here": {
      const dir = args.find((a) => !a.startsWith("-")) || process.cwd();
      try {
        const h = writeHere(dir);
        console.log(`${tr("Fleet für", "Fleet for")} ${h.dir}`);
      } catch (e) {
        console.error(`✖ ${e instanceof Error ? e.message : e}`);
        return 1;
      }
      return launcher(
        "start",
        args.filter((a) => a.startsWith("-")),
      );
    }
    case "start":
    case "status":
    case "stop":
    case "restart":
    case "supervise":
      return launcher(cmd, args);
    case "install-hooks": {
      const nodeArg = args.find((a) => a.startsWith("--node-cmd="));
      const r = installHooks({
        uninstall: args.includes("--uninstall"),
        light: args.includes("--light"),
        sync: args.includes("--sync"),
        nodeCmd: nodeArg ? nodeArg.slice(11) : undefined,
        noStatusline: args.includes("--no-statusline"),
        noBrake: args.includes("--no-brake"),
      });
      console.log(`${r.ok ? "✔" : "✖"} ${r.message}`);
      return r.ok ? 0 : 1;
    }
    case "audit":
      return audit(args);
    case "compat":
      return compat(args);
    case "balance":
      return balance(args);
    case "scope":
      return scope(args);
    case "hook": {
      // The kill switch for the hook in every session: off takes effect with the next event, no restart needed.
      const sub = args[0] || "status";
      if (sub === "off" || sub === "on") setHookOff(sub === "off");
      else if (sub !== "status") {
        console.log(tr("Aufruf: fleet hook [status|on|off]", "Usage: fleet hook [status|on|off]"));
        return 2;
      }
      const off = hookOff();
      const errors = recentErrors(Date.now() - 3_600_000);
      console.log(
        [
          off
            ? tr(
                `✖ Hook ist aus (${off === "auto" ? "automatisch nach Abstürzen" : "von Hand"})`,
                `✖ Hook is off (${off === "auto" ? "automatically after crashes" : "by hand"})`,
              )
            : tr("✔ Hook ist an", "✔ Hook is on"),
          `${tr("Geprüfter Build", "Tested build")}: ${
            currentId() ||
            tr(
              "— (noch keiner: `fleet setup` oder `fleet install-hooks` legt ihn fest)",
              "— (none yet: `fleet setup` or `fleet install-hooks` sets it)",
            )
          }`,
          `${tr("Abstürze in der letzten Stunde", "Crashes in the last hour")}: ${errors.length}`,
          ...errors.slice(-3).map((e) => `  ${new Date(e.at).toISOString()} ${e.kind}: ${e.error.split("\n")[0]}`),
        ].join("\n"),
      );
      return 0;
    }
    case "--version":
    case "version":
      console.log(version());
      return 0;
    default:
      console.log(usage());
      return cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
