import { exec } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Agent, Config, FleetEvent, HookState, Meta, Status } from "../../shared/types";
import { ID_RE } from "./paths";

/* ---------- Hook states ---------- */

const hookCache = new Map<string, { mtime: number; s: HookState }>();

export async function readHookStates(cfg: Pick<Config, "_fleetHome" | "sessionMaxAgeDays">) {
  const dir = path.join(cfg._fleetHome, "state");
  const out: Record<string, HookState> = Object.create(null);
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  const cutoff = Date.now() - cfg.sessionMaxAgeDays * 86400e3;
  const seen = new Set<string>();
  await Promise.all(
    files.map(async (f) => {
      const p = path.join(dir, f);
      seen.add(p);
      try {
        const st = await fsp.stat(p);
        let c = hookCache.get(p);
        if (!c || c.mtime !== st.mtimeMs) {
          c = { mtime: st.mtimeMs, s: JSON.parse(await fsp.readFile(p, "utf8")) as HookState };
          hookCache.set(p, c);
        }
        const s = c.s;
        if (!s || typeof s.sessionId !== "string" || !ID_RE.test(s.sessionId)) return;
        if (!(s.at >= cutoff)) {
          // old state: clean up
          hookCache.delete(p);
          await fsp.unlink(p).catch(() => {});
          // the hook's recent tool calls of that session
          await fsp.unlink(`${p.slice(0, -".json".length)}.calls`).catch(() => {});
          return;
        }
        out[s.sessionId] = s;
      } catch {
        // being written right now
      }
    }),
  );
  for (const k of hookCache.keys()) if (!seen.has(k)) hookCache.delete(k);
  // Leftover temp files of interrupted hooks.
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith(".tmp")) continue;
      const p = path.join(dir, f);
      const st = await fsp.stat(p);
      if (Date.now() - st.mtimeMs > 60e3) await fsp.unlink(p);
    }
  } catch {
    // nothing to clean up
  }
  return out;
}

let evCache: { key: string; list: FleetEvent[] } = { key: "", list: [] };

/** The newest events from events.jsonl, newest first. Reads at most the last 256 KB. */
export async function readEvents(cfg: Pick<Config, "_fleetHome">, limit = 150): Promise<FleetEvent[]> {
  const p = path.join(cfg._fleetHome, "events.jsonl");
  try {
    const st = await fsp.stat(p);
    const key = `${st.mtimeMs}:${st.size}`;
    if (evCache.key === key) return evCache.list;
    const len = Math.min(st.size, 256 * 1024);
    const fh = await fsp.open(p, "r");
    const buf = Buffer.alloc(len);
    try {
      await fh.read(buf, 0, len, st.size - len);
    } finally {
      await fh.close();
    }
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    if (st.size > len) lines.shift();
    const out: FleetEvent[] = [];
    for (const l of lines.slice(-limit)) {
      try {
        const e = JSON.parse(l) as FleetEvent;
        if (e && typeof e.at === "number") out.push(e);
      } catch {
        // cut-off line
      }
    }
    evCache = { key, list: out.reverse() };
    return evCache.list;
  } catch {
    return [];
  }
}

/* ---------- Agent view (`claude agents --json --all`) ---------- */

let agentCache: { at: number; list: Agent[]; error: string | null; disabledUntil: number } = {
  at: 0,
  list: [],
  error: null,
  disabledUntil: 0,
};
let agentInflight = false;

