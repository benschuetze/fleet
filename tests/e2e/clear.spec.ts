import type { Page } from "@playwright/test";
import { expect, isMobile, test, withOverview } from "./fixtures";

// Release 6 (plan R4–R6): an alarm goes away in its row (x or ×), `:cleanup` hides what has been quiet for hours,
// `:stop` ends every session in Fleet's window. Writes to the shared demo server are caught and only recorded.

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const ask = (page: Page) => page.getByRole("contentinfo").getByRole("alert");
const line = (page: Page) => page.getByRole("combobox", { name: /Befehl/ });

async function recordMeta(page: Page) {
  const sent: { id: string; hidden?: boolean }[] = [];
  await page.route("**/api/meta", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  return sent;
}

async function command(page: Page, text: string) {
  await line(page).click();
  await line(page).fill(text);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Runde 6: der Knopf × heißt, was er tut: Ausblenden bei einer Session, 1 h stumm sonst", async ({ page }) => {
  const session = zone(page).locator('[data-row][data-kind="session"]').first();
  await expect(session.getByRole("button", { name: /^Ausblenden:/ })).toBeVisible();
  const ci = zone(page).locator('[data-row][data-kind="ci"]').first();
  await expect(ci.getByRole("button", { name: /^1 h stumm:/ })).toBeVisible();
});

test("x auf einer Session-Alarmzeile blendet die Session aus, die Auswahl geht zur nächsten Zeile", async ({
  page,
}) => {
  const sent = await recordMeta(page);
  const rows = zone(page).locator('[data-row][data-kind="session"]');
  const first = rows.first();
  const id = await first.getAttribute("data-session");
  await first.focus();
  await page.keyboard.press("x");
  // It waits for you: hiding it asks first (round 4)
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText("y/n");
  await page.keyboard.press("y");
  await expect.poll(() => sent).toContainEqual({ id, hidden: true });
  await expect(status(page)).toHaveText(/ausgeblendet/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-row"))).toBe(true);
  // The status line says "u holt sie zurück": u does, in this mode as in Vim (practical test 15 Oct)
  await page.keyboard.press("u");
  await expect.poll(() => sent).toContainEqual({ id, hidden: false });
});

test("Der Knopf × in der Zeile räumt weg wie x: eine CI-Zeile wird 1 h stumm, die Rahmenzeile zählt sie", async ({
  page,
}) => {
  const ci = zone(page).locator('[data-row][data-kind="ci"]').first();
  const name = await ci.getAttribute("aria-label");
  await ci.getByRole("button", { name: /^1 h stumm:/ }).click();
  await expect(ask(page)).toContainText("für 1 h stummschalten? y/n");
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/stumm bis/);
  await expect(zone(page).getByRole("button", { name: /stumm – wieder zeigen$/ })).toBeVisible();
  await expect(zone(page).getByRole("article", { name: name || "", exact: true })).toHaveCount(0);
  // Back as it was for the other tests (mutes live in this browser only).
  await zone(page)
    .getByRole("button", { name: /stumm – wieder zeigen$/ })
    .click();
});

test(":cleanup fragt mit Anzahl, blendet nach y alles aus, was seit 8 h still ist; die Alarmzone bietet es an", async ({
  page,
}) => {
  const sent = await recordMeta(page);
  const old = Date.now() - 14 * 3600e3;
  let ids: string[] = [];
  await withOverview(page, (o) => {
    const quiet = o.sessions.filter((s) => s.status === "error" || s.status === "stale").slice(0, 2);
    for (const s of quiet) Object.assign(s, { lastActivity: old, statusSince: old });
    ids = quiet.map((s) => s.id);
  });
  expect(ids.length).toBe(2);
  // The frame line offers it for the old alarms
  await expect(zone(page).getByRole("button", { name: /älter als 8 h – aufräumen$/ })).toBeVisible();
  await command(page, ":cleanup");
  await expect(ask(page)).toContainText(/\d+ Sessions ohne Lebenszeichen seit 8 h ausblenden\? y\/n/);
  await page.keyboard.press("y");
  for (const id of ids) await expect.poll(() => sent).toContainEqual({ id, hidden: true });
  await expect(status(page)).toHaveText(/aufgeräumt – u holt sie zurück/);
});

test(":stop beendet nach y alle Sessions im Fleet-Fenster und nennt, was außerhalb weiterläuft", async ({ page }) => {
  const killed: string[] = [];
  await page.route("**/api/term/kill", async (route) => {
    killed.push(route.request().postDataJSON().id);
    await route.fulfill({ json: { ok: true } });
  });
  await command(page, ":stop");
  await expect(ask(page)).toContainText(/Alle \d+ Sessions im Fleet-Fenster beenden\? y\/n/);
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Abgebrochen/);
  expect(killed).toEqual([]);
  await command(page, ":stop");
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/\d+ von \d+ beendet/);
  expect(killed.length).toBeGreaterThan(0);
});

test("Ausblenden in der Schublade sagt, wie es zurückgeht, und u holt die Session zurück (Runde 5)", async ({
  page,
}) => {
  const sent = await recordMeta(page);
  const board = page.getByRole("main", { name: "Wachtafel" });
  const row = board.locator('[data-row][data-kind="session"]').first();
  const id = await row.getAttribute("data-session");
  await row.locator("button.opener").click();
  await page.getByRole("complementary").getByRole("button", { name: "Ausblenden", exact: true }).click();
  await expect.poll(() => sent).toContainEqual({ id, hidden: true });
  // Round 5: the drawer promised "unter Ruht wieder einblendbar", but a hidden session is under Ruht nowhere.
  await expect(status(page)).toHaveText(/u holt sie zurück/);
  // The drawer closes with it (round 6)
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await page.keyboard.press("u");
  await expect.poll(() => sent).toContainEqual({ id, hidden: false });
  await expect(status(page)).toHaveText(/: wieder eingeblendet$/);
});

test("Runde 6: x auf einer CI-Zeile schaltet stumm, die Auswahl bleibt in der Alarmzone, u macht es rückgängig", async ({
  page,
}) => {
  const ci = zone(page).locator('[data-row][data-kind="ci"]').first();
  const key = await ci.getAttribute("data-row");
  await ci.focus();
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText("für 1 h stummschalten? y/n");
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/stumm bis .* u holt/);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[data-tile="alarm"]') !== null))
    .toBe(true);
  await page.keyboard.press("u");
  await expect(status(page)).toHaveText(/Stummschaltung aufgehoben/);
  await expect(zone(page).locator(`[data-row="${key}"]`)).toHaveCount(1);
});
