import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Release 6 (plan R9, R10): what a session changed, full screen, by keyboard: d (Vim g d) opens it from a row or the
// session drawer, n/N walk the changes, ]/[ the files, t the whole file, / searches, Esc goes back to the row.

const view = (page: Page) => page.getByRole("region", { name: /^Änderungen: / });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const say = (page: Page) => page.getByTestId("diff-say");
const current = (page: Page) =>
  view(page).getByRole("navigation", { name: "Dateien" }).locator('[aria-current="true"]');

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("d auf einer Zeile: Diff im Vollbild; n/N Änderungen, ]/[ Dateien, t ganze Datei, / Suche, Esc zurück", async ({
  page,
}) => {
  // The cart session: its diff is the cart fix (each demo session shows its own files, see the next test)
  const row = page.locator('[data-row][data-kind="session"]').filter({ hasText: "Rundung im Warenkorb korrigieren" });
  await row.focus();
  await page.keyboard.press("d");
  await expect(view(page)).toBeVisible();
  await expect(page.getByTestId("diff-summary")).toContainText("gegen main · 3 Dateien · +10 −2");
  await expect(page.getByTestId("tile-keys")).toHaveText(
    "n/N Änderung · ]/[ Datei · t ganze Datei · f Liste · Esc zurück",
  );
  // The session's own files first, marked
  await expect(current(page)).toContainText("src/cart.ts");
  await expect(view(page).getByRole("article", { name: "src/cart.ts" }).locator(".df-l.del")).toHaveCount(2);
  // n walks the changes in order, also when everything fits on screen; the file list follows
  await page.keyboard.press("n");
  await expect(say(page)).toHaveText("Änderung 1 von 3");
  await page.keyboard.press("n");
  await expect(say(page)).toHaveText("Änderung 2 von 3");
  await expect(current(page)).toContainText("src/cart.test.ts");
  await page.keyboard.press("Shift+N");
  await expect(say(page)).toHaveText("Änderung 1 von 3");
  await expect(current(page)).toContainText("src/cart.ts");
  // ] goes to the next file and the list stays on it
  await page.keyboard.press("]");
  await expect(current(page)).toContainText("src/cart.test.ts");
  // The status follows the file, and n goes on from this file's first change
  await expect(say(page)).toHaveText("Datei 2 von 3");
  await page.keyboard.press("n");
  await expect(say(page)).toHaveText("Änderung 2 von 3");
  await expect(current(page)).toContainText("src/cart.test.ts");
  await page.keyboard.press("]");
  await expect(current(page)).toContainText("README.md");
  await page.keyboard.press("[");
  await expect(current(page)).toContainText("src/cart.test.ts");
  // t shows the whole file with line numbers, t again the diff
  await page.keyboard.press("t");
  await expect(view(page).getByRole("article", { name: "Datei src/cart.test.ts" })).toContainText("toBe(30)");
  await page.keyboard.press("t");
  await expect(view(page).getByRole("article", { name: "src/cart.test.ts" })).toBeVisible();
  // / searches; n then walks the hits
  await page.keyboard.press("/");
  await page.getByRole("searchbox", { name: "Im Diff suchen" }).fill("cents");
  await page.keyboard.press("Enter");
  await expect(say(page)).toHaveText(/^Treffer 1 von \d+$/);
  // Esc goes back to the row it was opened from
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("Each session's diff is its own: the checkout session shows its files and its task, not the cart", async ({
  page,
}) => {
  const row = page
    .locator('[data-row][data-kind="session"]')
    .filter({ hasText: "Checkout auf die neuen Komponenten umstellen" });
  await row.focus();
  await page.keyboard.press("d");
  await expect(view(page)).toBeVisible();
  await expect(view(page)).not.toContainText("src/cart.ts");
  await expect(view(page)).toContainText("Checkout auf die neuen Komponenten umstellen");
});

test("Vim: g d aus der Session-Schublade; die Seite darunter nimmt keine Taste", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByTestId("key-mode")).toHaveText("NORMAL");
  const row = board(page).locator('[data-row][data-kind="session"]').first();
  await row.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(view(page)).toBeVisible();
  // j moves the diff, not the board's selection; 1 is no tile key here
  await page.keyboard.press("j");
  await page.keyboard.press("1");
  await expect(page.locator('[data-tile="alarm"][data-active]')).toHaveCount(0);
  await page.keyboard.press("q");
  await expect(view(page)).toHaveCount(0);
  await expect(row).toBeFocused();
  // From the session drawer: d
  await page.keyboard.press("o");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toBeVisible();
  await page.keyboard.press("d");
  await expect(view(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("fleet.keyMode"));
});
