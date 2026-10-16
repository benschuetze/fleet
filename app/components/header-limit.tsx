import { Link } from "react-router";
import { charBar, clock, money, signedToks, tokenWord, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useNow } from "~/lib/use-now";
import { shortDate } from "../../shared/dates";
import { limitStale, windowOver } from "../../shared/limits";
import type { LimitWindow, Overview } from "../../shared/types";

type T = (de: string, en: string) => string;

const day = (ts: number, locale: string) =>
  ts - Date.now() < 20 * 3600e3 ? clock(ts, locale) : shortDate(ts, locale, true);

const windowName = (k: "five_hour" | "seven_day", t: T) =>
  k === "seven_day" ? t("Wochenlimit", "Weekly limit") : t("5-Stunden-Limit", "Five-hour limit");

/**
 * The limit in the header, only what is certain: the binding window from the status line as a bar with percent
 * and reset (the higher of five hours and week: only that one decides), or the hit Claude Code reported. Sessions
 * that keep working past it run on extra usage; that is said, with the tokens since the hit when they are known.
 * Without any limit value: tokens today (plan) or dollars today (API).
 */
export function LimitChip({ data }: { data: Overview }) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const u = data.usage;
  const L = u?.limits;
  const pick: { k: "five_hour" | "seven_day"; w: LimitWindow }[] = [];
  let expired = false;
  for (const k of ["five_hour", "seven_day"] as const) {
    const w = L?.[k];
    if (w && typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage)) {
      // A window past its reset keeps no old percentage on the screen (round 8).
      if (windowOver(w, now)) expired = true;
      else pick.push({ k, w });
    }
  }
  const bind = pick.sort((a, b) => b.w.used_percentage - a.w.used_percentage)[0];
  const hit = u?.limitHit;
  const working = data.sessions.some((s) => s.status === "working" && !s.meta?.hidden);
  const over = u?.overage;
  const credit = over
    ? `${t("läuft über Guthaben", "running on extra usage")} · ${toks(over.tok, locale)} ${tokenWord(locale)} ${t("seit", "since")} ${clock(over.since, locale)}`
    : t("läuft über Guthaben", "running on extra usage");

  if (hit && !bind) {
    const tip = `${windowName(hit.kind, t)} ${t("erreicht, wieder frei", "reached, free again")} ${day(hit.resetsAt, locale)}${over ? ` · ${credit}` : ""} – ${t("zum Verbrauch", "go to usage")}`;
    return (
      <Link className="hd-c hd-hot" to="/usage" title={tip}>
        <b>{hit.kind === "seven_day" ? t("Woche", "Week") : "Limit"}</b>
        <span className="rs">
          {t("frei", "free")} {day(hit.resetsAt, locale)}
        </span>
        {over && <span className="rs">{credit}</span>}
        <span className="sr">{tip}</span>
      </Link>
    );
  }
  if (bind) {
    const pct = Math.max(0, Math.round(bind.w.used_percentage));
    const reset = typeof bind.w.resets_at === "number" ? bind.w.resets_at * 1000 : null;
    const label = bind.k === "seven_day" ? t("Woche", "Week") : "5h";
    // Both windows in the tooltip; the header shows the one that binds.
    const both = pick
      .map(
        ({ k, w }) =>
          `${windowName(k, t)} ${Math.round(w.used_percentage)} %${w.resets_at ? `, Reset ${day(w.resets_at * 1000, locale)}` : ""}`,
      )
      .join(" · ");
    const running = pct >= 100 && working;
    // An old status line says only "at least": the app writes none, a CLI session refreshes it.
    const stale = limitStale(L?.at, now) && L?.at ? L.at : 0;
    const asOf = stale
      ? ` · ${t(`Stand ${clock(stale, locale)}: seitdem kann es nur mehr geworden sein (die Desktop-App meldet kein Limit, erst die nächste Statuszeile einer CLI-Session)`, `as of ${clock(stale, locale)}: it can only have grown since (the desktop app reports no limit, only the next status line of a CLI session does)`)}`
      : "";
    return (
      <Link
        className={`hd-c${pct >= 80 ? " hd-hot" : ""}`}
        to="/usage"
        title={`${both}${asOf}${running ? ` · ${credit}` : ""} – ${t("zum Verbrauch", "go to usage")}`}
      >
        <span aria-hidden="true">{label}</span>
        <span className="sr">{windowName(bind.k, t)}</span>
        {/* A character bar like the context column (rule 7, btop); from 80 % brighter grey, a threshold. */}
        <span
          className="hd-bar"
          role="progressbar"
          aria-label={windowName(bind.k, t)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, pct)}
        >
          {charBar(pct, 12)}
        </span>
        <b>
          {stale ? "≥" : ""}
          {pct} %
        </b>
        {reset ? (
          <span>
            {t("bis", "until")} {day(reset, locale)}
          </span>
        ) : null}
        {running && <span>{credit}</span>}
      </Link>
    );
  }
  if (expired) {
    const tip = t(
      "Reset vorbei, wartet auf neue Statuszeile. Der alte Prozentwert gilt nicht mehr.",
      "Reset passed, waiting for a new status line. The old percentage no longer applies.",
    );
    return (
      <Link className="hd-c" to="/usage" title={`${tip} – ${t("zum Verbrauch", "go to usage")}`}>
        <span>Limit</span>
        <span>{t("Reset vorbei", "reset passed")}</span>
        <span className="sr">{tip}</span>
      </Link>
    );
  }
  const today = u?.totals?.today;
  if (!today?.n) return null;
  return (
    <Link className="hd-c" to="/usage" title={t("Zum Verbrauch", "Go to usage")}>
      <b>
        {data.billing === "api"
          ? `${today.cost.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`
          : toks(today.tok, locale)}
      </b>
      {data.billing === "api" ? t("heute", "today") : t("Tokens heute", "tokens today")}
    </Link>
  );
}

