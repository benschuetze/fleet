import type { ReactNode } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { type CiCard, GLYPH, type Inbox, places } from "../../../shared/inbox";
import type { Duplicate, Session } from "../../../shared/types";
import type { ReadyRepo } from "../drawer/handoff-panel";
import { ReplyLine } from "../keys/reply";
import { CiRow, DupRow, HandoffRow } from "./board-groups";
import { BoardRow, type Kind } from "./board-row";

/**
 * Columns of the watch board, widths in `ch` (rows.css); `hide` drops a column on narrow screens (phone) or medium
 * ones (tablet). `short` is what fits the column; the full name stays its accessible name.
 */
const COLS = [
  { key: "nr", de: "Nr.", en: "No.", hide: "" },
  { key: "st", de: "Status", en: "Status", short: "St", shortEn: "St", hide: "" },
  { key: "repo", de: "Repo", en: "Repo", hide: "" },
  { key: "branch", de: "Branch", en: "Branch", hide: "t-hide" },
  { key: "task", de: "Aufgabe", en: "Task", hide: "" },
  { key: "doing", de: "Aktivität", en: "Activity", short: "Akt", shortEn: "Act", hide: "" },
  { key: "age", de: "Alter", en: "Age", hide: "m-hide" },
  { key: "ctx", de: "Kontext", en: "Context", hide: "m-hide" },
  { key: "cache", de: "Cache", en: "Cache", hide: "t-hide" },
  { key: "pr", de: "PR/CI", en: "PR/CI", hide: "" },
  { key: "act", de: "Aktion", en: "Action", hide: "m-hide" },
] as const;

const byAct = (x: Session, y: Session) =>
  (y.meta?.pinned ? 1 : 0) - (x.meta?.pinned ? 1 : 0) || (y.lastActivity || 0) - (x.lastActivity || 0);
const bySince = (x: Session, y: Session) => (x.statusSince || 0) - (y.statusSince || 0);

/**
 * The watch board: one table row per session that needs no decision (those stand in the alarm zone above),
 * sorted by status, then by age. Resting ones fold into one line per browser; the archive and replaced
 * sessions only come up through the search. Rows are numbered on from the alarm zone (`start` is its last number),
 * in the order they stand, so each visible row has one number.
 */
