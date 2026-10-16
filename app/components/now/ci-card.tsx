import { useCallback, useEffect, useState } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { rowProps } from "~/lib/rows";
import { fetchRun } from "~/lib/run";
import { alarmKey } from "~/lib/view";
import type { CiCard } from "../../../shared/inbox";
import type { RunDetails } from "../../../shared/types";
import { CI_SYM } from "../mark";
import { ExtLink } from "../tag";
import { ClearAlarm } from "./alarm-rows";

const RUN_ICON: Record<string, string> = {
  success: CI_SYM.ok,
  failure: CI_SYM.failed,
  skipped: "–",
  pending: "•",
  none: "·",
  running: CI_SYM.running,
};

/**
 * A red pipeline in one row of the alarm zone. The row has one action: a fix session, or GitHub when Fleet knows no
 * run id. Its title opens the drawer with the jobs, failed tests, log excerpt and the other actions (rule 9: what
 * needs more than one line goes there); running pipelines are board rows (`CiRow`).
 */
export function CiCardView({ c, nr }: { c: CiCard; nr: number }) {
  const { t } = useI18n();
  const { openDrawer } = useFleet();
  const { live, id, heading, cause, main } = useRun(c, false);
  return (
    <article
      className={`arow ${live ? "" : "t-crit"}`}
      aria-label={`${c.repo} · ${heading}`}
      {...rowProps("alarm", "ci", alarmKey.ci(c.key), nr, { mute: alarmKey.ci(c.key) })}
      data-root={c.root}
      data-run={id || undefined}
      data-url={c.run?.url || c.pr?.url || undefined}
    >
      <span className="nr">{nr}</span>
      <span className="a-k">{live ? t("CI läuft", "CI running") : t("CI rot", "CI red")}</span>
      <span className="a-where" title={c.branch ? `${c.repo} · ${c.branch}` : c.repo}>
        <b>{c.repo}</b>
        {c.branch && <span className="mono"> {c.branch}</span>}
      </span>
      <span className="a-what">
        <button
          type="button"
          className="opener"
          onClick={() => openDrawer({ kind: "ci", id: c.key, title: `${c.repo} · ${heading}` })}
          title={t("Jobs, Tests und Log in der Schublade", "Jobs, tests and log in the drawer")}
          data-opener=""
        >
          {heading}
        </button>
        <span className="a-why" title={cause}>
          {cause}
        </span>
      </span>
      <span className="a-age" />
      <span className="a-act" data-act="">
        {main}
      </span>
      <ClearAlarm what={`${c.repo} · ${heading}`} />
    </article>
  );
}

/**
 * A pipeline's run as the alarm row and the board row both need it: its details (a running run refreshes every 5 s,
 * an opened red one loads once), what it is and does in words, and its actions. `main` is the row's one action: a fix
 * session for a red run, cancel for a running one, GitHub when Fleet knows no run id.
 */
export function useRun(c: CiCard, open: boolean) {
  const { t } = useI18n();
  const { preferred } = useFleet();
  const a = useActions();
  const live = c.run?.state === "running" || c.run?.state === "pending";
  const [details, setDetails] = useState<RunDetails | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = c.run?.id;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setDetails(await fetchRun(c.root, id));
    } catch {
      setDetails({ error: t("Details nicht erreichbar", "Details not reachable") });
    }
  }, [c.root, id, t]);

  // Running runs refresh every 5 s; an opened red run loads once.
  useEffect(() => {
    if (!id || (!live && !open)) return;
    load();
    if (!live) return;
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 5000);
    return () => clearInterval(timer);
  }, [id, live, open, load]);

  const act = async (action: "rerun" | "cancel" | "fix") => {
    if (!id) return;
    setBusy(true);
    await a.runAction(c.root, id, action, action === "fix" ? preferred?.id : undefined);
    setDetails(null);
    setBusy(false);
  };
  const d = details && !("error" in details) ? details : null;
  const cur = live && d ? d.jobs.find((j) => j.state === "running") : null;
  const what = live
    ? c.run?.state === "pending"
      ? t("wartet auf einen Runner", "waiting for a runner")
      : t("läuft", "running")
    : c.run?.state === "failure"
      ? t("Pipeline fehlgeschlagen", "pipeline failed")
      : t("PR-Checks fehlgeschlagen", "PR checks failed");
  const heading = c.pr
    ? `PR #${c.pr.number}${c.pr.title ? ` · ${c.pr.title}` : ""}`
    : `${t("Letzter Lauf", "Last run")}${c.branch ? ` ${t("auf", "on")} ${c.branch}` : ""}`;
  const cause = `${what}${c.run?.name ? ` – ${c.run.name}` : ""}${cur ? ` · ${cur.name}${cur.current ? `: ${cur.current}` : ""}` : ""}`;
  const github = (
    <ExtLink href={c.run?.url || c.pr?.url} className="act-link">
      GitHub
    </ExtLink>
  );
  const rerun = (
    <button
      type="button"
      className="act-link"
      disabled={busy}
      title={t("Nur die fehlgeschlagenen Jobs neu starten", "Restart only the failed jobs")}
      onClick={() => act("rerun")}
    >
      {t("Neu starten", "Re-run")}
    </button>
  );
  const fix =
    preferred && id ? (
      <button
        type="button"
        className="act-link"
        disabled={busy}
        title={t(
          "Neue Session im Repo mit Job, Fehler und Log-Befehl",
          "New session in the repo with job, error and log command",
        )}
        onClick={() => act("fix")}
      >
        {t("Fix-Session starten", "Start a fix session")}
      </button>
    ) : null;
  // The one action of the row; the others wait in the opened row.
  const main = !id ? (
    github
  ) : live ? (
    <button type="button" className="act-link" disabled={busy} onClick={() => act("cancel")}>
      {t("Abbrechen", "Cancel")}
    </button>
  ) : (
    fix || rerun
  );
  return { live, id, details, heading, cause, fix, rerun, github, main };
}

