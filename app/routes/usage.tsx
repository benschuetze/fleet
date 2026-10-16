import { useState } from "react";
import { ADV_TONE, adviceShort } from "~/components/session/bits";
import { Tag } from "~/components/tag";
import { BalanceCard } from "~/components/usage/balance";
import { DayChart, type Series } from "~/components/usage/day-chart";
import { Limits } from "~/components/usage/limits";
import { Card } from "~/components/views";
import { useFleet } from "~/lib/fleet";
import { ago, money, pct, toks, weekdayLabel } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { lineProps } from "~/lib/rows";
import { load, save } from "~/lib/store";
import { useLastActive, useStatus } from "~/lib/use-status";
import type { Session, Usage } from "../../shared/types";

const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];

/** Builds the stacked series: colour follows the entry, ordered by its total over the whole period (stable when switching 14/30 days). */
function series(u: Usage, group: "model" | "project", metric: "cost" | "tok", range: number, other: string): Series {
  const key = group === "project" ? "byProject" : "byModel";
  const tot: Record<string, number> = {};
  for (const d of u.days) for (const [k, v] of Object.entries(d[key])) tot[k] = (tot[k] || 0) + v[metric];
  const names = Object.keys(tot)
    .filter((k) => (tot[k] ?? 0) > 0)
    .sort((a, b) => (tot[b] ?? 0) - (tot[a] ?? 0));
  const top = names.length > 5 ? names.slice(0, 4) : names;
  const list = top.map((name, i) => ({ name, color: COLORS[i] as string, rest: false }));
  if (names.length > top.length) list.push({ name: other, color: "var(--s-other)", rest: true });
  const days = u.days.slice(-range).map((d) => {
    const vals = list.map((s) =>
      s.rest
        ? Object.entries(d[key])
            .filter(([k]) => !top.includes(k))
            .reduce((a, [, v]) => a + v[metric], 0)
        : d[key][s.name]?.[metric] || 0,
    );
    return { day: d.day, vals, total: vals.reduce((a, b) => a + b, 0) };
  });
  return { series: list, days };
}

