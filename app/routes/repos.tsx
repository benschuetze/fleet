import { Link } from "react-router";
import { GitTags, PrTags } from "~/components/ci-tags";
import { NewSession } from "~/components/repos/new-session";
import { OpenPrs } from "~/components/repos/open-prs";
import { ExtLink, Tag } from "~/components/tag";
import { Section } from "~/components/views";
import { useActions } from "~/lib/actions";
import { useDollars } from "~/lib/billing";
import { useFleet } from "~/lib/fleet";
import { ago, money } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { lineProps } from "~/lib/rows";
import { useLastActive, useStatus } from "~/lib/use-status";
import { openPrKeys } from "../../shared/prs";
import type { Project, Repo, Session } from "../../shared/types";

const ACTIVE = ["working", "needs_input", "waiting", "stale", "error"];

/** Repos & PRs: projects (desktop app groups) and every repo with its branch, local state, PR/CI and sessions. */
export default function Repos() {
  const { t, locale } = useI18n();
  const statusOf = useStatus();
  const { data, query, sessionById, openDrawer } = useFleet();
  if (!data) return null;
  // The repo bar's name: worktrees of one remote are one repo there (shared/repobar.ts).
  const barName = (r: Repo) => r.remote?.repo || r.name;
  const firstOfRemote = (r: Repo) => {
    const key = (x: Repo) => (x.remote ? `${x.remote.host}/${x.remote.path}` : x.root);
    return repos.find((x) => key(x) === key(r)) === r;
  };
  const q = query.toLowerCase();
  const sess = (r: Repo) => r.sessions.map((id) => sessionById.get(id)).filter((s): s is Session => !!s);
  const last = (r: Repo) => Math.max(0, ...sess(r).map((s) => s.lastActivity || 0));
  const repos = data.repos
    .slice()
    .sort((a, b) => last(b) - last(a))
    .filter(
      (r) =>
        !q ||
        `${r.name} ${r.branch} ${r.root} ${sess(r)
          .map((s) => `${s.title} ${s.branch}`)
          .join(" ")}`
          .toLowerCase()
          .includes(q),
    );
  const projects = data.projects.filter((p) => !q || `${p.name} ${p.repos.join(" ")}`.toLowerCase().includes(q));
  const provider = (r: Repo) =>
    r.remote
      ? (
          { github: "GitHub", gitlab: "GitLab", azure: "Azure DevOps", bitbucket: "Bitbucket" } as Record<
            string,
            string
          >
        )[r.remote.provider] || r.remote.host
      : t("nur lokal", "local only");
  return (
    <div className="uview">
      <h1 className="sr">{t("Repos & PRs", "Repos & PRs")}</h1>
      {projects.length > 0 && (
        <Section
          id="projects"
          title={t("Projekte", "Projects")}
          count={projects.length}
          aside={
            <span className="hint" style={{ marginLeft: "auto" }}>
              {t("aus den Gruppen der Desktop-App", "from the desktop app's groups")}
            </span>
          }
        >
          <div className="projects">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        </Section>
      )}
      {repos.some((r) => r.prs?.prs?.length) && (
        <Section
          id="open-prs"
          title={t("Offene PRs", "Open PRs")}
          count={openPrKeys({ sessions: data?.sessions || [], repos }).size}
          aside={
            <span className="hint" style={{ marginLeft: "auto" }}>
              {t("alle Repos, auch ohne Session", "all repos, also without a session")}
            </span>
          }
        >
          <OpenPrs repos={repos} />
        </Section>
      )}
      {repos.length ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable)
        <section className="card tablewrap" aria-label={t("Repos", "Repos")} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th className="px">Repo</th>
                <th className="px">Branch</th>
                <th className="px">{t("Lokal", "Local")}</th>
                <th className="px">PR / CI</th>
                <th className="px">Claude</th>
                <th className="px">{t("Letzter Commit", "Last commit")}</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => {
                const ss = sess(r);
                const active = ss.filter((s) => ACTIVE.includes(String(s.status)));
                const branches = [
                  ...new Set(ss.map((s) => s.branch).filter((b): b is string => !!b && b !== r.branch)),
                ];
                return (
                  <tr key={r.root} {...lineProps()}>
                    <td>
                      <b>{r.remote ? <ExtLink href={r.remote.webUrl}>{r.name}</ExtLink> : r.name}</b>
                      <div className="hint">{provider(r)}</div>
                      <div className="repo-links">
                        <Link className="link" to={`/?repo=${encodeURIComponent(barName(r))}`} data-opener="">
                          {t("Sessions auf Jetzt", "Sessions on Now")}
                        </Link>
                        {/* Once per repo: worktrees of the same remote share one architecture. */}
                        {firstOfRemote(r) && (
                          <button
                            type="button"
                            className="link"
                            aria-label={t(`Architektur von ${barName(r)}`, `Architecture of ${barName(r)}`)}
                            onClick={() =>
                              openDrawer({ kind: "repo", name: barName(r), title: barName(r), tab: "arch" })
                            }
                          >
                            {t("Architektur", "Architecture")}
                          </button>
                        )}
                      </div>
                      {data.terminal?.available && <NewSession r={r} />}
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 13 }}>
                        {r.branch || "–"}
                      </span>
                      {branches.length > 0 && (
                        <div className="hint" style={{ marginTop: 3 }}>
                          {t("Sessions auch auf", "Sessions also on")}: {branches.join(", ")}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="chips">
                        <GitTags r={r} />
                      </div>
                    </td>
                    <td>
                      <div className="chips">{r.ci ? <PrTags ci={r.ci} /> : <span className="hint">–</span>}</div>
                    </td>
                    <td>
                      <div className="chips">
                        {active.length ? (
                          active.map((s) => {
                            const st = statusOf(s);
                            return (
                              <Tag key={s.id} tone={st.tone} title={String(s.title || "")}>
                                {st.label}
                              </Tag>
                            );
                          })
                        ) : ss.length ? (
                          // One state, one word (round 7): "none active" beside "resting" on Now and "archived" in the
                          // drawer; the same tags, one per kind of state.
                          [...new Map(ss.map((s) => [statusOf(s).label, statusOf(s)])).values()].map((st) => (
                            <Tag key={st.label} tone={st.tone}>
                              {st.label}
                            </Tag>
                          ))
                        ) : (
                          <span className="hint">–</span>
                        )}
                      </div>
                      <div className="hint" style={{ marginTop: 3 }}>
                        <span className="num">{ss.length}</span>{" "}
                        {/* One row per checkout (round 6: "1 Session gesamt" beside two in the repo bar). */}
                        {t(
                          `Session${ss.length === 1 ? "" : "s"} in diesem Checkout`,
                          `session${ss.length === 1 ? "" : "s"} in this checkout`,
                        )}
                      </div>
                    </td>
                    <td>
                      {r.lastCommit ? (
                        <>
                          {r.lastCommit.subject}
                          <div className="hint">
                            <span className="mono">{r.lastCommit.hash}</span> · {ago(r.lastCommit.at, locale)}
                          </div>
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <div className="card empty">{t("Keine Git-Repos gefunden.", "No git repos found.")}</div>
      )}
    </div>
  );
}

/** A desktop app group across several repos, with a briefing session for all of them. */
function ProjectCard({ p }: { p: Project }) {
  const { t, locale } = useI18n();
  const dollars = useDollars();
  const { repoByRoot, preferred, sessionById } = useFleet();
  const lastActive = useLastActive();
  const a = useActions();
  // The project was last active when its newest session was (the same time its drawers show).
  const last = Math.max(0, ...p.sessions.map((id) => sessionById.get(id)).map((s) => (s ? lastActive(s) : 0)));
  const repos = p.repos.map((root) => repoByRoot.get(root)).filter((r): r is Repo => !!r);
  return (
    <article className="projcard" aria-label={p.name} {...lineProps()}>
      <div className="t-top">
        <b>{p.name}</b>
        <span className="tm">{last ? ago(last, locale) : ""}</span>
      </div>
      <div className="hint">
        <span className="num">{p.sessions.length}</span>{" "}
        {t(`Session${p.sessions.length === 1 ? "" : "s"}`, `session${p.sessions.length === 1 ? "" : "s"}`)}
        {p.active > 0 && (
          <>
            {" · "}
            <span className="num">{p.active}</span> {t("aktiv", "active")}
          </>
        )}
        {/* On a plan the dollar value is no bill: only on the usage page there. */}
        {dollars && (
          <>
            {" "}
            · {money(p.cost, locale)} {t("API-Gegenwert", "API value")}
          </>
        )}
      </div>
      <div className="repos">
        {repos.length ? (
          repos.map((r) => (
            <Tag key={r.root}>
              {r.name}
              {r.ci?.pr ? ` · PR #${r.ci.pr.number}` : ""}
              {r.handoff?.trusted ? ` · ${t("Übergabe", "handoff")}` : ""}
            </Tag>
          ))
        ) : (
          <span className="hint">{t("Noch kein Repo erkannt", "No repo detected yet")}</span>
        )}
      </div>
      {preferred && repos.length > 0 && (
        <div className="acts">
          <button
            type="button"
            className="ghost"
            title={t(
              "Neue Session, die sich einen Überblick über alle Repos des Projekts verschafft",
              "New session that gets an overview of all the project's repos",
            )}
            onClick={() => a.projectBrief(p.id, preferred.id)}
          >
            {t("Projekt-Briefing in", "Project briefing in")} {preferred.label}
          </button>
        </div>
      )}
    </article>
  );
}
