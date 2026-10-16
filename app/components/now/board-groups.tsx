import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { rowProps } from "~/lib/rows";
import { continueCmd } from "~/lib/session";
import { usePlaces } from "~/lib/use-status";
import type { CiCard } from "../../../shared/inbox";
import type { Duplicate } from "../../../shared/types";
import { ConflictButton } from "../drawer/conflict-button";
import { dupPair, dupReason, dupState, dupTitle } from "../drawer/dup-panel";
import { openedRecently, type ReadyRepo } from "../drawer/handoff-panel";
import { CI_SYM } from "../mark";
import { ExtLink } from "../tag";
import { Age } from "./board-row";
import { useRun } from "./ci-card";

/**
 * The groups at the end of the watch board (plan, stage 12.2): what used to be cards is one line each, with one
 * action; everything that needs more than a line is in the drawer (spec rule 9). Each row spans the board's columns
 * like a session row: number, mark, repo, then the text across branch and task.
 */

/** A mark that is no session state (duplicate, handoff, CI): grey, with its word for screen readers. */
function GroupMark({ c, label }: { c: string; label: string }) {
  return (
    <span className="mark" role="img" aria-label={label} title={label}>
      {c}
    </span>
  );
}

/**
 * A pipeline that runs: what it is, the job running now (refreshed every 5 s), and cancel as its one action. Its
 * jobs are on GitHub: the title links there. The drawer key opens its CI drawer, as on a red run in the alarm zone;
 * it never opens a browser tab unasked.
 */
export function CiRow({ c, nr }: { c: CiCard; nr: number }) {
  const { t } = useI18n();
  const { id, heading, cause, main } = useRun(c, false);
  const text = `${heading} · ${cause}`;
  return (
    <tr
      className="b-row b-ci"
      aria-label={`${c.repo} · ${heading}`}
      {...rowProps("board", "ci", `ci:${c.key}`, nr)}
      data-root={c.root}
      data-run={id || undefined}
    >
      <td className="c-nr nr">{nr}</td>
      <td className="c-st">
        <GroupMark c={CI_SYM.running} label={t("CI läuft", "CI running")} />
      </td>
      <td className="c-repo" title={c.repo}>
        {c.repo}
      </td>
      <td className="c-branch mono t-hide" title={c.branch || ""}>
        {c.branch || ""}
      </td>
      <td className="c-task" title={text}>
        <ExtLink href={c.run?.url || c.pr?.url} className="opener">
          {text}
        </ExtLink>
      </td>
      <td className="c-doing">{c.run?.state === "pending" ? t("wartet", "waiting") : t("läuft", "running")}</td>
      <td colSpan={4} />
      <td className="c-act m-hide" data-act="">
        {main}
      </td>
    </tr>
  );
}

/**
 * A handoff nobody continues yet: when it was written and how many next steps it has. The row continues it in the
 * preferred target; its title (and Enter) opens the handoff drawer with every step and every target.
 */
export function HandoffRow({ r, nr }: { r: ReadyRepo; nr: number }) {
  const { t, locale } = useI18n();
  const { openDrawer, preferred, data } = useFleet();
  const a = useActions();
  const h = r.handoff;
  const opened = openedRecently(h);
  const steps = h.next.length;
  const text = `${t("Übergabe", "Handoff")} ${clock(h.at, locale)}${steps ? ` · ${steps === 1 ? t("1 nächster Schritt", "1 next step") : t(`${steps} nächste Schritte`, `${steps} next steps`)}` : ""}`;
  const go = () =>
    preferred
      ? a.continueIn(r.root, preferred.id)
      : a.copy(
          continueCmd(r.root, data?.platform || "", t("Mach mit der Übergabe weiter", "Continue from the handoff")),
          t("Befehl", "Command"),
        );
  return (
    <tr className="b-row b-ho" aria-label={r.name} {...rowProps("board", "handoff", `ho:${r.root}`, nr)}>
      <td className="c-nr nr">{nr}</td>
      <td className="c-st">
        <GroupMark c="↷" label={t("Übergabe bereit", "Handoff ready")} />
      </td>
      <td className="c-repo" title={r.name}>
        {r.name}
      </td>
      <td className="c-branch mono t-hide" title={r.branch || ""}>
        {r.branch || ""}
      </td>
      <td className="c-task">
        <button
          type="button"
          className="opener"
          title={text}
          data-opener=""
          onClick={() => openDrawer({ kind: "handoff", root: r.root, title: r.name })}
        >
          {text}
        </button>
      </td>
      <td
        className="c-doing"
        title={
          opened
            ? t("Neue Session geöffnet – dort mit Enter abschicken", "New session opened: send it there with Enter")
            : undefined
        }
      >
        {opened ? t("geöffnet", "opened") : t("bereit", "ready")}
      </td>
      <td className="c-age num m-hide">
        <Age at={h.at} />
      </td>
      <td colSpan={3} />
      <td className="c-act m-hide" data-act="">
        <button
          type="button"
          className="act-link"
          title={
            preferred ? `${t("Weiter in", "Continue in")} ${preferred.label}` : t("Befehl kopieren", "Copy command")
          }
          onClick={go}
        >
          {opened ? t("Nochmal", "Again") : t("Weiter", "Continue")}
        </button>
      </td>
    </tr>
  );
}

/**
 * Sessions on the same work in one checkout. With shared files it is "Doppelt"; same branch or task alone stands grey
 * under "Parallel". The row opens the conflict drawer, with the group and how to merge it on top.
 */
export function DupRow({ d, nr }: { d: Duplicate; nr: number }) {
  const { t } = useI18n();
  const state = dupState(d, usePlaces(), t);
  const pair = dupPair(d);
  const n = d.sessions.length;
  const text = `${t(`${n} Sessions`, `${n} sessions`)} · ${dupReason(d, t)}`;
  const button = (label: string, opener: boolean) =>
    pair ? (
      <ConflictButton
        root={d.root}
        a={`s:${pair[0]}`}
        b={`s:${pair[1]}`}
        dup
        title={dupTitle(d, pair[0], pair[1])}
        label={label}
        className={opener ? "opener" : "act-link"}
        opener={opener}
      />
    ) : (
      label
    );
  return (
    <tr
      className={`b-row b-dup${d.overlap ? "" : " parallel"}`}
      aria-label={d.repo}
      {...rowProps("board", "dup", `dup:${d.root}`, nr)}
    >
      <td className="c-nr nr">{nr}</td>
      <td className="c-st">
        <GroupMark c="⇄" label={d.overlap ? t("doppelt", "duplicate") : t("parallel", "parallel")} />
      </td>
      <td className="c-repo" title={d.repo}>
        {d.repo}
      </td>
      <td className="c-task" colSpan={2} title={text}>
        {button(text, true)}
      </td>
      {/* Over the doing, age, context, cache and PR columns: "1 wartet, 1 arbeitet, 1 fertig" is longer than one. */}
      <td className="c-doing c-span" colSpan={5} title={state}>
        {state}
      </td>
      <td className="c-act m-hide" data-act="">
        {button(d.overlap ? t("Konflikt", "Conflict") : t("Ansehen", "Show"), false)}
      </td>
    </tr>
  );
}
