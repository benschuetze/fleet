import { shortDate } from "../../shared/dates";
import type { Timeline } from "../../shared/types";
/** Numbers, money, tokens and times in the dashboard's language. */

export function money(v: number, locale: string): string {
  const n = v || 0;
  const s =
    n >= 1000
      ? Math.round(n).toLocaleString(locale)
      : n >= 100
        ? n.toFixed(0)
        : n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s} $`;
}

export function toks(v: number, locale: string): string {
  const n = Number(v) || 0;
  const de = locale.startsWith("de");
  if (n >= 1e9) return `${(n / 1e9).toLocaleString(locale, { maximumFractionDigits: 1 })} ${de ? "Mrd." : "B"}`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString(locale, { maximumFractionDigits: 1 })} ${de ? "Mio." : "M"}`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString(locale)} ${de ? "Tsd." : "k"}`;
  return String(Math.round(n));
}

/** A balance with its sign: "+1,3 Mio.", "−120 Tsd." (a real minus), "0". */
export function signedToks(v: number, locale: string): string {
  const n = Math.round(Number(v) || 0);
  if (!n) return "0";
  return `${n > 0 ? "+" : "−"}${toks(Math.abs(n), locale)}`;
}

/**
 * "12 Min", "2 Std 55 Min", "2 T" / "12 min", "2 h 55 min", "2 d". Whole units gone by, like `duration` (round 3: 9 vs
 * 8 min), and the minutes stay beside the hours like in every other time (round 8: 2 h 55 min read "2 Std").
 */
export function ago(t: number | null | undefined, locale: string): string {
  if (!t) return "–";
  const de = locale.startsWith("de");
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return de ? "gerade" : "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} ${de ? "Min" : "min"}`;
  if (s < 86400) return duration(s * 1000, locale);
  return `${Math.floor(s / 86400)} ${de ? "T" : "d"}`;
}

export const clock = (t: number, locale: string) =>
  new Date(t).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

export function until(ms: number, locale: string): string {
  const de = locale.startsWith("de");
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `${m} ${de ? "Min" : "min"}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${de ? "Std" : "h"} ${m % 60} ${de ? "Min" : "min"}`;
  return `${Math.round(h / 24)} ${de ? "T" : "d"}`;
}

export const duration = (ms: number, locale: string) => {
  const de = locale.startsWith("de");
  const m = Math.max(0, Math.floor(ms / 60e3));
  return m < 60
    ? `${m} ${de ? "Min" : "min"}`
    : `${Math.floor(m / 60)} ${de ? "Std" : "h"} ${m % 60} ${de ? "Min" : "min"}`;
};

/**
 * A row's age on the board, short like kubectl's AGE and ticking every second in the first hour (spec rule 16: the
 * age column is what lives on the screen): `45s`, `3m07s`, `2h05m`, `3T` (`3d` in English).
 */
export function age(ms: number, locale: string): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}${locale.startsWith("de") ? "T" : "d"}`;
}

export const mmss = (ms: number) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * A share 0..100 as a bar of block characters (spec, "Vorbilder": `███░░░░ 42 %` like btop), always `cells` wide.
 * Anything above zero shows at least one full cell, anything below 100 leaves at least one empty: the bar never
 * says "empty" or "full" when it is not.
 */
export function charBar(share: number, cells = 7): string {
  const p = Math.max(0, Math.min(100, Number(share) || 0));
  const full = p <= 0 ? 0 : p >= 100 ? cells : Math.min(cells - 1, Math.max(1, Math.round((p / 100) * cells)));
  return "█".repeat(full) + "░".repeat(cells - full);
}

/** Share 0..1 as "94 %" ('' without a value). */
export const pct = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)} %` : "";

const dayDate = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, dd ?? 1);
};
export const dayLabel = (d: string, locale: string) => shortDate(dayDate(d), locale);
export const weekdayLabel = (d: string, locale: string) => shortDate(dayDate(d), locale, true);

/** "Tokens" in German, "tokens" in English running text (headings and column heads keep their capital). */
export const tokenWord = (locale: string) => (locale.startsWith("de") ? "Tokens" : "tokens");

/** Rounds a chart maximum up to 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/**
 * A path with the home folder as "~" (macOS, Linux, Windows). The browser does not know the home folder, so it is
 * recognised by its usual place; anything else stays as it is.
 */
export function tildify(p: string | null | undefined): string {
  const s = String(p || "");
  return s.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, "~");
}

/** Only http(s) links (no javascript:, data: …): some values come from foreign APIs. */
export function safeUrl(u: unknown): string | null {
  try {
    const x = new URL(String(u));
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

/**
 * Minutes waited for you, per shown lane and in all, so that the header is exactly the lanes plus the rest (practical
 * test 15 Oct: 323 min in the header, 306 in the lanes). The rest is time of sessions in no shown lane.
 */
export function waitMinutes(tl: Pick<Timeline, "lanes" | "totals">): { lanes: number[]; rest: number; total: number } {
  const lanes = tl.lanes.map((l) => Math.round(l.attention / 60e3));
  const shown = tl.lanes.reduce((acc, l) => acc + l.attention, 0);
  const rest = Math.max(0, Math.round((tl.totals.attention - shown) / 60e3));
  return { lanes, rest, total: lanes.reduce((a, b) => a + b, 0) + rest };
}
