import path from "node:path";
import { byTime, LOG_MAX } from "../../shared/log";
import type { ChatEntry, ChatPage, LogLine } from "../../shared/types";
import { DEMO_FILES, demoLogSessions } from "./demo";
import { tr } from "./lang";
import type { LogRead } from "./log";

/**
 * Invented steps for the log view in demo mode: the demo sessions have no transcript files. Working sessions take a
 * step every 20 to 40 seconds, so new lines show up while one watches; the others stopped where their status began.
 * Two sessions appear only here, as in real life: a headless job without a title and a session in a folder that is
 * no repo of the overview.
 *
 * The steps hang on the time the server started, so the same step keeps its time and number on every request.
 */

const T0 = Date.now();
const MIN = 60e3;
const HISTORY = 16;
const ROOT = process.platform === "win32" ? "C:\\demo" : "/demo";

interface Script {
  id: string;
  cwd: string;
  working: boolean;
  /** Time of the last step of a session that stopped. */
  last: number;
  period: number;
  files: string[];
  todos: string[];
  /** The step a session that stopped ended with. */
  end: Omit<LogLine, "seq" | "at" | "session"> | null;
  loop: boolean;
  /** Changes no code: Edit steps become reads. */
  readOnly?: boolean;
  /** The task it stood at when the demo started. */
  cur?: number;
}

const EXTRA: Script[] = [
  {
    id: "c0ffee12-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    cwd: path.join(ROOT, "billing-service"),
    working: true,
    last: 0,
    period: 45e3,
    files: ["HANDOFF.md", "docs/invoices.md"],
    todos: [],
    end: null,
    loop: false,
  },
  {
    id: "a9d4e2f7-1b3c-4e5f-a6b7-c8d9e0f1a2b3",
    cwd: process.platform === "win32" ? "C:\\scratch\\csv-check" : "/scratch/csv-check",
    working: false,
    last: T0 - 12 * MIN,
    period: 50e3,
    files: ["check.py", "sample.csv"],
    todos: [],
    end: { kind: "text", tool: null, text: tr("Alle 412 Zeilen sind gültig.", "All 412 rows are valid.") },
    loop: false,
  },
];

const first = (s: string | null) => (s || "").split("\n")[0]?.trim() || "";

/**
 * The call Fleet's demo approval waits for (round 3: the session kept working in the log while it waited): its log
 * ends with this call at the server start, and the board and drawer name its tool.
 */
export const APPROVAL = { session: "demo-02", tool: "Bash", text: "pnpm add -D p-limit" } as const;

function scripts(): Script[] {
  return [
    ...demoLogSessions().map((s, k) => {
      // "Approval for Bash: pnpm e2e …": the call that waits for the yes.
      const ask = /^[^:]+ (\w+): (.+)$/.exec(first(s.detail));
      const end: Script["end"] =
        s.failure || s.status === "error"
          ? { kind: "error", tool: null, text: s.failure || `API Error: ${first(s.detail)}` }
          : s.status === "needs_input" && ask
            ? { kind: "tool", tool: ask[1] || "Bash", text: ask[2] || "" }
            : s.answer
              ? { kind: "text", tool: null, text: first(s.answer) }
              : null;
      const waits = s.id === APPROVAL.session;
      return {
        id: s.id,
        cwd: s.cwd,
        working: s.status === "working" && !waits,
        last: waits ? T0 : T0 - s.mins * MIN,
        period: (20 + (k % 5) * 5) * 1000,
        files: s.edits.length ? s.edits : DEMO_FILES,
        readOnly: s.readOnly,
        cur: s.cur,
        todos: s.todos,
        end: waits ? ({ kind: "tool", tool: APPROVAL.tool, text: APPROVAL.text } as const) : end,
        loop: s.loop,
      };
    }),
    ...EXTRA,
  ];
}

/** Step `j` of a session; one that changes no code reads where others edit. */
function step(s: Script, j: number, k: number): Omit<LogLine, "seq" | "at" | "session">[] {
  const out = rawStep(s, j, k);
  return s.readOnly ? out.map((x) => (x.tool === "Edit" ? { ...x, tool: "Read" } : x)) : out;
}

/** The tool of a working demo session's newest step: the board's activity says the same as its drawer. */
export function demoNowTool(id: string, now = Date.now()): string | null {
  if (id === APPROVAL.session) return APPROVAL.tool;
  const all = scripts();
  const k = all.findIndex((x) => x.id === id);
  const s = all[k];
  if (!s?.working) return null;
  for (let j = Math.floor((now - T0) / s.period); j > -HISTORY; j--) {
    if (T0 + j * s.period + k * 700 > now) continue;
    const tools = step(s, j, k).filter((x) => x.kind === "tool");
    const last = tools[tools.length - 1];
    if (last?.tool) return last.tool;
  }
  return null;
}

/** Step `j` of a session: reading, searching, editing, testing, a word in between. */
/** Modulo that stays positive: the history counts `j` below zero. */
const mod = (a: number, n: number) => ((a % n) + n) % n;

