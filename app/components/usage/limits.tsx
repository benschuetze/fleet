import { clock, money, tokenWord, toks, until } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useNow } from "~/lib/use-now";
import { dateTime } from "../../../shared/dates";
import { inbox } from "../../../shared/inbox";
import { limitStale, windowOver } from "../../../shared/limits";
import type { LimitWindow, Overview, Usage } from "../../../shared/types";
import { Card } from "../views";

/**
 * Limits, only what is certain: percentages exist only when Claude Code reported them (status line or the
 * Cowork plugin). Without them: the limit hit Claude Code wrote into a transcript, and the tokens used.
 */
export function Limits({ data, u }: { data: Overview; u: Usage }) {
  const { t, locale } = useI18n();
  const L = u.limits || {};
  const parts: React.ReactNode[] = [];
  if (L.five_hour)
    parts.push(
      <Meter
        key="5h"
        title={t("5-Stunden-Limit", "Five-hour limit")}
        w={L.five_hour}
        spanMs={5 * 3600e3}
        working={inbox(data).counts.working > 0}
        at={L.at}
      />,
    );
  if (L.seven_day)
    parts.push(
      <Meter
        key="7d"
        title={t("Wochenlimit", "Weekly limit")}
        w={L.seven_day}
        spanMs={7 * 86400e3}
        working={inbox(data).counts.working > 0}
        at={L.at}
      />,
    );
  if (L.spend_limit)
    parts.push(
      <Meter key="sp" title={t("Ausgabenlimit", "Spend limit")} w={L.spend_limit} spanMs={0} working={false} />,
    );
  if (!parts.length && (u.block || u.limitHit)) {
    const b = u.block;
    const hit = u.limitHit;
    const now = Date.now();
    const when = (ts: number) =>
      Math.abs(ts - now) < 20 * 3600e3
        ? `${t("um", "at")} ${clock(ts, locale)}`
        : `${t("am", "on")} ${dateTime(ts, locale, true)}`;
    parts.push(
      <Card key="hit" title="Limit">
        <div className="meter">
          {hit && (
            <>
              <div className="big c-red">
                {hit.kind === "seven_day"
                  ? t("Wochenlimit erreicht", "Weekly limit reached")
                  : t("Erreicht", "Reached")}
                <small>{when(hit.at)}</small>
              </div>
              <div className="line c">
                {t("Wieder frei", "Free again")} {when(hit.resetsAt)} ({t("in", "in")}{" "}
                {until(hit.resetsAt - now, locale)}).{" "}
                {u.overage
                  ? t(
                      "Sessions arbeiten seitdem weiter: das läuft über dein Nutzungsguthaben.",
                      "Sessions kept working since: that runs on your extra usage.",
                    )
                  : t(
                      "Was du seitdem nutzt, läuft über dein Nutzungsguthaben, falls aktiviert.",
                      "What you use since then runs on your extra usage, if enabled.",
                    )}
              </div>
              {u.overage && (
                <div className="line" data-testid="overage">
                  <b>{t("Läuft über Guthaben", "Running on extra usage")}:</b> {toks(u.overage.tok, locale)}{" "}
                  {tokenWord(locale)} {t("seit", "since")} {clock(u.overage.since, locale)} ({u.overage.n}{" "}
                  {t("Aufrufe", "calls")})<span className="hint">· {money(u.overage.cost, locale)}</span>
                </div>
              )}
            </>
          )}
          {b && (
            <div className="line">
              <b>{toks(b.tok, locale)}</b> {t("Tokens seit", "tokens since")} {clock(b.first, locale)}{" "}
              {t("in deinen Claude-Code-Sessions", "in your Claude Code sessions")} · {t("Tempo", "pace")}{" "}
              {toks(b.burnPerMin, locale)}/{t("Min", "min")}
              <span className="hint">
                · {money(b.cost, locale)} {t("zu Listenpreisen", "at list prices")}
              </span>
            </div>
          )}
          <Approx u={u} />
          <div className="line hint">
            {t(
              "Den Prozentwert kennt nur Claude Code selbst. Fleet zeigt ihn, sobald die Statuszeile im Terminal oder das Cowork-Plugin ihn liefert, und rät ihn nicht.",
              "Only Claude Code knows the percentage. Fleet shows it once the status line in the terminal or the Cowork plugin reports it, and never guesses it.",
            )}
          </div>
        </div>
      </Card>,
    );
  }
  if (!parts.length) {
    parts.push(
      <Card key="none" title="Limits">
        <div className="meter">
          <div className="line">
            {t(
              "Noch keine Limit-Daten. Sie kommen von der Claude-Code-Statuszeile oder vom Cowork-Plugin, jeweils nach der nächsten Antwort von Claude (nur mit Pro/Max-Abo).",
              "No limit data yet. It comes from the Claude Code status line or the Cowork plugin, after Claude's next answer (Pro/Max plans only).",
            )}
          </div>
          <Approx u={u} />
        </div>
      </Card>,
    );
  }
  return <div className="ugrid">{parts}</div>;
}

