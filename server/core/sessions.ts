import type { Dirent, Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AUTO_PROMPT_RE, isInjectedPrompt, ownText } from "../../shared/prompts";
import type { Config, LoopSignal, TranscriptData } from "../../shared/types";
import { classifyLine } from "./apierror";
import { detectAsk, INTERACTIVE, toolQuestion } from "./ask";
import { sig } from "./loop";
import { newestCopies } from "./paths";
import { TEST_RE } from "./result";

/**
 * Reads local Claude Code transcripts from <claudeHome>/projects/<project>/<session>.jsonl. The format is
 * internal and may change, so everything is read defensively.
 *
 * Fast even with many and big transcripts:
 *  - fully asynchronous (never blocks the server)
 *  - the first time only head (96 KB) and tail (1 MB) of a file
 *  - afterwards incrementally: only the bytes appended since the last read
 */

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 1024 * 1024;
const STAT_CONCURRENCY = 32;

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;
interface Parsed {
  mtime: number;
  size: number;
  offset: number;
  data: TranscriptData;
}

const parsed = new Map<string, Parsed>();

async function readBuf(file: string, start: number, len: number): Promise<Buffer> {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Splits a buffer into JSON lines. dropFirst: discard the first (possibly cut) line. */
function parseLines(buf: Buffer, dropFirst: boolean): Line[] {
  const lines = buf.toString("utf8").split("\n");
  if (dropFirst) lines.shift();
  const out: Line[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Line);
    } catch {
      // cut-off line
    }
  }
  return out;
}

/** Complete lines only: up to and including the last '\n'. */
export function completeLines(buf: Buffer): Buffer {
  const i = buf.lastIndexOf(0x0a);
  return i < 0 ? buf.subarray(0, 0) : buf.subarray(0, i + 1);
}

