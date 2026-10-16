import { useDollars } from "~/lib/billing";
import { useFleet } from "~/lib/fleet";
import { age, charBar, mmss, tokenWord } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { rowProps } from "~/lib/rows";
import { type ActivityKind, activity, conflictText, looping, loopText } from "~/lib/session";
import { useNow } from "~/lib/use-now";
import { useStatus } from "~/lib/use-status";
import type { CiCard, Glyph } from "../../../shared/inbox";
import { fleetWorktree } from "../../../shared/repo";
import type { Session } from "../../../shared/types";
import { CI_SYM, Mark } from "../mark";
import { rebuildText } from "../session/bits";
import { FreshButton } from "../session/fresh-button";
import { OpenButton } from "../session/open";
import { MergeButton } from "../session/result";
import { ExtLink } from "../tag";

/** Ticks every second (spec rule 16): the one thing that moves on a working row, since its mark stands still. */
export function Age({ at }: { at: number | null | undefined }) {
  const { locale } = useI18n();
  const now = useNow(1000);
  return at ? age(now - at, locale) : null;
}

/**
 * Context as a character bar with the number next to it. From 70 % bar and number turn bright: a threshold is no
 * error, and colour is kept for errors, waiting and editable fields (spec, Recherche II).
 */
export function CtxBar({ s }: { s: Session }) {
  const { t } = useI18n();
  const c = s.context;
  if (!c?.size) return null;
  const pct = Math.round(Math.max(0, Math.min(100, Number(c.pct) || 0)));
  const lvl = pct >= 70 ? "hi" : "";
  return (
    <span className={`cbar ${lvl}`} title={`${t("Kontextfenster", "Context window")}: ${pct} %`}>
      <span
        className="cb"
        role="progressbar"
        aria-label={t("Kontextfenster", "Context window")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        {charBar(pct)}
      </span>
      <span className="num">{pct} %</span>
    </span>
  );
}

/** Prompt cache left as mm:ss, bright under five minutes; once expired, what the next call costs. */
export function CacheCell({ s }: { s: Session }) {
  const { t, locale } = useI18n();
  const dollars = useDollars();
  const now = useNow(1000);
  const c = s.cache;
  if (!c) return null;
  const left = c.until - now;
  const why = t(
    `Prompt-Cache (${c.ttl === "1h" ? "1 Stunde" : "5 Minuten"}) – solange er hält, liest der nächste Aufruf den Kontext günstig`,
    `Prompt cache (${c.ttl === "1h" ? "1 hour" : "5 minutes"}): while it holds, the next call reads the context cheaply`,
  );
  return left > 0 ? (
    <span className={left < 5 * 60e3 ? "hi" : ""} title={why}>
      <span className="sr">{t("Cache noch", "Cache for")} </span>
      {mmss(left)}
    </span>
  ) : (
    <span
      title={t(
        "Cache abgelaufen – der nächste Aufruf schreibt den ganzen Kontext neu in den Cache",
        "Cache expired: the next call writes the whole context to the cache again",
      )}
    >
      <span className="sr">{t("Cache abgelaufen, nächster Aufruf", "Cache expired, next call")} </span>≈{" "}
      {/* The column says the number, the screen reader and the title the unit (round 7: 19 columns took the task's room). */}
      {rebuildText(s, dollars, locale).replace(/ [Tt]okens$/, "")}
      {!dollars && /[Tt]okens$/.test(rebuildText(s, dollars, locale)) ? (
        <span className="sr"> {tokenWord(locale)}</span>
      ) : null}
    </span>
  );
}

/**
 * The PR of the row (only the youngest session of a PR carries it). Red CI is said here only while this session
 * fixes it; otherwise the alarm zone says it, once.
 */
export function PrCell({ s, red }: { s: Session; red: CiCard | null }) {
  const { t } = useI18n();
  const pr = s.ci?.pr;
  if (!pr && !red) return null;
  const state: Record<string, string> = {
    draft: t("Entwurf", "draft"),
    merged: t("gemergt", "merged"),
    closed: t("zu", "closed"),
  };
  const ci = red
    ? null
    : pr?.ci === "success"
      ? { sym: CI_SYM.ok, label: t("CI grün", "CI green") }
      : pr?.ci === "running" || pr?.ci === "pending"
        ? { sym: CI_SYM.running, label: t("CI läuft", "CI running") }
        : null;
  const label = pr ? `#${pr.number}` : "CI";
  return (
    <span className="pr-cell">
      <ExtLink href={pr?.url || red?.run?.url} className="pr-n">
        {label}
      </ExtLink>
      {pr && state[pr.state] ? <span className="hint"> {state[pr.state]}</span> : null}
      {ci ? (
        // A labelled image, not an .sr span: that one is absolutely positioned, escapes the cell's clipping and
        // widens the page on a phone.
        <span className="hint">
          {" "}
          <span role="img" aria-label={ci.label} title={ci.label}>
            {ci.sym}
          </span>
        </span>
      ) : null}
      {red && (
        <span className="sig crit">
          <span aria-hidden="true">{CI_SYM.failed}</span> {t("CI rot", "CI red")}
        </span>
      )}
    </span>
  );
}

export type Kind = "working" | "done" | "resting" | "archive";

/** What a working session does, in one short word for the activity column; the sentence is in its tooltip. */
const DOING: Record<ActivityKind, (t: (de: string, en: string) => string) => string> = {
  edit: (t) => t("schreibt", "writes"),
  read: (t) => t("liest", "reads"),
  term: () => "Bash",
  web: () => "Web",
  agent: () => "Agent",
  plan: (t) => t("plant", "plans"),
  plug: () => "MCP",
  think: (t) => t("denkt", "thinks"),
  ask: (t) => t("fragt", "asks"),
};

/** One session in one line. Long values never wrap: they end in an ellipsis, the full text is in the tooltip. */
export function BoardRow({
  s,
  nr,
  kind,
  glyph,
  red,
  onOpen,
}: {
  s: Session;
  nr: number;
  kind: Kind;
  glyph: Glyph;
  red: CiCard | null;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const statusOf = useStatus();
  const { data } = useFleet();
  const st = statusOf(s);
  const wt = fleetWorktree(s.repoRoot);
  const [doing, what] = activity(s, t);
  const word =
    kind === "working"
      ? s.proc?.job
        ? t("Fleet-Job", "Fleet job")
        : t("arbeitet", "working")
      : s.next
        ? t("abgelöst", "replaced")
        : st.label;
  // Only where Fleet could run it itself; without its terminal every session is external and the mark says nothing.
  const external = !!data?.terminal?.available && !s.proc && (kind === "working" || kind === "done");
  const todos = s.todos || [];
  const step = todos.find((x) => x.status === "in_progress");
  const doneSteps = todos.filter((x) => x.status === "completed").length;
  const status =
    kind === "working"
      ? `${what}${todos.length ? ` · ${t("Schritt", "step")} ${Math.min(doneSteps + 1, todos.length)}/${todos.length}${step ? `: ${step.activeForm || step.content}` : ""}` : ""}`
      : s.next
        ? `${t("abgelöst", "replaced")}: ${s.next.title || ""}`
        : st.label;
  const open = <OpenButton s={s} />;
  const action =
    kind === "done" ? (
      <MergeButton
        s={s}
        fallback={s.fresh ? <FreshButton s={s} label={t("Frisch weiter", "Continue fresh")} /> : open}
      />
    ) : (
      open
    );
  return (
    <tr
      id={`s-${s.id}`}
      className="b-row"
      aria-label={s.title || s.project}
      {...rowProps("board", "session", s.id, nr, { session: s.id })}
    >
      <td className="c-nr nr">{nr}</td>
      <td className="c-st">
        <Mark g={glyph} label={word} />
        {external && (
          <span
            className="ext"
            role="img"
            aria-label={t("extern", "external")}
            title={t(
              "Läuft außerhalb von Fleet (Desktop-App, VS Code, eigenes Terminal): hier nur lesend",
              "Runs outside Fleet (desktop app, VS Code, own terminal): read-only here",
            )}
          >
            ≡
          </span>
        )}
      </td>
      <td className="c-repo" title={wt ? `${s.project} · ${t("Worktree", "worktree")} ${s.cwd || wt.name}` : s.project}>
        {s.meta?.pinned && (
          <span role="img" aria-label={t("angepinnt", "pinned")}>
            ★{" "}
          </span>
        )}
        {s.project}
        {wt && <span className="wt-mark"> ⎇ {wt.name}</span>}
      </td>
      <td className="c-branch mono t-hide" title={s.branch || ""}>
        {s.branch || ""}
      </td>
      <td className="c-task">
        <button type="button" className="opener" onClick={onOpen} title={s.title || undefined} data-opener="">
          {s.title}
        </button>
      </td>
      <td className="c-doing" title={status}>
        {s.conflict ? (
          <span className="sig hi" title={conflictText(s, t)}>
            {t("Konflikt?", "Conflict?")}
          </span>
        ) : looping(s) ? (
          <span className="sig hi" title={loopText(s, t)}>
            {t("Schleife?", "Loop?")}
          </span>
        ) : kind === "working" && !s.proc?.job ? (
          DOING[doing](t)
        ) : (
          word
        )}
      </td>
      <td className="c-age num m-hide">
        <Age at={s.statusSince || s.lastActivity} />
      </td>
      <td className="c-ctx m-hide">
        <CtxBar s={s} />
      </td>
      <td className="c-cache num t-hide">
        <CacheCell s={s} />
      </td>
      <td className="c-pr">
        <PrCell s={s} red={red} />
      </td>
      <td className="c-act m-hide">{kind === "archive" && !s.next ? open : action}</td>
    </tr>
  );
}
