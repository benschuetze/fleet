import type { OpenPr } from "../../shared/types";

type T = (de: string, en: string) => string;

/**
 * The merge confirmation names what is merged where: "Merge PR #14 (3 commits) into main?". Without the PR
 * list (a PR only the desktop app knows) it falls back to the number alone.
 */
export function mergeQuestion(n: number | string, p: Pick<OpenPr, "base" | "commits"> | undefined, t: T): string {
  const c = typeof p?.commits === "number" && p.commits > 0 ? p.commits : null;
  const commits = c ? t(` (${c} Commit${c === 1 ? "" : "s"})`, ` (${c} commit${c === 1 ? "" : "s"})`) : "";
  const base = p?.base ? p.base.slice(0, 80) : "";
  return base
    ? t(`PR #${n}${commits} nach ${base} mergen?`, `Merge PR #${n}${commits} into ${base}?`)
    : t(`PR #${n}${commits} wirklich mergen?`, `Really merge PR #${n}${commits}?`);
}

/** How a PR merges from Fleet: at once (green CI), anyway past red, running or missing CI, or not yet, with the reason. */
export type MergeWay = "ok" | "anyway" | "draft" | "stacked" | "base";

export function mergeWay(p: Pick<OpenPr, "draft" | "onDefault" | "stackedOn" | "ci">): MergeWay {
  if (p.draft) return "draft";
  if (!p.onDefault) return p.stackedOn ? "stacked" : "base";
  return p.ci === "success" ? "ok" : "anyway";
}

/** The y/n question, the same for the button and `:merge`: past CI that is not green it says so first. */
export function mergeAsk(n: number, p: Pick<OpenPr, "base" | "commits" | "ci"> | undefined, t: T): string {
  const q = mergeQuestion(n, p, t);
  if (!p || p.ci === "success") return q;
  if (p.ci === "failure") return t(`CI ist rot – trotzdem: ${q}`, `CI is red, anyway: ${q}`);
  if (p.ci === "none") return t(`Keine CI – trotzdem: ${q}`, `No CI, anyway: ${q}`);
  return t(`CI läuft noch – trotzdem: ${q}`, `CI still running, anyway: ${q}`);
}

/** Why a PR does not merge yet, in one sentence. */
export function mergeBlocked(
  why: Exclude<MergeWay, "ok" | "anyway">,
  p: Pick<OpenPr, "stackedOn" | "base">,
  t: T,
): string {
  if (why === "draft") return t("Entwurf – erst als bereit markieren", "Draft: mark it ready first");
  if (why === "stacked")
    return t(`wartet auf #${p.stackedOn} – erst den mergen`, `waits for #${p.stackedOn}: merge that one first`);
  return t(`zielt auf ${p.base}, nicht auf den Hauptbranch`, `targets ${p.base}, not the default branch`);
}
