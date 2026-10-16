import { type ReactNode, useEffect, useState } from "react";
import { alarmCount } from "~/components/now/alarms";
import { Board } from "~/components/now/board";
import { RepoBar } from "~/components/now/repo-bar";
import { EventStream } from "~/components/now/stream";
import { Safe } from "~/components/safe";
import { Tile } from "~/components/screen/tile";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { clearKey } from "~/lib/keymap";
import { statusName } from "~/lib/palette";
import { useTiles } from "~/lib/tiles";
import { useHere, useRepoFilter, useRepos } from "~/lib/use-repos";
import { useNowView } from "~/lib/use-view";
import { boardEmpty, filteredIds } from "~/lib/view";

/**
 * "Now" as a control room, three tiles side by side under the alarm zone (spec, "Ein Schirm im CLI-Look", rule 2):
 * the repo bar on the left, the watch board in the middle with the rows of sessions and what is left to pick up
 * (duplicates, handoffs, running pipelines), and the event stream on the right. The alarm zone is a tile of the
 * screen (stage 12.6), above every view. The repo chosen in the bar narrows everything but the alarm zone: an alarm
 * elsewhere must stay in sight. Alarm zone and board see the same derivation (`nowView`), so the board numbers on
 * where the alarm zone stops. The token section is gone: the limit stands in the header, the lever ("Frisch
 * starten") in the session's row and drawer.
 */
export default function Now() {
  const { t } = useI18n();
  const { data, query, prefs, setPref, sessionById, openDrawer } = useFleet();
  const entries = useRepos();
  const { repo, choose } = useRepoFilter(entries);
  useHere(entries, repo, choose);
  const { filter, setFilter } = useKeys();
  const { show } = useTiles();
  const view = useNowView(repo);
  // A jump from the stream into the folded "Resting" group waits for the group to unfold.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  useEffect(() => {
    if (jumpTo && focusRow(jumpTo)) setJumpTo(null);
  });
  if (!data || !view) return null;

  // A session's details live in the drawer only (spec, "Ein Schirm im CLI-Look", rules 9 and 10).
  const toggle = (id: string) => {
    const s = sessionById.get(id);
    openDrawer({ kind: "session", id, title: String(s?.title || s?.project || "") });
  };
  // From the stream: to the row when it stands on the board, else into the drawer. Under 100 columns the board
  // first comes to the front (rule 17), a folded group first unfolds; the effect above then puts the focus there.
  const jump = (id: string) => {
    if (focusRow(id)) return;
    const behind = !!document.getElementById(`s-${id}`);
    const folded = view.mine.resting.some((s) => s.id === id) && !prefs.inactive && !query.trim();
    if (behind || folded) {
      if (folded) setPref("inactive", true);
      show("board");
      setJumpTo(id);
      return;
    }
    toggle(id);
  };

  const { ib, decisions, mine } = view;
  let board: ReactNode;
  if (!view.all.length)
    board = (
      <div className="zone empty">
        {data.sessions.length ? (
          t("Keine Treffer.", "No matches.")
        ) : (
          <>
            {t("Noch keine Sessions.", "No sessions yet.")}
            <br />
            <span className="hint">
              {t(
                "Starte Claude Code oder eine Cowork-Session – sie erscheinen hier automatisch.",
                "Start Claude Code or a Cowork session; it shows up here automatically.",
              )}
            </span>
          </>
        )}
      </div>
    );
  else
    board = (
      <>
        {filter && (
          <p className="fbar" data-testid="status-filter">
            {t("Filter", "Filter")}: <b>{statusName(filter, t)}</b> ·{" "}
            <button type="button" className="link" onClick={() => setFilter(null)}>
              {t("alle zeigen", "show all")}
            </button>{" "}
            <kbd>{clearKey()}</kbd>
          </p>
        )}
        <Board
          ib={mine}
          start={alarmCount(ib, decisions)}
          dups={filter ? [] : view.dups}
          handoffs={filter ? [] : view.ready}
          ci={view.running}
          onOpen={toggle}
          empty={
            repo && !filter
              ? t(`Keine Session in ${repo.name} ohne Alarm.`, `No session in ${repo.name} without an alarm.`)
              : boardEmpty(ib, decisions.length, filter, t)
          }
          showRest={filter === "resting"}
        />
      </>
    );

  return (
    <>
      <Safe>
        <RepoBar entries={entries} chosen={repo} onChoose={choose} />
      </Safe>
      <Tile id="board" title={t("Wachtafel", "Watch board")} main>
        <div className="now-main">
          <h1 className="sr">{t("Jetzt", "Now")}</h1>
          {board}
        </div>
      </Tile>
      <Safe>
        <EventStream repo={repo} onJump={jump} only={filteredIds(ib, decisions, filter)} />
      </Safe>
    </>
  );
}

/** Scrolls a session's row into view and puts the focus on its title; false when it has no row in sight. */
function focusRow(id: string): boolean {
  const el = document.getElementById(`s-${id}`);
  if (!el?.getClientRects().length) return false;
  el.scrollIntoView({ block: "center" });
  el.querySelector<HTMLElement>("button.opener")?.focus();
  return true;
}
