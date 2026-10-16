import path from "node:path";
import { UUID } from "../core/desktop";
import { tr } from "../core/lang";

/**
 * The argument lists for `claude`. Pure functions, so every case is testable. Never a shell string: the
 * process manager passes the list as it is, and a prompt cannot become an option.
 */

export const MAX_PROMPT = 4000;
/** Fleet's jobs may write the handoff and little else; a few turns are enough for reading and writing one file. */
export const JOB_MAX_TURNS = 4;

export type Built = { ok: true; args: string[] } | { ok: false; error: string };

/** Without NUL and CR (a CR would send the line early in a terminal); too long is refused, not cut. */
export function cleanPrompt(p: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (p === undefined || p === null) return { ok: true, text: "" };
  if (typeof p !== "string") return { ok: false, error: tr("Auftrag muss Text sein", "The task must be text") };
  const text = p.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_PROMPT)
    return {
      ok: false,
      error: tr(
        `Auftrag zu lang (höchstens ${MAX_PROMPT} Zeichen)`,
        `Task too long (at most ${MAX_PROMPT} characters)`,
      ),
    };
  // A leading dash would be read as an option.
  return { ok: true, text: text.startsWith("-") ? ` ${text}` : text };
}

export const absDir = (dir: unknown): dir is string =>
  typeof dir === "string" && path.isAbsolute(dir) && !/[\0\r\n]/.test(dir);

const mode = (pm: string | undefined) => (pm ? ["--permission-mode", pm] : []);

/** A new session with an id Fleet chose, so its transcript is known before it exists. */
export function newArgs(cwd: unknown, id: string, prompt: unknown, o: { permissionMode?: string } = {}): Built {
  if (!absDir(cwd)) return { ok: false, error: tr("Ordner ungültig", "Invalid folder") };
  if (!UUID.test(id)) return { ok: false, error: tr("id ungültig", "Invalid id") };
  const p = cleanPrompt(prompt);
  if (!p.ok) return p;
  return { ok: true, args: ["--session-id", id, ...mode(o.permissionMode), ...(p.text ? [p.text] : [])] };
}

export function resumeArgs(id: string, o: { permissionMode?: string } = {}): Built {
  if (!UUID.test(id)) return { ok: false, error: tr("id ungültig", "Invalid id") };
  return { ok: true, args: ["--resume", id, ...mode(o.permissionMode)] };
}

/**
 * Continues a session as a branch of its own (`id`): for a session that may still run elsewhere (the desktop app,
 * another terminal). Its transcript stays untouched; the branch carries the conversation on in Fleet's window.
 */
export function forkArgs(from: string, id: string, o: { permissionMode?: string } = {}): Built {
  if (!UUID.test(from) || !UUID.test(id)) return { ok: false, error: tr("id ungültig", "Invalid id") };
  return { ok: true, args: ["--resume", from, "--fork-session", "--session-id", id, ...mode(o.permissionMode)] };
}

/** A headless turn in an existing session; its result line carries the exact usage and cost. */
export function jobArgs(id: string, prompt: string): Built {
  if (!UUID.test(id)) return { ok: false, error: tr("id ungültig", "Invalid id") };
  const p = cleanPrompt(prompt);
  if (!p.ok) return p;
  if (!p.text) return { ok: false, error: tr("Auftrag fehlt", "Task missing") };
  return {
    ok: true,
    args: [
      "--resume",
      id,
      "-p",
      p.text,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      String(JOB_MAX_TURNS),
    ],
  };
}
