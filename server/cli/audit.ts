import fs from "node:fs";
import path from "node:path";
import {
  type AuditDecision,
  type AuditEvent,
  type AuditReport,
  type Moment,
  replaySession,
  report,
  WAIT_KINDS,
} from "../core/audit";
import { loadConfig } from "../core/config";
import { tr } from "../core/lang";
import { ID_RE, newestCopies } from "../core/paths";

/**
 * fleet audit [--hours N] [--json]: replays the transcripts and hook events of the last N hours (default 48) and
 * lists every moment a session waited for the user but Fleet would not have shown "wartet", and every "wartet"
 * that was none, and sessions the hook reported without a transcript. Read-only: it never writes to ~/.claude or ~/.claude-fleet. Prints ids, kinds and times only,
 * never prompt or answer text.
 */

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;

const MAX_FILE = 256 * 1024 * 1024;

/** Every session id with a main transcript, of any age (names only, nothing is read). */
function transcriptIds(claudeHome: string): Set<string> {
  const ids = new Set<string>();
  const root = path.join(claudeHome, "projects");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return ids;
  }
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6));
    } catch {
      // not a folder
    }
  }
  return ids;
}

export function transcripts(claudeHome: string, since: number): string[] {
  const root = path.join(claudeHome, "projects");
  const out: { file: string; st: fs.Stats }[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    // Only the main transcripts: a subagent's questions reach the user through its parent's hook events.
    for (const f of files) {
      if (!f.endsWith(".jsonl") || !ID_RE.test(f.slice(0, -6))) continue;
      const p = path.join(root, d, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) out.push({ file: p, st });
      } catch {
        // gone in the meantime
      }
    }
  }
  return newestCopies(root, out)
    .filter(({ st }) => st.mtimeMs >= since && st.size > 0 && st.size <= MAX_FILE)
    .map((x) => x.file);
}

export function jsonLines(file: string): Line[] {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Line[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object") out.push(o);
    } catch {
      // cut-off line
    }
  }
  return out;
}

export function events(fleetHome: string): Map<string, AuditEvent[]> {
  const by = new Map<string, AuditEvent[]>();
  // The hook rotates the log at 2 MB: the older half is in events.jsonl.old.
  for (const f of ["events.jsonl.old", "events.jsonl"]) {
    for (const e of jsonLines(path.join(fleetHome, f))) {
      if (typeof e.at !== "number" || typeof e.sessionId !== "string" || !ID_RE.test(e.sessionId)) continue;
      if (typeof e.event !== "string" || typeof e.status !== "string") continue;
      const list = by.get(e.sessionId) || [];
      list.push({
        at: e.at,
        sessionId: e.sessionId,
        event: e.event.slice(0, 40),
        status: e.status as AuditEvent["status"],
      });
      by.set(e.sessionId, list);
    }
  }
  return by;
}

/** The brake's answers: when each wait ended, and how. */
export function decisions(fleetHome: string): Map<string, AuditDecision[]> {
  const by = new Map<string, AuditDecision[]>();
  const dir = path.join(fleetHome, "decisions");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return by;
  }
  for (const f of files) {
    let d: Line;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!d || typeof d.sessionId !== "string" || !ID_RE.test(d.sessionId) || typeof d.kind !== "string") continue;
    const answered =
      typeof d.answeredAt === "number" ? d.answeredAt : typeof d.appliedAt === "number" ? d.appliedAt : 0;
    const item: AuditDecision | null =
      (d.status === "answered" || d.status === "applied") && answered
        ? { sessionId: d.sessionId, kind: d.kind, at: answered, reply: d.answer === "stop" ? "stop" : "answer" }
        : d.status === "expired" && typeof d.expiresAt === "number"
          ? { sessionId: d.sessionId, kind: d.kind, at: d.expiresAt, reply: "" }
          : null;
    if (!item) continue;
    by.set(d.sessionId, [...(by.get(d.sessionId) || []), item]);
  }
  return by;
}

export function runAudit(hours: number, now = Date.now()): AuditReport {
  const cfg = loadConfig();
  const from = now - hours * 3600e3;
  const evs = events(cfg._fleetHome);
  const decs = decisions(cfg._fleetHome);
  const audits = transcripts(cfg.claudeHome, from).map((file) => {
    const id = path.basename(file, ".jsonl");
    return replaySession(id, jsonLines(file), evs.get(id) || [], {
      from,
      to: now,
      staleMinutes: cfg.staleMinutes,
      decisions: decs.get(id),
    });
  });
  const r = report(audits, { hours, from, to: now });
  const known = transcriptIds(cfg.claudeHome);
  for (const [id, list] of evs) {
    const inside = list.filter((e) => e.at >= from && e.at <= now);
    if (!inside.length || known.has(id)) continue;
    const ats = inside.map((e) => e.at);
    r.noTranscript.push({ sessionId: id, from: Math.min(...ats), to: Math.max(...ats), events: inside.length });
  }
  r.noTranscript.sort((a, b) => a.from - b.from);
  return r;
}

const pad = (n: number) => String(n).padStart(2, "0");
const time = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const mins = (ms: number) => (ms < 60e3 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60e3)} min`);
const row = (m: Moment) =>
  `  ${time(m.from)}  ${mins(m.to - m.from).padStart(7)}  ${m.sessionId.slice(0, 8)}  ${(m.kind || "-").padEnd(10)} → ${m.fleet} (${m.source || "-"}${m.why ? ` ${m.why}` : ""})`;

export function audit(args: string[]): number {
  const i = args.indexOf("--hours");
  const h = i >= 0 ? Number(args[i + 1]) : 48;
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : 48;
  const r = runAudit(hours);
  if (args.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return r.misses.length || r.noTranscript.length ? 1 : 0;
  }
  console.log(
    tr(
      `fleet audit: ${hours} h, ${r.sessions} Sessions (${r.withHooks} mit Hooks)`,
      `fleet audit: ${hours} h, ${r.sessions} sessions (${r.withHooks} with hooks)`,
    ),
  );
  console.log(tr("  Art         Warten  verpasst", "  kind        waits   missed"));
  for (const k of WAIT_KINDS) {
    const c = r.byKind[k];
    console.log(`  ${k.padEnd(10)}  ${String(c.waits).padStart(6)}  ${String(c.missed).padStart(8)}`);
  }
  console.log(
    tr(
      `\nVerpasst (wartet, Fleet zeigte nicht „wartet“): ${r.misses.length}`,
      `\nMissed (waits, Fleet did not show "waits"): ${r.misses.length}`,
    ),
  );
  for (const m of r.misses) console.log(row(m));
  console.log(
    tr(
      `\nFehlalarme („wartet“ ohne offene Frage): ${r.falseAlarms.length}`,
      `\nFalse alarms ("waits" with nothing open): ${r.falseAlarms.length}`,
    ),
  );
  for (const m of r.falseAlarms) console.log(row(m));
  console.log(
    tr(
      `\nHook-Ereignisse ohne Transcript (nicht prüfbar): ${r.noTranscript.length}`,
      `\nHook events without a transcript (cannot be checked): ${r.noTranscript.length}`,
    ),
  );
  for (const n of r.noTranscript)
    console.log(
      `  ${time(n.from)}  ${mins(n.to - n.from).padStart(7)}  ${n.sessionId.slice(0, 8)}  ${n.events} events`,
    );
  return r.misses.length || r.noTranscript.length ? 1 : 0;
}