export function RunPanel({ details }: { details: RunDetails | { error: string } | null }) {
  const { t } = useI18n();
  if (!details)
    return <div className="runbox">{<span className="sub">{t("Lade Details…", "Loading details…")}</span>}</div>;
  if ("error" in details) {
    return (
      <div className="runbox">
        <span className="note">{details.error}</span>
      </div>
    );
  }
  const label: Record<string, string> = {
    success: t("erfolgreich", "succeeded"),
    failure: t("fehlgeschlagen", "failed"),
    skipped: t("übersprungen", "skipped"),
    pending: t("wartet", "waiting"),
    none: t("ohne Status", "no status"),
    running: t("läuft", "running"),
  };
  // The same reason for every failed job (e.g. the spending limit): once at the top instead of at every job.
  const failed = details.jobs.filter((j) => j.state === "failure");
  const common =
    failed.length > 1 && failed[0]?.notes.length
      ? failed[0].notes.filter((n) => failed.every((j) => j.notes.includes(n)))
      : [];
  return (
    <div className="runbox">
      {common.map((n) => (
        <div key={n} className="note">
          {t("Alle fehlgeschlagenen Jobs", "All failed jobs")}: {n}
        </div>
      ))}
      <span className="sub">
        {details.workflow || "Workflow"}
        {details.title ? ` · ${details.title}` : ""}
        {details.sha && (
          <>
            {" · "}
            <span className="mono">{details.sha.slice(0, 7)}</span>
          </>
        )}
      </span>
      <ul className="jobs">
        {details.jobs.map((j) => {
          const failStep = j.state === "failure" ? j.steps.find((x) => x.state === "failure") : null;
          return (
            <li key={`${j.id}-${j.name}`}>
              <span className={`st ${j.state}`} role="img" aria-label={label[j.state] || j.state}>
                {RUN_ICON[j.state] || ""}
              </span>
              <span>
                <b>{j.name}</b>
                {j.current ? (
                  <span className="sub">
                    {" "}
                    – {t("läuft", "running")}: {j.current}
                  </span>
                ) : failStep ? (
                  <span className="sub">
                    {" "}
                    – {t(`fehlgeschlagen in „${failStep.name}“`, `failed in "${failStep.name}"`)}
                  </span>
                ) : j.state === "pending" ? (
                  <span className="sub"> – {t("wartet", "waiting")}</span>
                ) : null}
                {j.notes
                  .filter((n) => !common.includes(n))
                  .map((n) => (
                    <div key={n} className="note">
                      {n}
                    </div>
                  ))}
              </span>
            </li>
          );
        })}
      </ul>
      {details.tests.length > 0 && (
        <div>
          <span className="sub">{t("Fehlgeschlagene Tests", "Failed tests")}</span>
          <ul className="tests">
            {details.tests.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {details.log && (
        <details>
          <summary className="sub">{t("Log-Auszug", "Log excerpt")}</summary>
          <pre>{details.log}</pre>
        </details>
      )}
    </div>
  );
}
