import fsp from "node:fs/promises";
import type { ChatEntry, ChatPage } from "../../shared/types";
import { classifyLine } from "./apierror";
import { clip, firstLine, shortPaths, textOf, toolText } from "./log";
import { completeLines, isRealUserPrompt } from "./sessions";

/**
 * One session's conversation for its drawer: opening a session always shows what was said and what it does right
 * now. Unlike the log view (one line per step, prompts cut to 60 characters, a shared pool of the newest lines of
 * all sessions) this reads the session's own transcript, so an old session has its history too, and keeps the
 * texts whole up to a cap. Read only on request, from the file's tail.
 */

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;

export const CHAT_MAX = 200;
const TAIL_BYTES = 2 * 1024 * 1024;
const YOU_MAX = 4000;
const CLAUDE_MAX = 8000;
const TOOL_MAX = 200;

/** Keeps line breaks (a chat reads in paragraphs), trims each end and caps the length. */
function whole(s: string, n: number): string {
  const t = s
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** The entries in some transcript lines, oldest first; a tool call without a result yet is `open`. */
export function chatOf(objs: Line[], cwd: string | null = null): ChatEntry[] {
  const out: ChatEntry[] = [];
  const calls = new Map<string, ChatEntry>();
  for (const o of objs) {
    if (!o || typeof o !== "object" || o.isSidechain) continue;
    if (typeof o.cwd === "string" && o.cwd) cwd = o.cwd;
    const at = Date.parse(o.timestamp);
    if (!Number.isFinite(at)) continue;
    const add = (kind: ChatEntry["kind"], tool: string | null, text: string) => {
      const e: ChatEntry = { at, kind, tool, text: shortPaths(text, cwd) };
      out.push(e);
      return e;
    };
    const content: Line[] = Array.isArray(o.message?.content) ? o.message.content : [];
    if (o.type === "user") {
      if (isRealUserPrompt(o)) {
        const text = whole(textOf(o.message.content), YOU_MAX);
        if (text) add("you", null, text);
      }
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const call = calls.get(String(b.tool_use_id));
        if (call) {
          call.open = false;
          calls.delete(String(b.tool_use_id));
        }
        if (!b.is_error) continue;
        const msg = firstLine(typeof b.content === "string" ? b.content : textOf(b.content)) || "error";
        add("error", call?.tool || null, clip(msg, TOOL_MAX));
      }
      continue;
    }
    if (o.type !== "assistant" || !o.message) continue;
    const failure = classifyLine(o);
    if (failure) {
      add("error", null, failure.text);
      continue;
    }
    if (o.message.model === "<synthetic>") continue;
    const text = whole(textOf(o.message.content), CLAUDE_MAX);
    if (text) add("claude", null, text);
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const e = add("tool", clip(b.name, 60), clip(toolText(b.name, b.input), TOOL_MAX));
      e.open = true;
      if (typeof b.id === "string") calls.set(b.id, e);
    }
  }
  // Only the newest call can still run: older ones without a result were interrupted.
  const last = out[out.length - 1];
  for (const e of out) if (e.open && e !== last) e.open = false;
  for (const e of out) if (e.open === false) delete e.open;
  return out;
}

/** The conversation in a transcript file: its last CHAT_MAX entries, read from the tail. */
export async function readChat(session: string, file: string): Promise<ChatPage> {
  const fh = await fsp.open(file, "r");
  let buf: Buffer;
  let cut = false;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    cut = start > 0;
    buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    buf = completeLines(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
  const lines = buf.toString("utf8").split("\n");
  if (cut) lines.shift(); // starts mid-line
  const objs: Line[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      objs.push(JSON.parse(l));
    } catch {
      // cut-off or broken line
    }
  }
  const all = chatOf(objs);
  return { session, entries: all.slice(-CHAT_MAX), more: cut || all.length > CHAT_MAX };
}
