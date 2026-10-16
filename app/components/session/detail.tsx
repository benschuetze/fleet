import { useRef, useState } from "react";
import { useActions } from "~/lib/actions";
import { useDollars } from "~/lib/billing";
import { useFleet } from "~/lib/fleet";
import { ago, money, pct, tildify, tokenWord, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { looping, loopText, resumeCmds } from "~/lib/session";
import { useLastActive, useStatus } from "~/lib/use-status";
import { dateTimeFull } from "../../../shared/dates";
import type { Session } from "../../../shared/types";
import { GitTags, PrTags } from "../ci-tags";
import { ExtLink, Tag } from "../tag";
import { ADV_TONE, AdviceTag, ConflictBox, ContextBar, LoopTag } from "./bits";
import { SessionChat } from "./chat";
import { FreshButton } from "./fresh-button";
import { OpenButton, OpenMenu } from "./open";
import { ResultLine } from "./result";

/**
 * A session opened up in the drawer, as lines on the grid (spec, "Ein Schirm im CLI-Look", rules 8, 9): the last
 * answer, tasks, efficiency hints, where to open it, what it worked on, technical details and a note that saves
 * itself while typing. The drawer's frame line already names it; no card, no frame around a tag.
 */
export function SessionDetail({ s }: { s: Session }) {
  const { t, locale } = useI18n();
  const statusOf = useStatus();
  const lastActive = useLastActive();
  const dollars = useDollars();
  const { data, repoByRoot } = useFleet();
  const a = useActions();
  const r = s.repoRoot ? repoByRoot.get(s.repoRoot) : undefined;
  const st = statusOf(s);
  const remote = s.source === "cloud" || s.source === "cowork";
  const rc = !remote ? resumeCmds(s, data?.platform || "") : {};
  const advice = (s.advice || []).filter((x) => x.level !== "ok");

  return (
    <div className="sd">
      <p className="sd-dim">
        {s.meta?.pinned && <>★ {t("angepinnt", "pinned")} · </>}
        {t("zuletzt aktiv", "last active")} {ago(lastActive(s), locale)}
      </p>
      {s.status === "needs_input" && s.detail ? (
        <p className="sd-msg sd-ask">{s.detail}</p>
      ) : s.status === "error" && s.detail ? (
        <p className="sd-msg sd-err">{s.detail}</p>
      ) : null}
      {s.lastPrompt && (
        <p className="sd-dim" title={s.lastPrompt}>
          {t("Auftrag", "Task")}: {s.lastPrompt}
        </p>
      )}
      <SessionChat s={s} />
      <ConflictBox s={s} />
      {s.next && (
        <p className="sd-msg">
          ↷ {t("Weiter in neuer Session", "Continues in a new session")}
          {s.next.title && (
            <>
              : <b>{s.next.title}</b>
            </>
          )}
        </p>
      )}
      <p className="sd-tags">
        <Tag tone={st.tone}>{st.label}</Tag>
        <LoopTag s={s} />
        <AdviceTag s={s} />
        {s.source === "cowork" && <Tag tone="violet">Cowork</Tag>}
        <PrTags ci={s.ci} />
        {s.usage && s.usage.cost >= 0.01 && (
          <Tag
            mono
            title={
              dollars
                ? `${toks(s.usage.tok, locale)} ${tokenWord(locale)} · ${t("Listenpreise, Schätzung", "list prices, estimate")}`
                : t("Input + Output + Cache-Schreiben", "input + output + cache writes")
            }
          >
            {dollars ? money(s.usage.cost, locale) : `${toks(s.usage.tok, locale)} ${tokenWord(locale)}`}
          </Tag>
        )}
      </p>
      <ContextBar s={s} />
      <ResultLine s={s} />
      <div className="detail">
        {s.todos && s.todos.length > 0 && (
          <>
            <h4 className="sd-h">{t("Aufgaben", "Tasks")}</h4>
            <ul className="sd-todos" aria-label={t("Aufgaben", "Tasks")}>
              {s.todos.map((x, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: todo items have no id; the position is their identity
                  key={`${i}-${x.content}`}
                  className={x.status === "completed" ? "done" : x.status === "in_progress" ? "now" : ""}
                >
                  {/* ✓ done, ▸ now, · open: a character in the first column, like the status marks */}
                  <span aria-hidden="true">
                    {x.status === "completed" ? "✓" : x.status === "in_progress" ? "▸" : "·"}
                  </span>{" "}
                  {x.content}
                </li>
              ))}
            </ul>
          </>
        )}
        {advice.length > 0 && (
          <>
            <h4 className="sd-h">{t("Effizienz", "Efficiency")}</h4>
            <ul className="sd-advice">
              {advice.map((x) => (
                <li key={x.title}>
                  <Tag tone={ADV_TONE[x.level]}>
                    {x.level === "warn" ? t("wichtig", "important") : t("Tipp", "tip")}
                  </Tag>{" "}
                  <b>{x.title}</b>
                  <p>{x.text}</p>
                  {x.how && (
                    <div className="acts">
                      <button
                        type="button"
                        className="link"
                        onClick={() => a.copy(x.how as string, t("Befehl", "Command"))}
                      >
                        {x.how} {t("kopieren", "copy")}
                      </button>
                    </div>
                  )}
                  {x.kind === "handoff" && (
                    <div className="acts">
                      <FreshButton s={s} />
                      <button
                        type="button"
                        className="link"
                        onClick={() => a.copy(data?.handoffPrompt || "", t("Übergabe-Prompt", "Handoff prompt"))}
                      >
                        {t("Übergabe-Prompt kopieren", "Copy handoff prompt")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {!remote && <OpenMenu s={s} />}
        {!remote && s.status === "waiting" && !s.next && (
          <div className="acts">
            <button
              type="button"
              className="link"
              title={t(
                "Die Session schreibt ihre Übergabe jetzt im Hintergrund (headless); die Tokens stehen danach in der Statuszeile",
                "The session writes its handoff now in the background (headless); the tokens show in the status line afterwards",
              )}
              onClick={() => a.handoffJob(s)}
            >
              {t("Übergabe jetzt (Job)", "Handoff now (job)")}
            </button>
          </div>
        )}
        <dl className="kv">
          {s.lastPrompt && (
            <>
              <dt>{t("Letzter Auftrag", "Last task")}</dt>
              <dd>{s.lastPrompt}</dd>
            </>
          )}
          {s.cwd && (
            <>
              <dt>{t("Ordner", "Folder")}</dt>
              <dd className="mono path" title={s.cwd}>
                {tildify(s.cwd)}
              </dd>
            </>
          )}
          {s.model && (
            <>
              <dt>{t("Modell", "Model")}</dt>
              <dd>{s.model}</dd>
            </>
          )}
          {s.usage && (
            <>
              <dt>{t("Verbrauch", "Usage")}</dt>
              <dd>
                {toks(s.usage.tok, locale)} {tokenWord(locale)}
                {dollars && ` · ${money(s.usage.cost, locale)}`}
                {dollars && s.usage.sub >= 0.01 && ` (${t("Subagenten", "subagents")} ${money(s.usage.sub, locale)})`} ·{" "}
                {t("Cache gelesen", "cache read")} {toks(s.usage.cr, locale)}
                {pct(s.usage.cacheRate) && ` (${pct(s.usage.cacheRate)} ${t("Treffer", "hits")})`}
              </dd>
            </>
          )}
          {looping(s) && (
            <>
              <dt>{t("Auffällig", "Notable")}</dt>
              <dd>{loopText(s, t)}</dd>
            </>
          )}
        </dl>
        <details className="tech">
          <summary>{t("Technische Details", "Technical details")}</summary>
          <dl className="kv">
            {!!s.compactions && (
              <>
                <dt>{t("Komprimiert", "Compacted")}</dt>
                <dd>{s.compactions}×</dd>
              </>
            )}
            {s.lastTool && (
              <>
                <dt>{t("Letztes Tool", "Last tool")}</dt>
                <dd>{s.lastTool}</dd>
              </>
            )}
            {s.startedAt && (
              <>
                <dt>{t("Gestartet", "Started")}</dt>
                <dd>{dateTimeFull(s.startedAt, locale)}</dd>
              </>
            )}
            {r?.lastCommit && (
              <>
                <dt>{t("Letzter Commit", "Last commit")}</dt>
                <dd>
                  <span className="mono">{r.lastCommit.hash}</span> {r.lastCommit.subject} (
                  {ago(r.lastCommit.at, locale)})
                </dd>
              </>
            )}
            {r && (
              <>
                <dt>Git</dt>
                <dd className="sd-tags">
                  <GitTags r={r} />
                </dd>
              </>
            )}
            <dt>{t("Status-Quelle", "Status source")}</dt>
            <dd>{s.statusSource || s.source}</dd>
            <dt>{t("Session-ID", "Session id")}</dt>
            <dd className="mono">{s.id}</dd>
            {rc.alt && (
              <>
                <dt>Resume ({rc.altLabel})</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    onClick={() => a.copy(rc.alt as string, `Resume (${rc.altLabel})`)}
                  >
                    {rc.alt}
                  </button>
                </dd>
              </>
            )}
          </dl>
        </details>
        <Note s={s} />
        {remote && s.url && (
          <p>
            <ExtLink href={s.url} className="link">
              {t("Session öffnen", "Open session")} ↗
            </ExtLink>
          </p>
        )}
      </div>
      <div className="acts">
        {!remote ? <OpenButton s={s} /> : null}
        {s.fresh && !advice.some((x) => x.kind === "handoff") && <FreshButton s={s} />}
        <MetaButtons s={s} />
      </div>
    </div>
  );
}

/** A note per session; saves 0.8 s after typing stops and when leaving the field. */
function Note({ s }: { s: Session }) {
  const { t } = useI18n();
  const a = useActions();
  const [text, setText] = useState(s.meta?.note || "");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saved = useRef(s.meta?.note || "");
  const store = (v: string, quiet: boolean) => {
    clearTimeout(timer.current);
    if (v === saved.current) return;
    saved.current = v;
    a.meta(s.id, { note: v }, quiet);
  };
  const id = `note-${s.id}`;
  return (
    <>
      <h4 className="sd-h">
        <label htmlFor={id}>{t("Notiz", "Note")}</label>
      </h4>
      <textarea
        className="sd-note"
        rows={3}
        id={id}
        maxLength={2000}
        placeholder={t("Nächster Schritt, Blocker, Kontext…", "Next step, blocker, context…")}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => store(v, true), 800);
        }}
        onBlur={() => store(text, false)}
      />
    </>
  );
}

export function MetaButtons({ s }: { s: Session }) {
  const { t } = useI18n();
  const a = useActions();
  const { showToast } = useFleet();
  const { hideSession } = useKeys();
  const title = String(s.title || s.project || "");
  return (
    <>
      {/* Words, not icons: a button in the drawer is text on the grid (rule 8). */}
      <button
        type="button"
        className="link"
        aria-pressed={!!s.meta?.pinned}
        onClick={() => a.meta(s.id, { pinned: !s.meta?.pinned })}
      >
        {s.meta?.pinned ? t("Lösen", "Unpin") : t("Anpinnen", "Pin")}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => {
          // Hiding goes the road of `x` (round 7: a waiting session was hidden here without the y/n, and the focus
          // fell on the body); showing again needs no question.
          if (!s.meta?.hidden) return hideSession(s.id);
          a.meta(s.id, { hidden: false });
          showToast(t(`${title}: wieder eingeblendet`, `${title}: shown again`));
        }}
      >
        {s.meta?.hidden ? t("Wieder einblenden", "Show again") : t("Ausblenden", "Hide")}
      </button>
    </>
  );
}
