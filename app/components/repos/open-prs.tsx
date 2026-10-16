import { useState } from "react";
import { ExtLink, Tag } from "~/components/tag";
import { useActions } from "~/lib/actions";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { mergeAsk, mergeBlocked, mergeWay } from "~/lib/merge";
import { lineProps } from "~/lib/rows";
import type { Tone } from "~/lib/session";
import type { OpenPr, Repo } from "../../../shared/types";
import { ConflictButton } from "../drawer/conflict-button";

/**
 * All open PRs of the repos Fleet knows, also those without a session (e.g. from a closed session or the web).
 * Green CI merges with one confirmation; red, running or missing CI offers "merge anyway" with the red checks
 * named; a PR that builds on another one waits until that one is merged.
 */
export function OpenPrs({ repos }: { repos: Repo[] }) {
  const { t } = useI18n();
  // Several checkouts (worktrees) of one GitHub repo share its PRs: list them once.
  const seen = new Set<string>();
  const withPrs = repos.filter((r) => {
    if (!((Array.isArray(r.prs?.prs) && r.prs.prs.length > 0) || r.prs?.error)) return false;
    const k = r.remote ? `${r.remote.host}/${r.remote.path}` : r.root;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!withPrs.length) return null;
  return (
    <div className="openprs">
      {withPrs.map((r) => (
        <article key={r.root} className="prrepo" aria-label={t(`Offene PRs in ${r.name}`, `Open PRs in ${r.name}`)}>
          <b>{r.remote ? <ExtLink href={r.remote.webUrl}>{r.name}</ExtLink> : r.name}</b>
          {r.prs?.error && <div className="hint">{r.prs.error}</div>}
          <ul>
            {(r.prs?.prs || []).map((p) => (
              <PrRow key={p.number} root={r.root} p={p} />
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function ciTag(p: OpenPr, t: (de: string, en: string) => string): { tone: Tone; label: string } {
  switch (p.ci) {
    case "success":
      return { tone: "green", label: t("CI grün", "CI green") };
    case "failure":
      return { tone: "red", label: t("CI rot", "CI red") };
    case "running":
    case "pending":
      return { tone: "amber", label: t("CI läuft", "CI running") };
    default:
      return { tone: "", label: t("keine CI", "no CI") };
  }
}

function PrRow({ root, p }: { root: string; p: OpenPr }) {
  const { t } = useI18n();
  const ci = ciTag(p, t);
  const review =
    p.review === "approved"
      ? { tone: "green" as Tone, label: t("freigegeben", "approved") }
      : p.review === "changes"
        ? { tone: "red" as Tone, label: t("Änderungen gewünscht", "changes requested") }
        : p.review === "pending"
          ? { tone: "amber" as Tone, label: t("Review offen", "review pending") }
          : null;
  return (
    <li className="prrow" {...lineProps()}>
      <div className="prmain">
        <ExtLink href={p.url}>
          <span className="num">#{p.number}</span> {p.title}
        </ExtLink>
        <div className="chips">
          <Tag tone={ci.tone}>{ci.label}</Tag>
          {review && <Tag tone={review.tone}>{review.label}</Tag>}
          {p.draft && <Tag>{t("Entwurf", "draft")}</Tag>}
          {!p.onDefault && (
            <Tag tone="violet">
              {p.stackedOn ? t(`wartet auf #${p.stackedOn}`, `waits for #${p.stackedOn}`) : `→ ${p.base}`}
            </Tag>
          )}
        </div>
        {p.ci === "failure" && p.failed.length > 0 && (
          <div className="hint">
            {t("Rot", "Red")}: {p.failed.join(", ")}
          </div>
        )}
        <PrConflicts root={root} p={p} />
      </div>
      <MergePr root={root} p={p} />
    </li>
  );
}

/**
 * The conflict point of a PR: the other open PRs git cannot merge it with (probe merge every five minutes). Each
 * opens the conflict drawer with this PR as A. Nothing while no probe ran, so "unknown" never looks like "clean".
 */
export function PrConflicts({ root, p }: { root: string; p: Pick<OpenPr, "number" | "conflicts"> }) {
  const { t } = useI18n();
  if (!p.conflicts?.length) return null;
  return (
    <div className="pr-conflicts">
      {p.conflicts.map((c) => (
        <ConflictButton
          key={c.with}
          root={root}
          a={`pr:${p.number}`}
          b={`pr:${c.with}`}
          title={`#${p.number} ↔ #${c.with}`}
          label={t(`Konflikt mit #${c.with}`, `Conflict with #${c.with}`)}
          crit
        />
      ))}
      <span className="hint" title={p.conflicts.flatMap((c) => c.files).join(", ")}>
        {[...new Set(p.conflicts.flatMap((c) => c.files))].join(", ")}
      </span>
    </div>
  );
}

/**
 * First click asks, second merges; the question says what is merged where and what is skipped when CI is not
 * green. A draft or a PR waiting for another one shows a disabled button with the reason (the server refuses
 * both anyway).
 */
export function MergePr({ root, p }: { root: string; p: OpenPr }) {
  const { t } = useI18n();
  const a = useActions();
  const { ask } = useKeys();
  const [busy, setBusy] = useState(false);
  const way = mergeWay(p);
  if (way !== "ok" && way !== "anyway") {
    const why = mergeBlocked(way, p, t);
    // The reason stands on screen (round 3: a disabled "Merge" read as mergeable).
    const short =
      way === "draft"
        ? t("erst bereit markieren", "mark ready first")
        : way === "stacked"
          ? t(`erst #${p.stackedOn}`, `#${p.stackedOn} first`)
          : t("anderes Ziel", "other base");
    return (
      <button type="button" className="ghost" disabled title={why} aria-label={`${t("Mergen", "Merge")}: ${why}`}>
        {short}
      </button>
    );
  }
  const green = p.ci === "success";
  // The question stands in the status line with y/n, exactly as `:merge` asks it (round 7: the button asked in its
  // own label, `:merge` in the status line). It stays until it is answered; Esc takes it back.
  const click = () =>
    ask(`${mergeAsk(p.number, p, t)} y/n`, async () => {
      setBusy(true);
      await a.mergePr(root, p.number, !green);
      setBusy(false);
    });
  return (
    <button
      type="button"
      className="ghost"
      disabled={busy}
      title={
        green
          ? t("Squash-Merge über gh, Branch wird gelöscht", "Squash merge via gh, deletes the branch")
          : t(
              "Squash-Merge über gh mit Admin-Rechten, an der CI vorbei",
              "Squash merge via gh with admin rights, bypassing CI",
            )
      }
      onClick={click}
    >
      {busy ? t("Mergt…", "Merging…") : green ? t("Mergen", "Merge") : t("Trotzdem mergen", "Merge anyway")}
    </button>
  );
}
