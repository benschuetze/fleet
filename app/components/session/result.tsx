import { type ReactNode, useEffect, useState } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { mergeAsk, mergeQuestion } from "~/lib/merge";
import { fetchRun } from "~/lib/run";
import type { Session } from "../../../shared/types";

/** What a session leaves behind, to tick it off: commits, changed lines, tests (its PR stands in the tags above). */
export function ResultLine({ s }: { s: Session }) {
  const { t } = useI18n();
  const r = s.result;
  if (!r) return null;
  const bits: ReactNode[] = [];
  if (r?.commits) {
    bits.push(
      <span key="c" title={r.last || ""}>
        <span className="num">{r.commits}</span> Commit{r.commits === 1 ? "" : "s"}
      </span>,
    );
  }
  if (r?.files) {
    bits.push(
      <span key="f">
        <span className="num">{r.files}</span>{" "}
        {t(`Datei${r.files === 1 ? "" : "en"}`, `file${r.files === 1 ? "" : "s"}`)}{" "}
        <span className="num">+{r.add}</span> <span className="num">−{r.del}</span>
      </span>,
    );
  }
  if (r?.test) {
    bits.push(
      <span key="t" className={r.test.ok ? "" : "bad-t"} title={r.test.cmd}>
        {r.test.ok ? t("✓ Tests grün", "✓ tests green") : t("✗ Tests rot", "✗ tests red")}
      </span>,
    );
  }
  if (!bits.length) return null;
  return (
    <div className="done-res">
      {bits.flatMap((b, i) =>
        i
          ? [
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
              <span key={`s${i}`} aria-hidden="true">
                ·
              </span>,
              b,
            ]
          : [b],
      )}
    </div>
  );
}

/**
 * Merge with a confirmation in the status line (y/n), the same question `:merge` asks. When CI could not even
 * start (GitHub's spending limit, billing), "merge anyway" is offered after the local checks, with the same
 * confirmation. Where merging is not possible, `fallback` stands instead, so a row always has its one action.
 */
export function MergeButton({ s, fallback = null }: { s: Session; fallback?: ReactNode }) {
  const { t } = useI18n();
  const { data } = useFleet();
  const a = useActions();
  const pr = s.ci?.pr;
  const { ask } = useKeys();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const runId = s.ci?.ci?.id;
  const red = pr?.ci === "failure";
  // Ask the run once whether its jobs never started; only then "merge anyway" makes sense.
  useEffect(() => {
    if (!red || !runId || !s.repoRoot || pr?.state !== "open") return;
    let gone = false;
    fetchRun(s.repoRoot, runId)
      .then((d) => {
        const failed = "error" in d ? [] : d.jobs.filter((j) => j.state === "failure");
        if (!gone)
          setBlocked(
            failed.length > 0 &&
              failed.every((j) => j.notes.some((n) => /was not started|spending limit|billing/i.test(n))),
          );
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [red, runId, s.repoRoot, pr?.state]);
  if (pr?.state !== "open" || !s.remote || pr.ci === "pending") return <>{fallback}</>;
  const force = red && blocked;
  if (red && !force) return <>{fallback}</>;
  // Target branch and commit count from the repo's PR list; a PR only the desktop app knows has neither.
  const known = s.repoRoot
    ? (data?.repos.find((r) => r.root === s.repoRoot)?.prs?.prs || []).find((p) => p.number === pr.number)
    : undefined;
  // The question stands in the status line with y/n, exactly as `:merge` asks it (round 7: it vanished after 5 s
  // without a word). It stays until it is answered; Esc takes it back.
  const p = { base: known?.base || "", commits: known?.commits ?? null, ci: pr.ci };
  const n = Number(pr.number);
  const question = force
    ? t(`CI lief nicht – ${mergeQuestion(n, p, t)}`, `CI did not run: ${mergeQuestion(n, p, t)}`)
    : mergeAsk(n, p, t);
  const click = () =>
    ask(`${question} y/n`, async () => {
      setBusy(true);
      await a.merge(s, force);
      setBusy(false);
    });
  const label = busy ? t("Mergt…", "Merging…") : force ? t("Trotzdem mergen", "Merge anyway") : t("Mergen", "Merge");
  return (
    <button
      type="button"
      className={`act-link ${force ? "danger" : ""}`}
      disabled={busy}
      title={
        force
          ? t(
              "GitHub hat die CI nicht gestartet (Ausgabenlimit). Mergt mit Admin-Rechten, nachdem du lokal geprüft hast.",
              "GitHub did not start CI (spending limit). Merges with admin rights after you checked locally.",
            )
          : t("Squash-Merge über gh", "Squash merge via gh")
      }
      onClick={click}
    >
      {label}
    </button>
  );
}
