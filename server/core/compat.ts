import fs from "node:fs";
import path from "node:path";
import type { AuditReport } from "./audit";
import { tr } from "./lang";
import { fleetHome } from "./paths";

/**
 * Compatibility per Claude Code version. Fleet depends on formats Claude Code does not promise to keep: the
 * transcript JSONL, the hook events, CLI flags. Every transcript line names the version that wrote it, so
 * `fleet compat` replays the recent sessions per version through the real detection (the same replay as
 * `fleet audit`) and checks the format Fleet reads. A version is
 * - "ok" with at least MIN_WAITS waits seen, none missed, no false alarm, no format problem,
 * - "broken" with a missed wait, a false alarm or a format problem,
 * - "unproven" otherwise (too little use so far).
 * The server runs it in the background at start and every few hours; a broken newest version is a warning in the
 * message row.
 */

export const MIN_WAITS = 5;
export type Verdict = "ok" | "broken" | "unproven";

// biome-ignore lint/suspicious/noExplicitAny: transcript lines are a foreign format, read defensively
type Line = Record<string, any>;

/** The Claude Code version that wrote a transcript: its newest line that names one. */
export function versionOf(lines: Line[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = lines[i]?.version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) return v.slice(0, 32);
  }
  return null;
}

/** What Fleet reads from a transcript and did not find, by kind (counts). Empty: the format fits. */
export function formatProblems(lines: Line[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string) => {
    out[k] = (out[k] || 0) + 1;
  };
  const uses = new Set<string>();
  const results: string[] = [];
  for (const l of lines) {
    if (l.type !== "user" && l.type !== "assistant") continue;
    if (typeof l.timestamp !== "string" || Number.isNaN(Date.parse(l.timestamp))) add("timestamp");
    const m = l.message;
    if (!m || typeof m !== "object") {
      add("message");
      continue;
    }
    if (l.type === "assistant") {
      if (!Array.isArray(m.content)) add("assistant.content");
      const u = m.usage;
      if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") add("usage");
    }
    if (Array.isArray(m.content))
      for (const b of m.content) {
        if (b?.type === "tool_use") {
          if (typeof b.id === "string" && typeof b.name === "string") uses.add(b.id);
          else add("tool_use");
        }
        if (b?.type === "tool_result") {
          if (typeof b.tool_use_id === "string") results.push(b.tool_use_id);
          else add("tool_result");
        }
      }
  }
  // Results whose call is unknown: ids no longer pair (a call can come before the window, so only if most fail).
  const orphans = results.filter((id) => !uses.has(id)).length;
  if (results.length >= 5 && orphans > results.length / 2) out["tool ids"] = orphans;
  return out;
}

export interface VersionResult {
  version: string;
  sessions: number;
  waits: number;
  missed: number;
  falseAlarms: number;
  format: Record<string, number>;
  verdict: Verdict;
}

export interface CompatResult {
  at: number;
  hours: number;
  /** `claude --version` of the CLI Fleet would start; null when none was found. */
  cli: string | null;
  /** Flags Fleet passes to claude that its --help no longer names. */
  missingFlags: string[];
  /** Claude Code's process files (~/.claude/sessions, ccprocs.ts): how many there are and how many Fleet can read. */
  procs?: { files: number; readable: number };
  versions: VersionResult[];
}

export function verdict(v: Omit<VersionResult, "verdict">): Verdict {
  if (v.missed || v.falseAlarms || Object.keys(v.format).length) return "broken";
  return v.waits >= MIN_WAITS ? "ok" : "unproven";
}

export function versionResult(version: string, sessions: number, r: AuditReport, format: Record<string, number>) {
  const waits = Object.values(r.byKind).reduce((n, k) => n + k.waits, 0);
  const base = { version, sessions, waits, missed: r.misses.length, falseAlarms: r.falseAlarms.length, format };
  return { ...base, verdict: verdict(base) };
}

/** Newest first, by version number. */
export function byVersion(a: { version: string }, b: { version: string }): number {
  const p = (v: string) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a.version);
  const y = p(b.version);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

/** The flags Fleet passes to claude, each with a value it accepts (server/process/args.ts, handoff/fresh.ts). */
export const FLAGS: [string, ...string[]][] = [
  ["--resume", "00000000-0000-4000-8000-000000000000"],
  ["--session-id", "00000000-0000-4000-8000-000000000000"],
  ["--fork-session"],
  ["--permission-mode", "default"],
  ["--output-format", "stream-json"],
  ["--verbose"],
  ["--max-turns", "1"],
  ["--print"],
];
/** An option no claude knows: whether claude names it or the flag before it as unknown tells if the flag exists. */
export const PROBE = "--fleet-compat-probe";

export const compatFile = () => path.join(fleetHome(), "compat.json");

export function readCompat(): CompatResult | null {
  try {
    const c = JSON.parse(fs.readFileSync(compatFile(), "utf8"));
    return c && Array.isArray(c.versions) ? c : null;
  } catch {
    return null;
  }
}

export function saveCompat(c: CompatResult): void {
  fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  const tmp = `${compatFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, compatFile());
}

/** The line for the message row: the newest Claude Code version in use does not fit Fleet. */
export function compatWarning(c: CompatResult | null = readCompat()): string {
  if (!c) return "";
  const newest = c.versions[0];
  if (c.missingFlags.length)
    return tr(
      `Claude Code ${c.cli || ""} kennt ${c.missingFlags.join(", ")} nicht mehr – Fleet kann dort Sessions nicht starten oder fortsetzen. Details: node dist/fleet.cjs compat`,
      `Claude Code ${c.cli || ""} no longer knows ${c.missingFlags.join(", ")}; Fleet cannot start or resume sessions there. Details: node dist/fleet.cjs compat`,
    );
  if (c.procs && c.procs.files > 0 && c.procs.readable === 0)
    return tr(
      `Claude Code ${c.cli || ""} schreibt seine Prozessdateien anders – Fleet sieht Wartezustände nur noch aus Hooks und Transcripts. Details: node dist/fleet.cjs compat`,
      `Claude Code ${c.cli || ""} writes its process files differently; Fleet sees waiting states only from hooks and transcripts. Details: node dist/fleet.cjs compat`,
    );
  if (newest?.verdict !== "broken") return "";
  const what = [
    newest.missed ? tr(`${newest.missed} Wartezustände verpasst`, `${newest.missed} waits missed`) : "",
    newest.falseAlarms ? tr(`${newest.falseAlarms} Fehlalarme`, `${newest.falseAlarms} false alarms`) : "",
    Object.keys(newest.format).length ? tr("Transcript-Format geändert", "transcript format changed") : "",
  ]
    .filter(Boolean)
    .join(", ");
  return tr(
    `Claude Code ${newest.version}: ${what} – Fleet zeigt dort vielleicht nicht jedes Warten. Details: node dist/fleet.cjs compat`,
    `Claude Code ${newest.version}: ${what}; Fleet may not show every wait there. Details: node dist/fleet.cjs compat`,
  );
}
