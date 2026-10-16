import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "../core/paths";
import { contextFromTranscript } from "./transcript";

/**
 * How full are limit and context? The five-hour limit applies to the whole account: the newest value of
 * any session counts. Its only source is the status line (terminal). Without it there is no limit value:
 * an estimate once paused sessions at 80 % when the limit had long been reached. Only certain values
 * trigger anything. The context is then read from the end of the transcript.
 */
export function readUsage(sid: string, now: number, transcript?: unknown) {
  const dir = path.join(fleetHome(), "statusline");
  const out: {
    limit: number | null;
    resetsAt: number | null;
    context: number | null;
    tokens: number | null;
    model: string | null;
  } = {
    limit: null,
    resetsAt: null,
    context: null,
    tokens: null,
    model: null,
  };
  let newest = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    // no status line
  }
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.sessionId === sid && j.context && Number.isFinite(j.context.pct)) {
        out.context = j.context.pct;
        out.tokens = Number.isFinite(j.context.tokens) ? j.context.tokens : null;
        out.model = j.model || null;
      }
      const five = j.rateLimits?.five_hour;
      if (
        five &&
        Number.isFinite(five.used_percentage) &&
        j.at > newest &&
        now - j.at < 30 * 60e3 &&
        (!five.resets_at || five.resets_at * 1000 > now)
      ) {
        newest = j.at;
        out.limit = five.used_percentage;
        out.resetsAt = five.resets_at || null;
      }
    } catch {
      // being written
    }
  }
  if (out.context === null && typeof transcript === "string") {
    const c = contextFromTranscript(transcript);
    if (c) {
      out.context = c.pct;
      out.tokens = c.tokens;
      out.model = c.model;
    }
  }
  return out;
}
