import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { colorOf, tagsOf } from "~/lib/log";
import { rowNumbers } from "~/lib/rows";
import { useLog } from "~/lib/use-log";
import { LOG_MAX, signals } from "../../../shared/log";
import type { LogLine } from "../../../shared/types";
import { Safe } from "../safe";

/**
 * The log view (spec, "Log-Sicht (Shift+L)"): every step of every session, one line each, newest at the bottom, as
 * the terminal next to Fleet showed it during the rebuild. A layer over the current view, which stays as it was
 * underneath; Shift+L or Esc goes back to the same row and scroll position. Rendered only while open.
 */
export function LogView() {
  const { log } = useKeys();
  if (!log) return null;
  return (
    <Safe>
      <LogPane />
    </Safe>
  );
}

/** Close to the end counts as at the end: new lines then keep the view at the bottom, like `tail -f`. */
const END_SLACK = 24;

function LogPane() {
  const { t, locale } = useI18n();
  const { setLog, logFilter } = useKeys();
  const { lines, sessions, waiting, failed } = useLog();
  const list = useRef<HTMLOListElement>(null);
  const atEnd = useRef(true);
  const shown = logFilter ? lines.filter((l) => l.session === logFilter.session) : lines;
  const sig = useMemo(() => signals(lines, waiting), [lines, waiting]);
  const tags = useMemo(() => tagsOf(lines.map((l) => l.session)), [lines]);
  const last = shown[shown.length - 1]?.seq;
  // The number to type for a session: its row on Now, which stays mounted under the log (practical test 15 Oct).
  const nrOf = rowNumbers();

  useEffect(() => {
    list.current?.focus({ preventScroll: true });
  }, []);
  // A new last line, or another filter: stay at the end if the view was there.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !atEnd.current || (last === undefined && !logFilter)) return;
    el.scrollTop = el.scrollHeight;
  }, [last, logFilter]);

  const time = (at: number) =>
    new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const toolOf = (l: LogLine) =>
    l.tool || (l.kind === "prompt" ? t("Auftrag", "prompt") : l.kind === "error" ? "API" : "");

  return (
    <section className="logview" aria-label={t("Log-Sicht", "Log view")}>
      <div className="log-head">
        <h2>Log</h2>
        <span className="mono" data-testid="log-count">
          {shown.length} / {LOG_MAX}
        </span>
        <span className="hint">
          {logFilter
            ? t(
                `nur Zeile ${logFilter.nr}: ${logFilter.label} · 0 zeigt alle`,
                `only row ${logFilter.nr}: ${logFilter.label} · 0 shows all`,
              )
            : t(
                "alle Sessions · die Nummer vor dem Kürzel ist die Zeile auf Jetzt: tippen filtert, 0 zeigt alle",
                "all sessions · the number before the tag is the row on Now: type it to filter, 0 shows all",
              )}
          {failed ? ` · ${t("Server nicht erreichbar", "server not reachable")}` : ""}
        </span>
        <button type="button" className="act-link" onClick={() => setLog(false)}>
          {t("Log schließen", "Close the log")} <kbd>Shift+L</kbd>
        </button>
      </div>
      <ol
        ref={list}
        className="log-lines"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard (WCAG 2.1.1)
        tabIndex={0}
        aria-label={t("Schritte aller Sessions", "Steps of all sessions")}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < END_SLACK;
        }}
      >
        {shown.map((l) => {
          const s = sig.get(l.seq) || null;
          const who = sessions[l.session];
          return (
            <li key={l.seq} className={`log-line${s ? ` sig-${s}` : ""}`} data-session={l.session}>
              <span className="log-at">{time(l.at)}</span>
              <span className="log-nr" data-testid="log-nr" title={t("Zeile auf Jetzt", "row on Now")}>
                {nrOf.get(l.session) ?? "·"}
              </span>
              <span className={`log-tag c${colorOf(l.session)}`} data-testid="log-tag" title={l.session}>
                {tags.get(l.session) || l.session.slice(0, 4)}
              </span>
              <span className="log-who" title={who?.name || who?.project || undefined}>
                {who?.name || who?.project || ""}
              </span>
              <span className="log-sig">
                {s === "crit" ? t("Fehler", "error") : s === "warn" ? t("wartet", "waiting") : ""}
              </span>
              <span className="log-tool">{toolOf(l)}</span>
              <span className="log-text">{l.text}</span>
            </li>
          );
        })}
      </ol>
      {!shown.length && (
        <p className="log-empty">
          {logFilter
            ? t(
                "Von dieser Session ist kein Schritt unter den letzten 500.",
                "No step of this session among the last 500.",
              )
            : t("Noch keine Schritte.", "No steps yet.")}
        </p>
      )}
    </section>
  );
}
