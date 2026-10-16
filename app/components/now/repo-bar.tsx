import { type MouseEvent, useState } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import type { RepoEntry } from "../../../shared/repobar";
import { CI_SYM, DIFF_SYM, MARK } from "../mark";
import { Tile } from "../screen/tile";

/**
 * The repo bar, the left tile (spec, Grundaufbau: L2; "Ein Schirm im CLI-Look", rule 2): one line of 28 columns per
 * repo, `shop-frontend ±4 #48✗ ?1●1`: its local changes, its first open PR (a red one first) and its sessions as
 * marks with counts. The name filters the watch board and the event stream (Enter, click); Shift+Enter or Shift+click
 * opens the repo in the drawer, which then follows the choice. All grey: the alarm zone carries the colour, each
 * signal once (a red PR is a plain ✗ here, the alarm row says it). Where the tile is wider (zoomed, on a phone), a
 * "Details" column shows the drawer's way for the pointer too.
 */
export function RepoBar({
  entries,
  chosen,
  onChoose,
}: {
  entries: RepoEntry[];
  chosen: RepoEntry | null;
  onChoose: (name: string | null) => void;
}) {
  const { t } = useI18n();
  const { drawer, openDrawer } = useFleet();
  const [more, setMore] = useState(false);
  const active = entries.filter((e) => !e.quiet || e === chosen);
  const quiet = entries.filter((e) => e.quiet && e !== chosen);
  const shown = more ? [...active, ...quiet] : active;
  const details = (e: RepoEntry) => openDrawer({ kind: "repo", name: e.name, title: e.name });
  const choose = (e: RepoEntry, ev: MouseEvent) => {
    if (ev.shiftKey) return details(e);
    onChoose(e.name);
    // The drawer follows the bar (spec: one shared context, like Bloomberg's group manager).
    if (drawer?.kind === "repo" && chosen?.name !== e.name) openDrawer({ ...drawer, name: e.name, title: e.name });
  };
  return (
    <Tile
      id="repos"
      title={t("Repos", "Repos")}
      count={entries.length}
      items="[data-repo]"
      aside={
        chosen ? (
          <button
            type="button"
            className="link"
            aria-label={t(`Nur ${chosen.name} – Filter aufheben`, `Only ${chosen.name}: clear the filter`)}
            title={t("Filter aufheben, alle Repos zeigen", "Clear the filter, show all repos")}
            onClick={() => onChoose(null)}
          >
            {/* The choice, and how to drop it (round 4: "– all" read as if all repos were shown). */}
            {chosen.name} ×
          </button>
        ) : null
      }
    >
      {entries.length ? (
        <table className="rtable">
          <colgroup>
            <col className="c-name" />
            <col className="c-local" />
            <col className="c-prs" />
            <col className="c-counts" />
            <col className="c-act" />
          </colgroup>
          <thead className="sr">
            <tr>
              <th scope="col">Repo</th>
              <th scope="col">{t("Lokal", "Local")}</th>
              <th scope="col">PRs</th>
              <th scope="col">Sessions</th>
              <th scope="col">{t("Aktion", "Action")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr
                key={e.key}
                aria-label={e.name}
                aria-current={chosen === e ? "true" : undefined}
                data-repo={e.name}
                data-roots={JSON.stringify(e.roots)}
              >
                <td className="rc rb-name">
                  <button
                    type="button"
                    className="opener"
                    data-opener=""
                    aria-pressed={chosen === e}
                    title={`${
                      chosen === e
                        ? t("Filter aufheben", "Clear the filter")
                        : t(`Sessions auf ${e.name} beschränken`, `Show only sessions of ${e.name}`)
                    } · ${t("Umschalt: Details", "Shift: details")}`}
                    onClick={(ev) => choose(e, ev)}
                  >
                    {e.name}
                  </button>
                </td>
                <td className="rc">
                  <Local e={e} />
                </td>
                <td className="rc">
                  <Prs e={e} />
                </td>
                <td className="rc">
                  <Counts e={e} />
                </td>
                <td className="rc rb-act">
                  <button
                    type="button"
                    className="act-link"
                    aria-label={t(`Details zu ${e.name}`, `Details of ${e.name}`)}
                    onClick={() => details(e)}
                  >
                    {t("Details", "Details")}
                  </button>
                </td>
              </tr>
            ))}
            {quiet.length > 0 && (
              <tr className="rb-more">
                <td className="rc" colSpan={5}>
                  <button
                    type="button"
                    className="fold"
                    data-line=""
                    aria-expanded={more}
                    onClick={() => setMore(!more)}
                  >
                    <span aria-hidden="true">{more ? "▾" : "▸"}</span> {t("ohne offene Arbeit", "nothing open")} ·{" "}
                    <span className="num">{quiet.length}</span>
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="tile-empty">{t("Keine Repos.", "No repos.")}</p>
      )}
    </Tile>
  );
}

