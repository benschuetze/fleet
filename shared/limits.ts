import type { LimitWindow } from "./types";

/**
 * A limit window whose reset time has passed says nothing about now (round 8: "Reset in 0 min · 06:00" at 06:43, still
 * 58 %). The percentage was true for the old window; the new one is unknown until the next status line reports it.
 * Fleet shows no number then, and never a guess (README, "Only certain numbers").
 */
/**
 * The status line that carried the limits is older than this: its percentage is only a floor, since use within a
 * window never goes down. Claude Code writes it only while a CLI session runs; the desktop app writes none (live
 * 16.10.2026: "56 %" from 00:00 shown at 09:20 while the app said 86 %).
 */
export const LIMIT_FRESH_MS = 30 * 60e3;
export const limitStale = (at: number | null | undefined, now: number): boolean =>
  typeof at === "number" && at > 0 && now - at > LIMIT_FRESH_MS;

export const windowOver = (w: Pick<LimitWindow, "resets_at"> | null | undefined, now: number): boolean =>
  typeof w?.resets_at === "number" && w.resets_at > 0 && w.resets_at * 1000 <= now;
