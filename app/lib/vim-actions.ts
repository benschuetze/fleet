import { useCallback } from "react";
import { inbox, places } from "../../shared/inbox";
import type { Session } from "../../shared/types";
import { useActions } from "./actions";
import { useFleet } from "./fleet";
import { clock } from "./format";
import { useI18n } from "./i18n";
import type { KeyApi } from "./key-actions";
import type { Binding } from "./keymap";
import { allRows, focusRow, refocus, rowLabel, rowOf, selectWhenBack } from "./rows";
import { matches } from "./session";
import { covered } from "./tiles";
import { MUTE_MS } from "./view";

/** Half of PageUp/PageDown's ten rows. */
const HALF = 5;

/**
 * What the actions of the Vim table do (spec, "Belegung Vim-Modus", stage 7) that standard mode has no key for:
 * half pages, jumps to the next alarm, repo or search hit, folding, marking rows with `V`, undoing a hide. They
 * use the same building blocks as the standard keys (`move`, `toggle`, `useActions`) and say in the status line
 * when they have nothing to act on. Returns null for an action that is not one of these.
 */
export function useVimKeys(
  api: KeyApi,
  k: {
    move: (row: HTMLElement | null, to: (i: number, n: number) => number) => boolean;
    toggle: (row: HTMLElement) => boolean;
    note: (msg: string) => boolean;
  },
) {
  const { t, locale } = useI18n();
  const f = useFleet();
  const a = useActions();
  const { sessionById, showToast: say } = f;
  const { move, toggle, note } = k;

  /** The next row after the selection (backwards for -1) that passes `ok`; the search wraps around like Vim's. */
  const jump = useCallback(
    (row: HTMLElement | null, dir: 1 | -1, ok: (r: HTMLElement) => boolean, wrap = false): boolean => {
      const rows = allRows();
      const i = row ? rows.indexOf(row) : -1;
      const order = dir > 0 ? [...rows.slice(i + 1), ...(wrap ? rows.slice(0, i + 1) : [])] : [];
      if (dir < 0) {
        const before = i < 0 ? rows : rows.slice(0, i);
        order.push(...before.reverse(), ...(wrap && i >= 0 ? rows.slice(i).reverse() : []));
      }
      return focusRow(order.find(ok) || null);
    },
    [],
  );

  const sessionOf = useCallback(
    (r: HTMLElement | null): Session | undefined =>
      r?.dataset.session ? sessionById.get(r.dataset.session) : undefined,
    [sessionById],
  );

  /**
   * `x` or `:archive` on marked rows: each row is treated as its own `x` would (round 8). A session leaves "Now" (a
   * waiting one is named in the question), an alarm without a session (a red CI run, Fleet's question, the limit) is
   * muted for 1 h, and `u` walks back each step; a marked row that is neither (a group) stays and the message says so.
   * One question for all of them.
   */
  const hideMarked = useCallback(() => {
    const keys = api.marked();
    const marked = allRows().filter((r) => keys.includes(r.dataset.row || ""));
    const ids = [...new Set(marked.map((r) => r.dataset.session || "").filter(Boolean))];
    const quiet = marked.filter((r) => !r.dataset.session && r.dataset.zone === "alarm" && r.dataset.mute);
    const skipped = marked.length - marked.filter((r) => r.dataset.session).length - quiet.length;
    if (!ids.length && !quiet.length) {
      api.setVisual(null);
      return note(
        t(
          "Unter den markierten Zeilen ist keine Session und kein Alarm – eine Gruppe lässt sich nicht ausblenden",
          "No session or alarm among the marked rows: a group cannot be hidden",
        ),
      );
    }
    const where = f.data ? places(inbox(f.data)) : new Map<string, string>();
    const waiting = ids.filter((id) => where.get(id) === "needs" || where.get(id) === "decision");
    const first = waiting.length === 1 ? sessionById.get(waiting[0] || "") : undefined;
    const who = String(first?.title || first?.project || "");
    const n = ids.length;
    const m = quiet.length;
    const hides = waiting.length
      ? waiting.length === 1 && who
        ? t(
            `„${who}“ wartet auf dich – ${n} markierte Session${n === 1 ? "" : "s"} trotzdem ausblenden`,
            `"${who}" waits for you: hide ${n} marked session${n === 1 ? "" : "s"} anyway`,
          )
        : t(
            `${waiting.length} davon warten auf dich – ${n} markierte Sessions trotzdem ausblenden`,
            `${waiting.length} of them wait for you: hide ${n} marked sessions anyway`,
          )
      : t(`${n} markierte Session${n === 1 ? "" : "s"} ausblenden`, `Hide ${n} marked session${n === 1 ? "" : "s"}`);
    const what = m === 1 ? rowLabel(quiet[0] as HTMLElement) : "";
    const mutes = what
      ? t(`„${what}“ für 1 h stummschalten`, `Mute "${what}" for 1 h`)
      : t(`${m} markierte Zeilen für 1 h stummschalten`, `Mute ${m} marked rows for 1 h`);
    const question = !m
      ? hides
      : !n
        ? mutes
        : t(
            `${hides} und ${m} Zeile${m === 1 ? "" : "n"} für 1 h stummschalten`,
            `${hides} and mute ${m} row${m === 1 ? "" : "s"} for 1 h`,
          );
    api.ask(`${question}? y/n`, () => {
      for (const id of ids) a.meta(id, { hidden: true });
      if (ids.length) api.hidden(ids);
      for (const r of quiet) api.mute(r.dataset.mute || "", rowLabel(r));
      api.setVisual(null);
      // The selection leaves with the marked rows: it goes to the nearest row that stays, now, not after the redraw.
      const at = rowOf(document.activeElement);
      if (at && keys.includes(at.dataset.row || "")) {
        const rows = allRows();
        const i = rows.indexOf(at);
        const stays = (r: HTMLElement) => !keys.includes(r.dataset.row || "");
        focusRow(rows.slice(i + 1).find(stays) || rows.slice(0, i).reverse().find(stays) || null);
      }
      const rest = skipped
        ? t(
            `; ${skipped} Zeile${skipped === 1 ? "" : "n"} ohne Session ${skipped === 1 ? "bleibt" : "bleiben"}`,
            `; ${skipped} row${skipped === 1 ? "" : "s"} without a session stay${skipped === 1 ? "s" : ""}`,
          )
        : "";
      const until = clock(Date.now() + MUTE_MS, locale);
      const done = [
        n && t(`${n} Session${n === 1 ? "" : "s"} ausgeblendet`, `${n} session${n === 1 ? "" : "s"} hidden`),
        m &&
          t(`${m} Zeile${m === 1 ? "" : "n"} stumm bis ${until}`, `${m} row${m === 1 ? "" : "s"} muted until ${until}`),
      ].filter(Boolean);
      // Hides alone keep the old wording; with mutes, `u` walks back each step.
      const sep = m ? "; " : ": ";
      say(
        t(
          `${done.join(", ")} – u holt ${n + m > 1 ? (m ? "sie Schritt für Schritt" : "sie") : "sie"} zurück${rest}`,
          `${done.join(", ")}${sep}u brings ${n + m > 1 ? (m ? "them back step by step" : "them back") : "it back"}${rest}`,
        ),
      );
    });
    return true;
  }, [a, api, f.data, locale, note, say, sessionById, t]);

  return useCallback(
    (b: Binding, row: HTMLElement | null): boolean | null => {
      switch (b.action) {
        case "command":
          api.setCommand(":");
          return true;
        case "close":
          // Escape first leaves the marking, as in Vim; the next one closes what is open.
          if (!api.marked().length) return null;
          api.setVisual(null);
          return true;
        case "zoneAlarm":
          return (
            focusRow(allRows().find((r) => r.dataset.zone === "alarm") || null) ||
            note(t("Die Alarmzone ist leer", "The alarm zone is empty"))
          );
        case "zoneStream": {
          if (covered("stream"))
            return note(t("Die Schublade steht an Stelle des Stroms", "The drawer stands in the stream's place"));
          const first = document.querySelector<HTMLElement>('[data-tile="stream"] button.st-go');
          if (!first) return note(t("Keine Ereignisse zum Anspringen", "No events to go to"));
          first.focus();
          return true;
        }
        case "halfUp":
          return move(row, (i) => i - HALF);
        case "halfDown":
          return move(row, (i) => i + HALF);
        case "nextAlarm":
        case "prevAlarm":
          return (
            jump(row, b.action === "nextAlarm" ? 1 : -1, (r) => r.dataset.zone === "alarm") ||
            note(t("Keine weitere Zeile mit Alarm", "No further row with an alarm"))
          );
        case "nextRepo":
        case "prevRepo": {
          const root = sessionOf(row)?.repoRoot;
          if (!root) return note(t("Diese Zeile gehört zu keinem Repo", "This row belongs to no repo"));
          return (
            jump(row, b.action === "nextRepo" ? 1 : -1, (r) => sessionOf(r)?.repoRoot === root) ||
            note(t("Keine weitere Zeile dieses Repos", "No further row of this repo"))
          );
        }
        case "searchNext":
        case "searchPrev": {
          const q = f.query.trim();
          if (!q) return note(t("Erst mit / suchen", "Search with / first"));
          const hit = (r: HTMLElement) => {
            const s = sessionOf(r);
            return !!s && matches(s, q);
          };
          return (
            jump(row, b.action === "searchNext" ? 1 : -1, hit, true) ||
            note(t(`Kein Treffer für „${q}“`, `No hit for "${q}"`))
          );
        }
        case "expand":
        case "collapse": {
          // A CI run folds its jobs; a session has nothing to unfold in its row since stage 12 (its details are in
          // the drawer), so zo and zc fold the group it can be in: the resting sessions.
          const open = b.action === "expand";
          if (row && row.dataset.kind !== "session" && row.querySelector("[data-opener]"))
            return !!row.dataset.open === open || toggle(row);
          f.setPref("inactive", open);
          say(open ? t("Ruht aufgeklappt", "Resting expanded") : t("Ruht zugeklappt", "Resting collapsed"));
          return true;
        }
        case "expandAll":
          f.setPref("inactive", true);
          say(t("Ruht aufgeklappt", "Resting expanded"));
          return true;
        case "collapseAll": {
          for (const r of allRows())
            if (r.dataset.open && r.dataset.kind !== "session") r.querySelector<HTMLElement>("[data-opener]")?.click();
          f.setPref("inactive", false);
          const key = row?.dataset.row;
          if (key) refocus(key);
          say(t("Alles zugeklappt", "Everything collapsed"));
          return true;
        }
        case "drawerClose":
          if (!f.drawer) return note(t("Keine Schublade offen", "No drawer open"));
          f.closeDrawer();
          return true;
        case "visual": {
          if (api.marked().length) {
            api.setVisual(null);
            return true;
          }
          const r = row || rowOf(document.activeElement);
          if (!r?.dataset.row) return note(t("Erst eine Zeile wählen (j k)", "Select a row first (j k)"));
          api.setVisual(r.dataset.row);
          return true;
        }
        case "hide":
          return api.marked().length ? hideMarked() : null;
        case "undo": {
          // Walks back every hide and mute of this page visit, newest first (round 7: one step only).
          const step = api.takeUndo();
          if (!step) return note(t("Nichts rückgängig zu machen", "Nothing to undo"));
          if (step.kind === "mute") {
            api.unmute(step.key);
            selectWhenBack(step.key.replace(/^s:/, ""));
            say(t(`${step.label}: Stummschaltung aufgehoben`, `${step.label}: unmuted`));
            return true;
          }
          for (const id of step.ids) a.meta(id, { hidden: false });
          // Round 7: the cursor was gone after `u`; it goes to the first restored row once that is drawn again.
          if (step.ids[0]) selectWhenBack(step.ids[0]);
          const first = sessionById.get(step.ids[0] || "");
          const name = String(first?.title || first?.project || "");
          say(
            step.ids.length === 1 && name
              ? t(`${name}: wieder eingeblendet`, `${name}: shown again`)
              : t(`${step.ids.length} Sessions wieder eingeblendet`, `${step.ids.length} sessions shown again`),
          );
          return true;
        }
        default:
          return null;
      }
    },
    [a, api, f, hideMarked, jump, move, note, say, sessionById, sessionOf, t, toggle],
  );
}
