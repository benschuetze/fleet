import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours come from the tokens (tokens.css), read at run time, so the pane follows light and dark
 * like the rest of the page. The ANSI palette stays xterm's own: those colours belong to the program's output.
 */
export function xtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    background: v("--bg-1"),
    foreground: v("--text-1"),
    cursor: v("--text-1"),
    cursorAccent: v("--bg-1"),
    selectionBackground: v("--sel"),
    selectionForeground: v("--bg-0"),
  };
}

export const monoFont = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--font").trim() ||
  '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
