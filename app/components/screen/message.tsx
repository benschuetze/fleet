import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { openSettings } from "~/lib/theme";
import { useRepos } from "~/lib/use-repos";
import { repoForDir } from "../../../shared/repobar";

/** The one keymap break of stage 12 in a line (spec rule 15): here once and in the first key help. */
export function KeysChanged() {
  const { t } = useI18n();
  const { mode } = useKeys();
  const vim = mode === "vim";
  // Release 6: what is new, with the keys of the mode in use (Vim is the default now).
  return (
    <>
      {t("Neu in 6.0", "New in 6.0")}: <kbd>{vim ? "i" : "→"}</kbd> {t("Terminal", "terminal")} ·{" "}
      <kbd>{vim ? "gd" : "d"}</kbd> Diff · <kbd>x</kbd> {t("wegräumen", "clear")} · <kbd>:cleanup</kbd> ·{" "}
      <kbd>:new</kbd> · <kbd>?</kbd> {t("alle", "all")}
    </>
  );
}

/**
 * The message row under the header (plan, open question 2): zero lines or one. What the server cannot do (offline,
 * warnings, why Claude cannot run in the window), that this is the demo, and once after the update which keys changed. One line of text, cut with an
 * ellipsis; only the keys note can be closed, and it stays closed in this browser (`keysChanged6` since release 6, which the first
 * key help sets too).
 */
export function MessageRow() {
  const { t } = useI18n();
  const { data, offline, unpaired } = useFleet();
  const entries = useRepos();
  const actions = useActions();
  // `fleet` typed in a folder no repo covers: offer Claude there (a known repo is chosen in the bar instead).
  const here = data?.here && !repoForDir(entries, data.here.dir) ? data.here : null;
  const { hintClosed, closeHint, mode } = useKeys();
  // Without the terminal one can neither answer nor start sessions from Fleet: say why, unless it was switched off.
  const term = data?.terminal;
  const noTerm =
    term && !term.available && !term.off
      ? `${t("Terminal im Fenster nicht verfügbar", "Terminal in the window not available")}: ${term.why || "?"}`
      : "";
  const alert = unpaired
    ? t(
        "Dieser Browser ist noch nicht mit Fleet verbunden – im Terminal: node dist/fleet.cjs open",
        "This browser is not paired with Fleet yet; in a terminal: node dist/fleet.cjs open",
      )
    : offline
      ? t("Server nicht erreichbar – läuft Claude Fleet?", "Server not reachable: is Claude Fleet running?")
      : [...(data?.warnings || []), noTerm].filter(Boolean).join(" · ");
  if (!alert && !data?.demo && hintClosed && !here) return null;
  return (
    <div className="msgrow">
      <span className="msg-t">
        {alert && (
          <span className={offline ? "msg-off" : "msg-warn"} role="alert">
            {alert}
          </span>
        )}
        {data?.demo && (
          <span
            title={t(
              "Deine echten Sessions zeigt node dist/fleet.cjs start.",
              "Your real sessions show with node dist/fleet.cjs start.",
            )}
          >
            {t(
              "Demo-Modus – alle Sessions, Repos und Zahlen sind erfunden.",
              "Demo mode: all sessions, repos and numbers are made up.",
            )}
          </span>
        )}
        {here && (
          <span role="note" aria-label={t("Ordner", "Folder")} className="msg-note">
            <span className="msg-cut">
              {t("Fleet für", "Fleet for")} {here.dir}
            </span>
            <span className="msg-mode">
              {" "}
              ·{" "}
              <button type="button" className="link" onClick={() => actions.startHere(here.dir, "")}>
                {t("Claude hier starten", "start Claude here")}
              </button>{" "}
              (<kbd>:here</kbd>)
            </span>
          </span>
        )}
        {!hintClosed && (
          <span role="note" aria-label={t("Tastatur", "Keyboard")} className="msg-note">
            {/* Only the list of keys is cut: the mode and its switch stay whole, or a narrow window hides the button. */}
            <span className="msg-cut">
              <KeysChanged />
            </span>
            <span className="msg-mode">
              {" "}
              · {t("Modus", "mode")} {mode === "vim" ? "Vim" : "Standard"}{" "}
              <button type="button" className="link" onClick={openSettings}>
                {t("wechseln", "change")}
              </button>
            </span>
          </span>
        )}
      </span>
      {!hintClosed && (
        <button
          type="button"
          className="act-link msg-x"
          aria-label={t("Tastatur-Hinweis ausblenden", "Hide the keyboard hint")}
          onClick={closeHint}
        >
          ×
        </button>
      )}
    </div>
  );
}
