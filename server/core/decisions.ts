import fs from "node:fs";
import path from "node:path";
import type { BrakeAnswer, Decision } from "../../shared/types";
import { tr } from "./lang";
import { fleetHome, ID_RE } from "./paths";

/** Where brake decisions live: one small JSON file each, written atomically; listed and answered by the server. */

export const decisionDir = () => path.join(fleetHome(), "decisions");

/** Windows refuses a rename while another process has the target open; that passes within milliseconds. */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(data);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  // Tried again for a busy target, then written in place like the hook does (CI on Windows, 16 Oct: EPERM lost an
  // approval's decision). Any other error is a real one and throws.
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!BUSY.has(String((e as NodeJS.ErrnoException).code))) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      pause(5 * (i + 1));
    }
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.rmSync(tmp, { force: true });
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Newest decision of a session with this status. */
export function latestFor(sid: string, status: Decision["status"]): Decision | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(decisionDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  let best: Decision | null = null;
  for (const f of names.sort().slice(-200)) {
    const d = readJson<Decision>(path.join(decisionDir(), f));
    if (
      d &&
      d.sessionId === sid &&
      d.status === status &&
      d.kind !== "permission" &&
      (!best || d.createdAt > best.createdAt)
    )
      best = d;
  }
  return best;
}

export const read = (id: string): Decision | null =>
  ID_RE.test(id) ? readJson<Decision>(path.join(decisionDir(), `${id}.json`)) : null;
export const save = (d: Decision) => writeAtomic(path.join(decisionDir(), `${d.id}.json`), d);

/** Decisions for the dashboard: open ones and those of the last 6 hours, newest first. Removes files older than two days. */
// Parsed decision files by path: every overview build lists them, and reading a few hundred old files each time
// blocked the server for tens of milliseconds per hook event. A file counts as unchanged with the same mtime and size.
const listCache = new Map<string, { mtime: number; size: number; d: Decision | null }>();

function readCached(p: string): Decision | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    listCache.delete(p);
    return null;
  }
  let c = listCache.get(p);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
    c = { mtime: st.mtimeMs, size: st.size, d: readJson<Decision>(p) };
    listCache.set(p, c);
  }
  // A copy: the caller marks expired decisions on it.
  return c.d && typeof c.d === "object" ? { ...c.d } : null;
}

export function list(now = Date.now()): Decision[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(decisionDir());
  } catch {
    return [];
  }
  const out: Decision[] = [];
  const seen = new Set(names.map((f) => path.join(decisionDir(), f)));
  for (const k of listCache.keys()) if (!seen.has(k)) listCache.delete(k);
  for (const f of names) {
    const p = path.join(decisionDir(), f);
    if (!f.endsWith(".json")) {
      if (f.endsWith(".tmp")) {
        try {
          if (now - fs.statSync(p).mtimeMs > 60e3) fs.unlinkSync(p);
        } catch {
          // gone already
        }
      }
      continue;
    }
    const d = readCached(p);
    if (
      !d ||
      typeof d.id !== "string" ||
      !ID_RE.test(d.id) ||
      typeof d.sessionId !== "string" ||
      !Number.isFinite(d.createdAt)
    )
      continue;
    if (now - d.createdAt > 2 * 86400e3) {
      try {
        fs.unlinkSync(p);
      } catch {
        // gone already
      }
      continue;
    }
    // Open, but the deadline passed and the hook did not mark it anymore (e.g. the session ended).
    if (d.status === "open" && now > d.expiresAt + 5000) d.status = "expired";
    if (d.status === "open" || now - d.createdAt < 6 * 3600e3) out.push(d);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
}

/** Stores the answer from the dashboard. Also after the deadline: then it applies at the next tool call. */
export function answer(
  id: string,
  value: unknown,
  now = Date.now(),
): { ok: true; decision: Decision } | { ok: false; status: number; error: string } {
  const d = read(id);
  if (!d) return { ok: false, status: 404, error: tr("Entscheidung nicht gefunden", "Decision not found") };
  if (!d.options.some((o) => o.id === value))
    return { ok: false, status: 400, error: tr("ungültige Antwort", "invalid answer") };
  if (d.status !== "open" && d.status !== "expired")
    return { ok: false, status: 409, error: tr("schon entschieden", "already decided") };
  // An expired approval is answered in the app; a later answer here would go nowhere.
  if (d.kind === "permission" && d.status === "expired")
    return {
      ok: false,
      status: 409,
      error: tr("abgelaufen – bitte in der App beantworten", "expired, please answer in the app"),
    };
  d.status = "answered";
  d.answer = value as BrakeAnswer;
  d.answeredAt = now;
  save(d);
  return { ok: true, decision: d };
}
