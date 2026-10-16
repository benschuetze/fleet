import type { Stats } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { byTime, LOG_MAX } from "../../shared/log";
import type { LogLine } from "../../shared/types";
import { classifyLine } from "./apierror";
import { tr } from "./lang";
import { ID_RE, newestCopies } from "./paths";
import { completeLines, isRealUserPrompt } from "./sessions";

/**
 * The log view's source (spec, "Log-Sicht (Shift+L)"): every step of every session, read from the transcripts
 * under <claudeHome>/projects. Unlike the overview nothing is filtered: headless runs (`claude -p`), sessions
 * without a title and sessions in folders Fleet shows nowhere else all count. Subagents' own files and sidechain
 * lines stay out; their Task call is the step.
 *
 * Cheap enough to ask every few seconds: a file is read once from its tail and afterwards only what was appended.
 * Only the newest LOG_MAX lines stay in memory, so on the first read files older than the oldest kept line are not
 * read at all, only remembered at their end for what comes next.
 */

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;

const TAIL_BYTES = 256 * 1024;
const MAX_APPEND = 1024 * 1024;
const STAT_CONCURRENCY = 32;
const TEXT_MAX = 160;
/** Prompts are no log: only their start (spec: "keine Prompts im Volltext"). */
const PROMPT_MAX = 60;

interface FileState {
  session: string;
  size: number;
  offset: number;
  cwd: string | null;
  title: string | null;
  /** Names of the last tool calls, for the line of a failed result. */
  tools: Map<string, string>;
}

