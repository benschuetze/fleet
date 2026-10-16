import { useState } from "react";
import { Ledger } from "~/components/activity/ledger";
import { LimitLine } from "~/components/activity/limit-line";
import { PulseChart } from "~/components/activity/pulse-chart";
import { TimelineView } from "~/components/activity/timeline";
import { Card } from "~/components/views";
import { useFleet } from "~/lib/fleet";
import { money, toks, waitMinutes } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import type { Overview } from "../../shared/types";

/**
 * Activity: for looking things up, not for running things. The pulse of the last hour, a timeline per repo of the
 * last three hours, the event history a page at a time, and the week report to take away.
 */
export default function Activity() {
  const { t } = useI18n();
  const { data, query } = useFleet();
  // A repo picked in the timeline filters the history.
  const [repo, setRepo] = useState<string | null>(null);
  if (!data) return null;
  return (
    <div className="uview">
      <h1 className="sr">{t("Aktivität", "Activity")}</h1>
      <Deck data={data} repo={repo} onRepo={setRepo} />
      <Card title={t("Verlauf", "History")} aside={<ReportLinks />}>
        <Ledger key={`${repo}|${query}`} repo={repo} onRepo={setRepo} />
      </Card>
    </div>
  );
}

/** The week report as a file: Markdown to hand to a Claude session, JSON for tools. Under 5,000 tokens each. */
function ReportLinks() {
  const { t } = useI18n();
  const hint = t(
    "Sessions nach Repo und Status, häufigste Alarme, liegengebliebene PRs, Cache-Neuschreibungen, Haiku-Kandidaten und Doppelt-Fälle der letzten 7 Tage, unter 5.000 Tokens",
    "Sessions by repo and status, most frequent alarms, stale PRs, cache rebuilds, Haiku candidates and duplicates of the last 7 days, under 5,000 tokens",
  );
  return (
    <span className="report-links" title={hint}>
      {t("Wochenbericht exportieren:", "Export week report:")}{" "}
      <a className="link" href="/api/report/week?format=md" download>
        Markdown
      </a>{" "}
      ·{" "}
      <a className="link" href="/api/report/week?format=json" download>
        JSON
      </a>
    </span>
  );
}

/** Tokens per minute of the last 5 minutes (the running minute does not count yet). */
const rate = (arr: number[] | undefined, n = 5) => {
  if (!arr) return 0;
  const a = arr.slice(-n - 1, -1);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
};

function Deck({ data, repo, onRepo }: { data: Overview; repo: string | null; onRepo: (key: string | null) => void }) {
  const { t, locale } = useI18n();
  const dollars = data.billing === "api";
  const all = data.usage?.live ? Object.values(data.usage.live.bySession) : [];
  const tokNow = all.reduce((a, l) => a + rate(l.tok), 0);
  const costNow = all.reduce((a, l) => a + rate(l.cost), 0);
  const hourTok = all.reduce((a, l) => a + l.tok.reduce((x, y) => x + y, 0), 0);
  const hourCost = all.reduce((a, l) => a + l.cost.reduce((x, y) => x + y, 0), 0);
  const waitMin = data.timeline ? waitMinutes(data.timeline).total : 0;
  return (
    <div className="deck">
      <section className="panel" aria-label={t("Puls", "Pulse")}>
        <h3>
          {t("Puls", "Pulse")}{" "}
          <span className="hint">{t("Tokens pro Minute, letzte Stunde", "tokens per minute, last hour")}</span>
        </h3>
        <div className="deck-top">
          <div className="kpis">
            <div className="kpi">
              <div className="v">
                {toks(tokNow, locale)}
                <small>/{t("Min", "min")}</small>
              </div>
              <div className="l">
                {t("Verbrauch gerade (Schnitt 5 Min)", "Using now (5 min average)")}
                {dollars && ` · ${money(costNow * 60, locale)}/${t("Std", "h")}`}
              </div>
            </div>
            <div className="kpi">
              <div className="v">{toks(hourTok, locale)}</div>
              <div className="l">
                {t("letzte Stunde", "last hour")}
                {dollars && ` · ${money(hourCost, locale)}`}
              </div>
            </div>
            <div className="kpi">
              <div className={`v ${waitMin >= 15 ? "w" : ""}`}>
                {waitMin} <small>{t("Min", "min")}</small>
              </div>
              {/* Round 5: 501 min "in 3 h" read as wrong; it is the sum over all sessions, as the lanes add up. */}
              <div className="l">
                {t("auf dich gewartet, alle Sessions zusammen (3 Std)", "waited for you, all sessions together (3 h)")}
              </div>
            </div>
          </div>
          <LimitLine data={data} />
        </div>
        <PulseChart data={data} />
      </section>
      <section className="panel" aria-label={t("Zeitleiste je Repo", "Timeline per repo")}>
        <h3>
          {t("Zeitleiste je Repo", "Timeline per repo")}{" "}
          <span className="hint">{t("letzte 3 Stunden", "last 3 hours")}</span>
        </h3>
        <TimelineView data={data} repo={repo} onRepo={onRepo} />
      </section>
    </div>
  );
}