function textOf(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

const INTERRUPT_RE = /^\[Request interrupted by user/;

export function isRealUserPrompt(o: Line): boolean {
  // The summary after a compaction is written as a user line: nobody typed it, an open question stays open.
  if (o?.type !== "user" || o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly)
    return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return false;
  const t = ownText(textOf(c));
  if (isInjectedPrompt(t)) return false;
  if (t.startsWith("Caveat:")) return false;
  if (INTERRUPT_RE.test(t)) return false;
  return true;
}

/** A message the app injected (CI monitor, side sessions, other sessions) that starts a turn of its own. */
function isAutoPrompt(o: Line): boolean {
  if (o?.type !== "user" || o.isSidechain) return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return false;
  return AUTO_PROMPT_RE.test(ownText(textOf(c)));
}

function clip(v: unknown, n: number): string {
  const s = String(v || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function emptyData(file: string): TranscriptData {
  return {
    id: path.basename(file, ".jsonl"),
    file,
    cwd: null,
    gitBranch: null,
    title: null,
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    lastTool: null,
    model: null,
    todos: null,
    startedAt: null,
    lastTimestamp: null,
    ctx: null,
    compactions: 0,
    turn: null,
    pending: [],
    loop: null,
    recent: [],
    dirs: [],
    stats: { prompts: 0, promptChars: 0, tools: 0, edits: 0, reads: 0, shells: 0, errors: 0, subagents: 0 },
  };
}

/** Remembers a working folder; dependencies and subfolders of the same repo are sorted out later by repoRoot. */
function noteDir(data: TranscriptData, dir: string) {
  if (/[\\/](node_modules|\.git)([\\/]|$)/.test(dir)) return;
  const d = data.dirs || [];
  data.dirs = d;
  if (!d.includes(dir) && d.length < 20) d.push(dir);
}

function applyHead(data: TranscriptData, objs: Line[]) {
  for (const o of objs) {
    if (data.startedAt && data.cwd && data.firstPrompt) break;
    if (!data.startedAt && o.timestamp) data.startedAt = Date.parse(o.timestamp) || null;
    if (!data.cwd && typeof o.cwd === "string") data.cwd = o.cwd;
    if (!data.firstPrompt && isRealUserPrompt(o)) data.firstPrompt = clip(ownText(textOf(o.message.content)), 160);
  }
}

function applyTitles(data: TranscriptData, objs: Line[]) {
  for (const o of objs) {
    if (o.type === "summary" && o.summary) data.summary = clip(o.summary, 160);
    if (typeof o.customTitle === "string" && o.customTitle) data.title = clip(o.customTitle, 160);
    if ((o.type === "custom-title" || o.type === "ai-title") && (o.title || o.customTitle))
      data.title = clip(o.title || o.customTitle, 160);
  }
}

export function applyTail(data: TranscriptData, objs: Line[]) {
  for (const o of objs) {
    if (!o || o.isSidechain) continue;
    if (typeof o.cwd === "string") {
      data.cwd = o.cwd;
      noteDir(data, o.cwd);
    }
    if (typeof o.gitBranch === "string" && o.gitBranch && o.gitBranch !== "HEAD") data.gitBranch = o.gitBranch;
    if (o.timestamp) data.lastTimestamp = Date.parse(o.timestamp) || data.lastTimestamp;
    if (isRealUserPrompt(o)) {
      data.lastPrompt = clip(ownText(textOf(o.message.content)), 200);
      data.turn = "running";
      data.pending = [];
      data.recent = [];
      data.loop = null;
      data.ask = null;
      data.boxAsk = null;
      data.offer = null;
      data.toolAsk = null;
      data.heldAsk = null;
      data.failure = null;
    } else if (isAutoPrompt(o)) {
      // A turn the app started on its own: working, but the open question stays (no answer of the user).
      data.turn = "running";
      data.pending = [];
      // A closing question in text is recomputed from every answer; the injected turn's answer must not replace it.
      data.heldAsk = data.ask || data.heldAsk || null;
    }
    trackTurn(data, o);
    trackAsk(data, o);
    trackTools(data, o);
    if (o.type === "system" && o.subtype === "compact_boundary") {
      data.compactions = (data.compactions || 0) + 1;
      data.ctx = null;
    }
    if (o.type === "assistant" && o.message) {
      if (typeof o.message.model === "string" && o.message.model !== "<synthetic>") data.model = o.message.model;
      const u = o.message.usage;
      if (u && typeof u === "object" && o.message.model !== "<synthetic>") {
        // Context = what lay in the window at the last call (input + cache), as Claude Code itself counts.
        const n = (+u.input_tokens || 0) + (+u.cache_creation_input_tokens || 0) + (+u.cache_read_input_tokens || 0);
        if (n > 0) data.ctx = { tokens: n, at: Date.parse(o.timestamp) || null };
        // Lifetime of the prompt cache: present once the call wrote to the cache.
        const cc = u.cache_creation;
        if (cc && typeof cc === "object") {
          if (+cc.ephemeral_1h_input_tokens > 0) data.cacheTtl = "1h";
          else if (+cc.ephemeral_5m_input_tokens > 0) data.cacheTtl = "5m";
        }
      }
      const t = textOf(o.message.content).trim();
      if (t) data.lastAssistant = clip(t, 280);
      const content: Line[] = Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of content) {
        if (b?.type !== "tool_use") continue;
        if (typeof b.name === "string") data.lastTool = b.name;
        if (b.name === "TodoWrite" && b.input && Array.isArray(b.input.todos)) {
          data.todos = b.input.todos.slice(0, 100).map((t: Line) => ({
            content: clip(t.content || t.subject || "", 120),
            activeForm: clip(t.activeForm || "", 120),
            status: ["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending",
          }));
        }
      }
    }
  }
}

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const READ_TOOLS = /^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/;
const SHELL_TOOLS = /^(Bash|PowerShell)$/;

/** Work profile for the efficiency advisor: what kind of work does the session do? */
function countStats(data: TranscriptData, o: Line, content: Line[]) {
  const st = {
    ...(data.stats || { prompts: 0, promptChars: 0, tools: 0, edits: 0, reads: 0, shells: 0, errors: 0, subagents: 0 }),
  };
  data.stats = st;
  if (isRealUserPrompt(o)) {
    st.prompts++;
    st.promptChars += textOf(o.message.content).length;
  }
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (o.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      st.tools++;
      if (EDIT_TOOLS.test(b.name)) st.edits++;
      else if (READ_TOOLS.test(b.name)) st.reads++;
      else if (SHELL_TOOLS.test(b.name)) st.shells++;
      else if (b.name === "Task" || b.name === "Agent") st.subagents++;
    } else if (o.type === "user" && b.type === "tool_result" && b.is_error) st.errors++;
  }
}

const LOOP_WINDOW = 8; // so many last calls are compared
const LOOP_REPEAT = 4; // the same call this often in the window: loop?
const LOOP_ERRORS = 3; // this many errors in a row: stuck?

/**
 * Agents that get stuck show two patterns: the same call with the same input again and again, or a run of
 * failed tool calls. Both cost tokens without progress and deserve a look.
 */
function trackTools(data: TranscriptData, o: Line) {
  const content: Line[] = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  countStats(data, o, content);
  let recent = data.recent || [];
  let changed = false;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (o.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
      // Last test run for the result line; its result comes with the tool_result. Only the first line:
      // heredocs often contain text that looks like a test command.
      const cmd =
        b.name === "Bash" && b.input && typeof b.input.command === "string"
          ? (b.input.command.split("\n")[0] ?? "")
          : "";
      if (cmd && TEST_RE.test(cmd))
        data.testRun = { id: String(b.id || ""), cmd: clip(cmd, 120), ok: null, at: Date.parse(o.timestamp) || null };
      if (cmd && /\bgit\s+commit\b/.test(cmd)) data.commitCall = String(b.id || "");
      // Edited files for the conflict warning (two sessions on the same file).
      const fp =
        EDIT_TOOLS.test(b.name) && b.input && typeof (b.input.file_path || b.input.notebook_path) === "string"
          ? String(b.input.file_path || b.input.notebook_path)
          : "";
      if (fp) data.edited = [...(data.edited || []).filter((x) => x !== fp), fp].slice(-60);
      recent = [
        ...recent,
        { id: String(b.id || ""), sig: sig(b.name, b.input), tool: clip(b.name, 80), err: false },
      ].slice(-12);
      changed = true;
    } else if (
      o.type === "user" &&
      b.type === "tool_result" &&
      data.testRun &&
      b.tool_use_id === data.testRun.id &&
      data.testRun.ok === null
    ) {
      data.testRun = { ...data.testRun, ok: !b.is_error };
    }
    // The session's own commits: git prints "[branch abc1234] subject".
    if (
      o.type === "user" &&
      b.type === "tool_result" &&
      data.commitCall &&
      b.tool_use_id === data.commitCall &&
      !b.is_error
    ) {
      const out = typeof b.content === "string" ? b.content : textOf(b.content);
      const m = /\[[^\]\s]+\s+(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]/.exec(out);
      const id = m?.[1];
      if (id) data.commits = [...(data.commits || []).filter((x) => x !== id), id].slice(-100);
      // With -q git prints no id: match by time instead (result.ts).
      else if (Date.parse(o.timestamp)) data.commitAt = [...(data.commitAt || []), Date.parse(o.timestamp)].slice(-200);
      data.commitCall = null;
    }
    if (o.type === "user" && b.type === "tool_result" && b.is_error) {
      recent = recent.map((r) => (r.id && r.id === b.tool_use_id ? { ...r, err: true } : r));
      changed = true;
    }
  }
  if (!changed) return;
  data.recent = recent;
  data.loop = loopOf(recent);
}

function loopOf(recent: NonNullable<TranscriptData["recent"]>): LoopSignal | null {
  const counts = new Map<string, number>();
  for (const r of recent.slice(-LOOP_WINDOW)) counts.set(r.sig, (counts.get(r.sig) || 0) + 1);
  let best = { sig: "", n: 0 };
  for (const [k, n] of counts) if (n > best.n) best = { sig: k, n };
  if (best.n >= LOOP_REPEAT)
    return { kind: "repeat", tool: best.sig.slice(0, best.sig.lastIndexOf(":")), count: best.n };
  let errs = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i]?.err; i--) errs++;
  const last = recent[recent.length - 1];
  if (errs >= LOOP_ERRORS && last) return { kind: "errors", tool: last.tool, count: errs };
  return null;
}

