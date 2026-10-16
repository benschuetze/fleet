import crypto from "node:crypto";
import type { Config, JobKind, JobResult, Proc, TerminalState } from "../../shared/types";
import { childEnv } from "../core/childenv";
import { tr } from "../core/lang";
import { NO_CLI } from "../core/launch";
import { forkArgs, jobArgs, newArgs, resumeArgs } from "./args";
import { RingBuffer } from "./buffer";
import { claudeCli, cliLoggedIn } from "./cli";
import { JOB_TIMEOUT_MS, lineSplitter, logJob, parseResult } from "./jobs";
import { type Child, ptyMode, spawnChild } from "./pty";
import { LOOK_MS, nextScreen, TAIL_BYTES } from "./screen";
import { alive, readStore, writeStore } from "./store";

/**
 * The process manager: Claude sessions Fleet starts itself. Interactive ones run in a pty and keep running when
 * the browser tab closes; the drawer attaches to their output (buffer first, then live). Headless jobs run
 * Fleet's own turns with exactly counted costs. Folders always come from the caller's overview, never from a
 * request.
 */

export type TermEvent = { type: "out"; data: Buffer } | { type: "exit"; code: number | null };
export type StartResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export interface StartRequest {
  root: string;
  cwd: string;
  prompt?: string;
  /** Session to continue; without it Fleet starts a new one with an id of its own. */
  resume?: string;
  /** With `resume`: continue as a new branch of that session (it may still run elsewhere). */
  fork?: boolean;
  title?: string | null;
  /** Fleet starts this session for its own reason: the hook marks the first turn as Fleet's cost. */
  turn?: "fix" | "brief";
}

export interface JobRequest {
  kind: JobKind;
  id: string;
  root: string;
  cwd: string;
  prompt: string;
}

/** What the API and the overview need; the demo mode has its own implementation (demo-term.ts). */
export interface Terminals {
  state(): TerminalState;
  list(): Proc[];
  get(id: string): Proc | null;
  start(r: StartRequest): Promise<StartResult>;
  job(r: JobRequest): Promise<StartResult & { done?: Promise<JobResult> }>;
  attach(id: string, on: (e: TermEvent) => void): (() => void) | null;
  write(id: string, data: Buffer): boolean;
  resize(id: string, cols: number, rows: number): boolean;
  kill(id: string, signal: "int" | "term"): boolean;
  counts(): { interactive: number; jobs: number };
  /** Takes over what processes.json still lists from the last run (as "interrupted"). */
  restore(): void;
  close(): void;
}

export const MAX_JOBS = 2;
/** Ended processes stay visible for a while: an exit for 10 minutes, a crash or interruption for a day. */
const KEEP_EXITED = 10 * 60e3;
const KEEP_FAILED = 24 * 3600e3;

interface Entry {
  info: Proc;
  child: Child | null;
  buf: RingBuffer;
  listeners: Set<(e: TermEvent) => void>;
  userKill: boolean;
  screenTimer?: NodeJS.Timeout;
  quiet: NodeJS.Timeout[];
}

export const live = (p: Pick<Proc, "status">) => p.status === "starting" || p.status === "running";

