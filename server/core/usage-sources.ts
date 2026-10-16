import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { windowOver } from "../../shared/limits";
import type { Usage, UsageEntry } from "../../shared/types";

/** Usage sources besides the transcripts: Cowork reports and the limits from the status line. */

const DAY = 24 * 3600e3;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// biome-ignore lint/suspicious/noExplicitAny: report lines are untrusted JSON; every field is checked where it is read
type Line = Record<string, any>;

/* Cowork: the plugin appends one line per turn. */
export const COWORK = { offset: 0, size: -1, msgs: new Map<string, UsageEntry>() };

export async function scanCowork(fleetHome: string) {
  const file = path.join(fleetHome, "usage-cowork.jsonl");
  let st: Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    return;
  }
  if (st.size < COWORK.offset) {
    COWORK.offset = 0;
    COWORK.msgs = new Map();
  }
  if (st.size === COWORK.size) return;
  const fh = await fsp.open(file, "r");
  try {
    const len = st.size - COWORK.offset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, COWORK.offset);
    const last = buf.lastIndexOf(0x0a);
    if (last >= 0) {
      for (const line of buf
        .subarray(0, last + 1)
        .toString("utf8")
        .split("\n")) {
        if (!line) continue;
        try {
          const o = JSON.parse(line) as Line;
          if (!o || typeof o.sessionId !== "string" || !o.at) continue;
          COWORK.msgs.set(`${o.sessionId}:${o.turnId || o.at}`, {
            t: Number(o.at),
            model: String(o.model || "?"),
            sid: o.sessionId,
            i: num(o.i),
            o: num(o.o),
            cw: num(o.cw),
            cr: num(o.cr),
            cw1h: 0,
          });
        } catch {
          // ignore broken line
        }
      }
      COWORK.offset += last + 1;
    }
    COWORK.size = st.size;
  } finally {
    await fh.close();
  }
}

/* ---------- Limits from the status line (hooks/statusline.ts) ---------- */

type Window = { used_percentage: number; resets_at?: number };
export interface StatuslineState {
  sessionId: string;
  at: number;
  model: string | null;
  context: { size: number; pct: number | null; tokens: number | null } | null;
  cost: number | null;
  rateLimits: Record<string, Window | undefined> | null;
}

export async function readStatuslines(fleetHome: string) {
  const dir = path.join(fleetHome, "statusline");
  const out: { bySession: Record<string, StatuslineState>; limits: Usage["limits"] } = { bySession: {}, limits: null };
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  let newest = 0;
  const now = Date.now();
  await Promise.all(
    names.map(async (f) => {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8")) as StatuslineState;
        if (!j || typeof j.sessionId !== "string") return;
        out.bySession[j.sessionId] = j;
        if (j.rateLimits && j.at > newest) {
          newest = j.at;
          out.limits = { ...(j.rateLimits as NonNullable<Usage["limits"]>), at: j.at };
        }
        if (now - j.at > 14 * DAY) await fsp.unlink(path.join(dir, f)).catch(() => {});
      } catch {
        // being written
      }
    }),
  );
  if (out.limits) {
    const limits = out.limits as Record<string, Window | number | undefined>;
    for (const k of Object.keys(limits)) {
      const w = limits[k];
      if (w && typeof w === "object" && windowOver(w, now)) delete limits[k]; // expired
    }
  }
  return out;
}
