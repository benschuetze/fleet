import { useRef, useState } from "react";
import { Tag } from "~/components/tag";
import { useFleet } from "~/lib/fleet";
import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { afterRender, lineProps } from "~/lib/rows";
import { nowLines, type Tone, waitWord } from "~/lib/session";
import { usePlaces, useStatus } from "~/lib/use-status";
import { dateTimeFull, shortDate } from "../../../shared/dates";
import { waitKind } from "../../../shared/inbox";
import { repoKey, repoName } from "../../../shared/repo";
import type { FleetEvent } from "../../../shared/types";

/** Rows per page: the history is for looking things up, a long list only costs rendering time. */
export const PAGE = 40;

/** The event history, newest first, a page at a time; optionally one repo only (picked in the timeline). */
export function Ledger({ repo, onRepo }: { repo: string | null; onRepo: (key: string | null) => void }) {
  const { t, locale } = useI18n();
  const { data, query, sessionById } = useFleet();
  const where = usePlaces();
  const status = useStatus();
  // The page keys this list by repo and search, so a new filter starts at the top again.
  const [shown, setShown] = useState(PAGE);
  const list = useRef<HTMLOListElement>(null);
  if (!data) return null;
  const ev: Record<string, [string, Tone]> = {
    SessionStart: [t("Session gestartet", "Session started"), ""],
    UserPromptSubmit: [t("Neuer Auftrag", "New task"), "blue"],
    Notification: [t("Braucht dich", "Needs you"), "amber"],
    PermissionRequest: [t("Freigabe", "Approval"), "amber"],
    Stop: [t("Fertig", "Done"), "green"],
    StopFailure: [t("Fehler", "Error"), "red"],
    SessionEnd: [t("Session beendet", "Session ended"), ""],
    PreCompact: [t("Kontext komprimiert", "Context compacted"), ""],
    SubagentStart: [t("Subagent gestartet", "Subagent started"), "violet"],
    SubagentStop: [t("Subagent fertig", "Subagent done"), "violet"],
    // The state Now shows, from the moment it began (round 6): normally replaced by the session's place.
    Now: [t("Jetzt", "Now"), "amber"],
  };
  const current = nowLines(data.events, (id) => where.get(id));
  const q = query.toLowerCase();
  const today = new Date().toDateString();
  const rows = data.events
    .map((e) => ({ e, s: sessionById.get(e.sessionId) }))
    .filter(({ s }) => !repo || (s && repoKey(s) === repo))
    .filter(
      ({ e, s }) =>
        !q || `${s ? `${s.project} ${s.title}` : ""} ${e.detail || ""} ${e.cwd || ""}`.toLowerCase().includes(q),
    );
  const name = repo ? data.timeline?.lanes.find((l) => l.id === repo)?.project || repo : null;
  return (
    <div className="ledger">
      {name && (
        <p className="ledger-filter">
          {t(`Nur ${name}`, `Only ${name}`)}{" "}
          <button type="button" className="link" onClick={() => onRepo(null)}>
            {t("alle zeigen", "show all")}
          </button>
        </p>
      )}
      {!data.events.length ? (
        <div className="empty-col">
          {t(
            "Noch keine Ereignisse. Sie erscheinen, sobald die Hooks installiert sind (node dist/fleet.cjs setup).",
            "No events yet. They appear once the hooks are installed (node dist/fleet.cjs setup).",
          )}
        </div>
      ) : rows.length ? (
        <>
          <ol ref={list} className="events" aria-label={t("Ereignisse", "Events")}>
            {rows.slice(0, shown).map(({ e, s }) => {
              // The newest line of a session that waits or failed now says so, as Now and the stream do.
              const place = current.get(e);
              const [label, tone] =
                place && s
                  ? [status(s).label, (place === "errors" ? "red" : "amber") as Tone]
                  : e.status === "needs_input"
                    ? // One state, one word (round 7): every wait reads "waits · approval/question", old lines too.
                      [
                        `${t("wartet", "waits")} · ${waitWord(eventWait(e) ?? (s ? waitKind(s) : "question"), t)}`,
                        "amber" as Tone,
                      ]
                    : e.event === "Now" && e.status === "error"
                      ? [t("Fehler", "error"), "red" as Tone]
                      : ev[e.event] || [e.event, ""];
              const d = new Date(e.at);
              return (
                <li key={`${e.at}-${e.sessionId}-${e.event}`} className="ev" {...lineProps(s?.id)}>
                  <span className="when" title={dateTimeFull(d, locale)}>
                    {d.toDateString() === today
                      ? clock(e.at, locale)
                      : `${shortDate(d, locale)} ${clock(e.at, locale)}`}
                  </span>
                  <span className="p">
                    <b>
                      {s
                        ? repoName(s)
                        : String(e.cwd || "")
                            .split(/[\\/]/)
                            .pop()}
                    </b>
                  </span>
                  <span className="what">
                    <Tag tone={tone}>{label}</Tag>{" "}
                    <span>{endReason(e, t) ?? (e.detail || (e.event === "SessionStart" && s ? s.title : ""))}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {rows.length > shown && (
            // A line of the tile (round 8): j/k, G and End reach it, Enter shows the next page.
            <button
              type="button"
              className="btn more"
              data-line=""
              onClick={() => {
                const from = shown;
                setShown((n) => n + PAGE);
                // The last page takes the button with it: the selection goes to the first line that came in.
                afterRender(() => {
                  if (document.activeElement && document.activeElement !== document.body) return;
                  list.current?.querySelectorAll<HTMLElement>("[data-line]")[from]?.focus({ preventScroll: true });
                });
              }}
            >
              {t(
                // "23 von 23" read odd (round 6): the last page says "alle".
                // Round 7: "alle 27" beside 40 visible rows read as the total; it is what is still hidden.
                rows.length - shown <= PAGE
                  ? `Ältere zeigen (${rows.length - shown} weitere)`
                  : `Ältere zeigen (${PAGE} von ${rows.length - shown} weiteren)`,
                rows.length - shown <= PAGE
                  ? `Show older (${rows.length - shown} more)`
                  : `Show older (${PAGE} of ${rows.length - shown} more)`,
              )}
            </button>
          )}
        </>
      ) : (
        <div className="empty-col">{t("Keine Treffer.", "No matches.")}</div>
      )}
    </div>
  );
}

/**
 * Why a session ended, in words (round 5: "FEHLER logout" beside "Anmeldung abgelaufen"); the hook sends Claude
 * Code's reason as it is. Null for other events and unknown reasons, which stand as sent.
 */
export function endReason(e: { event: string; detail?: string | null }, t: (de: string, en: string) => string) {
  if (e.event !== "SessionEnd") return null;
  const words: Record<string, [string, string]> = {
    logout: ["abgemeldet", "logged out"],
    clear: ["mit /clear geleert", "cleared with /clear"],
    prompt_input_exit: ["von dir beendet", "ended by you"],
    other: ["", ""],
  };
  const w = words[String(e.detail || "")];
  return w ? t(w[0], w[1]) : null;
}

/**
 * What a permission request in the log waits for. The hook logs it by tool (one rule with waitsFor, review #145);
 * older lines only had the words, where "AskUserQuestion" or a closing "?" meant a question.
 */
export function eventWait(e: Pick<FleetEvent, "event" | "detail" | "waits">): "approval" | "question" | null {
  if (e.event !== "PermissionRequest") return null;
  if (e.waits === "approval" || e.waits === "question") return e.waits;
  return /AskUserQuestion|ExitPlanMode|\?\s*$/.test(e.detail || "") ? "question" : "approval";
}