export interface LogRead {
  seq: number;
  lines: LogLine[];
  /** What the transcript says about a session the overview may not know. */
  info: Map<string, { title: string | null; cwd: string | null }>;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

export const firstLine = (s: string) =>
  (
    s
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || ""
  )
    .replace(/^[#>*\-\s]+/, "")
    .trim();

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Paths relative to the session's folder (usually the repo), the home folder as `~`. The part below the folder
 * gets forward slashes: a Windows path then reads like the same path anywhere else (`src/a.ts`).
 */
export function shortPaths(s: string, cwd: string | null, home = os.homedir()): string {
  let out = s;
  for (const [dir, to] of [
    [cwd, "."],
    [home, "~"],
  ] as const) {
    if (!dir || dir.length < 2) continue;
    const bare = dir.replace(/[\\/]+$/, "");
    const d = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The folder itself or a path below it, not a sibling that starts the same (/repo-old next to /repo).
    out = out.replace(new RegExp(`${d}(?:[\\\\/]([^\\s"'<>|]*)|(?![\\w.-]))`, "g"), (m, rest?: string) =>
      m.length > bare.length ? `${to}/${(rest || "").replace(/\\/g, "/")}` : to,
    );
    if (to === ".") out = out.replace(/(^|[\s"'=(])\.\/(?=\S)/g, "$1");
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What a tool call works on: its file, its command (first line only), its search, its task. */
export function toolText(name: string, input: unknown): string {
  const i: Line = input && typeof input === "object" ? (input as Line) : {};
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return str(i.file_path || i.notebook_path);
    case "Bash":
    case "PowerShell":
      return firstLine(str(i.command));
    case "Grep":
      return [str(i.pattern), str(i.path)].filter(Boolean).join("  ");
    case "Glob":
      return str(i.pattern);
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query);
    case "Task":
    case "Agent":
      return firstLine(str(i.description || i.prompt));
    case "TodoWrite":
      return Array.isArray(i.todos) ? `${i.todos.length} ${tr("Aufgaben", "todos")}` : "";
    default:
      return firstLine(String(Object.values(i).find((v) => typeof v === "string") || ""));
  }
}

/** The steps in some transcript lines; updates the file's folder, title and open tool calls on the way. */
function stepsOf(st: FileState, objs: Line[]): Omit<LogLine, "seq">[] {
  const out: Omit<LogLine, "seq">[] = [];
  for (const o of objs) {
    if (!o || typeof o !== "object" || o.isSidechain) continue;
    if (typeof o.cwd === "string" && o.cwd) st.cwd = o.cwd;
    if ((o.type === "custom-title" || o.type === "ai-title") && (o.title || o.customTitle))
      st.title = clip(str(o.title || o.customTitle), 120) || st.title;
    const at = Date.parse(o.timestamp);
    if (!Number.isFinite(at)) continue;
    const step = (kind: LogLine["kind"], tool: string | null, text: string, max = TEXT_MAX) =>
      out.push({ at, session: st.session, kind, tool, text: clip(shortPaths(text, st.cwd), max) });
    const content: Line[] = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === "user") {
      if (isRealUserPrompt(o)) step("prompt", null, firstLine(textOf(o.message.content)), PROMPT_MAX);
      for (const b of content) {
        if (b?.type !== "tool_result" || !b.is_error) continue;
        const tool = st.tools.get(String(b.tool_use_id)) || null;
        step("error", tool, firstLine(typeof b.content === "string" ? b.content : textOf(b.content)) || "error");
      }
      continue;
    }
    if (o.type !== "assistant" || !o.message) continue;
    // An API error is one red line, not also an assistant text.
    const failure = classifyLine(o);
    if (failure) {
      step("error", null, failure.text);
      continue;
    }
    if (o.message.model === "<synthetic>") continue;
    const text = firstLine(textOf(o.message.content));
    if (text) step("text", null, text);
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const name = clip(b.name, 60);
      if (typeof b.id === "string") {
        st.tools.set(b.id, name);
        if (st.tools.size > 100) st.tools.delete(st.tools.keys().next().value as string);
      }
      step("tool", name, toolText(b.name, b.input));
    }
  }
  return out;
}

function parseLines(buf: Buffer, dropFirst: boolean): Line[] {
  const lines = buf.toString("utf8").split("\n");
  if (dropFirst) lines.shift();
  const out: Line[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Line);
    } catch {
      // cut-off or broken line
    }
  }
  return out;
}

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

async function transcripts(claudeHome: string): Promise<{ file: string; st: Stats }[]> {
  const root = path.join(claudeHome, "projects");
  let dirs: string[] = [];
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const lists = await mapLimit(dirs, STAT_CONCURRENCY, async (d) => {
    try {
      return (await fsp.readdir(path.join(root, d)))
        .filter((f) => f.endsWith(".jsonl") && ID_RE.test(f.slice(0, -6)))
        .map((f) => path.join(root, d, f));
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
  return newestCopies(root, stats);
}

/** A reader with its own memory; the server keeps one, tests make their own. */
export function createLogReader() {
  const files = new Map<string, FileState>();
  let lines: LogLine[] = [];
  let seq = 0;
  let running: Promise<LogRead> | null = null;

  const result = (): LogRead => {
    const info = new Map<string, { title: string | null; cwd: string | null }>();
    const kept = new Set(lines.map((l) => l.session));
    for (const st of files.values()) if (kept.has(st.session)) info.set(st.session, { title: st.title, cwd: st.cwd });
    return { seq, lines, info };
  };

  /** Reads `file` from `start` (or its tail); returns the steps found and moves the file's offset. */
  async function readFrom(st: FileState, file: string, size: number, start: number | null) {
    let from = start ?? Math.max(0, size - TAIL_BYTES);
    let dropFirst = start === null && from > 0;
    if (size - from > MAX_APPEND) {
      from = size - MAX_APPEND;
      dropFirst = true;
    }
    const buf = completeLines(await readBuf(file, from, size - from));
    st.offset = from + buf.length;
    st.size = size;
    return stepsOf(st, parseLines(buf, dropFirst));
  }

  async function read(claudeHome: string): Promise<LogRead> {
    const found = await transcripts(claudeHome);
    const seen = new Set(found.map((f) => f.file));
    for (const k of files.keys()) if (!seen.has(k)) files.delete(k);
    const added: Omit<LogLine, "seq">[] = [];
    const fresh: { file: string; st: Stats }[] = [];
    for (const f of found) {
      const st = files.get(f.file);
      if (!st) fresh.push(f);
      else if (f.st.size < st.size) {
        // Rewritten from the start: its old lines go, the file counts as new.
        lines = lines.filter((l) => l.session !== st.session);
        files.delete(f.file);
        fresh.push(f);
      } else if (f.st.size > st.offset) {
        try {
          added.push(...(await readFrom(st, f.file, f.st.size, st.offset)));
        } catch {
          // locked or gone: next time
        }
      }
    }
    // Newest first: once LOG_MAX lines are there, an older file has nothing among the newest.
    fresh.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const f of fresh) {
      const session = path.basename(f.file, ".jsonl");
      const st: FileState = { session, size: 0, offset: 0, cwd: null, title: null, tools: new Map() };
      files.set(f.file, st);
      const pool = lines.length + added.length;
      if (pool >= LOG_MAX) {
        const oldest = [...lines, ...added].map((l) => l.at).sort((a, b) => b - a)[LOG_MAX - 1] ?? 0;
        if (f.st.mtimeMs < oldest) {
          // Remembered at its end: only what it writes from now on counts.
          st.size = f.st.size;
          st.offset = f.st.size;
          continue;
        }
      }
      try {
        added.push(...(await readFrom(st, f.file, f.st.size, null)));
      } catch {
        files.delete(f.file);
      }
    }
    if (added.length) {
      const numbered = added.sort((a, b) => a.at - b.at).map((l) => ({ ...l, seq: ++seq }));
      lines = [...lines, ...numbered].sort(byTime).slice(-LOG_MAX);
    }
    return result();
  }

  return {
    /** One read at a time; callers that come while it runs share it. */
    read(claudeHome: string): Promise<LogRead> {
      if (running) return running;
      running = read(claudeHome).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
