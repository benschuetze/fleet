import { useEffect, useRef, useState } from "react";
import { parseChatPage } from "~/lib/chat";
import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { activity, placeLabel } from "~/lib/session";
import { usePlaces } from "~/lib/use-status";
import type { ChatEntry, ChatPage, Session } from "../../../shared/types";

/** Entries have no id: time, kind and tool name, counted up where they repeat within the same millisecond. */
function keyed(entries: ChatEntry[]): [string, ChatEntry][] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = `${e.at}:${e.kind}:${e.tool || ""}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return [`${base}:${n}`, e];
  });
}

/** Entries shown at first; older ones come in steps of the same size. */
const STEP = 40;

/**
 * A session's conversation in its drawer: opening a session always shows what was said and, in the last line, what
 * Claude does right now (Ben: "man sieht den Chatverlauf und woran Claude gerade genau arbeitet"). Read from the
 * session's own transcript (/api/chat), again whenever the session moves; on opening, the drawer scrolls to the
 * last line like a chat.
 */
export function SessionChat({ s }: { s: Session }) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<ChatPage | null>(null);
  const [shown, setShown] = useState(STEP);
  const now = useRef<HTMLParagraphElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const at = s.lastActivity || 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` changes when the session moves; then there is more to read
  useEffect(() => {
    let gone = false;
    fetch(`/api/chat?session=${encodeURIComponent(s.id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!gone) setPage(parseChatPage(j) || { session: s.id, entries: [], more: false });
      })
      .catch(() => {
        if (!gone) setPage({ session: s.id, entries: [], more: false });
      });
    return () => {
      gone = true;
    };
  }, [s.id, at]);

  useEffect(() => {
    if (!page || page.session !== s.id || scrolledFor.current === s.id) return;
    scrolledFor.current = s.id;
    now.current?.scrollIntoView({ block: "nearest" });
  }, [page, s.id]);

  const entries = page?.session === s.id ? page.entries : [];
  const hidden = Math.max(0, entries.length - shown);
  const last = entries[entries.length - 1];
  const running = last?.open ? last : null;
  // The word of Now (places in shared/inbox.ts): a session Fleet holds a question for waits, even while it works.
  const place = usePlaces().get(s.id);
  const st = placeLabel(place, s, t);
  const waits = place === "needs" || place === "decision";
  const nowText =
    place === "working" || (!place && s.status === "working")
      ? [
          activity(running ? { ...s, lastTool: running.tool } : s, t)[1],
          running ? `${running.tool} ${running.text}`.trim() : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : st.label;

  return (
    <>
      <h4 className="sd-h">{t("Verlauf", "Conversation")}</h4>
      {!page ? (
        <p className="sd-dim">{t("lädt …", "loading …")}</p>
      ) : !entries.length ? (
        <p className="sd-dim">
          {t("Kein Verlauf im Transcript gefunden.", "No conversation found in the transcript.")}
        </p>
      ) : (
        <>
          {(hidden > 0 || page.more) && (
            <p className="sd-dim">
              {hidden > 0 ? (
                <button type="button" className="link" onClick={() => setShown((n) => n + STEP)}>
                  {t(`${Math.min(STEP, hidden)} ältere zeigen`, `show ${Math.min(STEP, hidden)} older`)}
                </button>
              ) : (
                t("Ältere Einträge stehen nur im Transcript.", "Older entries are only in the transcript.")
              )}
            </p>
          )}
          <ol className="sd-chat" aria-label={t("Verlauf", "Conversation")}>
            {keyed(entries.slice(hidden)).map(([key, e]) => (
              <li key={key} className={`c-${e.kind}${e.open ? " c-open" : ""}`}>
                <time>{clock(e.at, locale)}</time>{" "}
                <b>
                  {e.kind === "you"
                    ? t("Du", "You")
                    : e.kind === "claude"
                      ? "Claude"
                      : e.kind === "error"
                        ? `${t("Fehler", "Error")}${e.tool ? ` ${e.tool}` : ""}`
                        : e.tool}
                </b>{" "}
                {e.kind === "you" || e.kind === "claude" ? (
                  <span className="sd-msg">{e.text}</span>
                ) : (
                  <span title={e.text}>{e.text}</span>
                )}
                {e.open && <> · {t("läuft", "running")}</>}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="sd-now" ref={now} data-testid="session-now">
        <b>{t("Jetzt", "Now")}:</b> <span className={waits ? "sd-ask" : undefined}>{nowText}</span>
      </p>
    </>
  );
}