// The Desktop app ends a turn with a question box: a tool call, the question is never in the answer's text.
const BOX_TOOL = "mcp__ccd_turn__wrap_up";
// "New session or here?": the offer card blocks the turn until the user picks; other initiations do not.
const OFFER_TOOL = "mcp__ccd_session__start_session";

/**
 * A question at the end of the turn, and an API error that broke it off. The question is read from the full
 * text (lastAssistant is clipped to its start); a tool call afterwards means the turn went on. A question box
 * holds until the next prompt: text after it rarely asks again, a closing question in it wins. A real answer
 * after an API error means the session was continued.
 */
function trackAsk(data: TranscriptData, o: Line) {
  const content: Line[] = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  if (o.type === "user" && INTERRUPT_RE.test(textOf(o.message?.content).trim())) {
    data.ask = null;
    data.boxAsk = null;
    data.offer = null;
    data.toolAsk = null;
    data.heldAsk = null;
    return;
  }
  if (o.type === "user" && data.offer) {
    const id = data.offer.id;
    if (content.some((b) => b?.type === "tool_result" && b.tool_use_id === id)) data.offer = null;
  }
  if (o.type === "user" && data.toolAsk) {
    const id = data.toolAsk.id;
    if (content.some((b) => b?.type === "tool_result" && b.tool_use_id === id)) data.toolAsk = null;
  }
  if (o.type !== "assistant" || !o.message) return;
  const failure = classifyLine(o);
  if (failure) {
    data.failure = failure;
    data.ask = null;
    return;
  }
  if (o.message.model === "<synthetic>") return;
  data.failure = null;
  for (const b of content) {
    if (b?.type !== "tool_use" || !b.input || typeof b.input !== "object") continue;
    if (b.name === BOX_TOOL && typeof b.input.ask === "string" && b.input.ask.trim())
      data.boxAsk = { kind: "question", text: clip(b.input.ask, 200) };
    else if (
      b.name === OFFER_TOOL &&
      b.input.initiation === "offer" &&
      !b.input.proposal_id &&
      typeof b.id === "string"
    )
      data.offer = { id: b.id, text: clip(b.input.title, 160) };
    else if (typeof b.name === "string" && INTERACTIVE.test(b.name) && typeof b.id === "string")
      data.toolAsk = { id: b.id, tool: b.name, text: toolQuestion(b.name, b.input) };
  }
  if (content.some((b) => b?.type === "tool_use")) data.ask = data.boxAsk || data.heldAsk || null;
  else {
    const t = textOf(o.message.content);
    if (t.trim() || data.boxAsk) data.ask = detectAsk(t) || data.boxAsk || data.heldAsk || null;
  }
}

