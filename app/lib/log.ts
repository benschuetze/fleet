import { LOG_MAX } from "../../shared/log";
import type { LogLine, LogPage } from "../../shared/types";

/**
 * The log view in the browser: the server's answer checked like any input, and each session's short tag and colour
 * (spec: "festes Kürzel in einer festen Farbe, aus der Session-ID abgeleitet").
 */

/** Colours of the tags (`--log-1` … in tokens.css): cyan, violet, magenta, pink and sand, a light and a dark step. */
export const LOG_COLORS = 10;

const ID = /^[\w.-]{1,128}$/;
const KINDS: LogLine["kind"][] = ["tool", "text", "prompt", "error"];
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const strOrNull = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** A broken line costs that line, never the view. */
export function parseLogPage(raw: unknown): LogPage | null {
  const o = obj(raw);
  const seq = int(o.seq);
  if (typeof o.epoch !== "string" || seq === null || !Array.isArray(o.lines)) return null;
  const lines: LogLine[] = [];
  for (const v of o.lines.slice(-LOG_MAX)) {
    const l = obj(v);
    const s = int(l.seq);
    const at = Number(l.at);
    if (s === null || !Number.isFinite(at) || typeof l.session !== "string" || !ID.test(l.session)) continue;
    if (!KINDS.includes(l.kind as LogLine["kind"]) || typeof l.text !== "string") continue;
    lines.push({
      seq: s,
      at,
      session: l.session,
      kind: l.kind as LogLine["kind"],
      tool: strOrNull(l.tool, 60),
      text: l.text.slice(0, 300),
    });
  }
  const sessions: LogPage["sessions"] = {};
  for (const [id, v] of Object.entries(obj(o.sessions)).slice(0, 2000)) {
    if (!ID.test(id)) continue;
    const x = obj(v);
    sessions[id] = { name: strOrNull(x.name, 200), project: strOrNull(x.project, 200) };
  }
  const waiting = Array.isArray(o.waiting)
    ? o.waiting.filter((x): x is string => typeof x === "string" && ID.test(x)).slice(0, 2000)
    : [];
  return { epoch: o.epoch.slice(0, 40), seq, lines, sessions, waiting };
}

/** FNV-1a: the same id, the same number, in every browser and after every reload. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The colour of a session's tag, 1 … LOG_COLORS. */
export const colorOf = (id: string) => (hash(id) % LOG_COLORS) + 1;

/**
 * Short tags from the ids: four characters (as `claude --resume` ids start), longer only where two of the shown
 * sessions would share them. Colours repeat after LOG_COLORS sessions; the tags never do.
 */
export function tagsOf(ids: Iterable<string>): Map<string, string> {
  const all = [...new Set(ids)];
  const plain = new Map(all.map((id) => [id, id.replace(/[^a-z0-9]/gi, "").toLowerCase() || id]));
  const out = new Map<string, string>();
  for (const id of all) {
    const p = plain.get(id) || id;
    let n = Math.min(4, p.length);
    while (n < p.length && all.some((o) => o !== id && (plain.get(o) || o).startsWith(p.slice(0, n)))) n++;
    out.set(id, p.slice(0, n));
  }
  return out;
}
