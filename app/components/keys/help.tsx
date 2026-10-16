import { useEffect, useRef, useState } from "react";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { helpEntries, hit, type Mode, shownKeys, type Zone } from "~/lib/keymap";
import { KeysChanged } from "../screen/message";
import { isMac, Modal } from "./modal";

/**
 * The key help, built from the keymap (spec, Grundregel 3). `?` once shows the keys of where the selection is,
 * `?` again all keys with a search that filters while typing. Keys that come with a later stage stand there
 * with their stage: they are reserved, not missing.
 */
export function HelpOverlay() {
  const { help, setHelp, helpZones, mode } = useKeys();
  if (!help) return null;
  return (
    <Help
      all={help === "all"}
      zones={helpZones}
      mode={mode}
      onAll={() => setHelp("all")}
      onClose={() => setHelp(null)}
    />
  );
}

/** Whether the tile a `1`–`5` key names exists on this page (the drawer counts wherever the watch board has rows). */
function tileHere(id?: string): boolean {
  if (!id || typeof document === "undefined") return true;
  if (document.querySelector(`[data-tile="${id}"]`)) return true;
  return id === "drawer" && !!document.querySelector('[data-tile="board"] [data-row]');
}

/**
 * Whether a key does something on this page (round 8: the help of Activity listed Ctrl+K for a stream that is not
 * there, the status filters and the folding of Resting). What belongs to "Now" shows where the watch board has its
 * rows; the stream keys where the stream is; every other page keeps the keys that move, open and ask. The complete
 * list (`??`) is not narrowed.
 */
function actsHere(x: { action: string; arg?: string }): boolean {
  if (typeof document === "undefined") return true;
  const now = !!document.querySelector('[data-tile="board"] [data-row]');
  switch (x.action) {
    case "tile":
      return tileHere(x.arg);
    case "zoneStream":
    case "streamJump":
      return !!document.querySelector('[data-tile="stream"]');
    case "filter":
    case "expand":
    case "collapse":
    case "expandAll":
    case "collapseAll":
      return now;
    default:
      return true;
  }
}

/** The keys of the active mode only: a binding without a key there is reached through the palette or `:`. */
function Help({
  all,
  zones,
  mode,
  onAll,
  onClose,
}: {
  all: boolean;
  zones: Zone[];
  mode: Mode;
  onAll: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (all) search.current?.focus();
    else closeBtn.current?.focus();
  }, [all]);
  // Spec rule 15: the one keymap break is announced once, the first time the help opens after the update; seen
  // here, the same note leaves the message row.
  const { hintClosed, closeHint } = useKeys();
  const [changed] = useState(() => !hintClosed);
  useEffect(() => {
    if (changed) closeHint();
  }, [changed, closeHint]);
  const mac = isMac();
  const needle = q.trim().toLowerCase();
  const shown = helpEntries(all ? null : zones, mode).map((z) => ({
    ...z,
    list: z.list.filter((x) => {
      // Round 7: Repos and Usage have the board alone; their help does not offer tiles that are not there.
      if (!all && !actsHere(x)) return false;
      if (!needle) return true;
      const keys = shownKeys(x, mode, mac).join(" ").toLowerCase();
      return `${x.de} ${x.en}`.toLowerCase().includes(needle) || keys.includes(needle);
    }),
  }));
  return (
    <Modal
      label={t("Tastenhilfe", "Key help")}
      className="keys-help"
      onClose={onClose}
      onKey={(e) => {
        if (!all && hit(e.nativeEvent, "help")) {
          e.preventDefault();
          onAll();
        }
      }}
    >
      <div className="m-head">
        <h2>
          {t("Tasten", "Keys")} <span className="mono">· {mode === "vim" ? "VIM" : "STANDARD"}</span>
        </h2>
        <span className="hint">
          {all
            ? t("Esc schließt", "Esc closes")
            : t("? noch einmal: alle Tasten mit Suche · Esc schließt", "? again: all keys with search · Esc closes")}
        </span>
        <button ref={closeBtn} type="button" className="act-link" onClick={onClose}>
          {t("Schließen", "Close")}
        </button>
      </div>
      {changed && (
        <p className="keys-changed" role="note">
          <KeysChanged />
        </p>
      )}
      {all && (
        <input
          ref={search}
          type="search"
          className="m-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("Tasten durchsuchen", "Search keys")}
          placeholder={t("Aktion oder Taste…", "Action or key…")}
          autoComplete="off"
        />
      )}
      {/* Scrolls on small screens: focusable, so the arrow keys can scroll it too (WCAG 2.1.1). */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard */}
      <section className="m-body" tabIndex={0} aria-label={t("Tastenliste", "Key list")}>
        {shown
          .filter((z) => z.list.length)
          .map((z) => (
            <section key={z.zone} aria-labelledby={`kz-${z.zone}`}>
              <h3 id={`kz-${z.zone}`}>{t(z.de, z.en)}</h3>
              <dl className="keylist">
                {z.list.map((x) => (
                  <div key={`${x.action}-${x.keys[mode].join()}`} className={x.stage ? "later" : ""}>
                    <dt>
                      {shownKeys(x, mode, mac).map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>
                      {t(x.de, x.en)}
                      {x.stage ? (
                        <span className="hint"> · {t(`ab Stufe ${x.stage}`, `from stage ${x.stage}`)}</span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        {shown.every((z) => !z.list.length) && <p className="hint">{t("Keine Taste passt.", "No key matches.")}</p>}
      </section>
    </Modal>
  );
}