/**
 * Without a limit value: the tokens of the last seven days, labelled as what they are. Not "since the start of the
 * week": the weekly window starts at first use, and without its reset time that start would be a guess.
 */
function Approx({ u }: { u: Usage }) {
  const { t, locale } = useI18n();
  const d7 = u.totals?.d7;
  if (!d7?.n) return null;
  return (
    <div className="line" data-testid="limit-approx">
      <b>{toks(d7.tok, locale)}</b>{" "}
      {t("Tokens, 7 Tage (Näherung, kein Limitwert)", "tokens, 7 days (approximation, no limit value)")}
    </div>
  );
}

function Meter({
  title,
  w,
  spanMs,
  working,
  at,
}: {
  title: string;
  w: LimitWindow;
  spanMs: number;
  working: boolean;
  at?: number;
}) {
  const { t, locale } = useI18n();
  const pct = Math.max(0, Number(w.used_percentage) || 0);
  const reset = (Number(w.resets_at) || 0) * 1000;
  const now = useNow(30_000);
  // The window has reset since the last status line: its percentage is old, the new one unknown (round 8).
  if (windowOver(w, now))
    return (
      <Card title={title}>
        <div className="meter">
          <div className="line" data-testid="limit-over">
            {t("Reset vorbei, wartet auf neue Statuszeile", "Reset passed, waiting for a new status line")}
          </div>
          <div className="line hint">
            {t(
              "Der Prozentwert vor dem Reset gilt nicht mehr; Fleet zeigt keinen geschätzten.",
              "The percentage from before the reset no longer applies; Fleet does not show an estimate.",
            )}
          </div>
        </div>
      </Card>
    );
  // An old status line: a floor, no projection from it (16.10.2026).
  const stale = limitStale(at, now) && at ? at : 0;
  // Thresholds of the spec: noticeable from 80 %, an alarm from 90 % (bright, not red: red means error).
  const lvl = pct >= 90 ? "c" : pct >= 80 ? "w" : "";
  let projection: React.ReactNode = null;
  if (reset > now && spanMs && !stale) {
    const elapsed = now - (reset - spanMs);
    // Without a working session nothing is used: no projection, only the reset.
    const rate = elapsed > 5 * 60e3 && working ? pct / elapsed : 0;
    if (pct >= 100)
      projection = (
        <div className="line c">
          ⚠ {t("Limit erreicht – wieder frei in", "Limit reached, free again in")} {until(reset - now, locale)}
          {/* Sessions still work: that is extra usage. Since when is unknown here, so no number. */}
          {working && <> · {t("läuft über Guthaben", "running on extra usage")}</>}
        </div>
      );
    else if (rate > 0) {
      const eta = now + (100 - pct) / rate;
      projection =
        eta < reset ? (
          <div className="line w">
            ⚠ {t("Beim jetzigen Tempo voll um ca.", "At this pace full around")} {clock(eta, locale)} ({t("in", "in")}{" "}
            {until(eta - now, locale)})
          </div>
        ) : (
          <div className="line">
            ✓ {t("Beim jetzigen Tempo reicht es bis zum Reset", "At this pace it lasts until the reset")}
          </div>
        );
    }
  }
  const timeMark = reset > now && spanMs ? Math.max(0, Math.min(100, 100 * (1 - (reset - now) / spanMs))) : null;
  return (
    <Card title={title}>
      <div className="meter">
        <div className={`big ${lvl ? "c-amber" : ""}`}>
          {stale ? "≥ " : ""}
          {Math.round(pct)} %<small>{t("verbraucht", "used")}</small>
        </div>
        {stale ? (
          <div className="line hint" data-testid="limit-stale">
            {t(
              `Stand ${clock(stale, locale)} – seitdem kann es nur mehr geworden sein. Die Desktop-App meldet kein Limit; frisch wird die Zahl mit der nächsten Statuszeile einer CLI-Session.`,
              `As of ${clock(stale, locale)}; it can only have grown since. The desktop app reports no limit; the number is fresh again with the next status line of a CLI session.`,
            )}
          </div>
        ) : null}
        <div
          className="mbar"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <i className={lvl} style={{ width: `${Math.min(100, pct)}%` }} />
          {timeMark !== null && (
            <b
              style={{ left: `${timeMark}%` }}
              title={t("So viel Zeit des Fensters ist vergangen", "This much of the window's time has passed")}
            />
          )}
        </div>
        <div className="line">
          {reset
            ? `Reset ${t("in", "in")} ${until(reset - now, locale)} · ${reset - now < 86400e3 ? clock(reset, locale) : new Date(reset).toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
            : ""}
        </div>
        {projection}
      </div>
    </Card>
  );
}
