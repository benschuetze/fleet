import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Round 8: V+x treats every marked row like its own x (a session is hidden, an alarm without a session is muted for
// 1 h), asks one question for all of them, and `u` walks the steps back.

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const ask = (page: Page) => page.getByRole("contentinfo").getByRole("alert");
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const mode = (page: Page) => page.getByTestId("key-mode");

async function vimMode(page: Page) {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(mode(page)).toHaveText("NORMAL");
}

async function recordMeta(page: Page) {
  const sent: { id: string; hidden?: boolean }[] = [];
  await page.route("**/api/meta", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  return sent;
}

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("V+x auf zwei CI-Zeilen fragt dieselbe Stummschalt-Frage wie x, u holt sie Schritt für Schritt zurück (Runde 8)", async ({
  page,
}) => {
  await vimMode(page);
  const ci = zone(page).locator('[data-row][data-kind="ci"]');
  expect(await ci.count()).toBeGreaterThan(1);
  const first = ci.first();
  const names = [await ci.nth(0).getAttribute("aria-label"), await ci.nth(1).getAttribute("aria-label")];
  await first.focus();
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText(`„${names[0]}“ für 1 h stummschalten? y/n`);
  await page.keyboard.press("n");
  await first.focus();
  await page.keyboard.press("Shift+V");
  await ci.nth(1).focus();
  await expect(mode(page)).toHaveText("VISUAL · 2");
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText("2 markierte Zeilen für 1 h stummschalten? y/n");
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/2 Zeilen stumm bis .* u holt sie Schritt für Schritt zurück/);
  await expect(zone(page).getByRole("article", { name: names[0] || "", exact: true })).toHaveCount(0);
  await expect(zone(page).getByRole("article", { name: names[1] || "", exact: true })).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(zone(page).getByRole("article", { name: names[1] || "", exact: true })).toBeVisible();
  await expect(zone(page).getByRole("article", { name: names[0] || "", exact: true })).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(zone(page).getByRole("article", { name: names[0] || "", exact: true })).toBeVisible();
});

test("V+x mit Session und CI gemischt: jede Zeile wie ihr eigenes x, eine Frage (Runde 8)", async ({ page }) => {
  await vimMode(page);
  const sent = await recordMeta(page);
  const rows = zone(page).locator("[data-row]");
  const session = zone(page).locator('[data-row][data-kind="session"]').last();
  const ci = zone(page).locator('[data-row][data-kind="ci"]').first();
  const id = await session.getAttribute("data-session");
  await session.focus();
  await page.keyboard.press("Shift+V");
  await ci.focus();
  expect(await rows.count()).toBeGreaterThan(2);
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText(/ausblenden und \d+ Zeilen? für 1 h stummschalten\? y\/n/);
  await page.keyboard.press("y");
  await expect.poll(() => sent).toContainEqual({ id, hidden: true });
  await expect(status(page)).toHaveText(/ausgeblendet, .* stumm bis/);
  // Back as it was for the other tests (mutes live in this browser only)
  await page.keyboard.press("u");
  await page.keyboard.press("u");
});
