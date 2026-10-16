import { useEffect } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { countUse } from "~/lib/featureuse";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { focusRow } from "~/lib/rows";
import { useTiles } from "~/lib/tiles";
import { headerCounts } from "~/lib/view";
import { openPrKeys } from "../../../shared/prs";
import type { Overview } from "../../../shared/types";
import { BalanceChip, LimitChip } from "../header-limit";
import { SettingsMenu } from "../header-tools";
import { CI_SYM, MARK } from "../mark";

/**
 * The header, one line of text (spec, "Ein Schirm im CLI-Look", rules 2 and 7; k9s shows its counters in the head
 * too): name and version, the areas as text links (the same as `:now` `:repos` `:usage` `:activity`), the counters
 * as characters (`?7 ✗3 CI3 ●5 ✓3 #5`), the limit as a character bar, the Fleet balance, and the gear. No icons, no
 * chips, no search: that lives in the command line behind `/`.
 */
export function Header() {
  const { t } = useI18n();
  const { data } = useFleet();
  const areas = [
    { to: "/", label: t("Jetzt", "Now") },
    // Short on the screen, the full name for screen readers and the tile's title.
    { to: "/repos", label: "Repos", name: t("Repos & PRs", "Repos & PRs") },
    { to: "/usage", label: t("Verbrauch", "Usage") },
    { to: "/activity", label: t("Aktivität", "Activity") },
  ];
  return (
    <header className="hd">
      <span className="hd-name">Claude Fleet</span>
      {data?.version && <span className="hd-ver"> {data.version}</span>}
      <nav className="hd-nav" aria-label={t("Bereiche", "Sections")}>
        {areas.map((a) => (
          <NavLink key={a.to} to={a.to} end aria-label={a.name}>
            {a.label}
          </NavLink>
        ))}
      </nav>
      {data && <Counters data={data} />}
      <span className="hd-gear">
        <SettingsMenu />
      </span>
    </header>
  );
}

/**
 * The counters, one character and number per group, from the one source (shared/inbox.ts). A click jumps to the
 * place on "Now" (the alarm zone or a group of the watch board); zero stays quiet. Then the limit (only what is
 * certain) and the Fleet balance.
 */
function Counters({ data }: { data: Overview }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Which views are used (docs/SCOPE.md): one count per visit.
  useEffect(() => countUse(`view:${pathname}`), [pathname]);
  const tiles = useTiles();
  // What the alarm zone shows: a muted alarm leaves the count too (round 6).
  const { muted } = useKeys();
  const c = headerCounts(data, muted, Date.now());
  // Counted like Repos & PRs (shared/prs.ts): every open PR once, also those without a session.
  const prs = openPrKeys(data);

  const jump = (id: string) => {
    // The alarm zone stands on every view (stage 12.6): its first row of that kind, else the tile itself.
    if (id.startsWith("alarm:")) {
      const row = document.querySelector<HTMLElement>(`[data-tile="alarm"] ${id.slice(6)}`);
      if (!focusRow(row)) tiles.go("alarm");
      return;
    }
    const go = () => {
      const sec = document.getElementById(id);
      if (!sec) return;
      sec.scrollIntoView({ block: "start" });
      // A group heading of the watch board is the target itself; a section is reached by its heading.
      (sec.hasAttribute("tabindex") ? sec : sec.querySelector<HTMLElement>("h2"))?.focus({ preventScroll: true });
    };
    if (pathname !== "/") {
      navigate("/");
      setTimeout(go, 60);
    } else go();
  };
  const count = (cls: string, sym: string, k: number, label: string, to: string) =>
    k ? (
      <button
        type="button"
        className={`hd-c hd-n ${cls}`}
        onClick={() => jump(to)}
        aria-label={`${k} ${label}`}
        title={`${k} ${label} – ${t("hinspringen", "jump there")}`}
      >
        <span aria-hidden="true">{sym}</span>
        <b>{k}</b>
      </button>
    ) : (
      <span className="hd-c hd-n" role="img" aria-label={`0 ${label}`} title={`0 ${label}`}>
        {sym}
        <b>0</b>
      </span>
    );

  return (
    <fieldset className="hd-counts" aria-label={t("Überblick", "Overview")}>
      {count(
        "hd-warn",
        MARK.waiting,
        c.needs,
        t("warten auf dich", "waiting for you"),
        "alarm:[data-row]:has(.g-waiting)",
      )}
      {count("hd-crit", CI_SYM.failed, c.errors, t("Fehler", "errors"), "alarm:[data-row]:has(.g-error)")}
      {count("hd-crit", "CI", c.ciRed, t("CI rot", "CI red"), 'alarm:[data-kind="ci"]')}
      {count("hd-on", MARK.working, c.working, t("arbeiten", "working"), "running")}
      {count("hd-on", MARK.done, c.done, t("fertig", "done"), "done")}
      {prs.size > 0 && (
        <Link
          className="hd-c hd-n hd-on"
          to="/repos"
          aria-label={`${prs.size} ${t("offene PRs", "open PRs")}`}
          title={`${prs.size} ${t("offene PRs – zu Repos & PRs", "open PRs: go to Repos & PRs")}`}
        >
          <span aria-hidden="true">#</span>
          <b>{prs.size}</b>
        </Link>
      )}
      <LimitChip data={data} />
      <BalanceChip data={data} />
    </fieldset>
  );
}
