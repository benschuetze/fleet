import { money, signedToks, weekdayLabel } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import type { Balance, FleetTurnKind } from "../../../shared/types";
import { Card } from "../views";

type T = (de: string, en: string) => string;

const KIND: Record<FleetTurnKind, (t: T) => string> = {
  handoff: (t) => t("Übergaben schreiben", "Writing handoffs"),
  job: (t) => t("Fleet-Jobs (headless)", "Fleet jobs (headless)"),
  continue: (t) => t("Weitermachen, erster Turn", "Continuing, first turn"),
  merge: (t) => t("Zusammenfassen, erster Turn", "Merging, first turn"),
  fix: (t) => t("Fix-Sessions, erster Turn", "Fix sessions, first turn"),
  brief: (t) => t("Projekt-Briefing, erster Turn", "Project briefing, first turn"),
};

/**
 * Does Fleet save more than it costs? Seven days, tokens first (they are what the limit counts), dollars grey as the
 * second number. Every row comes from realised calls; what cannot be measured is named, not numbered.
 */
export function BalanceCard({ b }: { b: Balance }) {
  const { t, locale } = useI18n();
  const max = Math.max(1, ...b.daily.map((d) => Math.max(d.cost, d.saved)));
  const kinds = (Object.keys(KIND) as FleetTurnKind[]).filter((k) => b.cost.byKind[k]?.n);
  const usd = (v: number) => <span className="hint"> · {money(v, locale)}</span>;
  return (
    <Card
      id="balance"
      title={t("Fleet-Bilanz, 7 Tage", "Fleet balance, 7 days")}
      aside={
        <span className="hint" style={{ marginLeft: "auto" }}>
          {t("Schätzung, nur realisierte Aufrufe", "estimate, realised calls only")}
        </span>
      }
    >
      <div className="meter bal-card">
        <div className="bal-figs">
          <div>
            <div className="hint">{t("gekostet", "spent")}</div>
            <div className="big">{signedToks(-b.cost.tok, locale)}</div>
            <div className="line">
              {b.cost.n} {t("Turns", "turns")}
              {usd(b.cost.cost)}
            </div>
          </div>
          <div>
            <div className="hint">{t("gespart", "saved")}</div>
            <div className="big">{signedToks(b.saved.tok, locale)}</div>
            <div className="line">
              {b.saved.n} {t("Nachfolger", "successors")}
              {usd(b.saved.cost)}
            </div>
          </div>
          <div>
            <div className="hint">{t("Bilanz", "Balance")}</div>
            <div className={`big ${b.net.tok < 0 ? "bal-neg" : ""}`}>{signedToks(b.net.tok, locale)}</div>
            <div className="line">Tokens{usd(b.net.cost)}</div>
          </div>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable) */}
        <section className="tablewrap" aria-label={t("Maßnahmen", "Measures")} tabIndex={0}>
          <table className="bal-table">
            <thead>
              <tr>
                <th className="px">{t("Maßnahme", "Measure")}</th>
                <th className="px" style={{ textAlign: "right" }}>
                  {t("Anzahl", "Count")}
                </th>
                <th className="px" style={{ textAlign: "right" }}>
                  Tokens
                </th>
                <th className="px m-hide" style={{ textAlign: "right" }}>
                  $
                </th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => {
                const v = b.cost.byKind[k];
                return v ? (
                  <tr key={k}>
                    <td>{KIND[k](t)}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {v.n}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {signedToks(-v.tok, locale)}
                    </td>
                    <td className="num hint m-hide" style={{ textAlign: "right" }}>
                      {money(v.cost, locale)}
                    </td>
                  </tr>
                ) : null;
              })}
              <tr>
                <td
                  title={t(
                    "Tokens pro Aufruf alt − neu, je tatsächlichem Aufruf",
                    "Tokens per call old − new, per realised call",
                  )}
                >
                  {t("Frisch gestartet", "Started fresh")}
                  <div className="hint">
                    {b.saved.fresh.calls} {t("Aufrufe der Nachfolger", "calls of the successors")}
                  </div>
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {b.saved.fresh.n}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {signedToks(b.saved.fresh.tok, locale)}
                </td>
                <td className="num hint m-hide" style={{ textAlign: "right" }}>
                  {money(b.saved.fresh.cost, locale)}
                </td>
              </tr>
              <tr>
                <td
                  title={t("verglichen mit der kleinsten Vorgängersession", "compared with the smallest predecessor")}
                >
                  {t("Zusammengefasst", "Merged")}
                  <div className="hint">
                    {b.saved.merge.calls} {t("Aufrufe", "calls")}
                  </div>
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {b.saved.merge.n}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {signedToks(b.saved.merge.tok, locale)}
                </td>
                <td className="num hint m-hide" style={{ textAlign: "right" }}>
                  {money(b.saved.merge.cost, locale)}
                </td>
              </tr>
              <tr>
                <td
                  title={t(
                    "Der Cache der alten Session war nach der Pause abgelaufen. Die Tokens sind oben schon gezählt; teurer wäre nur das Neuschreiben.",
                    "The old session's cache had expired after the pause. The tokens are counted above already; only rewriting would have cost more.",
                  )}
                >
                  {t("Vermiedene Cache-Neuschreibungen", "Avoided cache rewrites")}
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {b.saved.rebuild.n}
                </td>
                <td className="num hint" style={{ textAlign: "right" }}>
                  –
                </td>
                <td className="num hint m-hide" style={{ textAlign: "right" }}>
                  {money(b.saved.rebuild.cost, locale)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        {b.vsCompact?.n > 0 && (
          <p className="line" data-testid="bal-compact">
            {t(
              `Gegen /compact an denselben ${b.vsCompact.n} Stellen: /compact ≈ ${money(b.vsCompact.compact, locale)}, Übergaben schreiben ${money(b.vsCompact.fleet, locale)} → `,
              `Against /compact at the same ${b.vsCompact.n} points: /compact ≈ ${money(b.vsCompact.compact, locale)}, writing the handoffs ${money(b.vsCompact.fleet, locale)} → `,
            )}
            <span className={b.vsCompact.net < 0 ? "bal-neg" : ""}>
              {b.vsCompact.net >= 0 ? "+" : "−"}
              {money(Math.abs(b.vsCompact.net), locale)}
            </span>
            <span className="hint">
              {t(" · Wochen: node dist/fleet.cjs balance", " · weeks: node dist/fleet.cjs balance")}
            </span>
          </p>
        )}
        <ul
          className="bal-days"
          aria-label={t("Tokens pro Tag: gekostet und gespart", "Tokens per day: spent and saved")}
        >
          {b.daily.map((d) => (
            <li
              key={d.day}
              title={`${weekdayLabel(d.day, locale)}: ${signedToks(-d.cost, locale)} ${t("gekostet", "spent")} · ${signedToks(d.saved, locale)} ${t("gespart", "saved")}`}
            >
              <span className="bal-day">{weekdayLabel(d.day, locale)}</span>
              <span className="bal-bars" aria-hidden="true">
                <span className="bal-c" style={{ width: `${(100 * d.cost) / max}%` }} />
                <span className="bal-s" style={{ width: `${(100 * d.saved) / max}%` }} />
              </span>
              <span className="sr">
                {signedToks(-d.cost, locale)} {t("gekostet", "spent")}, {signedToks(d.saved, locale)}{" "}
                {t("gespart", "saved")}
              </span>
            </li>
          ))}
        </ul>
        <p className="line hint">
          {t(
            "Die Ersparnis ist eine Schätzung gegen einen nicht eingetretenen Fall: so viele Tokens hätte die alte Session bei denselben Aufrufen gelesen. Gekostet zählt jeder Turn, den Fleet ausgelöst hat; bei Sessions, die Fleet gestartet hat, nur der erste. Nicht gemessen: Haiku statt Opus, Bremse, gestoppte Schleifen, weniger Kontextverlust und Fehlversuche.",
            "The saving is an estimate against a case that did not happen: this many tokens the old session would have read for the same calls. Spent counts every turn Fleet caused; for sessions Fleet started only the first. Not measured: Haiku instead of Opus, the brake, stopped loops, less lost context and fewer failed attempts.",
          )}
        </p>
        {b.unmatched > 0 && (
          <p className="line hint">
            {t(
              `${b.unmatched} Nachfolger ohne Vergleichswert (Vorgänger älter als der Zeitraum) – nicht gezählt.`,
              `${b.unmatched} successor(s) without a comparison (predecessor older than the period): not counted.`,
            )}
          </p>
        )}
        {b.incomplete && (
          <p className="line bal-warn">
            {t(
              "Bilanz unvollständig: Fleet-Jobs liefen, aber die Hooks fehlen – Übergaben und erste Turns sind nicht gezählt. Hooks einrichten: node dist/fleet.cjs install-hooks.",
              "Balance incomplete: Fleet jobs ran but the hooks are missing, so handoffs and first turns are not counted. Set up hooks: node dist/fleet.cjs install-hooks.",
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
