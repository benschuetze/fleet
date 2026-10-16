import { useMemo } from "react";
import { useFleet } from "~/lib/fleet";
import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { matches } from "~/lib/session";
import { dateTimeFull, shortDate } from "../../../shared/dates";
import type { Glyph } from "../../../shared/inbox";
import { inRepo, type RepoEntry } from "../../../shared/repobar";
import { nowForStream, type StreamStatus, stateChanges } from "../../../shared/stream";
import { MARK } from "../mark";
import { Tile } from "../screen/tile";

/** The mark of a change of state: what the session became then, not what it is now (that is the board's mark). */
const STREAM_MARK: Record<StreamStatus, Glyph> = {
  working: "working",
  needs_input: "waiting",
  waiting: "done",
  error: "error",
  stale: "error",
  ended: "resting",
};

/**
 * The event stream, the right tile (spec, Brainstorming: Ereignisstrom; "Ein Schirm im CLI-Look", rule 2): changes
 * of state in time order, newest on top, like a ticker, one line of 36 columns each: `22:58 ✓ design-system Docs
 * für…`. It follows the repo bar's choice. A click or Enter jumps to the session's row; a session without a row on
 * screen (folded, archived, filtered by the search) opens in the drawer instead. All grey: it is history, the
 * alarm zone says what needs you now.
 */
export function EventStream({
  repo,
  onJump,
  only = null,
}: {
  repo: RepoEntry | null;
  onJump: (id: string) => void;
  /** Under a status filter: only these sessions, as on the board and in the alarm zone (release 6). */
  only?: Set<string> | null;
}) {
  const { t, locale } = useI18n();
  const { data, sessionById, query } = useFleet();
  const items = useMemo(() => stateChanges(data?.events || [], 200, data ? nowForStream(data) : []), [data]);
  const word: Record<StreamStatus, string> = {
    working: t("arbeitet", "working"),
    needs_input: t("wartet auf dich", "waits for you"),
    waiting: t("fertig", "done"),
    error: t("Fehler", "error"),
    stale: t("keine Rückmeldung", "no sign of life"),
    ended: t("beendet", "ended"),
  };
  const shown = items
    .filter((e) => {
      const s = sessionById.get(e.sessionId);
      // The search narrows the stream like the board: an unknown session has nothing to match.
      if (query.trim() && !(s && matches(s, query))) return false;
      if (only && !only.has(e.sessionId)) return false;
      return !s?.meta?.hidden && (!repo || (s ? inRepo(repo, s) : false));
    })
    .slice(0, 30);
  const today = new Date().toDateString();
  return (
    <Tile
      id="stream"
      title={t("Ereignisse", "Events")}
      count={shown.length}
      items=".st-list > li"
      aside={repo ? repo.name : only ? t("gefiltert", "filtered") : null}
    >
      {shown.length ? (
        <ol className="st-list">
          {shown.map((e) => {
            const s = sessionById.get(e.sessionId);
            const where =
              s?.project ||
              String(e.cwd || "")
                .split(/[\\/]/)
                .filter(Boolean)
                .pop() ||
              "";
            const what = `${word[e.status]}${s?.title ? ` · ${s.title}` : ""}`;
            const d = new Date(e.at);
            const when = d.toDateString() === today ? clock(e.at, locale) : shortDate(d, locale);
            // The line shows the mark, the label keeps the words: readers hear "infra fertig · Laufzeit …".
            const line = (
              <>
                <span className="st-m" aria-hidden="true">
                  {MARK[STREAM_MARK[e.status]]}
                </span>
                <span className="st-r">{where}</span>
                <span className="st-t">{s?.title || word[e.status]}</span>
              </>
            );
            return (
              <li key={`${e.at}-${e.sessionId}-${e.status}`}>
                <time dateTime={d.toISOString()} title={dateTimeFull(d, locale)}>
                  {when}
                </time>
                {s ? (
                  <button
                    type="button"
                    className="st-go"
                    aria-label={`${where} ${what}`}
                    title={e.detail || what}
                    data-session={s.id}
                    onClick={() => onJump(s.id)}
                  >
                    {line}
                  </button>
                ) : (
                  <span className="st-go" role="img" aria-label={`${where} ${what}`} title={e.detail || what}>
                    {line}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="tile-empty">
          {data?.events.length
            ? t("Keine Wechsel für diese Auswahl.", "No changes for this choice.")
            : t(
                "Noch keine Ereignisse – sie kommen, sobald die Hooks installiert sind.",
                "No events yet; they come once the hooks are installed.",
              )}
        </p>
      )}
    </Tile>
  );
}
