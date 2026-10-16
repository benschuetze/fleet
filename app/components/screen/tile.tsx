import { type CSSProperties, type ReactNode, type RefObject, useRef } from "react";
import { TILE_ORDER, type TileId, useBelow, useScrollPos, useTileProps } from "~/lib/tiles";

/**
 * One tile: a frame line with its number and title (as btop and lazygit write them into the border), then a body
 * that scrolls on its own, so the page never does (rule 3). The body is focusable: a scroll area must be reachable
 * by keyboard, and the tile keys land there when no row of the tile is selected. The middle tile's body is the
 * page's `main`: a named region around it would put the main landmark inside another one. Every other tile is a
 * region named by its title, frame line included, so a control in the frame (btop's buttons in the border) belongs
 * to it; the drawer is a `complementary` landmark the same way.
 */
export function Tile({
  id,
  title,
  count,
  pos,
  aside,
  items,
  main = false,
  complementary = false,
  bodyClass = "",
  style,
  below,
  children,
}: {
  id: TileId;
  title: string;
  count?: ReactNode;
  pos?: ReactNode;
  /** A control in the frame line, after the title (btop: buttons in the border). */
  aside?: ReactNode;
  /** What counts as one line for the position in the frame line; numbered rows by default. */
  items?: string;
  main?: boolean;
  /** The drawer: a complementary landmark beside the page's main one rather than a plain region. */
  complementary?: boolean;
  /** Extra class on the body: the terminal scrolls by itself, its body must not. */
  bodyClass?: string;
  style?: CSSProperties;
  /** Rows that must not wait out of sight: the frame line says how many lie below the view (B14). */
  below?: { items: string; text: (n: number) => string };
  children: ReactNode;
}) {
  const tile = useTileProps(id);
  const body = useRef<HTMLElement>(null);
  // Without a position of its own, the tile says where its lines stand (rule 3), only while it scrolls.
  const at = useScrollPos(body, items);
  const shown = pos ?? at;
  const hidden = useBelow(body, below?.items);
  const head = (
    <div className="tile-h">
      <span className="tile-t">
        <span className="tile-nr">{TILE_ORDER.indexOf(id) + 1}</span> {title}
        {count !== undefined && count !== null && <span className="tile-n"> {count}</span>}
      </span>
      {aside ? <span className="tile-a">{aside}</span> : null}
      {below && hidden > 0 ? (
        <span className="tile-below" data-testid="tile-below">
          {below.text(hidden)}
        </span>
      ) : null}
      {shown ? (
        <span className="pos" data-testid="tile-pos">
          {shown}
        </span>
      ) : null}
    </div>
  );
  if (main)
    return (
      <div className="tile" style={style} {...tile}>
        {head}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable) */}
        <main ref={body} className={`tile-b ${bodyClass}`} tabIndex={0} aria-label={title}>
          {children}
        </main>
      </div>
    );
  const Box = complementary ? "aside" : "section";
  return (
    <Box className={complementary ? "tile drawer" : "tile"} aria-label={title} style={style} {...tile}>
      {head}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable) */}
      <div ref={body as RefObject<HTMLDivElement>} className={`tile-b ${bodyClass}`} tabIndex={0}>
        {children}
      </div>
    </Box>
  );
}
