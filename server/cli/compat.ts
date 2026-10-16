import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { replaySession, report, type SessionAudit } from "../core/audit";
import { readClaudeProcs } from "../core/ccprocs";
import {
  byVersion,
  type CompatResult,
  FLAGS,
  formatProblems,
  MIN_WAITS,
  PROBE,
  saveCompat,
  versionOf,
  versionResult,
} from "../core/compat";
import { loadConfig } from "../core/config";
import { tr } from "../core/lang";
import { bundledClaude, candidates, extendPath, findExecutable } from "../core/toolpath";
import { decisions, events, jsonLines, transcripts } from "./audit";

/**
 * `fleet compat [--hours 72] [--json] [--save] [--quiet]`: does Fleet still fit the Claude Code versions in use?
 * Reads only (transcripts, hook events, `claude --version`/`--help`); `--save` writes ~/.claude-fleet/compat.json
 * for the warning in the dashboard. Exit code 1 when the newest version is broken or a flag is gone.
 */

function cliInfo(): { cli: string | null; missingFlags: string[] } {
  const bin = findExecutable("claude", extendPath(process.env.PATH, candidates())) || bundledClaude();
  if (!bin) return { cli: null, missingFlags: [] };
  const run = (...a: string[]) => {
    const r = spawnSync(bin, a, {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `${r.stdout || ""}${r.stderr || ""}`;
  };
  const cli = /\d+\.\d+\.\d+[\w.-]*/.exec(run("--version"))?.[0] || null;
  if (!cli) return { cli: null, missingFlags: [] };
  // Help texts hide flags (--max-turns is accepted but not listed in 2.1.295): ask the parser instead. claude
  // rejects the first unknown option before it does anything, so a known flag lets the probe be the unknown one.
  const missingFlags = FLAGS.filter((f) => !run(...f, PROBE).includes(`unknown option '${PROBE}'`)).map((f) => f[0]);
  return { cli, missingFlags };
}

/** Files in ~/.claude/sessions against the entries ccprocs.ts can read (dead processes included, they parse too). */
function procFiles(claudeHome: string): { files: number; readable: number } {
  const dir = path.join(claudeHome, "sessions");
  let files = 0;
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{1,10}\.json$/.test(f)).length;
  } catch {
    return { files: 0, readable: 0 };
  }
  return { files, readable: readClaudeProcs(claudeHome, () => true).size };
}

export function runCompat(hours: number, now = Date.now()): CompatResult {
  const cfg = loadConfig();
  const from = now - hours * 3600e3;
  const evs = events(cfg._fleetHome);
  const decs = decisions(cfg._fleetHome);
  const groups = new Map<string, { audits: SessionAudit[]; format: Record<string, number> }>();
  for (const file of transcripts(cfg.claudeHome, from)) {
    const id = path.basename(file, ".jsonl");
    const lines = jsonLines(file);
    const v = versionOf(lines) || "?";
    const g = groups.get(v) || { audits: [], format: {} };
    g.audits.push(
      replaySession(id, lines, evs.get(id) || [], {
        from,
        to: now,
        staleMinutes: cfg.staleMinutes,
        decisions: decs.get(id),
      }),
    );
    for (const [k, n] of Object.entries(formatProblems(lines))) g.format[k] = (g.format[k] || 0) + n;
    groups.set(v, g);
  }
  const versions = [...groups]
    .map(([v, g]) => versionResult(v, g.audits.length, report(g.audits, { hours, from, to: now }), g.format))
    .sort(byVersion);
  return { at: now, hours, ...cliInfo(), procs: procFiles(cfg.claudeHome), versions };
}

export function compat(args: string[]): number {
  const i = args.indexOf("--hours");
  const h = i >= 0 ? Number(args[i + 1]) : 72;
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : 72;
  const r = runCompat(hours);
  if (args.includes("--save")) saveCompat(r);
  const bad =
    r.missingFlags.length > 0 || (!!r.procs?.files && !r.procs.readable) || r.versions[0]?.verdict === "broken";
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else if (!args.includes("--quiet")) {
    console.log(
      tr(
        `fleet compat: ${hours} h, Claude Code CLI ${r.cli || "nicht gefunden"}`,
        `fleet compat: ${hours} h, Claude Code CLI ${r.cli || "not found"}`,
      ),
    );
    console.log(
      r.missingFlags.length
        ? tr(`  ✖ Schalter fehlen: ${r.missingFlags.join(", ")}`, `  ✖ flags missing: ${r.missingFlags.join(", ")}`)
        : tr(
            `  ✔ alle ${FLAGS.length} Schalter, die Fleet nutzt, sind da`,
            `  ✔ all ${FLAGS.length} flags Fleet uses are there`,
          ),
    );
    if (r.procs?.files)
      console.log(
        r.procs.readable
          ? tr(
              `  ✔ Prozessstatus von Claude Code lesbar (${r.procs.readable} von ${r.procs.files})`,
              `  ✔ Claude Code's process status readable (${r.procs.readable} of ${r.procs.files})`,
            )
          : tr(
              `  ✖ Prozessdateien von Claude Code nicht lesbar (${r.procs.files})`,
              `  ✖ Claude Code's process files not readable (${r.procs.files})`,
            ),
      );
    console.log(
      tr(
        "  Version      Sessions  Warten  verpasst  Fehlalarm  Format  Urteil",
        "  version      sessions  waits   missed    false      format  verdict",
      ),
    );
    for (const v of r.versions) {
      const f = Object.entries(v.format)
        .map(([k, n]) => `${k}×${n}`)
        .join(" ");
      console.log(
        `  ${v.version.padEnd(11)}  ${String(v.sessions).padStart(8)}  ${String(v.waits).padStart(6)}  ${String(v.missed).padStart(8)}  ${String(v.falseAlarms).padStart(9)}  ${(f || "ok").padEnd(6)}  ${v.verdict}`,
      );
    }
    console.log(
      tr(
        `\n„ok“ ab ${MIN_WAITS} Wartezuständen ohne Fehler; „unproven“ heißt: noch zu wenig benutzt. Einzelne Momente: node dist/fleet.cjs audit`,
        `\n"ok" from ${MIN_WAITS} waits without an error; "unproven" means: used too little so far. Single moments: node dist/fleet.cjs audit`,
      ),
    );
  }
  return bad ? 1 : 0;
}
