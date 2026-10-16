import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { DiffLayer } from "~/components/diff/diff-view";
import { Drawer } from "~/components/drawer/drawer";
import { HelpOverlay } from "~/components/keys/help";
import { LogView } from "~/components/log/log-view";
import { AlarmZone } from "~/components/now/alarms";
import { Safe } from "~/components/safe";
import { Header } from "~/components/screen/header";
import { MessageRow } from "~/components/screen/message";
import { Screen } from "~/components/screen/screen";
import { Tile } from "~/components/screen/tile";
import { FleetProvider, useFleet } from "~/lib/fleet";
import { I18nProvider, useI18n } from "~/lib/i18n";
import { KeysProvider, useKeys } from "~/lib/keyboard";
import { TilesProvider } from "~/lib/tiles";
import { loudInbox } from "~/lib/view";

/**
 * The frame of every page: the one screen (components/screen) with the header line, warnings, the alarm zone, the
 * page as the middle tile, the status line and the command line.
 */
export default function Shell() {
  return (
    <FleetProvider>
      <WithLanguage />
    </FleetProvider>
  );
}

function WithLanguage() {
  const { data, drawer } = useFleet();
  return (
    <I18nProvider serverLang={data?.language}>
      <TilesProvider drawer={!!drawer} full={!!drawer && (!drawer.kind || drawer.kind === "term")}>
        <KeysProvider>
          <Frame />
        </KeysProvider>
      </TilesProvider>
    </I18nProvider>
  );
}

function Frame() {
  const { t, lang } = useI18n();
  const { data } = useFleet();
  const { log, diff, muted } = useKeys();
  const { pathname } = useLocation();
  // The header's waiting count, muted alarms left out (round 7: header ?6, tab title "(7)").
  const attention = data ? loudInbox(data, muted, Date.now()).counts.needs : 0;

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${attention ? `(${attention}) ` : ""}Claude Fleet`;
  }, [lang, attention]);

  // "Now" brings its own tiles (routes/now.tsx); every other area is one tile under its own name.
  const titles: Record<string, string> = {
    "/repos": t("Repos & PRs", "Repos & PRs"),
    "/usage": t("Verbrauch", "Usage"),
    "/activity": t("Aktivität", "Activity"),
  };
  const title = titles[pathname] || "Claude Fleet";

  const top = (
    <>
      <Header />
      <MessageRow />
    </>
  );

  return (
    <>
      {/* Under the log view the page stays as it was (selection, scroll position) but takes no focus. */}
      <Screen
        top={top}
        alarm={
          <Safe>
            <AlarmZone />
          </Safe>
        }
        inert={log || !!diff}
        drawer={
          <Safe>
            <Drawer />
          </Safe>
        }
      >
        {data && pathname === "/" ? (
          <Outlet />
        ) : (
          // One tile per view: a new view starts at its top (round 5: Usage opened 336 px down, as Repos was left).
          <Tile key={pathname} id="board" title={title} main>
            <div className="wrap">{data ? <Outlet /> : <div className="empty">{t("Lade …", "Loading …")}</div>}</div>
          </Tile>
        )}
      </Screen>
      <LogView />
      <DiffLayer />
      <Safe>
        <HelpOverlay />
      </Safe>
    </>
  );
}