/**
 * How did the last turn end? This lets the status be guessed without hooks: end_turn = done, an open tool_use
 * = a tool is running (or waits for approval).
 */
function trackTurn(data: TranscriptData, o: Line) {
  const content: Line[] = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  if (o.type === "assistant" && o.message) {
    const ids = content
      .filter((b) => b && b.type === "tool_use" && typeof b.id === "string")
      .map((b) => b.id as string);
    if (ids.length) {
      data.pending = [...(data.pending || []), ...ids].slice(-50);
      data.turn = "tool_pending";
    } else if (o.message.stop_reason === "end_turn" || o.message.stop_reason === "stop_sequence") {
      data.turn = "done";
      data.pending = [];
    }
  } else if (o.type === "user") {
    const done = content.filter((b) => b && b.type === "tool_result").map((b) => b.tool_use_id);
    if (done.length) {
      data.pending = (data.pending || []).filter((id) => !done.includes(id));
      data.turn = data.pending.length ? "tool_pending" : "running";
    }
    if (INTERRUPT_RE.test(textOf(o.message?.content).trim())) {
      data.turn = "interrupted";
      data.pending = [];
    }
  }
}

export async function parseFull(
  file: string,
  st: Pick<Stats, "size">,
): Promise<{ data: TranscriptData; offset: number }> {
  const data = emptyData(file);
  let offset: number;
  if (st.size <= TAIL_BYTES) {
    const buf = completeLines(await readBuf(file, 0, st.size));
    const all = parseLines(buf, false);
    applyHead(data, all);
    applyTitles(data, all);
    applyTail(data, all);
    offset = buf.length;
  } else {
    const head = parseLines(await readBuf(file, 0, HEAD_BYTES), false);
    const tailStart = st.size - TAIL_BYTES;
    const tbuf = completeLines(await readBuf(file, tailStart, TAIL_BYTES));
    const tail = parseLines(tbuf, true);
    applyHead(data, head);
    applyTitles(data, head.concat(tail));
    applyTail(data, tail);
    offset = tailStart + tbuf.length;
  }
  return { data, offset };
}

