import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "../core/paths";

/**
 * The handoff registry (~/.claude-fleet/handoffs.json): which session was asked to write which
 * HANDOFF.md, its fingerprint once written, and who took it over.
 *
 * Trust: a new session only receives the content if Fleet requested the handoff itself and stored its
 * SHA-256. A HANDOFF.md that arrives with a foreign repo could otherwise smuggle instructions into
 * every session.
 */

export const FILE = "HANDOFF.md";
export const MAX_BYTES = 64 * 1024;
const MAX_LINKS = 300;
export const SID = /^[\w.-]{1,128}$/;

export interface Entry {
  sessionId: string;
  requestedAt: number;
  reason: string;
  key: string;
  file: string;
  sha?: string;
  writtenAt?: number;
  baseAt?: number;
  deliveredTo?: string;
  deliveredAt?: number;
  openIn?: string;
  openWhy?: string;
  openedAt?: number;
  /** openIn "fleet": the hook cannot start a terminal in the server, so it leaves this for Fleet (server/process/pending.ts). */
  pendingStart?: boolean;
  pendingPrompt?: string;
  group?: { id: string; name: string };
  prev?: { id: string; title: string };
  merged?: string[];
  prevs?: { id: string; title: string }[];
}

export interface Registry {
  byDir: Record<string, Entry>;
  /** Replaced -> successor, kept apart from byDir: the next handoff in a folder overwrites its entry, and the old session must not count as active again. */
  links?: Record<string, string>;
}

const registryPath = () => path.join(fleetHome(), "handoffs.json");
export const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

export function readRegistry(): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Partial<Registry>;
    if (r?.byDir && typeof r.byDir === "object") {
      const links: Record<string, string> = Object.create(null);
      if (r.links && typeof r.links === "object") {
        for (const [k, v] of Object.entries(r.links))
          if (SID.test(k) && typeof v === "string" && SID.test(v)) links[k] = v;
      }
      return { byDir: Object.assign(Object.create(null), r.byDir), links };
    }
  } catch {
    // no registry yet
  }
  return { byDir: Object.create(null) };
}

export function writeRegistry(r: Registry): void {
  fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  const f = registryPath();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/**
 * Does the running Fleet have its terminal? The server says so in runtime.json; the hook reads only that file
 * instead of loading the process manager.
 */
export function fleetTerminal(): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(fleetHome(), "runtime.json"), "utf8")).terminal === true;
  } catch {
    return false;
  }
}

/** Root of the git repo, else the folder itself (without calling git: the hook has to be fast). */
export function rootOf(cwd: string): string {
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(cwd);
    d = up;
  }
}

/** Reads a file if it exists, is not too big and not too old. */
export function readSmall(file: string, now: number, maxAge: number): Buffer | null {
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > maxAge || st.size > MAX_BYTES) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** HANDOFF.md must not be committed by accident: excluded locally (.git/info/exclude, not .gitignore). */
export function excludeFromGit(root: string): void {
  try {
    if (!fs.statSync(path.join(root, ".git")).isDirectory()) return; // worktree: .git is a file
    const info = path.join(root, ".git", "info");
    fs.mkdirSync(info, { recursive: true });
    const ex = path.join(info, "exclude");
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
    if (!cur.split(/\r?\n/).includes(`/${FILE}`))
      fs.appendFileSync(ex, `${cur && !cur.endsWith("\n") ? "\n" : ""}/${FILE}\n`);
  } catch {
    // not a git repo
  }
}

/** Records who took over a handoff: every session that wrote or was merged into it now points to `to`. */
export function link(reg: Registry, e: Entry, to: string): void {
  const links = reg.links || Object.create(null);
  for (const old of Array.isArray(e.merged) ? e.merged : [e.sessionId]) {
    if (typeof old === "string" && SID.test(old) && old !== to && SID.test(to)) {
      delete links[old];
      links[old] = to;
    }
  }
  const keys = Object.keys(links);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LINKS))) delete links[k];
  reg.links = links;
}

/** Which session received the handoff of which other one (replaced session -> successor). */
export function successors(): Map<string, string> {
  const m = new Map<string, string>();
  const reg = readRegistry();
  for (const [k, v] of Object.entries(reg.links || {})) m.set(k, v);
  for (const e of Object.values(reg.byDir)) {
    if (!e || typeof e.deliveredTo !== "string") continue;
    for (const sid of Array.isArray(e.merged) ? e.merged : [e.sessionId])
      if (typeof sid === "string") m.set(sid, e.deliveredTo);
  }
  return m;
}

/** Sessions whose handoff is written but whose successor is not running yet: nothing left to start fresh. */
export function awaitingStart(): Set<string> {
  const s = new Set<string>();
  for (const e of Object.values(readRegistry().byDir)) {
    if (!e?.sha || e.deliveredTo || !e.openedAt) continue;
    for (const sid of Array.isArray(e.merged) ? e.merged : [e.sessionId]) if (typeof sid === "string") s.add(sid);
  }
  return s;
}
