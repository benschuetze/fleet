import { type ReactNode, useEffect, useRef } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { ago } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { hit } from "~/lib/keymap";
import { afterRender, isEditable } from "~/lib/rows";
import { tileOf, useTiles } from "~/lib/tiles";
import { useStatus } from "~/lib/use-status";
import { Safe } from "../safe";
import { Tile } from "../screen/tile";
import { SessionDetail } from "../session/detail";
import { TerminalPane } from "../terminal/pane";
import { CiPanel } from "./ci-panel";
import { ConflictPanel } from "./conflict-panel";
import { DecisionPanel } from "./decision-panel";
import { DupPanel } from "./dup-panel";
import { HandoffPanel } from "./handoff-panel";
import { RepoPanel } from "./repo-panel";

/**
 * The drawer, tile 5 of the screen (spec, "Ein Schirm im CLI-Look", rule 10): the terminal of a session Fleet runs,
 * a session's details, a repo with its architecture, sessions, PRs, usage and tools, a handoff, the conflict
 * between two sessions or PRs, Fleet's question or a red pipeline. One at a time, in the middle's right column instead of the event stream (60 columns),
 * in front of the middle under 100 columns; `+` shows it alone. Escape closes it unless the terminal has the focus
 * (release 6: Escape in the terminal closes it too, Ctrl+[ sends Esc to Claude); a terminal fills the screen
 * (TilesProvider `full`); → moves into the terminal, Ctrl+← back to the row it was opened from; `i` in a session's
 * details jumps into its terminal.
 */