export function createManager(o: { config: () => Config; onChange: () => void; jobTimeoutMs?: number }): Terminals {
  const table = new Map<string, Entry>();
  let closing = false;
  const timer = (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  };

  const count = (kind: Proc["kind"]) => [...table.values()].filter((e) => e.info.kind === kind && live(e.info)).length;
  const persist = () => {
    if (closing) return;
    writeStore(
      [...table.values()]
        .filter((e) => e.info.kind === "session" && live(e.info))
        .map((e) => ({
          id: e.info.id,
          root: e.info.root,
          cwd: e.info.cwd,
          startedAt: e.info.startedAt,
          pid: e.info.pid,
          title: e.info.title,
        })),
    );
  };
  const prune = (now: number) => {
    for (const [id, e] of table) {
      if (live(e.info)) continue;
      const age = now - (e.info.endedAt || e.info.startedAt);
      if (age > (e.info.status === "exited" ? KEEP_EXITED : KEEP_FAILED)) table.delete(id);
    }
  };

  function state(): TerminalState {
    const cfg = o.config().terminal;
    const max = cfg.maxSessions;
    if (!cfg.enabled)
      return { available: false, off: true, max, why: tr("in der Config abgeschaltet", "switched off in the config") };
    const pm = ptyMode();
    // CLAUDE_FLEET_PTY=off is a choice like the config switch, the missing module is not.
    if (!pm.mode)
      return { available: false, max, why: pm.why, ...(process.env.CLAUDE_FLEET_PTY === "off" ? { off: true } : {}) };
    if (!claudeCli()) return { available: false, max, why: tr(NO_CLI.de, NO_CLI.en) };
    return { available: true, max };
  }

  const newEntry = (info: Proc, kb: number): Entry => ({
    info,
    child: null,
    buf: new RingBuffer(kb * 1024),
    listeners: new Set(),
    userKill: false,
    quiet: [],
  });
  const emit = (e: Entry, ev: TermEvent) => {
    for (const l of e.listeners) {
      try {
        l(ev);
      } catch {
        // a closed connection must not stop the others
      }
    }
  };
  const output = (e: Entry, d: Buffer) => {
    e.buf.push(d);
    e.info.lastOutputAt = Date.now();
    if (e.info.status === "starting") {
      e.info.status = "running";
      o.onChange();
    }
    emit(e, { type: "out", data: d });
    if (e.info.kind !== "session") return;
    // The screen is read at most five times a second; a TUI redraws far more often.
    e.screenTimer ??= timer(() => {
      e.screenTimer = undefined;
      const prev = e.info.screen;
      e.info.screen = nextScreen(prev, e.buf.tail(TAIL_BYTES), Date.now());
      if (prev?.kind !== e.info.screen.kind) o.onChange();
    }, 200);
    quiet(e);
  };
  // LOOK_MS without a sign of life (output, input, start) changes the status without any new event
  // (server/core/status.ts): tell the pages then.
  const quiet = (e: Entry) => {
    for (const q of e.quiet) clearTimeout(q);
    e.quiet = [timer(o.onChange, LOOK_MS + 250)];
  };
  const exited = (e: Entry, code: number | null, error?: string) => {
    if (!live(e.info)) return;
    if (error) e.buf.push(Buffer.from(`\r\n[fleet] ${error}\r\n`));
    e.info.exitCode = code;
    e.info.endedAt = Date.now();
    e.info.status = !error && (e.userKill || code === 0) ? "exited" : "failed";
    e.child = null;
    emit(e, { type: "exit", code });
    persist();
    o.onChange();
  };

  /** Shared by start and job: the CLI must exist and be logged in, and no other process may hold the session. */
  async function preflight(id: string | undefined): Promise<{ ok: true; cli: string } | (StartResult & { ok: false })> {
    const cli = claudeCli();
    if (!cli) return { ok: false, status: 422, error: tr(NO_CLI.de, NO_CLI.en) };
    if (!(await cliLoggedIn(cli)))
      return {
        ok: false,
        status: 422,
        error: tr("claude ist nicht angemeldet (claude /login)", "claude is not logged in (claude /login)"),
      };
    const cur = id ? table.get(id) : undefined;
    if (cur && live(cur.info) && cur.info.kind === "job")
      return {
        ok: false,
        status: 409,
        error: tr("In dieser Session läuft gerade ein Fleet-Job", "A Fleet job is running in this session"),
      };
    return { ok: true, cli };
  }

  const env = (id: string, turn?: StartRequest["turn"]) => {
    // Without the markers of a Claude session Fleet may have been started from (transcripts, socket, UI flags).
    const e: NodeJS.ProcessEnv = {
      ...childEnv(process.env),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLAUDE_FLEET_PROC: id,
    };
    // Only what this start says; never inherited from the server's own environment.
    delete e.CLAUDE_FLEET_TURN;
    if (turn === "fix" || turn === "brief") e.CLAUDE_FLEET_TURN = turn;
    delete e.NO_COLOR;
    return e;
  };

  return {
    state,
    list() {
      prune(Date.now());
      return [...table.values()].map((e) => ({ ...e.info }));
    },
    get(id) {
      const e = table.get(id);
      return e ? { ...e.info } : null;
    },
    async start(r) {
      const st = state();
      if (!st.available) return { ok: false, status: 422, error: st.why || "" };
      const cur = r.resume && !r.fork ? table.get(r.resume) : undefined;
      if (cur && live(cur.info) && cur.info.kind === "session") return { ok: true, id: cur.info.id };
      const pre = await preflight(r.resume);
      if (!pre.ok) return pre;
      if (count("session") >= st.max)
        return {
          ok: false,
          status: 409,
          error: tr(`Höchstens ${st.max} Sessions gleichzeitig`, `At most ${st.max} sessions at the same time`),
        };
      const cfg = o.config().terminal;
      const id = r.resume && !r.fork ? r.resume : crypto.randomUUID();
      // A fix session works from foreign CI text (pipeline.fixPrompt): never without any permission check (audit M1).
      const pm =
        r.turn === "fix" && cfg.permissionMode[r.root] === "bypassPermissions" ? "auto" : cfg.permissionMode[r.root];
      const built = r.resume
        ? r.fork
          ? forkArgs(r.resume, id, { permissionMode: pm })
          : resumeArgs(id, { permissionMode: pm })
        : newArgs(r.cwd, id, r.prompt, { permissionMode: pm });
      if (!built.ok) return { ok: false, status: 400, error: built.error };
      const now = Date.now();
      const e = newEntry(
        {
          id,
          kind: "session",
          job: null,
          mode: "pty",
          root: r.root,
          cwd: r.cwd,
          pid: null,
          cols: 100,
          rows: 24,
          startedAt: now,
          status: "starting",
          screen: null,
          lastOutputAt: 0,
          lastInputAt: 0,
          title: r.title?.slice(0, 200) || null,
        },
        cfg.scrollbackKb,
      );
      table.set(id, e);
      quiet(e);
      try {
        const child = spawnChild(ptyMode().mode === "pty" ? "pty" : "pipe", pre.cli, built.args, {
          cwd: r.cwd,
          // A resumed session's first turn here is the user's, not Fleet's.
          env: env(id, r.resume ? undefined : r.turn),
          cols: e.info.cols,
          rows: e.info.rows,
        });
        e.child = child;
        e.info.pid = child.pid;
        child.onData((d) => output(e, d));
        child.onExit((code, error) => exited(e, code, error));
      } catch (err) {
        exited(e, null, (err as Error).message);
        return { ok: true, id };
      }
      persist();
      o.onChange();
      return { ok: true, id };
    },
    async job(r) {
      const pre = await preflight(r.id);
      if (!pre.ok) return pre;
      const cur = table.get(r.id);
      if (cur && live(cur.info))
        return {
          ok: false,
          status: 409,
          error: tr("Die Session läuft gerade in Fleet", "The session is running in Fleet right now"),
        };
      if (count("job") >= MAX_JOBS)
        return {
          ok: false,
          status: 409,
          error: tr(`Höchstens ${MAX_JOBS} Fleet-Jobs gleichzeitig`, `At most ${MAX_JOBS} Fleet jobs at the same time`),
        };
      const built = jobArgs(r.id, r.prompt);
      if (!built.ok) return { ok: false, status: 400, error: built.error };
      const now = Date.now();
      const e = newEntry(
        {
          id: r.id,
          kind: "job",
          job: r.kind,
          mode: "headless",
          root: r.root,
          cwd: r.cwd,
          pid: null,
          cols: 0,
          rows: 0,
          startedAt: now,
          status: "running",
          screen: null,
          lastOutputAt: now,
          lastInputAt: 0,
          result: null,
        },
        64,
      );
      table.set(r.id, e);
      const lines: string[] = [];
      const split = lineSplitter((l) => {
        lines.push(l);
        if (lines.length > 500) lines.shift();
      });
      // Windows: claude.cmd only starts through a pty or a shell; Fleet never uses a shell.
      const mode = process.platform === "win32" && /\.(cmd|bat)$/i.test(pre.cli) && ptyMode().mode === "pty";
      let timedOut = false;
      const done = new Promise<JobResult>((resolve) => {
        const finish = (code: number | null, error?: string) => {
          clearTimeout(kill);
          split.end();
          const result = parseResult(lines, {
            exitCode: code,
            error: error || (timedOut ? tr("Zeitüberschreitung", "timed out") : null),
          });
          e.info.result = result;
          e.info.exitCode = code;
          e.info.endedAt = Date.now();
          e.info.status = result.ok ? "exited" : "failed";
          e.child = null;
          logJob({ kind: r.kind, id: r.id, startedAt: now, endedAt: e.info.endedAt, result });
          o.onChange();
          resolve(result);
        };
        const kill = timer(() => {
          timedOut = true;
          e.child?.kill("SIGTERM");
        }, o.jobTimeoutMs ?? JOB_TIMEOUT_MS);
        try {
          const child = spawnChild(mode ? "pty" : "pipe", pre.cli, built.args, {
            cwd: r.cwd,
            env: env(r.id),
            cols: 200,
            rows: 24,
          });
          e.child = child;
          e.info.pid = child.pid;
          child.onData((d) => {
            e.buf.push(d);
            e.info.lastOutputAt = Date.now();
            split.push(d);
          });
          child.onExit((code, error) => finish(code, error));
          // Headless needs no input; a closed stdin keeps a waiting prompt from hanging until the timeout.
          child.end();
        } catch (err) {
          finish(null, (err as Error).message);
        }
      });
      o.onChange();
      return { ok: true, id: r.id, done };
    },
    attach(id, on) {
      const e = table.get(id);
      if (!e) return null;
      if (e.info.kind !== "session") return null;
      on({ type: "out", data: e.buf.read() });
      if (!live(e.info)) {
        on({ type: "exit", code: e.info.exitCode ?? null });
        return () => {};
      }
      e.listeners.add(on);
      return () => e.listeners.delete(on);
    },
    write(id, data) {
      const e = table.get(id);
      if (!e?.child || !live(e.info) || e.info.kind !== "session") return false;
      e.child.write(data);
      e.info.lastInputAt = Date.now();
      // A lone Esc cancels an open approval or question without any hook event (status rule 4a).
      e.info.lastInputEsc = data.length === 1 && data[0] === 0x1b;
      // Own keystrokes answer an open question (status rule K) and restart the quiet clock.
      o.onChange();
      quiet(e);
      return true;
    },
    resize(id, cols, rows) {
      const e = table.get(id);
      if (!e?.child || !live(e.info) || e.info.kind !== "session") return false;
      e.child.resize(cols, rows);
      e.info.cols = cols;
      e.info.rows = rows;
      return true;
    },
    kill(id, signal) {
      const e = table.get(id);
      if (!e?.child || !live(e.info)) return false;
      e.userKill = true;
      e.child.kill(signal === "int" ? "SIGINT" : "SIGTERM");
      return true;
    },
    counts: () => ({ interactive: count("session"), jobs: count("job") }),
    restore() {
      const now = Date.now();
      const kb = o.config().terminal.scrollbackKb;
      for (const s of readStore()) {
        if (table.has(s.id)) continue;
        const e = newEntry(
          {
            id: s.id,
            kind: "session",
            job: null,
            mode: "pty",
            root: s.root,
            cwd: s.cwd,
            pid: null,
            cols: 100,
            rows: 24,
            startedAt: s.startedAt,
            endedAt: now,
            exitCode: null,
            status: "interrupted",
            screen: null,
            lastOutputAt: 0,
            lastInputAt: 0,
            title: s.title,
          },
          kb,
        );
        e.buf.push(
          Buffer.from(
            tr(
              `[fleet] Durch einen Neustart von Fleet unterbrochen${alive(s.pid) ? " (der alte Prozess läuft noch ohne Fenster)" : ""}.\r\n`,
              `[fleet] Interrupted by a Fleet restart${alive(s.pid) ? " (the old process still runs without a window)" : ""}.\r\n`,
            ),
          ),
        );
        table.set(s.id, e);
      }
      writeStore([]);
    },
    close() {
      // Write the running sessions before they end with the server, so the next start shows them as interrupted.
      persist();
      closing = true;
      for (const e of table.values()) for (const q of e.quiet) clearTimeout(q);
    },
  };
}
