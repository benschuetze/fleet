import type { Screen, SessionProc } from "../../shared/types";

/**
 * What the end of a terminal shows: an approval prompt, a question, the empty input line, work, or something
 * unknown, with the asking sentence. Display only: the status never reads the screen (server/core/status.ts,
 * rules K, S, Q), because these patterns follow Claude Code's interface and broke with 2.1 (B12). Pure; reads
 * only the last 4 KB of output after removing escape sequences. A TUI redraws by moving the cursor, so the tail
 * holds several frames: the pattern that matches last is what is on screen now.
 */

export const TAIL_BYTES = 4096;
/** No sign of life (output, keystroke, hook event) this long: the status asks for a look (rules S and Q). */
export const LOOK_MS = 10_000;

type Kind = Screen["kind"];
const PATTERNS: { kind: Kind; re: RegExp; line?: true }[] = [
  // Permission dialog: "Do you want to proceed?" / "Do you want to make this edit to x?" with numbered options.
  { kind: "approval", re: /Do you want to (?:proceed|make this edit|create|run|allow|fetch|use)\b[^\n?]*\?/gi },
  { kind: "approval", re: /❯\s*1\.\s*Yes\b/g },
  // Its footer also says "Esc to cancel"; with "Tab to amend" it stays an approval.
  { kind: "approval", re: /Esc to cancel[^\n]*Tab to amend/gi },
  // AskUserQuestion, pickers and the dialogs before the first prompt (folder trust, security notes, theme,
  // browser extension): none of them fires a hook.
  { kind: "question", re: /Enter to (?:select|confirm)\b/gi },
  { kind: "question", re: /Press Enter to continue/gi },
  { kind: "question", re: /Esc to cancel(?![^\n]*Tab to amend)/gi },
  { kind: "question", re: /Choose the text style/gi },
  // The empty input box: up to 2.0 with its hint line, from 2.1 a ❯ between two rules over the mode footer.
  { kind: "prompt", re: /\? for shortcuts/gi },
  { kind: "prompt", re: /│\s*>\s*│/g },
  { kind: "prompt", re: /─{3,}[^\S\n]*\n[^\S\n]*❯[^\n]*\n[^\S\n]*─{3,}/g, line: true },
  { kind: "prompt", re: /(?:⏸|⏵⏵)[^\S\n]*(?:[\w-]+ )+on\b/g },
  // Work: the spinner line says how to interrupt.
  { kind: "busy", re: /esc to interrupt/gi },
];

/** Removes escape sequences; a cursor step to the right becomes a space, line moves become line breaks. */
export function plain(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Math.min(Number(n) || 1, 40)))
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\x1b\[\d*(?:;\d*)?[ABEFH]/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      .replace(/\x1b[@-Z\\-_]/g, "")
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the remaining control characters
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}

const clip = (s: string, n: number) => {
  const t = s
    .replace(/[│╭╮╰╯─]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Headings of dialogs that ask without a question mark.
const TITLES = [/Choose the text style[^\n]*/i, /Security notes:?/i, /Claude in Chrome extension detected/i];
const OPTION = /^(?:❯|\d+\.\s)/;
const BORDER = /─{8,}|╭/;

/**
 * The asking sentence of the dialog that ends at the match: the nearest line with a question mark (cut after
 * it), else a known heading, else the dialog's first line below its border. Never an option or an older frame.
 */
function askingText(text: string, at: number): string {
  const end = text.indexOf("\n", at);
  const all = text.slice(0, end < 0 ? text.length : end).split("\n");
  let top = Math.max(0, all.length - 20);
  for (let i = all.length - 2; i >= top; i--)
    if (BORDER.test(all[i] || "")) {
      top = i + 1;
      break;
    }
  const lines = all.slice(top).map((l) => clip(l, 400));
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] || "";
    if (OPTION.test(l) || /for shortcuts/.test(l)) continue;
    const q = /^(.*\?)(?:\s|$)/.exec(l);
    if (q?.[1]) return clip(q[1], 200);
  }
  const block = lines.join("\n");
  for (const t of TITLES) {
    const m = t.exec(block);
    if (m) return clip(m[0], 200);
  }
  const first = lines.find((l) => l && !OPTION.test(l));
  return first ? clip(first, 200) : "";
}

/**
 * Classifies the end of the output. Unknown output is "unknown", never an approval. From 2.1 the spinner stands
 * above the input line in the same frame: work, unless a later frame drew the input line again without it.
 */
export function classify(rawTail: string): { kind: Kind; text: string } {
  const text = plain(rawTail.slice(-TAIL_BYTES));
  const hits: { kind: Kind; at: number; line?: true }[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) hits.push({ kind: p.kind, at: m.index, line: p.line });
  }
  if (!hits.length) return { kind: "unknown", text: "" };
  hits.sort((a, b) => a.at - b.at);
  const best = hits[hits.length - 1] as (typeof hits)[number];
  let kind = best.kind;
  if (kind === "prompt") {
    const busy = hits.filter((h) => h.kind === "busy").pop();
    const lines = hits.filter((h) => h.line && h.at <= best.at);
    const start = lines.length ? (lines[lines.length - 1] as (typeof hits)[number]).at : best.at;
    if (busy && busy.at < start && !hits.some((h) => h.kind === "prompt" && h.at > busy.at && h.at < start))
      kind = "busy";
  }
  return { kind, text: kind === "approval" || kind === "question" ? askingText(text, best.at) : "" };
}

/** The new screen state; keeps the time while the screen still shows the same. */
export function nextScreen(prev: Screen | null | undefined, rawTail: string, now: number): Screen {
  const c = classify(rawTail);
  return prev && prev.kind === c.kind && prev.text === c.text ? prev : { ...c, at: now };
}
