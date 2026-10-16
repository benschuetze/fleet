import { useRef, useState } from "react";
import { dayLabel, niceMax, weekdayLabel } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWidth } from "~/lib/use-width";

export interface Series {
  series: { name: string; color: string }[];
  days: { day: string; vals: number[]; total: number }[];
}

/** Stacked columns per day; hovering a day shows its parts in a tooltip. Only the top segment gets round corners. */
export function DayChart({ data, fmt, label }: { data: Series; fmt: (v: number) => string; label: string }) {
  const { locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const W = Math.max(320, Math.min(1180, width - 14));
  const H = 260;
  const L = 58;
  const R = 8;
  const T = 10;
  const B = 26;
  const pw = W - L - R;
  const ph = H - T - B;
  const max = niceMax(Math.max(...data.days.map((d) => d.total)) * 1.05);
  const n = data.days.length;
  const slot = pw / n;
  const bw = Math.max(4, Math.min(34, slot * 0.62));
  const every = Math.max(1, Math.ceil(52 / slot));
  const day = hover ? data.days[hover.i] : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only shows a tooltip; the same values are in the table view
    <div className="chartbox" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
        <g className="grid">
          {[0, 1, 2, 3, 4].map((k) => {
            const y = T + ph - (ph * k) / 4;
            return (
              <g key={k}>
                <line x1={L} x2={W - R} y1={y} y2={y} />
                <text x={L - 8} y={y + 4} textAnchor="end">
                  {fmt((max * k) / 4)}
                </text>
              </g>
            );
          })}
        </g>
        {data.days.map((d, i) => {
          const x = L + slot * i + (slot - bw) / 2;
          let y = T + ph;
          const top = d.vals.reduce((acc, v, j) => (v > 0 ? j : acc), -1);
          return (
            <g key={d.day}>
              {d.vals.map((v, j) => {
                if (v <= 0) return null;
                const h = Math.max(1, (ph * v) / max);
                y -= h;
                const r = j === top ? Math.min(4, bw / 2, h) : 0;
                const color = data.series[j]?.color;
                return r ? (
                  <path
                    key={data.series[j]?.name}
                    className="seg-r"
                    fill={color}
                    d={`M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + h}Z`}
                  />
                ) : (
                  <rect key={data.series[j]?.name} className="seg-r" fill={color} x={x} y={y} width={bw} height={h} />
                );
              })}
              {(n - 1 - i) % every === 0 && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle">
                  {dayLabel(d.day, locale)}
                </text>
              )}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: hover only shows a tooltip; the table view has the same values */}
              <rect
                className={`hit ${hover?.i === i ? "on" : ""}`}
                x={L + slot * i}
                y={T}
                width={slot}
                height={ph}
                rx={2}
                onMouseMove={(e) => {
                  const r = box.current?.getBoundingClientRect();
                  if (r) setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
              />
            </g>
          );
        })}
      </svg>
      {day && hover && (
        <div
          className="tip"
          style={{
            left: Math.max(0, hover.x + 214 > W ? hover.x - 200 : hover.x + 14),
            top: Math.max(0, hover.y - 10),
          }}
        >
          <div className="h">{weekdayLabel(day.day, locale)}</div>
          {data.series.map((s, j) =>
            day.vals[j] ? (
              <div key={s.name} className="r">
                <span>
                  <i style={{ background: s.color }} />
                  {s.name}
                </span>
                <b>{fmt(day.vals[j] ?? 0)}</b>
              </div>
            ) : null,
          )}
          <div className="r t">
            <span>Σ</span>
            <b>{fmt(day.total)}</b>
          </div>
        </div>
      )}
    </div>
  );
}
