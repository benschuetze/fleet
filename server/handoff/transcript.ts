import fs from "node:fs";
import path from "node:path";
import { contextSize } from "../core/models";

/** Reading the end of a transcript without a model: what happened, which context, which program. */

// biome-ignore lint/suspicious/noExplicitAny: transcript lines are Claude Code's internal format, read defensively
export type Line = Record<string, any>;

/** The end of a transcript (the last 512 KB, complete lines only). */
export function tailLines(file: string, bytes = 512 * 1024): Line[] {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, bytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, st.size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    if (st.size > len) lines.shift();
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
  } catch {
    return [];
  }
}

/** Context of the last answer in the transcript. */
export function contextFromTranscript(file: string): { pct: number; tokens: number; model: string } | null {
  const lines = tailLines(file, 128 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = lines[i] as Line;
    const u = o?.message?.usage;
    if (o.type !== "assistant" || o.isSidechain || !u || o.message.model === "<synthetic>") continue;
    const tokens = (+u.input_tokens || 0) + (+u.cache_creation_input_tokens || 0) + (+u.cache_read_input_tokens || 0);
    if (tokens > 0)
      return {
        pct: Math.round((1000 * tokens) / contextSize(o.message.model, tokens)) / 10,
        tokens,
        model: String(o.message.model),
      };
  }
  return null;
}

/** Where does the session run? From the transcript (entrypoint), so the new session opens in the same program. */
export function openTargetOf(transcript: unknown): "vscode" | "terminal" | "desktop" {
  let ep = "";
  if (typeof transcript === "string" && transcript) {
    const lines = tailLines(transcript, 64 * 1024);
    for (let i = lines.length - 1; i >= 0 && !ep; i--) {
      const v = lines[i]?.entrypoint;
      if (typeof v === "string") ep = v;
    }
  }
  return ep === "claude-vscode" ? "vscode" : ep === "cli" ? "terminal" : "desktop";
}

const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : "";

const isPrompt = (o: Line) =>
  o.type === "user" &&
  !o.isMeta &&
  !o.isSidechain &&
  !(Array.isArray(o.message?.content) && o.message.content.some((b: Line) => b?.type === "tool_result")) &&
  !!text(o.message?.content).trim() &&
  !/^(<|\[Request interrupted|Caveat:)/.test(text(o.message.content).trim());

export const oneLine = (v: string, n = 300) => v.replace(/\s+/g, " ").trim().slice(0, n);

export interface Progress {
  prompts: string[];
  done: string[];
  open: string[];
  files: string[];
  cmds: string[];
  answer: string;
}

/** What happened in the transcript since a point in time, gathered without a model. */
export function progressSince(transcript: string, root: string, since: number): Progress {
  const lines = tailLines(transcript).filter((o) => !since || Date.parse(o.timestamp) > since);
  const prompts: string[] = [];
  let todos: Line[] = [];
  let answer = "";
  const files: string[] = [];
  const cmds: string[] = [];
  for (const o of lines) {
    if (o.isSidechain) continue;
    if (isPrompt(o)) prompts.push(oneLine(text(o.message.content)));
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    const t = text(o.message.content).trim();
    if (t && o.message.model !== "<synthetic>") answer = t;
    for (const b of o.message.content as Line[]) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) todos = b.input.todos;
      const fp = b.input?.file_path || b.input?.notebook_path;
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && typeof fp === "string") {
        const rel = (path.relative(root, fp) || fp).split(path.sep).join("/");
        if (!files.includes(rel)) files.push(rel);
      }
      if (b.name === "Bash" && typeof b.input?.command === "string")
        cmds.push(oneLine(b.input.command.split("\n")[0] || "", 160));
    }
  }
  const status = (st: string) =>
    todos.filter((t) => t && t.status === st).map((t) => oneLine(String(t.content || ""), 200));
  return {
    prompts,
    done: status("completed"),
    open: [...status("in_progress"), ...status("pending")],
    files,
    cmds,
    answer,
  };
}
