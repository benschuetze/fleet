import type { Proc } from "../../shared/types";
import { demoSessionFacts, demoTerminalSessions } from "../core/demo";
import { demoLog } from "../core/demo-log";
import { tr } from "../core/lang";
import type { StartResult, TermEvent, Terminals } from "./manager";

/**
 * The terminal in demo mode: invented output, an invented approval prompt, input is echoed. Nothing is started.
 * Two demo sessions run "in Fleet" and show up in the overview. Sessions started or resumed in the demo only
 * exist in the drawer: all E2E tests share one demo server, and new rows would shift their counts.
 */

const ESC = "\x1b";
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
const line = (s = "") => `${s}\r\n`;

function banner(title: string): string {
  return [
    line(`${ESC}[38;5;209m╭──────────────────────────────────────────╮${ESC}[39m`),
    line(`${ESC}[38;5;209m│${ESC}[39m ✻ ${bold("Claude Code")} ${dim(tr("(Demo, erfunden)", "(demo, made up)"))}`),
    line(`${ESC}[38;5;209m╰──────────────────────────────────────────╯${ESC}[39m`),
    line(),
    line(`> ${title}`),
    line(),
  ].join("");
}

/**
 * A working session: its last file steps from the demo log, so terminal, log and diff name the same files (round 5:
 * the terminal read AddressForm.tsx while diff and log showed core.ts).
 */
function working(title: string, id: string): string {
  const steps = demoLog()
    .lines.filter((l) => l.session === id && l.kind === "tool" && /^(Read|Edit|Write)$/.test(String(l.tool)))
    .slice(-2);
  return [
    banner(title),
    ...steps.flatMap((l) => [
      line(`● ${l.tool}(${l.text})`),
      line(
        dim(
          `  ⎿  ${l.tool === "Read" ? tr("Datei gelesen", "Read the file") : tr("Datei geändert", "Changed the file")}`,
        ),
      ),
    ]),
    line(),
    line(`✻ ${tr("Arbeitet …", "Working …")} ${dim("(esc to interrupt)")}`),
  ].join("");
}

function asking(title: string, cmd: string): string {
  return [
    banner(title),
    line(`● Bash(${cmd})`),
    line(),
    line(` ${bold("Bash command")}`),
    line(`   ${cmd}`),
    line(),
    line(" Do you want to proceed?"),
    line(` ${ESC}[36m❯ 1. Yes${ESC}[39m`),
    line("   2. Yes, and don't ask again for this command"),
    line("   3. No, and tell Claude what to do differently (esc)"),
    line(),
  ].join("");
}

/** A turn that ended with a question in words: Claude's last text and the empty input line. */
function questioning(title: string, text: string): string {
  return [banner(title), line(`● ${text}`), line(), line(`${ESC}[2m╭─${ESC}[22m`), line("> "), line()].join("");
}

/** A finished turn: Claude's last answer and the empty input line. */
function finished(title: string, text: string): string {
  return [banner(title), line(`● ${text || tr("Fertig.", "Done.")}`), line(), line("> "), line()].join("");
}

/**
 * The screen of a demo session resumed here, from what it does in the demo (practical test 15 Oct: every resumed
 * session showed a Bash approval for `pnpm test`, also the one that asked "Shall I open the PR?").
 */
function screenOf(id: string, fallback: string): { out: string; screen: Proc["screen"] } {
  const f = demoSessionFacts(id);
  if (!f)
    return {
      out: asking(fallback, "pnpm test"),
      screen: { kind: "approval", at: Date.now(), text: "Do you want to proceed?" },
    };
  const perm = /^(Freigabe|Erlaubnis|Approval|Permission) (für|for) [^:]+:\s*(.+)$/.exec(f.detail);
  if (f.status === "needs_input" && perm)
    return {
      out: asking(f.title, perm[3] || "pnpm test"),
      screen: { kind: "approval", at: Date.now(), text: f.detail },
    };
  if (f.status === "needs_input")
    return { out: questioning(f.title, f.detail), screen: { kind: "question", at: Date.now(), text: f.detail } };
  if (f.status === "working") return { out: working(f.title, id), screen: { kind: "busy", at: Date.now(), text: "" } };
  return { out: finished(f.title, f.answer || f.detail), screen: { kind: "prompt", at: Date.now(), text: "" } };
}

