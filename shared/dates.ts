/**
 * Dates for the dashboard and for the texts the server writes, in one place (round 8: English "10/10, 16/10" reads as
 * day/month or month/day, whichever the reader expects). German stays "16.10."; English spells the month: "16 Oct".
 * A date is always shown without a year unless it is the full form for a tooltip.
 */
const isDe = (locale: string) => locale.startsWith("de");
const clockOpts = { hour: "2-digit", minute: "2-digit" } as const;

/** "16.10." / "16 Oct"; with `weekday` "Fr., 16.10." / "Fri 16 Oct". */
export function shortDate(ts: number | Date, locale: string, weekday = false): string {
  const d = new Date(ts);
  const w = weekday ? ({ weekday: "short" } as const) : {};
  return d.toLocaleDateString(
    locale,
    isDe(locale) ? { ...w, day: "2-digit", month: "2-digit" } : { ...w, day: "numeric", month: "short" },
  );
}

/** "16.10., 06:43" / "16 Oct, 06:43": a date with the time of day. */
export function dateTime(ts: number | Date, locale: string, weekday = false): string {
  return `${shortDate(ts, locale, weekday)}, ${new Date(ts).toLocaleTimeString(locale, clockOpts)}`;
}

/** The long form for tooltips: with year and seconds. German keeps the platform's form, English spells the month. */
export function dateTimeFull(ts: number | Date, locale: string): string {
  const d = new Date(ts);
  return isDe(locale)
    ? d.toLocaleString(locale)
    : d.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", ...clockOpts, second: "2-digit" });
}
