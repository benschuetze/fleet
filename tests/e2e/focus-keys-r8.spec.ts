import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Round 8: the focus never ends where the keys cannot reach it. After a y/n question started with the mouse, after the diff or the drawer closes and after `u`, the selection
// is a visible row with DOM focus and its keys work.

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const ask = (page: Page) => page.getByRole("contentinfo").getByRole("alert");
const mode = (page: Page) => page.getByTestId("key-mode");
const activeTile = (page: Page) => page.locator("[data-tile][data-active]").getAttribute("data-tile");

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

test("Vim: × per Maus, y/n mit n verworfen: der Fokus liegt wieder auf der Zeile, Ctrl+H und Ctrl+L wechseln die Kachel (Runde 8)", async ({
  page,
}) => {
  await vimMode(page);
  await recordMeta(page);
  const row = zone(page).locator('[data-row][data-kind="session"]').first();
  const key = await row.getAttribute("data-row");
  await row.getByRole("button", { name: /^Ausblenden:/ }).click();
  await expect(ask(page)).toBeVisible();
  await page.keyboard.press("n");
  await expect(ask(page)).toHaveCount(0);
  await expect(page.locator(`[data-row="${key}"]`)).toBeFocused();
  await page.keyboard.press("Control+l");
  await expect.poll(() => activeTile(page)).toBe("repos");
  await page.keyboard.press("Control+h");
  await expect.poll(() => activeTile(page)).toBe("alarm");
});

test("Ein fokussierter Knopf schluckt keine Kachel-Taste: Ctrl+H/L wirken, Tab bleibt auf Knöpfen beim Browser (Runde 8)", async ({
  page,
}) => {
  await vimMode(page);
  const x = zone(page)
    .getByRole("button", { name: /^Ausblenden:/ })
    .first();
  await x.focus();
  await page.keyboard.press("Control+l");
  await expect.poll(() => activeTile(page)).toBe("repos");
  await x.focus();
  await page.keyboard.press("Control+h");
  await expect.poll(() => activeTile(page)).toBe("stream");
  // Tab on such a button walks on to the next control, not to the next tile
  await x.focus();
  await page.keyboard.press("Tab");
  expect(await activeTile(page)).toBe("alarm");
});

test("Standard: Esc aus dem Diff und gleich Enter öffnet die Schublade der gewählten Zeile (Runde 8)", async ({
  page,
}) => {
  const row = board(page).locator('[data-row][data-kind="session"]').first();
  const key = await row.getAttribute("data-row");
  await row.focus();
  await page.keyboard.press("d");
  await expect(page.getByTestId("diff-say")).toBeVisible();
  // No wait in between: the key right after Esc must find the selection
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-row="${key}"]`)).toBeFocused();
});

test("Fokus auf dem Body: V und Enter wirken auf die zuletzt gewählte Zeile (Runde 8)", async ({ page }) => {
  await vimMode(page);
  const row = board(page).locator('[data-row][data-kind="session"]').first();
  const key = await row.getAttribute("data-row");
  await row.focus();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Shift+V");
  await expect(mode(page)).toHaveText(/^VISUAL/);
  await expect(page.locator(`[data-row="${key}"]`)).toBeFocused();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary")).toBeVisible();
});

test("Vim: Ausblenden und u mit dem echten Server: die Auswahl bleibt sichtbar, nach u steht sie auf der zurückgeholten Zeile (Runde 8)", async ({
  page,
}) => {
  await vimMode(page);
  const row = board(page).locator('[data-row][data-kind="session"]').nth(1);
  const key = await row.getAttribute("data-row");
  const id = await row.getAttribute("data-session");
  try {
    await row.focus();
    await page.keyboard.press("x");
    if (await ask(page).count()) await page.keyboard.press("y");
    await expect(page.locator(`[data-row="${key}"]`)).toHaveCount(0);
    // The next row has the cursor, also after the overview drew the board anew
    await page.waitForTimeout(1500);
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-row"))).toBe(true);
    await page.keyboard.press("u");
    await expect(page.locator(`[data-row="${key}"]`)).toBeFocused();
    await page.keyboard.press("Shift+V");
    await expect(mode(page)).toHaveText(/^VISUAL/);
  } finally {
    await page.request.post("/api/meta", { data: { id, hidden: false } }).catch(() => {});
  }
});