interface DemoEntry {
  info: Proc;
  out: string;
  listeners: Set<(e: TermEvent) => void>;
  listed: boolean;
}

export function createDemoTerminals(): Terminals {
  const table = new Map<string, DemoEntry>();
  let n = 0;
  const now = () => Date.now();
  const proc = (id: string, cwd: string, screen: Proc["screen"], title: string | null): Proc => ({
    id,
    kind: "session",
    job: null,
    mode: "pty",
    root: cwd,
    cwd,
    pid: null,
    cols: 100,
    rows: 24,
    startedAt: now() - 30 * 60e3,
    status: "running",
    screen,
    lastOutputAt: now() - 60e3,
    lastInputAt: 0,
    title,
  });
  for (const s of demoTerminalSessions()) {
    const cmd = s.detail.replace(/^[^:]*:\s*/, "") || "pnpm test";
    table.set(s.id, {
      info: proc(
        s.id,
        s.cwd,
        s.asks ? { kind: "approval", at: now() - 4 * 60e3, text: s.detail } : { kind: "busy", at: now(), text: "" },
        s.title,
      ),
      out: s.asks ? asking(s.title, cmd) : working(s.title, s.id),
      listeners: new Set(),
      listed: true,
    });
  }
  const scripted = (id: string, title: string, cwd: string): StartResult => {
    const { out, screen } = screenOf(id, title);
    table.set(id, {
      info: proc(id, cwd, screen, title),
      out,
      listeners: new Set(),
      listed: false,
    });
    return { ok: true, id };
  };
  const listed = () => [...table.values()].filter((e) => e.listed);
  return {
    state: () => ({ available: true, max: 8 }),
    // The demo processes stay "fresh": the waiting one quiet since the question, the working one busy.
    list: () =>
      listed().map((e) => ({
        ...e.info,
        lastOutputAt: e.info.screen?.kind === "busy" ? now() - 500 : e.info.lastOutputAt,
      })),
    get: (id) => {
      const e = table.get(id);
      return e ? { ...e.info } : null;
    },
    async start(r) {
      if (r.resume && table.has(r.resume)) return { ok: true, id: r.resume };
      if (table.size >= 40) table.delete([...table.keys()].find((k) => !table.get(k)?.listed) || "");
      const id = r.resume || `demo-term-${++n}`;
      return scripted(id, r.prompt || r.title || tr("Neue Session", "New session"), r.cwd);
    },
    async job() {
      return { ok: true, id: "demo-job" };
    },
    attach(id, on) {
      const e = table.get(id);
      if (!e) return null;
      on({ type: "out", data: Buffer.from(e.out) });
      e.listeners.add(on);
      return () => {
        e.listeners.delete(on);
        // A drawer-only demo session ends with its drawer, so the shared demo server starts the next test clean.
        if (!e.listed && !e.listeners.size) table.delete(id);
      };
    },
    write(id, data) {
      const e = table.get(id);
      if (!e) return false;
      // Echo like a terminal; Enter becomes a new line.
      const echo = data.toString("utf8").replace(/\r/g, "\r\n");
      e.out = (e.out + echo).slice(-64 * 1024);
      for (const l of e.listeners) l({ type: "out", data: Buffer.from(echo) });
      return true;
    },
    resize: (id) => table.has(id),
    kill(id) {
      const e = table.get(id);
      if (!e) return false;
      for (const l of e.listeners) l({ type: "exit", code: 0 });
      return true;
    },
    counts: () => ({ interactive: listed().length, jobs: 0 }),
    restore() {},
    close() {},
  };
}