export function Board({
  ib,
  start,
  onOpen,
  empty,
  showRest,
  dups = [],
  handoffs = [],
  ci = [],
}: {
  ib: Inbox;
  start: number;
  /** Duplicate groups as rows after the sessions; the conflict drawer has the rest. */
  dups?: Duplicate[];
  /** Handoffs nobody continues yet, one row each; the handoff drawer has the steps. */
  handoffs?: ReadyRepo[];
  /** Pipelines that run, one row each. */
  ci?: CiCard[];
  /** A session's details open in the drawer (spec rule 10); nothing unfolds in the row. */
  onOpen: (id: string) => void;
  /** What the empty board says (with a repo chosen in the repo bar). */
  empty?: string;
  showRest?: boolean;
}) {
  const { t } = useI18n();
  const { prefs, setPref, query } = useFleet();
  const { replying } = useKeys();
  const fixing = new Map(ib.ciFixing.map((c) => [c.fixedBy, c]));
  const where = places(ib);
  const searching = !!query.trim();
  // The "resting" filter (Alt+5) shows them unfolded; folding them away would leave the filter empty.
  const restOpen = prefs.inactive || searching || !!showRest;
  const later = [...ib.archive, ...ib.replaced];
  const row = (s: Session, kind: Kind) => [
    <BoardRow
      key={s.id}
      s={s}
      nr={nr.get(s.id) || 0}
      kind={kind}
      glyph={GLYPH[where.get(s.id) || "resting"]}
      red={fixing.get(s.id) || null}
      onOpen={() => onOpen(s.id)}
    />,
    replying === s.id ? (
      <tr key={`r-${s.id}`} className="b-reply">
        <td colSpan={COLS.length}>
          <ReplyLine s={s} />
        </td>
      </tr>
    ) : null,
  ];
  const groups: { id: string; label: string; kind: Kind; list: Session[] }[] = [
    { id: "running", label: t("Arbeitet", "Working"), kind: "working", list: ib.working.slice().sort(bySince) },
    { id: "done", label: t("Fertig", "Done"), kind: "done", list: ib.done.slice().sort(byAct) },
  ];
  const resting = ib.resting.slice().sort(byAct);
  const byRepo = new Map<string, Session[]>();
  for (const s of resting) byRepo.set(s.project || "—", [...(byRepo.get(s.project || "—") || []), s]);
  // The groups that used to be cards stand after the sessions, before the archive (spec rule 9, plan 3.1).
  const lines: { id: string; label: string; rows: (n: number) => ReactNode[]; count: number }[] = [
    ["duplicates", t("Doppelt", "Duplicates"), dups.filter((d) => d.overlap)] as const,
    ["parallel", t("Parallel", "Parallel"), dups.filter((d) => !d.overlap)] as const,
  ].map(([id, label, list]) => ({
    id,
    label,
    count: list.length,
    rows: (n) => list.map((d, i) => <DupRow key={d.root} d={d} nr={n + i + 1} />),
  }));
  lines.push({
    id: "handoffs",
    label: t("Übergabe bereit", "Handoff ready"),
    count: handoffs.length,
    rows: (n) => handoffs.map((r, i) => <HandoffRow key={r.root} r={r} nr={n + i + 1} />),
  });
  lines.push({
    id: "ci-running",
    label: t("CI läuft", "CI running"),
    count: ci.length,
    rows: (n) => ci.map((c, i) => <CiRow key={c.key} c={c} nr={n + i + 1} />),
  });
  const extra = lines.reduce((n, g) => n + g.count, 0);
  const nothing = !ib.working.length && !ib.done.length && !resting.length && !extra && !(searching && later.length);
  later.sort(byAct);
  const top = [...groups.flatMap((g) => g.list), ...(restOpen ? [...byRepo.values()].flat() : [])];
  const nr = new Map([
    ...top.map((s, i): [string, number] => [s.id, start + i + 1]),
    ...(searching ? later : []).map((s, i): [string, number] => [s.id, start + top.length + extra + i + 1]),
  ]);
  let next = start + top.length;

  return (
    <section className="zone board-z" id="board" aria-labelledby="board-h">
      <div className="z-h">
        <h2 id="board-h" tabIndex={-1}>
          {t("Sessions", "Sessions")}
        </h2>
      </div>
      {nothing ? (
        <p className="z-empty">{empty || t("Gerade arbeitet keine Session.", "No session is working right now.")}</p>
      ) : (
        <table className="wtable">
          <colgroup>
            {COLS.map((c) => (
              <col key={c.key} className={`c-${c.key} ${c.hide}`} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) =>
                "short" in c ? (
                  <th
                    key={c.key}
                    scope="col"
                    className={`c-${c.key} ${c.hide}`}
                    aria-label={t(c.de, c.en)}
                    title={t(c.de, c.en)}
                  >
                    {t(c.short, c.shortEn)}
                  </th>
                ) : (
                  <th key={c.key} scope="col" className={`c-${c.key} ${c.hide}`}>
                    {t(c.de, c.en)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          {groups.map((g) =>
            g.list.length ? (
              <tbody key={g.id} aria-label={g.label}>
                <GroupHead id={g.id} label={g.label} n={g.list.length} />
                {g.list.map((s) => row(s, g.kind))}
              </tbody>
            ) : null,
          )}
          {resting.length > 0 && (
            <tbody aria-label={t("Ruht", "Resting")}>
              <tr className="b-grp">
                <th colSpan={COLS.length} scope="rowgroup">
                  <h3 id="resting" tabIndex={-1}>
                    <button
                      type="button"
                      className="fold"
                      aria-expanded={restOpen}
                      disabled={searching}
                      onClick={() => setPref("inactive", !prefs.inactive)}
                    >
                      <span aria-hidden="true">{restOpen ? "▾" : "▸"}</span> {t("Ruht", "Resting")} ·{" "}
                      <span className="num">{resting.length}</span>
                    </button>
                  </h3>
                </th>
              </tr>
              {restOpen &&
                [...byRepo.entries()].flatMap(([repo, list]) => [
                  <tr key={`r-${repo}`} className="b-repo">
                    <th colSpan={COLS.length} scope="rowgroup">
                      {repo} · <span className="num">{list.length}</span>
                    </th>
                  </tr>,
                  ...list.map((s) => row(s, "resting")),
                ])}
            </tbody>
          )}
          {lines.map((g) => {
            if (!g.count) return null;
            const from = next;
            next += g.count;
            return (
              <tbody key={g.id} aria-label={g.label}>
                <GroupHead id={g.id} label={g.label} n={g.count} />
                {g.rows(from)}
              </tbody>
            );
          })}
          {searching && later.length > 0 && (
            <tbody aria-label={t("Archiv", "Archive")}>
              <GroupHead id="archive" label={t("Archiv und abgelöst", "Archive and replaced")} n={later.length} />
              {later.map((s) => row(s, "archive"))}
            </tbody>
          )}
        </table>
      )}
      {!searching && later.length > 0 && (
        <p className="z-foot">
          {t("Archiv", "Archive")} · <span className="num">{later.length}</span> –{" "}
          {t("über die Suche erreichbar", "reachable through the search")}
        </p>
      )}
    </section>
  );
}

function GroupHead({ id, label, n }: { id: string; label: string; n: number }) {
  return (
    <tr className="b-grp">
      <th colSpan={COLS.length} scope="rowgroup">
        <h3 id={id} tabIndex={-1}>
          {label} · <span className="num">{n}</span>
        </h3>
      </th>
    </tr>
  );
}