export function Drawer() {
  const { t, locale } = useI18n();
  const statusOf = useStatus();
  const { drawer, closeDrawer, leaveDrawer, data, sessionById } = useFleet();
  const a = useActions();
  const tiles = useTiles();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const focusTerm = useRef<(() => void) | null>(null);
  const kind = drawer?.kind || "term";
  const focusOnOpen = useRef(false);
  const keepFocus = useRef(false);
  keepFocus.current = drawer?.kind === "session" && !!drawer.keep;
  focusOnOpen.current = !!drawer && (!drawer.kind || drawer.kind === "term") && !!drawer.focus && !drawer.confirm;
  const opened = drawer
    ? `${kind}:${drawer.kind === "repo" ? drawer.name : drawer.kind === "conflict" ? `${drawer.a}|${drawer.b}` : drawer.kind === "handoff" ? drawer.root : drawer.id}`
    : null;

  // Focus moves in when the drawer opens, not when it follows a new choice in the repo bar (the focus stays there).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!opened) {
      wasOpen.current = false;
      return;
    }
    // A terminal jumped into takes the focus itself (TerminalPane `autoFocus`); everything else starts on Close.
    // Round 7: nor when it follows a click on another row: that row keeps the selection.
    const onRow = wasOpen.current && keepFocus.current;
    if ((!wasOpen.current || !opened.startsWith("repo:")) && !focusOnOpen.current && !onRow)
      closeBtn.current?.focus({ preventScroll: true });
    wasOpen.current = true;
    // Keys inside the drawer; outside it the page's Escape closes it too (keyboard.tsx).
    const key = (e: KeyboardEvent) => {
      const inTerm = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
      const inDrawer = !!(e.target as HTMLElement | null)?.closest?.(".drawer");
      // Vim's `q` closes it too, but never while typing (the note field lives in the drawer).
      const quit = hit(e, "drawerClose") && !isEditable(e.target as Element | null);
      if ((hit(e, "close") || quit) && inDrawer && !inTerm && !e.defaultPrevented) {
        e.preventDefault();
        closeDrawer();
      }
      const into = hit(e, "termFocus") || (hit(e, "terminal") && !isEditable(e.target as Element | null));
      if (into && inDrawer && !inTerm && opened.startsWith("term:") && focusTerm.current) {
        e.preventDefault();
        focusTerm.current();
      }
      // The drawer's body scrolls by keys too (release 6, plan R11): j/k or the arrows a row, Ctrl+D/U half a page.
      const body = (e.target as HTMLElement | null)?.closest?.(".drawer")?.querySelector<HTMLElement>(".tile-b.d-body");
      const free = !inTerm && !isEditable(e.target as Element | null) && !e.metaKey && !e.altKey;
      if (body && inDrawer && free && !e.defaultPrevented) {
        const half = body.clientHeight / 2;
        const dy =
          !e.ctrlKey && (e.key === "j" || e.key === "ArrowDown")
            ? 20
            : !e.ctrlKey && (e.key === "k" || e.key === "ArrowUp")
              ? -20
              : e.ctrlKey && e.key === "d"
                ? half
                : e.ctrlKey && e.key === "u"
                  ? -half
                  : 0;
        if (dy) {
          e.preventDefault();
          body.scrollTop += dy;
          return;
        }
      }
      // From a session's details to its changes (release 6, plan R9): d, also in Vim (g d needs no g here).
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (
        plain &&
        e.key === "d" &&
        inDrawer &&
        !isEditable(e.target as Element | null) &&
        opened.startsWith("session:")
      ) {
        const s = sessionByIdRef.current.get(opened.slice("session:".length));
        if (s) {
          e.preventDefault();
          diffRef.current({ id: s.id, title: String(s.title || s.project || "") });
        }
      }
      // From a session's details straight into its terminal (release 6, plan R8).
      const typing = isEditable(e.target as Element | null);
      if (hit(e, "terminal") && inDrawer && !typing && opened.startsWith("session:") && !e.defaultPrevented) {
        const s = sessionByIdRef.current.get(opened.slice("session:".length));
        if (s) {
          e.preventDefault();
          jumpRef.current(s);
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [opened, closeDrawer]);
  const sessionByIdRef = useRef(sessionById);
  sessionByIdRef.current = sessionById;
  const jumpRef = useRef(a.jump);
  jumpRef.current = a.jump;
  const { setDiff } = useKeys();
  const diffRef = useRef(setDiff);
  diffRef.current = setDiff;

  if (!drawer) return null;

  // Ctrl+← from the terminal: back to the row it was opened from. Under 100 columns that row's tile stands behind
  // the drawer; it comes to the front first, then takes the focus.
  const leave = () => {
    // Back to the list means back to the overview: a full-screen terminal steps aside, the drawer stays open.
    if (tiles.zoom) tiles.setZoom(false);
    const back = leaveDrawer();
    const id = tileOf(back);
    if (!back || back.getClientRects().length || !id) return;
    tiles.show(id);
    afterRender(() => back.focus());
  };
  const zoomed = tiles.zoom && tiles.front === "drawer";

  /**
   * The tile around each kind: `kind: title` names it (frame line and landmark), the buttons stand in the frame
   * line, the meta line opens the body. The terminal scrolls by itself, so its body does not.
   */
  const frame = (k: string, title: string, meta: ReactNode, children: ReactNode, opts: { term?: boolean } = {}) => (
    <Tile
      id="drawer"
      title={`${k}: ${title}`}
      complementary
      bodyClass={opts.term ? "d-term" : "d-body"}
      aside={
        <>
          {opts.term && (
            <button
              type="button"
              className="link"
              onClick={() => {
                tiles.setZoom(!zoomed);
                tiles.show("drawer");
              }}
              title={
                zoomed
                  ? t("Neben die Liste zurück (+)", "Back beside the list (+)")
                  : t("Nur die Schublade zeigen (+)", "Show the drawer alone (+)")
              }
            >
              {/* Named after what a click does (round 4: "Full screen" made the full-screen terminal smaller). */}
              {zoomed ? t("Verkleinern", "Shrink") : t("Vollbild", "Full screen")}
            </button>
          )}
          <button ref={closeBtn} type="button" className="link" onClick={closeDrawer}>
            {t("Schließen", "Close")}
          </button>
        </>
      }
    >
      {meta && <p className="d-meta">{meta}</p>}
      <Safe>{children}</Safe>
    </Tile>
  );

  if (drawer.kind === "repo")
    return frame("Repo", drawer.name, null, <RepoPanel name={drawer.name} tab={drawer.tab || "sessions"} />);

  if (drawer.kind === "handoff") {
    const r = data?.repos.find((x) => x.root === drawer.root);
    return frame(
      t("Übergabe", "Handoff"),
      drawer.title,
      <>
        {r?.branch && <span className="mono">{r.branch} · </span>}
        {r?.handoff && ago(r.handoff.at, locale)}
      </>,
      <HandoffPanel root={drawer.root} />,
    );
  }

  if (drawer.kind === "conflict")
    return frame(
      t("Konflikt", "Conflict"),
      drawer.title,
      t("Was beide ändern", "What both change"),
      <>
        {drawer.dup && (
          <Safe>
            <DupPanel root={drawer.root} />
          </Safe>
        )}
        <ConflictPanel root={drawer.root} a={drawer.a} b={drawer.b} />
      </>,
    );

  if (drawer.kind === "decision")
    return frame(t("Fleet-Frage", "Fleet question"), drawer.title, null, <DecisionPanel id={drawer.id} />);

  if (drawer.kind === "ci") return frame("CI", drawer.title, null, <CiPanel id={drawer.id} />);

  const s = sessionById.get(drawer.id);
  const title = String(s?.title || drawer.title || "");
  const st = s ? statusOf(s).label : "";
  const where = (
    <>
      {s?.project && <b>{s.project}</b>}
      {s?.branch && <span className="mono"> {s.branch}</span>}
      {st && <span> · {st}</span>}
    </>
  );

  if (drawer.kind === "session")
    return frame(
      "Session",
      title,
      where,
      s ? (
        <SessionDetail s={s} />
      ) : (
        <p className="z-empty">{t("Diese Session gibt es nicht mehr.", "This session is gone.")}</p>
      ),
    );

  const proc = (data?.processes || []).find((p) => p.id === drawer.id && p.kind === "session") || null;
  return frame(
    "Terminal",
    title,
    <>
      {where}{" "}
      <span
        className="badge"
        title={
          proc
            ? t("Läuft im Fleet-Terminal", "Runs in the Fleet terminal")
            : t("Läuft außerhalb von Fleet – hier nur lesend", "Runs outside Fleet; read-only here")
        }
      >
        {proc || !drawer.confirm ? "Fleet" : t("extern", "external")}
      </span>
    </>,
    drawer.confirm ? (
      <div className="d-confirm">
        <p>{drawer.confirm.text}</p>
        <div className="acts">
          <button
            type="button"
            className="link"
            onClick={() => {
              const target = sessionById.get(drawer.confirm?.session || "");
              if (target) a.openFleet(target, true);
            }}
          >
            {t("Trotzdem hier fortsetzen", "Continue here anyway")}
          </button>
          <button type="button" className="link" onClick={closeDrawer}>
            {t("Abbrechen", "Cancel")}
          </button>
        </div>
      </div>
    ) : (
      <TerminalPane
        key={drawer.id}
        id={drawer.id}
        status={proc?.status || null}
        exit={proc?.exitCode ?? null}
        focusRef={focusTerm}
        onLeave={leave}
        onExit={closeDrawer}
        autoFocus={!!drawer.focus}
        onResume={s ? () => a.openFleet(s, true) : null}
      />
    ),
    { term: true },
  );
}
