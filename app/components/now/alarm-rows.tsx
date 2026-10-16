import { Link } from "react-router";
import { clock, signedToks, tokenWord, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { rowProps } from "~/lib/rows";
import { approvalHolder, waitWord } from "~/lib/session";
import { alarmKey } from "~/lib/view";
import { dateTime } from "../../../shared/dates";
import { GLYPH, type Inbox, type LimitAlarm, waitKind } from "../../../shared/inbox";
import type { Session } from "../../../shared/types";
import { Mark } from "../mark";
import { CacheBadge, Since } from "../session/bits";
import { OpenButton } from "../session/open";
import { ExtLink } from "../tag";

type T = (de: string, en: string) => string;

/**
 * Clears the alarm row it stands in, as `x` does (release 6, plan R4): a session is hidden (`u` brings it back), any
 * other alarm muted for 1 h. A text button in its own last column, so the row's one action stays where it was.
 */
export function ClearAlarm({ what, session = false }: { what: string; session?: boolean }) {
  const { t } = useI18n();
  const { clearAlarm } = useKeys();
  return (
    <span className="a-x">
      <button
        type="button"
        className="act-link"
        // Named after what it does here, as the message after it says it (round 6: "Wegräumen" beside "ausgeblendet").
        aria-label={session ? t(`Ausblenden: ${what}`, `Hide: ${what}`) : t(`1 h stumm: ${what}`, `Mute 1 h: ${what}`)}
        title={
          session
            ? t("Ausblenden (x) – u holt sie zurück", "Hide (x); u brings it back")
            : t("1 h stummschalten (x)", "Mute for 1 h (x)")
        }
        onClick={(e) => {
          const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-row]");
          if (row) clearAlarm(row);
        }}
      >
        ×
      </button>
    </span>
  );
}

/** The one action that helps with an error, by its cause. */
export function errorAction(s: Session, t: T): { label: string; hint: string } {
  const kind = s.failure?.kind || (s.status === "stale" ? "stuck" : "api");
  if (kind === "auth")
    return {
      label: t("Neu anmelden", "Log in again"),
      hint: t("Session öffnen und dort /login eingeben", "Open the session and enter /login there"),
    };
  if (kind === "limit")
    return {
      label: t("Fortsetzen", "Continue"),
      hint: t(
        "Session öffnen und weitermachen, sobald das Limit frei ist",
        "Open the session and go on once the limit is free",
      ),
    };
  return {
    label: t("Neu starten", "Restart"),
    hint: t("Session öffnen und den Turn neu starten", "Open the session and restart the turn"),
  };
}

/**
 * A session in the alarm zone: an error (red) or waiting for your answer (orange). One row: kind, where, the
 * task with its cause in one sentence, since when, and exactly one action. The title opens the session.
 */
