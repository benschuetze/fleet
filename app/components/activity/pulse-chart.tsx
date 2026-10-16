import { useRef } from "react";
import { niceMax, tokenWord, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWidth } from "~/lib/use-width";
import type { Overview } from "../../../shared/types";

const COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];

/**
 * Pulse: tokens per minute of the last hour, stacked by project (at most four plus "other"). The scale follows the
 * normal range: single spikes (a cache rebuild) are capped at the top and labelled with their real value, instead
 * of making everything else invisible.
 */
export function PulseChart({ data }: { data: Overview }) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const live = data.usage?.live;
  if (!live) return null;
  const byProj = new Map<string, number[]>();
  const first = new Map<string, number>();
  for (const s of data.sessions) {
    const l = live.bySession[s.id];
    if (!l) continue;
    const p = s.project || "—";
    const a = byProj.get(p) || new Array(live.minutes).fill(0);
    l.tok.forEach((v, i) => {
      a[i] += v;
    });
    byProj.set(p, a);
    first.set(p, Math.min(first.get(p) ?? Number.POSITIVE_INFINITY, s.startedAt || Number.POSITIVE_INFINITY));
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const names = [...byProj.keys()].filter((p) => sum(byProj.get(p) || []) > 0);
  if (!names.length)
    return (
      <p className="hint" style={{ margin: 0 }}>
        {t("In der letzten Stunde hat keine Session Tokens verbraucht.", "No session used tokens in the last hour.")}
      </p>
    );
  // Colour follows the project, not its rank: ordered by when its sessions started.
  names.sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0) || a.localeCompare(b));
  const big = names.slice().sort((a, b) => sum(byProj.get(b) || []) - sum(byProj.get(a) || []));
  const keep = new Set(names.length > 5 ? big.slice(0, 4) : names);
  const series = names
    .filter((n) => keep.has(n))
    .map((n, i) => ({ name: n, color: COLORS[i] as string, vals: byProj.get(n) || [] }));
  if (names.length > keep.size) {
    const rest = new Array(live.minutes).fill(0);
    for (const n of names) {
      if (keep.has(n)) continue;
      const vals = byProj.get(n) || [];
      for (let i = 0; i < vals.length; i++) rest[i] += vals[i] ?? 0;
    }
    series.push({ name: t("Andere", "Other"), color: "var(--s-other)", vals: rest });
  }
  const n = live.minutes;
  const totals = new Array<number>(n).fill(0);
  for (const se of series) {
    for (let i = 0; i < se.vals.length; i++) totals[i] = (totals[i] ?? 0) + (se.vals[i] ?? 0);
  }
  const W = Math.max(300, Math.min(1180, width));
  const H = 150;
  // Room for the widest axis label, "100 Tsd." in German (round 6: it stood cut at the edge).
  const L = 72;
  const B = 18;
  const T = 6;
  const pw = W - L;
  const ph = H - B - T;
  const sorted = totals.filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = sorted.length ? (sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0) : 0;
  const peak = Math.max(...totals);
  const max = niceMax(peak > p90 * 3 && p90 > 0 ? p90 * 1.6 : peak * 1.05);
  const slot = pw / n;
  const bw = Math.max(2, slot - 2);
  const bars: React.ReactNode[] = [];
  let lastLabel = -1e9;
  for (let i = 0; i < n; i++) {
    let y = T + ph;
    const x = L + i * slot + 1;
    const parts: string[] = [];
    for (const se of series) {
      const v = se.vals[i] ?? 0;
      if (v <= 0) continue;
      const h = Math.max(0, Math.min(y - T, (ph * v) / max));
      y -= h;
      if (h <= 0) continue;
      bars.push(
        <rect
          key={`${i}-${se.name}`}
          x={x.toFixed(1)}
          y={y.toFixed(1)}
          width={bw.toFixed(1)}
          height={Math.max(0.5, h - 1).toFixed(1)}
          rx={1}
          fill={se.color}
        />,
      );
      parts.push(`${se.name}: ${toks(v, locale)}`);
    }
    const tot = totals[i] ?? 0;
    // Label capped spikes; of spikes close to each other only the highest.
    if (
      tot > max &&
      !((totals[i - 1] ?? 0) > tot) &&
      !((totals[i + 1] ?? 0) >= tot && i + 1 < n) &&
      L + i * slot - lastLabel > 70
    ) {
      bars.push(
        <text
          key={`l${i}`}
          className="ax"
          x={(L + i * slot + slot / 2).toFixed(1)}
          y={T + 9}
          textAnchor="middle"
          fontWeight={700}
        >
          ↑{toks(tot, locale)}
        </text>,
      );
      lastLabel = L + i * slot;
    }
    if (tot > 0) {
      bars.push(
        <rect key={`h${i}`} x={(L + i * slot).toFixed(1)} y={T} width={slot.toFixed(1)} height={ph} fill="transparent">
          <title>{`${t(`vor ${n - 1 - i} Min`, `${n - 1 - i} min ago`)} · ${toks(tot, locale)} ${tokenWord(locale)}\n${parts.join("\n")}`}</title>
        </rect>,
      );
    }
  }
  return (
    <div ref={box}>
      <div className="spark-legend">
        {series.map((se) => (
          <span key={se.name}>
            <i style={{ background: se.color }} />
            {se.name} <b>{toks(sum(se.vals), locale)}</b>
          </span>
        ))}
      </div>
      <svg
        className="pulsechart"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${t("Tokens pro Minute in der letzten Stunde, gestapelt nach Projekt. Insgesamt", "Tokens per minute in the last hour, stacked by project. In total")} ${toks(sum(totals), locale)}.`}
      >
        {[0, 1, 2].map((k) => {
          const y = T + ph - (ph * k) / 2;
          return (
            <g key={k}>
              <line x1={L} x2={W} y1={y} y2={y} />
              <text className="ax" x={L - 6} y={y + 4} textAnchor="end">
                {toks((max * k) / 2, locale)}
              </text>
            </g>
          );
        })}
        {bars}
        {(
          [
            [0, "−60"],
            [15, "−45"],
            [30, "−30"],
            [45, "−15"],
            [59, t("jetzt", "now")],
          ] as const
        ).map(([i, label]) => (
          <text key={i} className="ax" x={L + i * slot + slot / 2} y={H - 3} textAnchor={i === 59 ? "end" : "middle"}>
            {label}
          </text>
        ))}
      </svg>
    </div>
  );
}