export async function parseIncrement(
  file: string,
  st: Pick<Stats, "size">,
  prev: Parsed,
): Promise<{ data: TranscriptData; offset: number }> {
  let start = prev.offset;
  let dropFirst = false;
  if (st.size - start > TAIL_BYTES) {
    start = st.size - TAIL_BYTES;
    dropFirst = true;
  }
  const buf = completeLines(await readBuf(file, start, st.size - start));
  const data = { ...prev.data };
  const objs = parseLines(buf, dropFirst);
  if (!data.firstPrompt || !data.cwd) applyHead(data, objs);
  applyTitles(data, objs);
  applyTail(data, objs);
  return { data, offset: start + buf.length };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k] as T);
      }
    }),
  );
  return out;
}

export async function scanSessions(cfg: Pick<Config, "claudeHome" | "sessionMaxAgeDays">): Promise<TranscriptData[]> {
  const root = path.join(cfg.claudeHome, "projects");
  const maxAge = Date.now() - cfg.sessionMaxAgeDays * 86400e3;
  let dirs: Dirent[] = [];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const lists = await mapLimit(dirs, STAT_CONCURRENCY, async (d) => {
    const dir = path.join(root, d.name);
    try {
      return (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  });
  const stats = await mapLimit(lists.flat(), STAT_CONCURRENCY, async (file) => {
    try {
      const st = await fsp.stat(file);
      return st.isFile() ? { file, st } : null;
    } catch {
      return null;
    }
  });
  const found = newestCopies(root, stats).filter(({ st }) => st.mtimeMs >= maxAge && st.size > 0);
  const seen = new Set<string>();
  const results = await mapLimit(found, STAT_CONCURRENCY, async ({ file, st }) => {
    seen.add(file);
    const c = parsed.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.data;
    try {
      const r =
        c && st.size > c.size && c.offset <= st.size ? await parseIncrement(file, st, c) : await parseFull(file, st);
      r.data.mtime = st.mtimeMs;
      parsed.set(file, { mtime: st.mtimeMs, size: st.size, offset: r.offset, data: r.data });
      return r.data;
    } catch {
      return c ? c.data : null; // broken or locked file
    }
  });
  for (const k of parsed.keys()) if (!seen.has(k)) parsed.delete(k);
  return results.filter((r): r is TranscriptData => !!r);
}

/** Finds a session's transcript (<claudeHome>/projects/<project>/<id>.jsonl). */
export async function transcriptOf(claudeHome: string, id: string): Promise<string | null> {
  if (!/^[\w.-]{1,128}$/.test(id)) return null;
  const base = path.join(claudeHome, "projects");
  const found: { file: string; st: Stats }[] = [];
  try {
    for (const d of await fsp.readdir(base)) {
      const file = path.join(base, d, `${id}.jsonl`);
      try {
        found.push({ file, st: await fsp.stat(file) });
      } catch {
        // not in this project
      }
    }
  } catch {
    // no projects folder
  }
  return newestCopies(base, found)[0]?.file ?? null;
}