function rawStep(s: Script, j: number, k: number): Omit<LogLine, "seq" | "at" | "session">[] {
  const f = (n: number) => s.files[mod(j + n, s.files.length)] || "src/index.ts";
  if (s.loop)
    return j % 2
      ? [{ kind: "tool", tool: "Bash", text: "pnpm test e2e/login.spec.ts" }]
      : [{ kind: "error", tool: "Bash", text: "Exit code 1 · login.spec.ts: 1 failed" }];
  // Steps 3 apart: sessions that start together do not all do the same thing at once.
  switch (mod(j * 3 + k, 8)) {
    case 0:
      return [{ kind: "tool", tool: "Read", text: f(0) }];
    case 1:
      return [{ kind: "tool", tool: "Grep", text: `export function  ${path.dirname(f(1))}` }];
    case 2:
      return [{ kind: "tool", tool: "Edit", text: f(0) }];
    case 3:
      // Now and then a test run fails: the result is the red line, the call stays grey.
      return mod(j * 7 + k, 5) === 0
        ? [
            { kind: "tool", tool: "Bash", text: "pnpm test" },
            { kind: "error", tool: "Bash", text: "Exit code 1 · 2 failed, 48 passed" },
          ]
        : [{ kind: "tool", tool: "Bash", text: "pnpm test" }];
    case 4: {
      // The task it stands at then, as the task list moves (one a minute, demo.ts progress): never one it finished.
      const at = Math.max(0, Math.min(s.todos.length - 1, (s.cur || 0) + Math.floor((j * s.period) / MIN)));
      const todo = s.todos[at];
      return [
        {
          kind: "text",
          tool: null,
          text: todo ? tr(`Weiter mit: ${todo}`, `Moving on: ${todo}`) : tr("Sieht gut aus.", "Looks good."),
        },
      ];
    }
    case 5:
      // f(0) as in case 2: its step is one further, so the two edits alternate the files (round 7: with two files
      // f(1) picked the same one as case 2 every time, and the diff's other own file was never edited).
      return [{ kind: "tool", tool: "Edit", text: f(0) }];
    case 6:
      return [{ kind: "tool", tool: "Bash", text: "pnpm typecheck" }];
    default:
      return [{ kind: "tool", tool: "TodoWrite", text: `${s.todos.length || 3} ${tr("Aufgaben", "todos")}` }];
  }
}

export function demoLog(now = Date.now(), keep = true): LogRead {
  const lines: LogLine[] = [];
  const info: LogRead["info"] = new Map();
  scripts().forEach((s, k) => {
    info.set(s.id, { title: null, cwd: s.cwd });
    const push = (at: number, x: Omit<LogLine, "seq" | "at" | "session">, n: number) => {
      if (at <= now) lines.push({ ...x, at, session: s.id, seq: Math.floor(at / 100) * 64 + k * 2 + n });
    };
    const add = (at: number, j: number) => {
      for (const [n, x] of step(s, j, k).entries()) push(at + n * 1000, x, n);
    };
    if (s.working) {
      const last = Math.floor((now - T0) / s.period);
      for (let j = -HISTORY; j <= last; j++) add(T0 + j * s.period + k * 700, j);
      return;
    }
    for (let j = HISTORY; j >= 1; j--) add(s.last - j * s.period, j);
    if (s.end) push(s.last, s.end, 0);
  });
  const sorted = lines.sort(byTime);
  // `keep` false: the whole history, which `demoTaskStart` needs (the window below slides with the clock).
  const kept = keep ? sorted.slice(-LOG_MAX) : sorted;
  return { seq: kept.reduce((m, l) => Math.max(m, l.seq), 0), lines: kept, info };
}

/**
 * A demo session's conversation for its drawer (server/core/chat.ts reads real ones): its task as your prompt,
 * the invented steps, its last answer; the newest tool call of a working session is still running.
 */
export function demoChat(
  id: string,
  s:
    | { lastPrompt?: string | null; lastAssistant?: string | null; status?: string; statusSince?: number | null }
    | undefined,
  now = Date.now(),
): ChatPage {
  const steps = demoLog(now).lines.filter((l) => l.session === id);
  const entries: ChatEntry[] = steps.map((l) => ({
    at: l.at,
    kind: l.kind === "prompt" ? "you" : l.kind === "text" ? "claude" : l.kind,
    tool: l.tool,
    text: l.text,
  }));
  const working = s?.status === "working";
  // A working session's task came when it started working: there the history says "new task" too (round 4).
  // Fixed from the server start (round 7): the sliding log window and `now` moved the prompt's time on every request;
  // a session without steps (Cowork) asked when its state began, as the stream and the history say.
  const start = demoTaskStart(id) ?? s?.statusSince ?? T0;
  const asked = working && s?.statusSince ? Math.min(s.statusSince, start) : start;
  if (s?.lastPrompt) entries.unshift({ at: asked, kind: "you", tool: null, text: s.lastPrompt });
  // The log's last step of a finished session is the first line of its answer: the whole answer replaces it,
  // never a second time (practical test 15 Oct: the last Claude message stood twice).
  const end = entries[entries.length - 1];
  if (s?.lastAssistant && !working && end?.kind === "claude" && s.lastAssistant.startsWith(end.text.replace(/…$/, "")))
    end.text = s.lastAssistant;
  else if (s?.lastAssistant && !working)
    entries.push({
      at: (steps[steps.length - 1]?.at ?? s?.statusSince ?? T0) + 1000,
      kind: "claude",
      tool: null,
      text: s.lastAssistant,
    });
  const last = entries[entries.length - 1];
  if (working && last?.kind === "tool") last.open = true;
  return { session: id, entries, more: false };
}

/** When a demo session's conversation starts (its task as your prompt, a second before its first step); null without. */
export function demoTaskStart(id: string): number | null {
  // Anchored at the server start, never at the request (round 7: "new task" and the waits summed from it moved).
  const first = demoLog(T0, false).lines.find((l) => l.session === id);
  return first ? first.at - 1000 : null;
}
