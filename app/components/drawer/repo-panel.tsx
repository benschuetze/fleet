import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useActions } from "~/lib/actions";
import { type RepoTab, useFleet } from "~/lib/fleet";
import { ago, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { fetchArch, parseMarkdown } from "~/lib/markdown";
import { isEditable } from "~/lib/rows";
import { useRepos } from "~/lib/use-repos";
import { useLastActive, useStatus } from "~/lib/use-status";
import { archived, inbox } from "../../../shared/inbox";
import { inRepo, type RepoEntry } from "../../../shared/repobar";
import type { ArchDoc, Session } from "../../../shared/types";
import { NewSession } from "../repos/new-session";
import { PrConflicts } from "../repos/open-prs";
import { Safe } from "../safe";
import { ExtLink } from "../tag";
import { Markdown } from "./markdown";

const TABS: { id: RepoTab; de: string; en: string }[] = [
  // Sessions first: opening a repo shows who works in it (Ben, round 3); the architecture is one tab further.
  { id: "sessions", de: "Sessions", en: "Sessions" },
  { id: "arch", de: "Architektur", en: "Architecture" },
  { id: "prs", de: "PRs", en: "PRs" },
  { id: "usage", de: "Verbrauch", en: "Usage" },
  { id: "tools", de: "Werkzeuge", en: "Tools" },
];

/**
 * A repo in the drawer: its sessions first, its architecture notes rendered in place, PRs, tokens of the last 14 days
 * and the tools that act on this repo only. Tabs as in the WAI pattern: arrow keys move between them.
 */
export function RepoPanel({ name, tab }: { name: string; tab: RepoTab }) {
  const { t } = useI18n();
  const { openDrawer } = useFleet();
  const e = useRepos().find((x) => x.name === name) || null;
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // Round 7: the drawer opens with the focus on "Close" (mouse, Shift+Enter), and the status line says h l / ← → switch
  // tabs. So the tab keys work from anywhere in the drawer that takes no typing, not only from a tab button.
  useEffect(() => {
    const onKey = (ev: globalThis.KeyboardEvent) => {
      const el = ev.target instanceof HTMLElement ? ev.target : null;
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      if (!el?.closest(".drawer") || el.closest('[role="tablist"], .xterm, dialog') || isEditable(el)) return;
      const step = ev.key === "ArrowRight" || ev.key === "l" ? 1 : ev.key === "ArrowLeft" || ev.key === "h" ? -1 : 0;
      if (!step) return;
      const at = Math.max(
        0,
        TABS.findIndex((x) => x.id === tab),
      );
      ev.preventDefault();
      openDrawer({
        kind: "repo",
        name,
        title: name,
        tab: (TABS[(at + step + TABS.length) % TABS.length] as (typeof TABS)[number]).id,
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [name, tab, openDrawer]);
  if (!e)
    return <p className="z-empty">{t("Dieses Repo kennt Fleet nicht mehr.", "Fleet no longer knows this repo.")}</p>;
  const go = (id: RepoTab, focus = false) => {
    openDrawer({ kind: "repo", name, title: name, tab: id });
    if (focus) tabs.current[TABS.findIndex((x) => x.id === id)]?.focus();
  };
  const key = (ev: KeyboardEvent, i: number) => {
    const n = TABS.length;
    const to =
      // Vim's h and l as well (round 6: only the arrows moved, and nothing said so).
      ev.key === "ArrowRight" || ev.key === "l"
        ? (i + 1) % n
        : ev.key === "ArrowLeft" || ev.key === "h"
          ? (i - 1 + n) % n
          : ev.key === "Home"
            ? 0
            : ev.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    ev.preventDefault();
    go((TABS[to] as (typeof TABS)[number]).id, true);
  };
  return (
    <>
      <div className="d-tabs" role="tablist" aria-label={t("Repo-Ansichten", "Repo views")}>
        {TABS.map((x, i) => (
          <button
            key={x.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-t-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`${base}-p`}
            tabIndex={tab === x.id ? 0 : -1}
            onClick={() => go(x.id)}
            onKeyDown={(ev) => key(ev, i)}
          >
            {t(x.de, x.en)}
          </button>
        ))}
      </div>
      <div className="d-pane" role="tabpanel" id={`${base}-p`} aria-labelledby={`${base}-t-${tab}`}>
        <Safe>
          {tab === "arch" ? (
            <Arch e={e} />
          ) : tab === "sessions" ? (
            <Sessions e={e} />
          ) : tab === "prs" ? (
            <Prs e={e} />
          ) : tab === "usage" ? (
            <Usage e={e} />
          ) : (
            <Tools e={e} />
          )}
        </Safe>
      </div>
    </>
  );
}

function Arch({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<ArchDoc | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    fetchArch(e.root)
      .then((d) => live && setDoc(d))
      .catch(() => live && setDoc({ error: t("Server nicht erreichbar", "Server not reachable") }));
    return () => {
      live = false;
    };
  }, [e.root, t]);
  const blocks = useMemo(() => (doc && "text" in doc && doc.text ? parseMarkdown(doc.text) : []), [doc]);
  if (!doc) return <p className="hint">{t("Lade …", "Loading …")}</p>;
  if ("error" in doc) return <p className="hint">{doc.error}</p>;
  const mappe = doc.mappe && (
    <p className="hint" title={t("Liegt privat im Repo, nicht im Git", "Private in the repo, not in git")}>
      {t("Interaktive Mappe", "Interactive map")}: <span className="mono">.architektur/mappe.html</span>
    </p>
  );
  if (!doc.text)
    return (
      <>
        <p className="hint">
          {t(
            "Keine Architekturnotizen. Fleet liest .architektur/README.md, ARCHITECTURE.md oder docs/ARCHITECTURE.md.",
            "No architecture notes. Fleet reads .architektur/README.md, ARCHITECTURE.md or docs/ARCHITECTURE.md.",
          )}
        </p>
        {mappe}
      </>
    );
  return (
    <>
      <p className="hint mono">{doc.file}</p>
      {mappe}
      <Markdown blocks={blocks} />
      {doc.truncated && <p className="hint">{t("… gekürzt (64 KB)", "… cut (64 KB)")}</p>}
    </>
  );
}

function Sessions({ e }: { e: RepoEntry }) {
  const { t, locale } = useI18n();
  const statusOf = useStatus();
  const lastActive = useLastActive();
  const { data, openDrawer } = useFleet();
  if (!data) return null;
  const ib = inbox(data);
  // The order of the inbox: what needs you first, the archive last.
  const order = [ib.needs, ib.errors, ib.working, ib.done, ib.resting, ib.archive, ib.replaced];
  const deciding = new Set(ib.decisions.map((d) => d.sessionId));
  const rank = (s: Session) => (deciding.has(s.id) ? -1 : order.findIndex((g) => g.includes(s)));
  const list = data.sessions
    .filter((s) => !s.meta?.hidden && inRepo(e, s))
    .sort((x, y) => rank(x) - rank(y) || lastActive(y) - lastActive(x));
  if (!list.length) return <p className="hint">{t("Keine Sessions in diesem Repo.", "No sessions in this repo.")}</p>;
  return (
    <ul className="d-list">
      {list.map((s) => (
        <li key={s.id} className={archived(s) || s.next ? "past" : ""}>
          <span className="d-st">{statusOf(s).label}</span>
          <button
            type="button"
            className="link"
            onClick={() => openDrawer({ kind: "session", id: s.id, title: String(s.title || s.project || "") })}
          >
            {s.title || s.project}
          </button>
          <span className="mono hint">{s.branch || ""}</span>
          <span className="hint num">{ago(lastActive(s), locale)}</span>
        </li>
      ))}
    </ul>
  );
}

function Prs({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  const ci: Record<string, string> = {
    success: t("✓ grün", "✓ green"),
    failure: t("✗ rot", "✗ red"),
    running: t("läuft", "running"),
    pending: t("wartet", "pending"),
    none: "–",
  };
  return (
    <>
      {e.prs.length ? (
        <ul className="d-list">
          {e.prs.map((p) => (
            <li key={p.number}>
              <ExtLink href={p.url} className="link mono">
                #{p.number}
              </ExtLink>
              <span title={p.title}>{p.title}</span>
              <span className="hint">
                {p.draft ? `${t("Entwurf", "draft")} · ` : ""}CI {ci[p.ci] || "–"}
              </span>
              <PrConflicts root={e.root} p={p} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">{t("Keine offenen PRs.", "No open PRs.")}</p>
      )}
      <p className="hint">
        <Link className="link" to="/repos">
          {t("Mergen und Details unter Repos & PRs", "Merge and details under Repos & PRs")}
        </Link>
      </p>
    </>
  );
}

/** Tokens of this repo's folders per day, the last 14 days. Tokens, not dollars: the limit is what counts. */
function Usage({ e }: { e: RepoEntry }) {
  const { t, locale } = useI18n();
  const { data } = useFleet();
  const days = (data?.usage?.days || []).slice(-14);
  // The usage log knows the folder name of a session, not its repo: every checkout of the repo counts.
  const names = new Set(e.roots.map((r) => r.split(/[\\/]/).filter(Boolean).pop() || r));
  const per = days.map((d) => ({
    day: d.day,
    tok: Object.entries(d.byProject || {}).reduce((a, [k, v]) => a + (names.has(k) ? Number(v?.tok) || 0 : 0), 0),
  }));
  const total = per.reduce((a, d) => a + d.tok, 0);
  const max = Math.max(1, ...per.map((d) => d.tok));
  if (!days.length || !total)
    return <p className="hint">{t("Keine Tokens in den letzten 14 Tagen.", "No tokens in the last 14 days.")}</p>;
  return (
    <>
      <p>
        <span className="num">{toks(total, locale)}</span> {t("Tokens in 14 Tagen", "tokens in 14 days")}
      </p>
      <table className="d-days">
        <caption className="sr">{t("Tokens je Tag", "Tokens per day")}</caption>
        <tbody>
          {per.map((d) => (
            <tr key={d.day}>
              <th scope="row" className="mono">
                {d.day.slice(5)}
              </th>
              <td>
                <span className="bar6">
                  <span className="track" aria-hidden="true">
                    <i style={{ width: `${(d.tok / max) * 100}%` }} />
                  </span>
                </span>
              </td>
              <td className="num">{toks(d.tok, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Tools({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  const { data, repoByRoot } = useFleet();
  const a = useActions();
  const r = repoByRoot.get(e.root);
  const term = !!data?.terminal?.available;
  return (
    <div className="d-tools">
      {r && term ? (
        <NewSession r={r} />
      ) : (
        <p className="hint">
          {data?.terminal?.why ||
            t("Neue Sessions gehen nur im Fleet-Terminal.", "New sessions need the Fleet terminal.")}
        </p>
      )}
      {term && (
        <button
          type="button"
          className="act-link"
          title={t(
            "Startet eine Session im Fleet-Terminal, die .architektur/ auf den Stand bringt (kostet Tokens)",
            "Starts a session in the Fleet terminal that brings .architektur/ up to date (costs tokens)",
          )}
          onClick={() =>
            a.newSession(
              e.root,
              t(
                "Aktualisiere die Architekturmappe dieses Repos (.architektur/) nach dem Skill architektur-mappe.",
                "Update this repo's architecture map (.architektur/) following the architektur-mappe skill.",
              ),
            )
          }
        >
          {t("Architekturmappe aktualisieren", "Update the architecture map")}
        </button>
      )}
      <Link className="link" to={`/?repo=${encodeURIComponent(e.name)}`}>
        {t("Jetzt auf dieses Repo filtern", "Filter Now to this repo")}
      </Link>
      {r?.remote && (
        <ExtLink href={r.remote.webUrl} className="link">
          {t("Repo auf", "Repo on")} {r.remote.host}
        </ExtLink>
      )}
    </div>
  );
}