/** Usage: limits, tokens or cost per day, where tokens are lost, the most expensive sessions. */
export default function UsagePage() {
  const { t, locale } = useI18n();
  const statusOf = useStatus();
  const lastOf = useLastActive();
  const { data } = useFleet();
  // A choice made here wins; without one, a plan starts with tokens and API billing with dollars.
  const [chosen, setMetric] = useState<"cost" | "tok" | null>(() => {
    const m = load<string>("uMetric");
    return m === "tok" || m === "cost" ? m : null;
  });
  const api = data?.billing === "api";
  const metric = chosen ?? (api ? "cost" : "tok");
  const [group, setGroup] = useState<"model" | "project">(() =>
    load<string>("uGroup") === "project" ? "project" : "model",
  );
  const [range, setRange] = useState<14 | 30>(() => (load<number>("uRange") === 30 ? 30 : 14));
  const [table, setTable] = useState(false);
  if (!data) return null;
  const u = data.usage;
  if (!u?.hasData) {
    return (
      <div className="uview">
        <h1 className="sr">{t("Verbrauch", "Usage")}</h1>
        {u && <Limits data={data} u={u} />}
        <div className="card empty">
          {t("Noch keine Verbrauchsdaten.", "No usage data yet.")}
          <br />
          <span className="hint">
            {t(
              "Sie erscheinen, sobald Claude-Code- oder Cowork-Sessions laufen.",
              "It appears once Claude Code or Cowork sessions run.",
            )}
          </span>
        </div>
      </div>
    );
  }
  const S = series(u, group, metric, range, t("Andere", "Other"));
  const sums = S.series.map((_, j) => S.days.reduce((a, d) => a + (d.vals[j] || 0), 0));
  const fmt = (v: number) => (metric === "cost" ? money(v, locale) : toks(v, locale));
  const seg = <V extends string | number>(value: V, current: V, set: (v: V) => void, key: string, label: string) => (
    <button
      type="button"
      className={current === value ? "on" : ""}
      aria-pressed={current === value}
      onClick={() => {
        set(value);
        save(key, value);
      }}
    >
      {label}
    </button>
  );
  const top = data.sessions
    .filter((s): s is Session & { usage: NonNullable<Session["usage"]> } => !!s.usage && s.usage.cost > 0)
    .sort((a, b) => (api ? b.usage.cost - a.usage.cost : b.usage.tok - a.usage.tok))
    .slice(0, 8);
  const topTitle = api ? t("Teuerste Sessions", "Most expensive sessions") : t("Größte Sessions", "Largest sessions");
  return (
    <div className="uview">
      <h1 className="sr">{t("Verbrauch", "Usage")}</h1>
      <Limits data={data} u={u} />
      {u.balance && <BalanceCard b={u.balance} />}
      <Card
        title={metric === "cost" ? t("Kosten pro Tag", "Cost per day") : t("Tokens pro Tag", "Tokens per day")}
        aside={
          <span className="hint" style={{ marginLeft: "auto" }}>
            {metric === "cost"
              ? t("Listenpreise (Schätzung)", "list prices (estimate)")
              : t("Input + Output + Cache-Schreiben", "input + output + cache writes")}
          </span>
        }
      >
        <div className="ctrls">
          <fieldset className="seg" aria-label={t("Größe", "Measure")}>
            {seg("cost", metric, setMetric, "uMetric", t("Kosten", "Cost"))}
            {seg("tok", metric, setMetric, "uMetric", "Tokens")}
          </fieldset>
          <fieldset className="seg" aria-label={t("Aufteilung", "Split")}>
            {seg("model", group, setGroup, "uGroup", t("nach Modell", "by model"))}
            {seg("project", group, setGroup, "uGroup", t("nach Projekt", "by project"))}
          </fieldset>
          <fieldset className="seg" aria-label={t("Zeitraum", "Period")}>
            {seg<14 | 30>(14, range, setRange, "uRange", t("14 Tage", "14 days"))}
            {seg<14 | 30>(30, range, setRange, "uRange", t("30 Tage", "30 days"))}
          </fieldset>
          <button type="button" className="ghost" style={{ marginLeft: "auto" }} onClick={() => setTable(!table)}>
            {table ? t("Diagramm", "Chart") : t("Tabelle", "Table")}
          </button>
        </div>
        <div className="legend">
          {S.series.map((s, j) =>
            (sums[j] ?? 0) > 0 ? (
              <span key={s.name}>
                <i style={{ background: s.color }} />
                {s.name} <b className="num">{fmt(sums[j] ?? 0)}</b>
              </span>
            ) : null,
          )}
        </div>
        {table ? (
          <section
            className="tablewrap"
            aria-label={t("Werte pro Tag", "Values per day")}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable)
            tabIndex={0}
            style={{ padding: "0 18px 14px" }}
          >
            <table>
              <thead>
                <tr>
                  <th className="px">{t("Tag", "Day")}</th>
                  {S.series.map((s) => (
                    <th key={s.name} className="px" style={{ textAlign: "right" }}>
                      {s.name}
                    </th>
                  ))}
                  <th className="px" style={{ textAlign: "right" }}>
                    {t("Summe", "Total")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {S.days
                  .slice()
                  .reverse()
                  .map((d) => (
                    <tr key={d.day} {...lineProps()}>
                      <td>{weekdayLabel(d.day, locale)}</td>
                      {d.vals.map((v, j) => (
                        <td key={S.series[j]?.name} className="num" style={{ textAlign: "right" }}>
                          {v ? fmt(v) : "–"}
                        </td>
                      ))}
                      <td className="num" style={{ textAlign: "right" }}>
                        <b>{d.total ? fmt(d.total) : "–"}</b>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ) : (
          <DayChart
            data={S}
            fmt={fmt}
            label={`${metric === "cost" ? t("Kosten", "Cost") : "Tokens"} ${t("pro Tag, gestapelt nach", "per day, stacked by")} ${group === "project" ? t("Projekt", "project") : t("Modell", "model")}`}
          />
        )}
      </Card>
      <Waste />
      <Card
        title={topTitle}
        aside={
          <span className="hint" style={{ marginLeft: "auto" }}>
            {t(`letzte ${u.statsDays} Tage`, `last ${u.statsDays} days`)}
          </span>
        }
      >
        {top.length ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable)
          <section className="tablewrap" aria-label={topTitle} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th className="px">Session</th>
                  <th className="px m-hide">Status</th>
                  <th className="px" style={{ textAlign: "right" }}>
                    Tokens
                  </th>
                  <th className="px m-hide" style={{ textAlign: "right" }}>
                    Cache
                  </th>
                  <th className="px" style={{ textAlign: "right" }}>
                    {t("Kosten", "Cost")}
                  </th>
                  <th className="px m-hide">{t("Zuletzt", "Last")}</th>
                </tr>
              </thead>
              <tbody>
                {top.map((s) => {
                  const st = statusOf(s);
                  return (
                    <tr key={s.id} {...lineProps(s.id)}>
                      <td>
                        <b>{s.project}</b>
                        <div className="hint">{s.title}</div>
                      </td>
                      <td className="m-hide">
                        <Tag tone={st.tone}>{st.label}</Tag>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {api ? toks(s.usage.tok, locale) : <b>{toks(s.usage.tok, locale)}</b>}
                      </td>
                      <td
                        className="num m-hide"
                        style={{ textAlign: "right" }}
                        title={t("Anteil der Prompt-Tokens aus dem Cache", "Share of prompt tokens from the cache")}
                      >
                        {pct(s.usage.cacheRate) || "–"}
                      </td>
                      <td className={`num ${api ? "" : "hint"}`} style={{ textAlign: "right" }}>
                        {api ? <b>{money(s.usage.cost, locale)}</b> : money(s.usage.cost, locale)}
                        {s.usage.sub >= 0.01 && (
                          <div className="hint">
                            {t("davon Subagenten", "of which subagents")} {money(s.usage.sub, locale)}
                          </div>
                        )}
                      </td>
                      <td className="num m-hide">{ago(lastOf(s), locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : (
          <div className="ufoot">{t("Keine Daten.", "No data.")}</div>
        )}
      </Card>
      <p className="hint" style={{ margin: 0 }}>
        {t(
          "Kosten sind zu Listenpreisen geschätzt, nicht deine Rechnung – mit einem Pro/Max-Abo zählt vor allem das Limit; Dollar stehen dann nur hier. Eigene Preise:",
          "Costs are estimated at list prices, not your bill; with a Pro/Max plan the limit is what counts and dollars appear only here. Own prices:",
        )}{" "}
        <span className="mono">prices</span>, {t("Abrechnung", "billing")}: <span className="mono">billing</span>{" "}
        (subscription / api) {t("in der Config.", "in the config.")}
      </p>
    </div>
  );
}

/** Where tokens are lost: the advisor's hints with their effect in dollars, never empty (an amount, the cost per call, or why there is none). */
function Waste() {
  const { t, locale } = useI18n();
  const { data } = useFleet();
  if (!data) return null;
  const rows = data.sessions.flatMap((s) =>
    (s.advice || [])
      .filter((a) => a.level !== "ok")
      .map((a) => ({
        s,
        a,
        worth: a.kind === "model" ? Math.max(0, a.saving || 0) : a.kind === "cache" ? s.usage?.rebuildCost || 0 : 0,
      })),
  );
  if (!rows.length) return null;
  rows.sort((x, y) => Number(y.a.level === "warn") - Number(x.a.level === "warn") || y.worth - x.worth);
  const total = rows.reduce((acc, r) => acc + r.worth, 0);
  return (
    <Card
      title={t("Wo Tokens verloren gehen", "Where tokens are lost")}
      aside={
        <span className="hint" style={{ marginLeft: "auto" }}>
          {total >= 0.01 ? `${t("Sparpotenzial", "Potential saving")} ≈ ${money(total, locale)} · ` : ""}
          {t("Schätzung zu Listenpreisen", "estimate at list prices")}
        </span>
      }
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable) */}
      <section className="tablewrap" aria-label={t("Wo Tokens verloren gehen", "Where tokens are lost")} tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th className="px">Session</th>
              <th className="px">{t("Hinweis", "Hint")}</th>
              <th className="px" style={{ textAlign: "right" }}>
                {t("Wirkung", "Effect")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map(({ s, a, worth }) => (
              <tr key={`${s.id}-${a.kind}`} {...lineProps(s.id)}>
                <td>
                  <b>{s.project}</b>
                  <div className="hint">{s.title}</div>
                </td>
                <td>
                  <Tag tone={ADV_TONE[a.level]}>{adviceShort(a, t)}</Tag>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {a.text}
                  </div>
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  {worth >= 0.01 ? (
                    <b>{money(worth, locale)}</b>
                  ) : a.kind === "handoff" && s.fresh && s.fresh.perCall >= 0.01 ? (
                    <>
                      <b>≈ {money(s.fresh.perCall, locale)}</b>
                      <div className="hint">{t("je Aufruf", "per call")}</div>
                    </>
                  ) : a.kind === "model" && (a.saving || 0) <= -0.01 ? (
                    // A stronger model costs more: say so, not "under 1 cent" (practical test 15 Oct).
                    <span className="hint">
                      +{money(-(a.saving || 0), locale)} {t("Kosten", "cost")}
                    </span>
                  ) : (
                    <span className="hint">
                      {a.kind === "handoff"
                        ? t("kleinerer Kontext", "smaller context")
                        : t("unter 1 Cent", "under 1 cent")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Card>
  );
}
