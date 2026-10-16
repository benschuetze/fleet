import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, isMobile, showTile, tab, test, withOverview } from "./fixtures";

// Stage 6: the repo bar as a filter, the drawer for sessions and repos (architecture in place), the event stream.
// Stage 12.3: repo bar, watch board and stream are tiles; on the phone each test taps the tab of the one it checks.
const alarms = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const bar = (page: Page) => page.getByRole("region", { name: "Repos", exact: true });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const stream = (page: Page) => page.getByRole("region", { name: "Ereignisse" });

test("Repo-Leiste filtert Wachtafel und Ereignisstrom, nie die Alarmzone; der Filter steht in der URL", async ({
  page,
}) => {
  const before = await alarms(page).getByRole("article").count();
  await showTile(page, "2 Repos");
  const shop = bar(page).getByRole("row", { name: "shop-frontend" });
  // `?1`: the mark and the count, named with the word for readers (stage 12.3: one line of 28 columns)
  await expect(shop.getByRole("img", { name: "1 wartet" })).toHaveText("?1");
  await shop.getByRole("button", { name: "shop-frontend", exact: true }).click();
  await expect(page).toHaveURL(/\?repo=shop-frontend$/);
  await expect(shop.getByRole("button", { name: "shop-frontend", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await showTile(page, "3 Wache");
  await expect(
    board(page).getByRole("rowgroup", { name: "Arbeitet" }).getByRole("row", {
      name: "Checkout auf die neuen Komponenten umstellen",
    }),
  ).toBeVisible();
  await expect(board(page).getByRole("row", { name: "Rechnungen als PDF/A-3 exportieren" })).toHaveCount(0);
  // An alarm in another repo stays in sight
  await expect(alarms(page).getByRole("article")).toHaveCount(before);
  await expect(alarms(page).getByRole("article", { name: "Funnel-Auswertung je Kanal" })).toBeVisible();
  // The stream follows the choice
  await showTile(page, "4 Strom");
  const entries = stream(page).getByRole("listitem");
  await expect(entries.first()).toContainText("shop-frontend");
  for (const text of await entries.allTextContents()) expect(text).toContain("shop-frontend");
  // Reload and back keep it; the frame line names the choice and clears it
  await page.reload();
  await expect(board(page).getByRole("row", { name: "Rechnungen als PDF/A-3 exportieren" })).toHaveCount(0);
  await showTile(page, "2 Repos");
  await bar(page)
    .getByRole("button", { name: /^Nur .* – Filter aufheben$/ })
    .click();
  await expect(page).not.toHaveURL(/repo=/);
  await showTile(page, "3 Wache");
  await expect(board(page).getByRole("row", { name: "Rechnungen als PDF/A-3 exportieren" })).toBeVisible();
});

test("Signale einmal: rote CI ist in der Repo-Leiste ein graues ✗, die Alarmzeile sagt es", async ({ page }) => {
  await expect(alarms(page).getByRole("article", { name: /PR #87/ })).toBeVisible();
  await showTile(page, "2 Repos");
  const row = bar(page).getByRole("row", { name: "mobile-app" });
  // No second "CI rot" as text on the screen: a plain mark, named for screen readers
  await expect(row.getByText(/CI rot/i)).toHaveCount(0);
  await expect(row.getByRole("img", { name: "CI rot" })).toHaveText("✗");
  // The waiting and failing counters agree with the alarm zone (one waiting session of mobile-app: Fleet's question)
  await expect(row.getByRole("img", { name: "1 wartet" })).toBeVisible();
  await expect(bar(page).getByRole("row", { name: "analytics" }).getByRole("img", { name: "1 Fehler" })).toHaveText(
    "✗1",
  );
  // One row per repo: worktrees of shop-frontend are one entry
  await expect(bar(page).getByRole("row", { name: "shop-frontend" })).toHaveCount(1);
});

test("Repo in der Schublade: Architektur inline, Reiter per Pfeiltaste, folgt der Auswahl, Esc schließt", async ({
  page,
}) => {
  // In its 28 columns the repo bar opens the drawer on Shift+click on the name (no filter then); where the tile is
  // wider (phone), a "Details" column says it for the pointer.
  await showTile(page, "2 Repos");
  const details = bar(page).getByRole("button", { name: "Details zu shop-frontend" });
  if (isMobile(test.info().project.name)) await details.click();
  else {
    await expect(details).toBeHidden();
    await bar(page)
      .getByRole("button", { name: "shop-frontend", exact: true })
      .click({ modifiers: ["Shift"] });
  }
  await expect(page).not.toHaveURL(/repo=/);
  const drawer = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  // A repo opens on its sessions (Ben, round 4); the architecture is the next tab
  await expect(drawer.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
  await expect(drawer.getByRole("tabpanel")).toContainText("Checkout auf die neuen Komponenten umstellen");
  await drawer.getByRole("tab", { name: "Architektur" }).click();
  await expect(drawer.getByRole("heading", { name: "shop-frontend – Architektur" })).toBeVisible();
  await expect(drawer.getByRole("listitem").filter({ hasText: "Geld immer in Cent" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Beispiel-Doku" })).toHaveAttribute(
    "href",
    "https://example.com/docs/shop-frontend",
  );
  await expect(drawer.getByText(".architektur/mappe.html")).toBeVisible();
  // Tabs as in the WAI pattern
  await drawer.getByRole("tab", { name: "Sessions" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(drawer.getByRole("tab", { name: "Architektur" })).toBeFocused();
  await expect(drawer.getByRole("tab", { name: "Architektur" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(drawer.getByRole("tab", { name: "Werkzeuge" })).toHaveAttribute("aria-selected", "true");
  // The drawer follows the repo bar; a repo without notes says so
  if (!isMobile(test.info().project.name)) {
    await bar(page).getByRole("button", { name: "infra", exact: true }).click();
    const infra = page.getByRole("complementary", { name: "Repo: infra" });
    await expect(infra.getByRole("tab", { name: "Werkzeuge" })).toHaveAttribute("aria-selected", "true");
    await infra.getByRole("tab", { name: "Architektur" }).click();
    await expect(infra.getByText(/^Keine Architekturnotizen/)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

test("Session in der Schublade: Umschalt+Klick auf den Titel; der Strom springt zur Zeile oder klappt Ruht auf", async ({
  page,
}) => {
  const title = board(page).getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" });
  await title.click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Session: Checkout auf die neuen Komponenten umstellen" });
  await expect(drawer.getByText("feat/checkout-redesign").first()).toBeVisible();
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(title).toBeFocused();
  // A row on the board: the stream puts the focus on it (on the phone the board comes back to the front)
  await showTile(page, "4 Strom");
  await stream(page)
    .getByRole("button", { name: /Checkout auf die neuen Komponenten umstellen/ })
    .first()
    .click();
  await expect(title).toBeFocused();
  // A resting session: the folded group opens and the row gets the focus
  let title2 = "";
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.status === "idle" && !x.next && x.project === "infra");
    if (!s) throw new Error("demo without a resting infra session");
    title2 = String(s.title);
    o.events.unshift({
      at: Date.now(),
      sessionId: s.id,
      event: "Stop",
      status: "waiting",
      detail: "",
      cwd: s.cwd || "",
    });
  });
  await showTile(page, "2 Repos");
  await bar(page).getByRole("button", { name: "infra", exact: true }).click();
  await expect(page).toHaveURL(/\?repo=infra$/);
  await showTile(page, "3 Wache");
  const resting = board(page).getByRole("rowgroup", { name: "Ruht" });
  await expect(resting.getByRole("button", { name: /Ruht/ })).toHaveAttribute("aria-expanded", "false");
  await showTile(page, "4 Strom");
  await stream(page)
    .getByRole("button", { name: `infra fertig · ${title2}` })
    .first()
    .click();
  await expect(resting.getByRole("button", { name: /Ruht/ })).toHaveAttribute("aria-expanded", "true");
  // The focus sits on a session's title inside the opened group, not on the group's fold button
  const focused = resting.locator("button:focus");
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAccessibleName(title2);
});

test("Repos & PRs: Link auf die gefilterte Jetzt-Seite und Architektur einmal je Repo", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  await expect(page.getByRole("button", { name: "Architektur von shop-frontend" })).toHaveCount(1);
  await page.getByRole("button", { name: "Architektur von billing-service" }).click();
  await expect(
    page.getByRole("complementary", { name: "Repo: billing-service" }).getByRole("heading", { level: 3 }).first(),
  ).toHaveText("billing-service – Architektur");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Sessions auf Jetzt" }).first().click();
  await expect(tab(page, /Jetzt/)).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\?repo=/);
  await showTile(page, "2 Repos");
  await expect(bar(page).getByRole("button", { pressed: true })).toHaveCount(1);
});

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit Repo-Filter und Repo-Schublade`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    await showTile(page, "2 Repos");
    const name = bar(page).getByRole("button", { name: "billing-service", exact: true });
    await name.click();
    await name.click({ modifiers: ["Shift"] });
    const repo = page.getByRole("complementary", { name: "Repo: billing-service" });
    await repo.getByRole("tab", { name: "Architektur" }).click();
    await expect(repo.getByRole("heading", { level: 3 }).first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("The header counts the same open PRs as Repos & PRs; the repo bar says when a repo has more than one", async ({
  page,
}) => {
  const header = page.getByRole("banner").getByRole("group", { name: "Überblick" });
  const n = Number((await header.getByTitle(/offene PRs/).getAttribute("title"))?.match(/^\d+/)?.[0]);
  expect(n).toBe(7);
  await showTile(page, "2 Repos");
  await expect(
    bar(page)
      .getByRole("row", { name: "billing-service" })
      .first()
      .getByRole("img", { name: /weitere offene PRs/ }),
  ).toBeVisible();
  await page.keyboard.press(":");
  await page.keyboard.type("repos");
  await page.keyboard.press("Enter");
  await expect(page.locator("#open-prs")).toContainText(String(n));
});

test("Runde 5: jede Ansicht beginnt oben, auch nach Scrollen in der vorigen", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  const main = page.locator("main.tile-b");
  await expect(main).toContainText("Offene PRs");
  await main.evaluate((el) => {
    el.scrollTop = 300;
  });
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await tab(page, /Verbrauch/).click();
  await expect(page.locator("main.tile-b")).toHaveAttribute("aria-label", "Verbrauch");
  await expect.poll(() => page.locator("main.tile-b").evaluate((el) => el.scrollTop)).toBe(0);
});
