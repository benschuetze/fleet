import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useNow } from "~/lib/use-now";
import { inbox } from "../../../shared/inbox";
import { limitStale, windowOver } from "../../../shared/limits";
import type { Overview } from "../../../shared/types";

/**
 * The five-hour limit in one line, only when Claude Code reported a percentage: use, reset and whether the pace
 * lasts until then. The projection only runs while a session works.
 */
export function LimitLine({ data }: { data: Overview }) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const w = data.usage?.limits?.five_hour;
  if (!w || typeof w.used_percentage !== "number") return null;
  // Past its reset the old percentage says nothing (round 8): the line waits for the next status line.
  if (windowOver(w, now))
    return (
      <div className="lim">
        <div className="row">
          <span>{t("5-Stunden-Limit", "Five-hour limit")}</span>
        </div>
        <div className="note">
          {t("Reset vorbei, wartet auf neue Statuszeile", "Reset passed, waiting for a new status line")}
        </div>
      </div>
    );
  const pct = Math.max(0, Math.min(100, w.used_percentage));
  // An old status line is a floor: no projection from it (16.10.2026).
  const stale = limitStale(data.usage?.limits?.at, now);
  const reset = w.resets_at ? w.resets_at * 1000 : 0;
  const startT = reset ? reset - 5 * 3600e3 : 0;
  const el = startT ? Math.max(1, now - startT) : 0;
  const atEnd = el && !stale && inbox(data).counts.working ? (pct * (5 * 3600e3)) / el : 0;
  const runsOut = atEnd > 100 && reset ? startT + (el * 100) / pct : 0;
  const lvl = pct >= 90 ? "c" : pct >= 80 ? "w" : "";
  const auto = data.autoHandoff.enabled ? data.autoHandoff.limitPercent : 0;
  const note =
    pct >= 99
      ? `${t("Limit erreicht", "Limit reached")}${reset ? ` – ${t("wieder frei um", "free again at")} ${clock(reset, locale)}` : ""}${auto ? ` · ${t("offene Sessions schreiben ihre Übergabe", "open sessions write their handoff")}` : ""}`
      : `${reset ? `Reset ${clock(reset, locale)}` : ""}${
          runsOut
            ? ` · ${t("beim jetzigen Tempo leer um ca.", "empty at this pace around")} ${clock(runsOut, locale)}${auto ? ` – ${t(`Übergabe ab ${auto} % automatisch`, `handoff from ${auto} % automatically`)}` : ""}`
            : atEnd
              ? ` · ${t("reicht beim jetzigen Tempo", "lasts at this pace")} (${t("Prognose", "projection")} ${Math.round(atEnd)} %)`
              : ""
        }`;
  return (
    <div className="lim">
      <div className="row">
        <span>{t("5-Stunden-Limit", "Five-hour limit")}</span>
        <b>
          {stale ? "≥ " : ""}
          {Math.round(pct)} %
        </b>
      </div>
      <div
        className="track"
        role="progressbar"
        aria-label={t("5-Stunden-Limit", "Five-hour limit")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <i className={lvl} style={{ width: `${pct}%` }} />
        {atEnd > 0 && atEnd <= 100 && (
          <span
            className="fc"
            style={{ left: `${atEnd}%` }}
            title={t("Prognose bis zum Reset", "Projection until the reset")}
          />
        )}
      </div>
      <div className={`note ${runsOut || pct >= 99 ? "w" : ""}`}>{note}</div>
    </div>
  );
}
