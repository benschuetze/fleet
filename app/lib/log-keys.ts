import { useCallback, useRef, useState } from "react";
import { useFleet } from "./fleet";
import { useI18n } from "./i18n";
import { DIGIT_WAIT_MS, hit, type Zone } from "./keymap";
import { afterRender, refocus, rowByNr, rowOf } from "./rows";

/**
 * The log view's state and keys (spec, "Log-Sicht (Shift+L)"), for the keyboard controller. Open, the log takes the
 * keys: Shift+L or Esc go back to the row that was selected, `⌘K`/`:` and `?` still work, and the row numbers of
 * "Now" filter (`3` only the session of row 3, `0` all again). Digits typed within DIGIT_WAIT_MS make one number
 * (`12`); arrows and Page keys scroll the log as the browser does.
 */

export interface LogFilter {
  nr: number;
  session: string;
  label: string;
}

export function useLogKeys(o: { setCommand: (c: ":") => void; setHelp: (v: "zone", zones: Zone[]) => void }) {
  const { t } = useI18n();
  const { showToast, sessionById } = useFleet();
  const { setCommand, setHelp } = o;
  const [log, setLogState] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter | null>(null);
  const open = useRef(false);
  /** Where the selection was when the log opened: it goes back there (spec: "Auswahl bleibt"). */
  const back = useRef<{ row: string | null; el: HTMLElement | null }>({ row: null, el: null });
  const digits = useRef({ text: "", at: 0 });

  const setLog = useCallback((v: boolean) => {
    if (v === open.current) return;
    open.current = v;
    if (v) {
      const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      back.current = { row: rowOf(el)?.dataset.row || null, el };
    } else {
      setLogFilter(null);
      const b = back.current;
      // Once the page is no longer inert: the row first (it may have been drawn anew), else where the focus was.
      afterRender(() => {
        if (b.row) refocus(b.row, false);
        else if (b.el?.isConnected) b.el.focus({ preventScroll: true });
      });
    }
    setLogState(v);
  }, []);

  const logKey = useCallback(
    (e: KeyboardEvent) => {
      if (hit(e, "log") || hit(e, "close")) {
        e.preventDefault();
        setLog(false);
        return;
      }
      if (hit(e, "palette") || hit(e, "command")) {
        e.preventDefault();
        setCommand(":");
        return;
      }
      if (hit(e, "help")) {
        e.preventDefault();
        setHelp("zone", ["log", "global"]);
        return;
      }
      if (!hit(e, "logPick") && !hit(e, "logAll")) return;
      e.preventDefault();
      const d = digits.current;
      const now = Date.now();
      d.text = (now - d.at < DIGIT_WAIT_MS ? d.text + e.key : e.key).slice(-3);
      d.at = now;
      const nr = Number(d.text);
      if (!nr) {
        setLogFilter(null);
        showToast(t("Log: alle Sessions", "Log: all sessions"));
        return;
      }
      const row = rowByNr(nr);
      const id = row?.dataset.session || row?.dataset.owner;
      if (!id) {
        showToast(
          t(
            `Log: Zeile ${nr} ist keine Session auf Jetzt – 0 zeigt alle`,
            `Log: row ${nr} is no session on Now; 0 shows all`,
          ),
        );
        return;
      }
      const s = sessionById.get(id);
      const label = String(s?.title || s?.project || id).slice(0, 80);
      setLogFilter({ nr, session: id, label });
      showToast(t(`Log: nur Zeile ${nr} · ${label}`, `Log: only row ${nr} · ${label}`));
    },
    [setLog, setCommand, setHelp, showToast, t, sessionById],
  );

  const isOpen = useCallback(() => open.current, []);
  return { log, isOpen, setLog, logFilter, logKey };
}
