import type { Page } from "@playwright/test";
import { expect, isMobile, showTile, test } from "./fixtures";

// Practical test round 6: `?` and the status line follow the place the focus is in; the repo drawer's tabs go by
// keys in both modes; the diff names what `t` does in the whole-file view.

const bar = (page: Page) => page.getByRole("region", { name: /Repos/ }).first();

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("? in der Repo-Leiste zeigt die Tasten der Repo-Zeile, nicht die einer Session", async ({ page }) => {
  await showTile(page, "2 Repos");
  await bar(page).getByRole("button", { name: "shop-frontend", exact: true }).focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toContainText("Filter auf Repo");
  await expect(help).not.toContainText("Schublade öffnen");
});

test("Vim: h und l wechseln die Reiter der Repo-Schublade, die Statuszeile nennt sie", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await showTile(page, "2 Repos");
  await bar(page)
    .getByRole("button", { name: "shop-frontend", exact: true })
    .click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  await drawer.getByRole("tab", { name: "Sessions" }).focus();
  await expect(page.getByTestId("tile-keys")).toContainText("Reiter");
  await page.keyboard.press("l");
  await expect(drawer.getByRole("tab", { name: "Architektur" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("h");
  await expect(drawer.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
});

test("Diff: in der ganzen Datei nennt die Statuszeile t als Weg zurück zu den Änderungen", async ({ page }) => {
  const row = page.locator('[data-row][data-kind="session"]').filter({ hasText: "Rundung im Warenkorb korrigieren" });
  await row.focus();
  await page.keyboard.press("d");
  await expect(page.getByTestId("tile-keys")).toContainText("t ganze Datei");
  await page.keyboard.press("t");
  await expect(page.getByTestId("tile-keys")).toContainText("t Änderungen");
  await expect(page.getByTestId("tile-keys")).not.toContainText("ganze Datei");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});
