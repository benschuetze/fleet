import { Fragment, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useFleet } from "~/lib/fleet";
import { clock } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { keysFor, tileKeys, useTiles } from "~/lib/tiles";
import { isMac } from "../keys/modal";

/**
 * The status line, the last line but one (spec, "Ein Schirm im CLI-Look", rule 5; lnav's band order): the keyboard
 * mode on the left (in Vim the state: NORMAL, INSERT, COMMAND, VISUAL with the number of marked rows), then the key
 * sequence being typed and the last action with its result, on the right the five keys of the active tile (three
 * while the command line has the focus). The result replaces the toast: it stays until the next action, so it can
 * still be read after looking away. A destructive key asks here (`merge #8 in main? y/n`), never in a dialog that
 * takes the focus away; the two buttons are for the mouse.
 */
/** The focus is in Claude's terminal: the status line names the terminal's keys, not the drawer's. */
const inTerminal = () => typeof document !== "undefined" && !!document.activeElement?.closest(".xterm");

/** How long the last result stays in the status line. */
const RESULT_MS = 60_000;

export function StatusLine() {
  const { t, locale } = useI18n();
  const { toast, toastAt, toastHint, drawer } = useFleet();
  const { mode, label, marked, pending, confirm, answer, log, logFilter, command, diff } = useKeys();
  const { active } = useTiles();
  // The last result belongs to where it happened (practical test 15 Oct: "Demo: Allow …" stood for minutes in the
  // diff, the log and on usage): it goes with another view, the log or the diff, and after a minute.
  const { pathname } = useLocation();
  const where = `${pathname}|${log ? 1 : 0}|${diff ? 1 : 0}`;
  const origin = useRef({ at: 0, where: "" });
  if (origin.current.at !== toastAt) origin.current = { at: toastAt, where };
  const [, expire] = useState(0);
  useEffect(() => {
    const left = toastAt + RESULT_MS - Date.now();
    if (left <= 0) return;
    const id = setTimeout(() => expire((n) => n + 1), left + 50);
    return () => clearTimeout(id);
  }, [toastAt]);
  // A hint ("Select a row first") says why a key did nothing; the next key or focus change has answered it (round 7:
  // it stood for minutes). Results of real actions stay, as above.
  const [gone, setGone] = useState(0);
  useEffect(() => {
    if (!toastHint) return;
    let on: (() => void) | undefined;
    // Not the key that made the hint: listen from the next task on.
    const id = setTimeout(() => {
      on = () => setGone(toastAt);
      document.addEventListener("keydown", on, true);
      document.addEventListener("focusin", on, true);
    }, 0);
    return () => {
      clearTimeout(id);
      if (on) {
        document.removeEventListener("keydown", on, true);
        document.removeEventListener("focusin", on, true);
      }
    };
  }, [toastHint, toastAt]);
  const result =
    toast && !(toastHint && gone === toastAt) && origin.current.where === where && Date.now() - toastAt < RESULT_MS
      ? toast
      : "";
  // Follows the focus itself: in standard mode no mode label changes when it moves into the terminal.
  const [term, setTerm] = useState(false);
  // The selected alarm row holds an approval: its own keys (y a n, or where Enter goes).
  const [approval, setApproval] = useState<string | null>(null);
  useEffect(() => {
    const on = () => {
      setTerm(inTerminal());
      setApproval(document.activeElement?.closest<HTMLElement>("[data-approval]")?.dataset.approval || null);
    };
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", on);
    return () => {
      document.removeEventListener("focusin", on);
      document.removeEventListener("focusout", on);
    };
  }, []);
  const keys = log
    ? []
    : command
      ? tileKeys("cmdline", mode, isMac())
      : diff
        ? tileKeys(diff.whole ? "diffWhole" : "diff", mode, isMac())
        : term
          ? tileKeys("term", mode, isMac())
          : active === "alarm" && approval
            ? tileKeys(approval === "fleet" && mode !== "vim" ? "approval" : "approvalOther", mode, isMac())
            : active
              ? tileKeys(keysFor(active, pathname, drawer ? drawer.kind || "term" : null), mode, isMac())
              : [];
  return (
    <footer className="statusline">
      <span className="sl-mode" data-testid="key-mode" title={t("Tastaturmodus", "Keyboard mode")}>
        {label}
        {label === "VISUAL" && <span className="sl-at"> · {marked.length}</span>}
      </span>
      {confirm ? (
        <span className="sl-ask" role="alert">
          <span className="sl-ask-t" title={confirm}>
            {confirm}
          </span>{" "}
          <button type="button" className="act-link" onClick={() => answer(true)}>
            {t("Ja (y)", "Yes (y)")}
          </button>{" "}
          <button type="button" className="act-link" onClick={() => answer(false)}>
            {t("Nein (n)", "No (n)")}
          </button>
        </span>
      ) : pending ? (
        <span className="sl-keys" data-testid="pending-keys">
          {pending}…
        </span>
      ) : log ? (
        // The log's filter stands here while the log is open (spec: "der aktive Filter steht in der Statuszeile").
        <span className="sl-keys" data-testid="log-filter">
          LOG ·{" "}
          {logFilter
            ? t(`nur Zeile ${logFilter.nr}: ${logFilter.label}`, `only row ${logFilter.nr}: ${logFilter.label}`)
            : t("alle Sessions", "all sessions")}{" "}
          · <kbd>{t("Nr.", "no.")}</kbd> {t("Zeile auf Jetzt", "row on Now")} · <kbd>0</kbd> {t("alle", "all")} ·{" "}
          <kbd>Shift+L</kbd> {t("zurück", "back")}
        </span>
      ) : null}
      {/* A question stands alone (round 7): the old result beside it cut the y/n off. */}
      <span className="sl-last" role="status" aria-live="polite">
        {result && !confirm ? (
          <>
            <span className="sl-at">{clock(toastAt, locale)}</span> {result}
          </>
        ) : null}
      </span>
      {keys.length > 0 && !confirm && (
        <span className="sl-tile" data-testid="tile-keys">
          {keys.map((k, i) => (
            <Fragment key={`${k.keys}-${k.en}`}>
              {i > 0 && " · "}
              <kbd>{k.keys}</kbd> {t(k.de, k.en)}
            </Fragment>
          ))}
        </span>
      )}
    </footer>
  );
}