export function SessionAlarm({
  s,
  nr,
  fresh = false,
  onOpen,
}: {
  s: Session;
  nr: number;
  /** Came up just now: its mark blinks three times (spec rule 16). */
  fresh?: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const failing = s.status === "error" || s.status === "stale";
  const f = s.failure;
  const why = failing
    ? f?.text || s.detail || t("Turn fehlgeschlagen", "Turn failed")
    : s.detail || t("wartet auf deine Eingabe", "waits for your input");
  // One word with every other view (shared/inbox.ts waitKind): the hook's open permission is an approval, a sentence
  // that wants a yes is still a question in words.
  const kind = failing ? t("Fehler", "Error") : waitWord(waitKind(s), t);
  const act = errorAction(s, t);
  return (
    <article
      id={`s-${s.id}`}
      className={`arow ${failing ? "t-crit" : "t-warn"}`}
      aria-label={s.title || s.project}
      {...rowProps("alarm", "session", s.id, nr, {
        session: s.id,
        mute: alarmKey.session(s.id),
        approval: failing ? null : approvalHolder(s),
      })}
    >
      <span className="nr">{nr}</span>
      <span className="a-k">
        <Mark g={GLYPH[failing ? "errors" : "needs"]} fresh={fresh} />
        <span>{kind}</span>
      </span>
      <span className="a-where" title={s.branch ? `${s.project} · ${s.branch}` : s.project}>
        <b>{s.project}</b>
        {s.branch && <span className="mono"> {s.branch}</span>}
      </span>
      <span className="a-what">
        <h3>
          <button type="button" className="opener" onClick={onOpen} title={s.title || undefined} data-opener="">
            {s.title}
          </button>
        </h3>
        <span className="a-why" title={why}>
          {why}
        </span>
      </span>
      {/* A cache running out counts at every width: it stays on the phone (a-keep), "since" does not. */}
      <span className={!failing && s.cache ? "a-age a-keep a-cache" : "a-age"}>
        {failing ? (
          <Since at={s.statusSince || s.lastActivity} prefix={t("seit ", "for ")} />
        ) : s.cache ? (
          <CacheBadge s={s} />
        ) : (
          <Since at={s.statusSince || s.lastActivity} prefix={t("seit ", "for ")} />
        )}
      </span>
      <span className="a-act" data-act="">
        {!failing ? (
          <OpenButton s={s} />
        ) : f?.kind === "spend" && f.url && /^https:\/\/claude\.ai\/[^\s"'<>]*$/.test(f.url) ? (
          <ExtLink href={f.url} className="act-link">
            {t("Limit anheben", "Raise the limit")}
          </ExtLink>
        ) : (
          <OpenButton s={s} label={act.label} hint={act.hint} />
        )}
      </span>
      <ClearAlarm what={String(s.title || s.project || "")} session />
    </article>
  );
}

/**
 * Fleet cost more than it saved over three days: the one action is to look at the breakdown and switch off what
 * does not pay (a threshold, not an error: bright, not red).
 */
export function BalanceRow({ b, nr }: { b: NonNullable<Inbox["balance"]>; nr: number }) {
  const { t, locale } = useI18n();
  const why = `${t("3 Tage negativ", "3 days negative")}: ${signedToks(b.net, locale)} ${tokenWord(locale)} · ${t("Fleet hat", "Fleet spent")} ${toks(b.cost, locale)}${t(" verbraucht", "")}`;
  return (
    <article
      className="arow t-hi"
      aria-label={t("Fleet-Bilanz negativ", "Fleet balance negative")}
      {...rowProps("alarm", "balance", alarmKey.balance(b.since), nr, { mute: alarmKey.balance(b.since) })}
    >
      <span className="nr">{nr}</span>
      <span className="a-k">{t("Bilanz", "Balance")}</span>
      <span className="a-where">
        <b>{t("Fleet-Bilanz", "Fleet balance")}</b>
      </span>
      <span className="a-what">
        <span className="a-why" title={why}>
          {why}
        </span>
      </span>
      <span className="a-age" />
      <span className="a-act" data-act="">
        <Link className="act-link" to="/usage#balance">
          {t("Zum Verbrauch", "Go to usage")}
        </Link>
      </span>
      <ClearAlarm what={t("Fleet-Bilanz negativ", "Fleet balance negative")} />
    </article>
  );
}

/** A rate limit at 90 % or reached: only from the status line or the reported hit, never estimated. */
export function LimitRow({ l, nr }: { l: LimitAlarm; nr: number }) {
  const { t, locale } = useI18n();
  const name = l.kind === "seven_day" ? t("Wochenlimit", "Weekly limit") : t("5-Stunden-Limit", "Five-hour limit");
  const when = l.resetsAt
    ? l.resetsAt - Date.now() < 20 * 3600e3
      ? clock(l.resetsAt, locale)
      : dateTime(l.resetsAt, locale, true)
    : "";
  const why = l.hit
    ? `${t("erreicht", "reached")}${when ? ` – ${t("wieder frei", "free again")} ${when}` : ""}`
    : `${t("zu", "at")} ${Math.round(l.pct || 0)} %${when ? ` – Reset ${when}` : ""}`;
  return (
    // Not red: red stays for errors and red CI; sessions the limit stopped stand as errors already.
    <article
      className="arow t-hi"
      aria-label={name}
      {...rowProps("alarm", "limit", alarmKey.limit(l.kind), nr, { mute: alarmKey.limit(l.kind) })}
    >
      <span className="nr">{nr}</span>
      <span className="a-k">Limit</span>
      <span className="a-where">
        <b>{name}</b>
      </span>
      <span className="a-what">
        <span className="a-why" title={why}>
          {why}
        </span>
      </span>
      <span className="a-age" />
      <span className="a-act" data-act="">
        <Link className="act-link" to="/usage">
          {t("Zum Verbrauch", "Go to usage")}
        </Link>
      </span>
      <ClearAlarm what={name} />
    </article>
  );
}
