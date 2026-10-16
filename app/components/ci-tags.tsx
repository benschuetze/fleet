import { useI18n } from "~/lib/i18n";
import type { Tone } from "~/lib/session";
import type { CiResult, CiState, GitInfo } from "../../shared/types";
import { DIFF_SYM } from "./mark";
import { Tag } from "./tag";

/** PR, review and CI state as labels; the run on the branch only when it says something else than the PR checks. */
export function PrTags({ ci }: { ci: CiResult | null | undefined }) {
  const { t } = useI18n();
  if (!ci) return null;
  if (ci.loading) return <Tag>PR …</Tag>;
  if (ci.skipped) return <Tag title={ci.hint}>PR ?</Tag>;
  const state = (s: CiState, url: string | null | undefined, prefix: string) => {
    if (!s || s === "none") return null;
    const m: Record<string, [Tone, string]> = {
      success: ["green", t("grün", "green")],
      failure: ["red", t("rot", "red")],
      running: ["blue", t("läuft", "running")],
      pending: ["amber", t("wartet", "waiting")],
    };
    const [tone, label] = m[s] || ["", "?"];
    return (
      <Tag tone={tone} href={url}>
        {prefix} {label}
      </Tag>
    );
  };
  const p = ci.pr;
  const prTone: Record<string, Tone> = { open: "blue", draft: "", merged: "violet", closed: "" };
  const prLabel: Record<string, string> = {
    open: t("offen", "open"),
    draft: t("Entwurf", "draft"),
    merged: t("gemergt", "merged"),
    closed: t("zu", "closed"),
  };
  return (
    <>
      {p && (
        <>
          <Tag tone={prTone[p.state] || ""} href={p.url} title={p.title}>
            PR {String(p.number).startsWith("!") ? p.number : `#${p.number}`} {prLabel[p.state] || p.state}
          </Tag>
          {/* The same words as Repos & PRs (round 5: "FREIGEGEBEN" above, "APPROVED" in the table). */}
          {p.review === "approved" && <Tag tone="green">{t("freigegeben", "approved")}</Tag>}
          {p.review === "changes" && <Tag tone="red">{t("Änderungen gewünscht", "changes requested")}</Tag>}
          {p.review === "pending" && <Tag tone="amber">{t("Review offen", "review pending")}</Tag>}
          {p.ci && p.ci !== "none" && p.state !== "merged" && p.state !== "closed" && state(p.ci, p.url, "PR-CI")}
        </>
      )}
      {ci.ci && ci.ci.state !== "none" && !(p && p.ci === ci.ci.state) && state(ci.ci.state, ci.ci.url, "CI")}
      {!p && !ci.error && <Tag>{t("kein PR", "no PR")}</Tag>}
      {ci.error ? (
        <Tag tone="amber" title={ci.error}>
          {t("PR-Abfrage fehlgeschlagen", "PR lookup failed")}
        </Tag>
      ) : ci.hint ? (
        <Tag title={ci.hint}>ⓘ</Tag>
      ) : null}
    </>
  );
}

/** Local git state: changed files, unpushed and missing commits, no upstream. */
export function GitTags({ r }: { r: GitInfo | null | undefined }) {
  const { t } = useI18n();
  if (!r) return null;
  const tags = [
    r.dirty ? (
      <Tag key="d" tone="amber" title={t("Ungecommittete Änderungen", "Uncommitted changes")}>
        <span aria-hidden="true">{DIFF_SYM}</span>
        {r.dirty} {t("geändert", "changed")}
      </Tag>
    ) : null,
    r.ahead ? (
      <Tag key="a" tone="blue" title={t("Nicht gepushte Commits", "Unpushed commits")}>
        ↑{r.ahead}
      </Tag>
    ) : null,
    r.behind ? (
      <Tag key="b" tone="amber" title={t("Remote ist weiter", "Remote is ahead")}>
        ↓{r.behind}
      </Tag>
    ) : null,
    r.hasUpstream === false && r.branch && r.branch !== "HEAD" ? (
      <Tag key="u" title={t("Branch hat keinen Upstream", "Branch has no upstream")}>
        {t("nicht gepusht", "not pushed")}
      </Tag>
    ) : null,
  ].filter(Boolean);
  return tags.length ? tags : <Tag tone="green">{t("sauber", "clean")}</Tag>;
}