/**
 * "Fleet 7 T +1,3 Mio.": does Fleet save more than it costs? The three numbers and the method are in the tooltip;
 * the saving is an estimate against a case that did not happen, and that is written next to it.
 */
export function BalanceChip({ data }: { data: Overview }) {
  const { t, locale } = useI18n();
  const b = data.usage?.balance;
  if (!b || !Number.isFinite(b.net.tok)) return null;
  const api = data.billing === "api";
  const tip = [
    `${t("Fleet, 7 Tage", "Fleet, 7 days")}: ${signedToks(-b.cost.tok, locale)} ${t("gekostet", "spent")} · ${signedToks(b.saved.tok, locale)} ${t("gespart", "saved")} · ${t("Bilanz", "balance")} ${signedToks(b.net.tok, locale)} ${tokenWord(locale)}${api ? ` (${money(b.net.cost, locale)})` : ""}.`,
    t(
      "Gekostet: jeder Turn, den Fleet ausgelöst hat (Übergaben, Jobs, erster Turn neuer Sessions). Gespart: (Tokens pro Aufruf alt − neu) × tatsächliche Aufrufe der Nachfolgesession.",
      "Spent: every turn Fleet caused (handoffs, jobs, the first turn of new sessions). Saved: (tokens per call old − new) × realised calls of the successor.",
    ),
    t(
      "Die Ersparnis ist eine Schätzung gegen einen nicht eingetretenen Fall.",
      "The saving is an estimate against a case that did not happen.",
    ),
    b.incomplete ? t("Unvollständig: Hooks fehlen.", "Incomplete: hooks missing.") : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // One line has room for the balance only (plan 3.1); spent and saved are in the tooltip and on "Usage".
    <Link className={`hd-c${b.net.tok < 0 ? " hd-hot" : ""}`} to="/usage#balance" title={tip}>
      <span>{t("Fleet 7 T", "Fleet 7 d")}</span>
      <b>{signedToks(b.net.tok, locale)}</b>
      <span className="sr">{tip}</span>
    </Link>
  );
}
