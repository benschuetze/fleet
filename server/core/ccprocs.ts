import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ID_RE } from "./paths";

/**
 * Claude Code's own word on its running sessions: every interactive process keeps ~/.claude/sessions/<pid>.json with
 * its session id and a status, "busy", "waiting" (a prompt in the app waits for you) or "idle" (the turn ended).
 * Hooks and transcripts only let Fleet guess these: an approval prompt the hook never reported looked like a tool
 * that hangs (four sessions "no sign of life for 202 min" on 15 Oct, all of them waiting), and a long tool run
 * looked like a stall. Read only; a file whose process is gone does not count. Undocumented format: `fleet compat`
 * names a change.
 */

export type CcStatus = "idle" | "busy" | "waiting";
export interface CcProc {
  status: CcStatus;
  /** When Claude Code last set the status. */
  at: number;
  pid: number;
}

const STATUSES = new Set<CcStatus>(["idle", "busy", "waiting"]);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it is just not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let domain: ((d: string) => boolean) | null = null;

/**
 * Is a process file's `pidDomain` this machine (and pid namespace)? Claude Code writes "darwin" on macOS,
 * "<prefix>:<machine-id>:<pid namespace>" on Linux and "<prefix>:<hostname>" on Windows (review #146). Only then
 * does a dead pid mean a dead process; anything unknown counts as somewhere else.
 */
export function sameDomain(d: unknown): boolean {
  if (d === undefined) return true;
  if (typeof d !== "string") return false;
  if (!domain) {
    let parts: string[] = [];
    try {
      if (process.platform === "linux")
        parts = [fs.readFileSync("/etc/machine-id", "utf8").trim(), fs.readlinkSync("/proc/self/ns/pid")];
      else if (process.platform === "win32") parts = [os.hostname()];
    } catch {
      parts = [];
    }
    const own = parts.filter(Boolean);
    domain = (v) =>
      v === process.platform || (own.length > 0 && own.length === parts.length && own.every((x) => v.includes(x)));
  }
  return domain(d);
}

/**
 * `gone` collects sessions whose every process file names a dead pid: the process ended without a SessionEnd (a
 * window closed, a crash). The file stays, so this is certain, unlike a missing file.
 */
export function readClaudeProcs(
  claudeHome: string,
  isAlive: (pid: number) => boolean = alive,
  gone?: Set<string>,
  living?: Set<string>,
): Map<string, CcProc> {
  const out = new Map<string, CcProc>();
  const dir = path.join(claudeHome, "sessions");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{1,10}\.json$/.test(f));
  } catch {
    return out;
  }
  // Only certain absence counts: a live pid with any status, a file being written (young, or its pid lives) or a pid
  // of another domain keeps a session out of `gone` (review #146).
  const alive_ = living || new Set<string>();
  let unsure = false;
  for (const f of files.slice(0, 500)) {
    const file = path.join(dir, f);
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const pid = Number(j?.pid);
      const sid = j?.sessionId;
      const status = j?.status;
      if (!Number.isInteger(pid) || pid <= 0 || typeof sid !== "string" || !ID_RE.test(sid)) continue;
      const live = isAlive(pid);
      if (live || !sameDomain(j?.pidDomain)) alive_.add(sid);
      else gone?.add(sid);
      if (!live || !STATUSES.has(status)) continue;
      const at = Number(j.statusUpdatedAt || j.updatedAt) || 0;
      const prev = out.get(sid);
      if (!prev || at > prev.at) out.set(sid, { status, at, pid });
    } catch {
      // Half written: the next look reads it. An old unreadable file whose pid (its name) is dead stays dead; one
      // that vanished in between was a normal end.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < 10e3 || isAlive(Number(f.slice(0, -5)))) unsure = true;
      } catch {
        // gone
      }
    }
  }
  if (gone) {
    if (unsure || files.length > 500) gone.clear();
    for (const sid of alive_) gone.delete(sid);
  }
  return out;
}

/** As long as Fleet keeps a session's hook state (sessionMaxAgeDays, 14 by default) and a little more. */
const GONE_KEEP_MS = 15 * 86400e3;

/**
 * Claude Code removes the files of dead processes when the next process starts (live 16.10.2026): without them a
 * session found gone looked alive and waiting again. A session once certainly gone stays gone (in `file`, sid →
 * when found) until it shows life: any live process file (`alive`: every live pid, whatever its status or domain, as
 * readClaudeProcs counts it) or a hook event after that moment. Adds them to `gone`.
 */
export function stickyGone(
  file: string,
  gone: Set<string>,
  alive: Set<string>,
  lastSign: (sid: string) => number,
  now: number,
): void {
  let known: Record<string, number> = {};
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) known = j;
  } catch {
    // none yet
  }
  const next: Record<string, number> = {};
  for (const [sid, at] of Object.entries(known))
    if (
      ID_RE.test(sid) &&
      typeof at === "number" &&
      at <= now &&
      now - at < GONE_KEEP_MS &&
      !alive.has(sid) &&
      lastSign(sid) <= at
    )
      next[sid] = at;
  for (const sid of gone) if (!(sid in next)) next[sid] = now;
  const keys = Object.keys(next);
  for (const sid of keys.slice(0, Math.max(0, keys.length - 500))) delete next[sid];
  for (const sid of Object.keys(next)) gone.add(sid);
  if (JSON.stringify(next) === JSON.stringify(known)) return;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // remembered next time
  }
}
