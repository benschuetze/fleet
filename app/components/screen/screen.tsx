import type { ReactNode } from "react";
import { useTiles } from "~/lib/tiles";
import { CommandLine } from "./cmdline";
import { StatusLine } from "./statusline";
import { TabRow } from "./tabs";

/**
 * The one screen (spec, "Ein Schirm im CLI-Look", rules 1–5): a grid exactly as high as the window, with the top
 * (header and messages), the alarm zone (tile 1, at most three rows), the middle that fills the rest and scrolls
 * only inside its tiles, the status line and the command line as the last two rows. Nothing in it can make the page
 * longer, so the page never gets a scroll bar. Status and command line stay usable under the log view. The alarm
 * zone stands above every view and at every width (ISA-101: alarms never out of sight). The route brings the tiles
 * of the middle: "Now" its three (repo bar, watch board, event stream), every other area one under its own name; the
 * open drawer is the last tile of the middle. Under 100 columns the middle shows the tile in front alone, with the
 * tab row over it (rule 17).
 */
export function Screen({
  top,
  alarm,
  inert,
  drawer,
  children,
}: {
  top: ReactNode;
  /** Tile 1, between the top and the middle. */
  alarm: ReactNode;
  /** Under the log view the screen stays as it was (selection, scroll position) but takes no focus. */
  inert: boolean;
  /** Tile 5, the last of the middle while open: in the stream's place, or in front under 100 columns (rule 10). */
  drawer?: ReactNode;
  children: ReactNode;
}) {
  // `+` shows the tile in front alone (rule 17).
  const { zoom } = useTiles();
  return (
    <div className="screen">
      <div className="screen-top" inert={inert || undefined}>
        {top}
      </div>
      <div className="screen-alarm" inert={inert || undefined}>
        {alarm}
      </div>
      <div className="middle" inert={inert || undefined} data-zoom={zoom ? "" : undefined}>
        <TabRow />
        {children}
        {drawer}
      </div>
      <StatusLine />
      <CommandLine />
    </div>
  );
}
