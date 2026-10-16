import type { Glyph } from "../../shared/inbox";

/**
 * The repo symbols, one meaning each and nowhere else invented anew (spec, "Text zu Symbolen"): the pull request
 * is its number after `#`, the CI state one of these marks, the local diff `±` with the number of changed files.
 * Each comes with a tooltip and the same words for screen readers.
 */
export const CI_SYM = { ok: "✓", running: "◌", failed: "✗" } as const;
export const DIFF_SYM = "±";

/** One character per status (spec, "Ein Schirm im CLI-Look", rule 11): no sprites, no waves. */
export const MARK: Record<Glyph, string> = {
  waiting: "?",
  working: "●",
  done: "✓",
  error: "✗",
  resting: "·",
};

/**
 * The status mark in the first column. Its state comes from the place the session stands (`GLYPH[places(ib)]`),
 * never from the raw status. Signal colour only for `?` (waiting, --warn) and `✗` (error, --crit); the rest is
 * grey. With `label` it is a labelled image (where its word stands in another column); without, its word stands
 * right next to it and the mark is decoration. `fresh` makes a new alarm's mark blink three times (rule 16; only
 * without a wish for less motion, rows.css).
 */
export function Mark({ g, label, fresh = false }: { g: Glyph; label?: string; fresh?: boolean }) {
  return (
    <span
      className={`mark g-${g}${fresh ? " fresh" : ""}`}
      data-testid="glyph"
      data-glyph={g}
      {...(label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })}
    >
      {MARK[g]}
    </span>
  );
}
