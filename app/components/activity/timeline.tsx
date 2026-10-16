import { clock, duration, waitMinutes } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import type { Overview } from "../../../shared/types";

/**
 * Swim lanes, one per repo: when work ran there, how long it waited for you. Several sessions of a repo share a
 * lane; per moment it shows the state that matters most (error, then waiting for you, then working, then done).
 * The repo name filters the history below.
 */
export function TimelineView({
  data,
  repo,
  onRepo,
}: {
  data: Overview;
  repo: string | null;
  onRepo: (key: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const tl = data.timeline;
  if (!tl?.lanes.length)
    return (
      <p className="hint" style={{ margin: 0 }}>
        {t(
          "Noch keine Ereignisse. Die Zeitleiste füllt sich, sobald die Hooks installiert sind.",
          "No events yet. The timeline fills once the hooks are installed.",
        )}
      </p>
    );
  // Header and lanes from one sum (format.ts): the rest is time of sessions in no shown lane.
  const { lanes: laneMin, rest } = waitMinutes(tl);
  const span = tl.to - tl.from;
  const pos = (x: number) => (100 * (x - tl.from)) / span;
  const lane: Record<string, string> = {
    working: t("arbeitet", "working"),
    needs_input: t("braucht dich", "needs you"),
    waiting: t("fertig", "done"),
    error: t("Fehler", "error"),
  };
  return (
    <>
      <div className="lgd">
        {Object.entries(lane).map(([k, v]) => (
          <span key={k}>
            <i className={k} />
            {v}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          {t("rechts: Wartezeit auf dich", "right: time spent waiting for you")}
          {rest > 0 && t(` · +${rest} Min in weiteren Repos`, ` · +${rest} min in other repos`)}
        </span>
      </div>
      <div className="lanes">
        {tl.lanes.map((l, i) => {
          const wait = laneMin[i] ?? 0;
          const name = l.project || "—";
          const n = l.sessions || 1;
          return (
            <div key={l.id} className={`lane ${repo === l.id ? "on" : ""}`}>
              <button
                type="button"
                className="who"
                aria-pressed={repo === l.id}
                title={t(`Verlauf auf ${name} filtern`, `Filter the history to ${name}`)}
                onClick={() => onRepo(repo === l.id ? null : l.id)}
              >
                <b>{name}</b> · {n} {n === 1 ? t("Session", "session") : t("Sessions", "sessions")}
              </button>
              <span
                className="track"
                role="img"
                aria-label={t(
                  `${name}: ${Math.round(l.work / 60e3)} Min gearbeitet, ${wait} Min auf dich gewartet`,
                  `${name}: worked ${Math.round(l.work / 60e3)} min, waited ${wait} min for you`,
                )}
              >
                {l.segments.map((sg) => (
                  <span
                    key={`${sg.from}-${sg.status}`}
                    className={`seg ${sg.status}`}
                    style={{
                      left: `${pos(sg.from).toFixed(2)}%`,
                      width: `${Math.max(0.4, pos(sg.to) - pos(sg.from)).toFixed(2)}%`,
                    }}
                    title={`${lane[sg.status]} ${clock(sg.from, locale)}–${clock(sg.to, locale)} (${duration(sg.to - sg.from, locale)})`}
                  />
                ))}
              </span>
              <span
                className={`wt ${wait >= 10 ? "w" : ""}`}
                title={t(
                  "Zeit, in der Arbeit in diesem Repo auf eine Antwort oder Freigabe von dir gewartet hat",
                  "Time work in this repo waited for an answer or approval from you",
                )}
              >
                {wait ? `${wait} ${t("Min", "min")}` : "–"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="axis">
        <span className="sp" />
        <span className="ticks">
          {[0, 1, 2, 3].map((h) => {
            const at = tl.from + h * 3600e3;
            return (
              <span key={h} style={{ left: `${pos(at)}%` }}>
                {h === 3 ? t("jetzt", "now") : clock(at, locale)}
              </span>
            );
          })}
        </span>
        <span className="sp" style={{ minWidth: 64 }} />
      </div>
    </>
  );
}