/** `±4`: changed files in the working tree; `–` when git could not say. */
function Local({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  if (e.dirty === null) return <span title={t("Git-Stand unbekannt", "Git state unknown")}>–</span>;
  // Over several checkouts the sum says so (round 3: ±12 read as one checkout's 4).
  const n = e.roots.length;
  const word = !e.dirty
    ? t("sauber", "clean")
    : n > 1
      ? t(`${e.dirty} Dateien geändert in ${n} Checkouts`, `${e.dirty} files changed in ${n} checkouts`)
      : t(`${e.dirty} Dateien geändert`, `${e.dirty} files changed`);
  return (
    <span role="img" aria-label={word} title={word}>
      {DIFF_SYM}
      {e.dirty}
    </span>
  );
}

/** The first open PR, a red one first, with its CI mark; all of them in the tooltip. */
function Prs({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  if (!e.prs.length) return <span title={t("Kein offener PR", "No open PR")}>#–</span>;
  const ci = (c: string) =>
    c === "success"
      ? ([CI_SYM.ok, t("CI grün", "CI green")] as const)
      : c === "failure"
        ? ([CI_SYM.failed, t("CI rot", "CI red")] as const)
        : c === "running" || c === "pending"
          ? ([CI_SYM.running, t("CI läuft", "CI running")] as const)
          : (["", t("keine CI", "no CI")] as const);
  const list = e.prs.slice().sort((x, y) => Number(y.ci === "failure") - Number(x.ci === "failure"));
  const [first] = list;
  if (!first) return null;
  const [mark, word] = ci(first.ci);
  const title = list
    .map((p) => `#${p.number} ${p.title} · ${ci(p.ci)[1]}${p.draft ? ` · ${t("Entwurf", "draft")}` : ""}`)
    .join("\n");
  return (
    <span title={title}>
      #{first.number}
      {mark && (
        <span role="img" aria-label={word}>
          {mark}
        </span>
      )}
      {/* More open PRs than the one shown: say how many (practical test 15 Oct: billing showed #48 of three). */}
      {list.length > 1 && (
        <span role="img" aria-label={t(`${list.length - 1} weitere offene PRs`, `${list.length - 1} more open PRs`)}>
          +{list.length - 1}
        </span>
      )}
    </span>
  );
}

/** Sessions by status as marks with counts, only those that are not zero: `?1●1`; grey, the words for readers. */
function Counts({ e }: { e: RepoEntry }) {
  const { t } = useI18n();
  const c = e.counts;
  const parts = [
    [c.needs, MARK.waiting, t("wartet", "waiting")],
    [c.errors, MARK.error, t("Fehler", "error")],
    [c.working, MARK.working, t("arbeitet", "working")],
    [c.done, MARK.done, t("fertig", "done")],
    [c.resting, MARK.resting, t("ruht", "resting")],
  ].filter(([n]) => Number(n) > 0) as [number, string, string][];
  if (!parts.length) return <span title={t("Keine Session", "No session")}>–</span>;
  return (
    <span title={parts.map(([n, , w]) => `${n} ${w}`).join(" · ")}>
      {parts.map(([n, m, w]) => (
        <span key={w} role="img" aria-label={`${n} ${w}`}>
          {m}
          {n}
        </span>
      ))}
    </span>
  );
}
