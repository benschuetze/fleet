import { useActions } from "~/lib/actions";
import { contextTokens, useDollars } from "~/lib/billing";
import { charBar, duration, mmss, money, tokenWord, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { conflictText, looping, loopText, worktreeCmd } from "~/lib/session";
import { useNow } from "~/lib/use-now";
import type { Session } from "../../../shared/types";
import { ConflictButton } from "../drawer/conflict-button";
import { Tag } from "../tag";

/** "since 12 min", ticking every 15 s. */
export function Since({ at, prefix = "" }: { at: number | null | undefined; prefix?: string }) {
  const { locale } = useI18n();
  const now = useNow(15000);
  if (!at) return null;
  return (
    <span>
      {prefix}
      {duration(now - at, locale)}
    </span>
  );
}

/** What rebuilding the cache costs: tokens on a plan (the context written again), dollars with API billing. */
export function rebuildText(s: Session, dollars: boolean, locale: string): string {
  const tok = contextTokens(s);
  if (dollars || tok === null) return dollars ? money(s.cache?.rebuild || 0, locale) : "–";
  return `${toks(tok, locale)} ${tokenWord(locale)}`;
}

/** Prompt cache of a waiting session: time left, afterwards what the next call costs. */
export function CacheBadge({ s }: { s: Session }) {
  const { t, locale } = useI18n();
  const dollars = useDollars();
  const now = useNow(1000);
  const c = s.cache;
  if (!c) return null;
  const tok = contextTokens(s);
  const left = c.until - now;
  if (left > 0) {
    return (
      <span
        className={`cache ${left < 5 * 60e3 ? "low" : ""}`}
        title={t(
          `Prompt-Cache (${c.ttl === "1h" ? "1 Stunde" : "5 Minuten"}) – solange er hält, liest der nächste Aufruf den Kontext günstig`,
          `Prompt cache (${c.ttl === "1h" ? "1 hour" : "5 minutes"}): while it holds, the next call reads the context cheaply`,
        )}
      >
        {/* The word goes on a phone's alarm row (rows.css), the countdown stays. */}
        <span className="cache-w">{t("Cache noch", "Cache for")} </span>
        {mmss(left)}
      </span>
    );
  }
  return (
    <span
      className="cache gone"
      title={t(
        "Cache abgelaufen – der nächste Aufruf schreibt den ganzen Kontext neu in den Cache",
        "Cache expired: the next call writes the whole context to the cache again",
      )}
    >
      {/* One short phrase like the board's cache column; the long sentence is the tooltip, the unit is for readers. */}
      <span className="sr">{t("Cache abgelaufen, nächster Aufruf", "Cache expired, next call")} </span>
      <span aria-hidden="true">{t("Cache kalt", "Cache cold")} </span>≈{" "}
      {dollars || tok === null ? rebuildText(s, dollars, locale) : toks(tok, locale)}
      {!dollars && tok !== null ? <span className="sr"> {tokenWord(locale)}</span> : null}
    </span>
  );
}

export function ContextBar({ s }: { s: Session }) {
  const { t, locale } = useI18n();
  const c = s.context;
  if (!c?.size || !["working", "stale", "needs_input", "waiting", "error", "idle"].includes(String(s.status)))
    return null;
  const pct = Math.max(0, Math.min(100, Number(c.pct) || 0));
  const lvl = pct >= 85 ? "c" : pct >= 70 ? "w" : "";
  const note = lvl === "c" ? t("fast voll", "almost full") : lvl === "w" ? t("bald voll", "filling up") : "";
  // One line on the grid, the bar in characters like on the watch board; a threshold is lighter grey, no colour.
  return (
    <p
      className={`ctx cbar ${lvl ? "hi" : ""}`}
      title={`${t("Kontextfenster", "Context window")}: ${toks(c.tokens, locale)} ${t("von", "of")} ${toks(c.size, locale)} ${tokenWord(locale)}${c.src === "transcript" ? t(" (aus dem Transcript gelesen)", " (read from the transcript)") : ""}`}
    >
      {t("Kontext", "Context")}{" "}
      <span
        role="progressbar"
        aria-label={t("Kontextfenster", "Context window")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        {charBar(pct, 12)}
      </span>{" "}
      {Math.round(pct)} % {t("von", "of")} {toks(c.size, locale)}
      {note && ` · ${note}`}
    </p>
  );
}

export function LoopTag({ s }: { s: Session }) {
  const { t } = useI18n();
  return looping(s) ? (
    <Tag tone="hi" title={loopText(s, t)}>
      {t("Schleife?", "Loop?")}
    </Tag>
  ) : null;
}

/** Two sessions in the same repo edited the same files: what collides is in the drawer, a worktree separates them. */
export function ConflictBox({ s }: { s: Session }) {
  const { t } = useI18n();
  const a = useActions();
  if (!s.conflict) return null;
  return (
    <>
      <p className="sd-msg sd-err">{conflictText(s, t)}</p>
      <div className="acts">
        {s.repoRoot &&
          s.conflict.with.map((w) => (
            <ConflictButton
              key={w.id}
              root={s.repoRoot as string}
              a={`s:${s.id}`}
              b={`s:${w.id}`}
              title={`${s.title || s.project} ↔ ${w.title}`}
              label={
                s.conflict && s.conflict.with.length > 1
                  ? t(`Konflikt mit „${w.title}“ ansehen`, `Show the conflict with "${w.title}"`)
                  : t("Konflikt ansehen", "Show conflict")
              }
            />
          ))}
        <button
          type="button"
          className="ghost"
          title={t(
            "Eigener Ordner und Branch für eine der beiden Sessions",
            "Own folder and branch for one of the two sessions",
          )}
          onClick={() => a.copy(worktreeCmd(s), t("Befehl", "Command"))}
        >
          {t("Worktree-Befehl kopieren", "Copy worktree command")}
        </button>
      </div>
    </>
  );
}

// Hints are notable, not alarms: brighter grey instead of a signal colour.
const ADV_TONE = { warn: "hi", info: "blue", ok: "green" } as const;

/** The most important advice as a short label. */
export function adviceShort(a: NonNullable<Session["advice"]>[number], t: (de: string, en: string) => string): string {
  if (a.kind === "model")
    return a.model
      ? `${t("Tipp", "Tip")}: ${a.title.replace(/ (reicht|versuchen|erwägen|is enough|try|consider)$/i, "")}`
      : t("Modell passt", "Model fits");
  return a.kind === "handoff" ? t("Übergabe", "Handoff") : "Cache";
}

/** On the card only what is urgent; all hints are in the expanded view. */
export function AdviceTag({ s }: { s: Session }) {
  const { t } = useI18n();
  const a = (s.advice || []).find((x) => x.level !== "ok");
  if (a?.level !== "warn" || s.status === "ended") return null;
  return (
    <Tag tone={ADV_TONE[a.level]} title={`${a.title}: ${a.text}`}>
      {adviceShort(a, t)}
    </Tag>
  );
}

export { ADV_TONE };
