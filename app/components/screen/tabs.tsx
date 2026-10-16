import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { TILE_ORDER, type TileId, useTiles } from "~/lib/tiles";

/**
 * The tab row over the middle under 100 columns (spec, "Ein Schirm im CLI-Look", rule 17): there the middle shows one
 * tile at a time, and the five tabs say which, `1 Alarm · 2 Repos · 3 Wache · 4 Strom · 5 Schublade`. A tap does
 * what the digit does (the same binding, so the drawer when shut says how to open it). Wider windows hide the row.
 */
export function TabRow() {
  const { t } = useI18n();
  const { active, front } = useTiles();
  const { runCmd } = useKeys();
  const name: Record<TileId, string> = {
    alarm: t("Alarm", "Alarm"),
    repos: t("Repos", "Repos"),
    board: t("Wache", "Watch"),
    stream: t("Strom", "Stream"),
    drawer: t("Schublade", "Drawer"),
  };
  // The alarm zone stands above the middle (stage 12.6); while it is active, it is the tab.
  const current = active === "alarm" ? active : front;
  return (
    <nav className="tabrow" aria-label={t("Kacheln", "Tiles")}>
      {TILE_ORDER.map((id, i) => (
        <button
          key={id}
          type="button"
          aria-current={current === id ? "true" : undefined}
          onClick={() => runCmd({ kind: "action", action: "tile", arg: id })}
        >
          <span className="tile-nr">{i + 1}</span> {name[id]}
        </button>
      ))}
    </nav>
  );
}
