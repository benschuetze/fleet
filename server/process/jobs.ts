import fs from "node:fs";
import path from "node:path";
import type { JobKind, JobResult } from "../../shared/types";
import { fleetHome } from "../core/paths";

/**
 * Fleet's own jobs: a headless turn (`claude -p … --output-format stream-json`) in an existing session. Only the
 * numbers of the final `result` message count (usage, total_cost_usd, duration_ms, session_id); when Claude Code
 * does not report them they stay null, never an estimate. Every job leaves one line in
 * ~/.claude-fleet/jobs.jsonl, the basis for Fleet's own costs.
 */

export const JOB_TIMEOUT_MS = 5 * 60e3;
const MAX_LOG_BYTES = 1024 * 1024;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const clip = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** One line of stream-json, or null for anything that is no JSON object (progress text, half lines). */
export function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o: unknown = JSON.parse(t);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The result of a job from its output lines; the last `result` message wins. */
export function parseResult(lines: string[], fallback: { exitCode: number | null; error?: string | null }): JobResult {
  let r: Record<string, unknown> | null = null;
  let sessionId: string | null = null;
  for (const l of lines) {
    const o = parseLine(l);
    if (!o) continue;
    if (typeof o.session_id === "string" && /^[\w.-]{1,128}$/.test(o.session_id)) sessionId = o.session_id;
    if (o.type === "result") r = o;
  }
  if (!r)
    return {
      ok: false,
      sessionId,
      durationMs: null,
      tokens: null,
      costUsd: null,
      text: "",
      error:
        fallback.error ||
        (fallback.exitCode === 0 ? "no result" : `exit ${fallback.exitCode === null ? "?" : fallback.exitCode}`),
    };
  const u = r.usage && typeof r.usage === "object" ? (r.usage as Record<string, unknown>) : null;
  const tokens =
    u && num(u.input_tokens) !== null && num(u.output_tokens) !== null
      ? {
          input: num(u.input_tokens) as number,
          output: num(u.output_tokens) as number,
          cacheRead: num(u.cache_read_input_tokens) ?? 0,
          cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
        }
      : null;
  const failed = r.is_error === true || (typeof r.subtype === "string" && r.subtype !== "success");
  return {
    ok: !failed && !fallback.error,
    sessionId: typeof r.session_id === "string" && /^[\w.-]{1,128}$/.test(r.session_id) ? r.session_id : sessionId,
    durationMs: num(r.duration_ms),
    tokens,
    costUsd: num(r.total_cost_usd),
    text: clip(r.result, 400),
    error: fallback.error || (failed ? clip(r.subtype || "error", 120) : null),
  };
}

export function logJob(e: { kind: JobKind; id: string; startedAt: number; endedAt: number; result: JobResult }): void {
  try {
    const f = path.join(fleetHome(), "jobs.jsonl");
    try {
      if (fs.statSync(f).size > MAX_LOG_BYTES) fs.renameSync(f, `${f}.old`);
    } catch {
      // no log yet
    }
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(f, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("[fleet] jobs.jsonl:", (err as Error).message);
  }
}

/** Splits a byte stream into lines; the rest stays until the next chunk. */
export function lineSplitter(onLine: (l: string) => void): { push(b: Buffer): void; end(): void } {
  let rest = "";
  return {
    push(b) {
      rest += b.toString("utf8");
      const parts = rest.split("\n");
      rest = parts.pop() || "";
      // A result line is a few KB; a runaway line without a break must not grow without bound.
      if (rest.length > 1024 * 1024) rest = "";
      for (const p of parts) onLine(p);
    },
    end() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}