function refreshAgents(cfg: Pick<Config, "useAgentView">) {
  if (!cfg.useAgentView || agentInflight) return;
  if (Date.now() < agentCache.disabledUntil || Date.now() - agentCache.at < 15000) return;
  agentInflight = true;
  // A fixed command without user input, so a shell is harmless here (needed for claude.cmd on Windows).
  exec(
    "claude agents --json --all",
    { timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
    (err, stdout) => {
      agentInflight = false;
      if (err) {
        // Without the Claude CLI (only the desktop app) this is the normal case, not an error.
        const missing =
          (err as { code?: unknown }).code === 127 ||
          /not found|nicht gefunden|ENOENT|not recognized/i.test(String(err.message));
        agentCache = {
          at: Date.now(),
          list: [],
          error: missing ? null : "claude agents --json not available",
          disabledUntil: Date.now() + (missing ? 60 : 10) * 60e3,
        };
        return;
      }
      try {
        const j: unknown = JSON.parse(String(stdout).trim() || "[]");
        const o = j as Record<string, unknown>;
        const arr = Array.isArray(j) ? j : ((o.agents || o.sessions || o.items || []) as unknown[]);
        agentCache = {
          at: Date.now(),
          list: (Array.isArray(arr) ? arr : [])
            .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
            .map(normalizeAgent)
            .filter((a) => a.sessionId),
          error: null,
          disabledUntil: 0,
        };
      } catch {
        agentCache = {
          at: Date.now(),
          list: [],
          error: "claude agents --json: unexpected format",
          disabledUntil: Date.now() + 10 * 60e3,
        };
      }
    },
  );
}

/** One entry of `claude agents --json` (unchecked input). */
export function normalizeAgent(a: Record<string, unknown>): Agent {
  const raw = String(a.state || a.status || "").toLowerCase();
  let status: Status = "idle";
  if (/fail|error/.test(raw)) status = "error";
  else if (/input|block|permission|wait/.test(raw) || a.waitingFor) status = "needs_input";
  else if (/stop|kill|cancel/.test(raw)) status = "ended";
  else if (/complete|done|idle|inactive/.test(raw)) status = "waiting";
  else if (/work|run|busy|active/.test(raw)) status = "working";
  const sid = String(a.sessionId || a.session_id || a.id || "");
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  return {
    sessionId: ID_RE.test(sid) ? sid : null,
    name: str(a.name || a.title, 200),
    cwd: str(a.cwd || a.directory, 1000),
    status,
    rawState: str(a.state || a.status, 60),
    waitingFor: str(a.waitingFor, 200),
  };
}

export function getAgents(cfg: Pick<Config, "useAgentView">) {
  refreshAgents(cfg);
  return agentCache;
}

/* ---------- UI metadata (pin, hide, note) ---------- */

const metaPath = (cfg: Pick<Config, "_fleetHome">) => path.join(cfg._fleetHome, "meta.json");
let metaCache: { home: string; sessions: Record<string, Meta> } | null = null;

export function readMeta(cfg: Pick<Config, "_fleetHome">): { sessions: Record<string, Meta> } {
  if (metaCache && metaCache.home === cfg._fleetHome) return metaCache;
  let m: unknown;
  try {
    m = JSON.parse(fs.readFileSync(metaPath(cfg), "utf8"));
  } catch {
    m = {};
  }
  const sessions: Record<string, Meta> = Object.create(null);
  const raw = (m as { sessions?: unknown })?.sessions;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (ID_RE.test(k) && v && typeof v === "object") sessions[k] = clean(v as Record<string, unknown>);
    }
  }
  metaCache = { home: cfg._fleetHome, sessions };
  return metaCache;
}

function clean(v: Record<string, unknown>): Meta {
  const c: Meta = {};
  if (v.pinned) c.pinned = true;
  if (v.hidden) c.hidden = true;
  if (v.hidden && typeof v.hiddenAt === "number" && Number.isFinite(v.hiddenAt)) c.hiddenAt = v.hiddenAt;
  if (typeof v.note === "string" && v.note) c.note = v.note.slice(0, 2000);
  return c;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let writeChain: Promise<void> = Promise.resolve();

/**
 * The meta a session shows with (release 6): hidden stays hidden only while the session stays quiet. Activity after
 * it was hidden (a resumed session, a new question) shows it again, so clearing an alarm away never hides a session
 * that later waits for you. Entries from before release 6 have no time and stay as they were.
 */
export function shownMeta(m: Meta | undefined, lastActivity: number | undefined): Meta {
  const meta = m || {};
  if (!meta.hidden || !meta.hiddenAt || !lastActivity || lastActivity <= meta.hiddenAt) return meta;
  const { hidden: _h, hiddenAt: _a, ...rest } = meta;
  return rest;
}

export function updateMeta(cfg: Pick<Config, "_fleetHome">, id: string, patch: Meta): Promise<Meta> {
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid id");
  const m = readMeta(cfg);
  const cur: Meta = { ...(Object.hasOwn(m.sessions, id) ? m.sessions[id] : {}) };
  if (Object.hasOwn(patch, "pinned")) cur.pinned = !!patch.pinned;
  if (Object.hasOwn(patch, "hidden")) {
    cur.hidden = !!patch.hidden;
    if (cur.hidden) cur.hiddenAt = Date.now();
    else delete cur.hiddenAt;
  }
  if (Object.hasOwn(patch, "note")) cur.note = String(patch.note ?? "").slice(0, 2000);
  const c = clean(cur as Record<string, unknown>);
  if (!Object.keys(c).length) delete m.sessions[id];
  else m.sessions[id] = c;
  if (Object.keys(m.sessions).length > 5000) throw new HttpError(400, "too many entries");
  // Atomic write, serialised so two quick clicks cannot interleave.
  const data = JSON.stringify({ sessions: m.sessions }, null, 2);
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(cfg._fleetHome, { recursive: true, mode: 0o700 });
      const tmp = `${metaPath(cfg)}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data, { mode: 0o600 });
      await fsp.rename(tmp, metaPath(cfg));
    })
    .catch((e: Error) => console.error("[fleet] meta.json:", e.message));
  return writeChain.then(() => c);
}
