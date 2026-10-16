import { type CSSProperties, type ReactNode, useMemo } from "react";
import { CLEANUP_HOURS, cleanupCandidates } from "~/lib/cleanup";
import { useFleet } from "~/lib/fleet";
import { freshAlarms } from "~/lib/fresh";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { useNowView } from "~/lib/use-view";
import { alarmEmpty } from "~/lib/view";
import { alarmRows, inbox, waitingRows } from "../../../shared/inbox";
import type { Session } from "../../../shared/types";
import { ReplyLine } from "../keys/reply";
import { Safe } from "../safe";
import { Tile } from "../screen/tile";
import { BalanceRow, LimitRow, SessionAlarm } from "./alarm-rows";
import { CiCardView } from "./ci-card";
import { DecisionRow } from "./decision-row";

export { alarmCount } from "../../../shared/inbox";

/** Rows the zone shows before it scrolls; `--alarm-min` in screen.css says the same (release 6: three were too few). */
export const ALARM_ROWS = 6;

/** Rows waiting for you that the zone keeps in sight: it grows for them (up to half the window) before scrolling. */
const WAITING = "[data-row]:has(.g-waiting)";

/**
 * The alarm zone, tile 1 of the screen (spec, "Ein Schirm im CLI-Look", rule 2): only what needs a decision, one row
 * each with one action, in the order of `alarmRows`: everything waiting for you first (Fleet's own questions, then
 * sessions), then errors, red CI nobody fixes and a nearly used-up limit. It stands above the middle on every view
 * (ISA-101: alarms never out of sight), `ALARM_ROWS` rows high, taller while more rows wait for you (up to half the window,
 * B14); more scroll inside it, and the frame line says where it stands and how many waiting rows are below. The status filter
 * narrows it, the repo chosen in the repo bar never does. Empty, it says so in one sentence, and how many alarms a filter or
 * the search hides.
 */
export function AlarmZone() {
  const { t } = useI18n();
  const { data, openDrawer } = useFleet();
  const { replying, unmuteAll, runCmd, filter } = useKeys();
  // Never narrowed by the repo bar: an alarm elsewhere must stay in sight.
  const view = useNowView(null);
  // New is what came up since the page last looked, over all sessions: a filter or the search that hides an alarm
  // and shows it again does not make it new (rule 16: only new alarms blink).
  const all = useMemo(() => (data ? inbox(data) : null), [data]);
  // Only once there is data: the zone stands before the first overview, and an empty first look would make every
  // alarm of the first overview new.
  const fresh = all
    ? freshAlarms.seen(
        [...all.errors, ...all.needs].map((s) => s.id),
        Date.now(),
      )
    : new Set<string>();
  const ib = view?.ib;
  const decisions = view?.decisions || [];
  const rows = ib ? alarmRows(ib, decisions) : [];
  const n = rows.length;
  // A reply line opens under its row and counts as one more row to keep in sight.
  const waiting = ib ? waitingRows(ib, decisions) + (replying && ib.needs.some((s) => s.id === replying) ? 1 : 0) : 0;
  const muted = view?.mutedCount || 0;
  // Alarms of sessions quiet for hours help nobody (release 6, plan R5): the frame line offers `:cleanup` for them.
  const old = ib ? cleanupCandidates([...ib.needs, ...ib.errors], data?.processes || [], Date.now()).length : 0;
  const open = (s: Session) => openDrawer({ kind: "session", id: s.id, title: String(s.title || s.project || "") });

  let body: ReactNode;
  if (!ib) body = <p className="tile-empty">{t("Lade …", "Loading …")}</p>;
  else if (n === 0) body = <p className="tile-empty">{alarmEmpty(view?.hiddenAlarms || 0, filter, t)}</p>;
  else
    body = (
      <div className="a-list">
        {rows.map((r, i) => {
          // Numbers follow the order on screen.
          const nr = i + 1;
          if (r.kind === "decision") return <DecisionRow key={r.d.id} d={r.d} first={i === 0} nr={nr} />;
          if (r.kind === "needs" || r.kind === "errors")
            return [
              <SessionAlarm key={r.s.id} s={r.s} nr={nr} fresh={fresh.has(r.s.id)} onOpen={() => open(r.s)} />,
              replying === r.s.id ? <ReplyLine key={`r-${r.s.id}`} s={r.s} /> : null,
            ];
          if (r.kind === "ci") return <CiCardView key={r.c.key} c={r.c} nr={nr} />;
          if (r.kind === "limit") return <LimitRow key="limit" l={r.l} nr={nr} />;
          return <BalanceRow key="balance" b={r.b} nr={nr} />;
        })}
      </div>
    );

  return (
    <Tile
      id="alarm"
      title={t("Alarmzone", "Alarm zone")}
      count={n}
      style={{ "--alarm-rows": Math.max(ALARM_ROWS, waiting) } as CSSProperties}
      below={{
        items: WAITING,
        text: (k) => t(`+${k} wartend darunter`, `+${k} waiting below`),
      }}
      aside={
        <>
          {old > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => runCmd({ kind: "cleanup" })}
              aria-label={t(
                `${old} älter als ${CLEANUP_HOURS} h – aufräumen`,
                `${old} older than ${CLEANUP_HOURS} h – clean up`,
              )}
              title={t(
                `:cleanup – Sessions ohne Lebenszeichen seit ${CLEANUP_HOURS} h ausblenden (fragt y/n)`,
                `:cleanup – hide sessions quiet for ${CLEANUP_HOURS} h (asks y/n)`,
              )}
            >
              {t(`${old} alt · aufräumen`, `${old} old · clean up`)}
            </button>
          )}
          {muted > 0 && (
            <button
              type="button"
              className="link"
              onClick={unmuteAll}
              aria-label={t(`${muted} stumm – wieder zeigen`, `${muted} muted – show again`)}
              title={t("Stummgeschaltete Alarme wieder zeigen", "Show muted alarms again")}
            >
              {t(`${muted} stumm`, `${muted} muted`)}
            </button>
          )}
        </>
      }
    >
      <Safe>{body}</Safe>
    </Tile>
  );
}
