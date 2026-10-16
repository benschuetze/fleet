import { expect, test } from "./fixtures";

test("Sprache umschalten hinter dem Zahnrad: Oberfläche auf Englisch, die Wahl bleibt nach dem Neuladen", async ({
  page,
}) => {
  const gear = page.getByRole("button", { name: "Einstellungen" });
  await expect(page.getByRole("group", { name: "Sprache" })).toBeHidden();
  await gear.click();
  await expect(gear).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("group", { name: "Sprache" }).getByRole("button", { name: "EN" }).click();
  await expect(page.getByRole("region", { name: "Alarm zone", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /Now/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // Fleet's questions follow the dashboard's language, not the server's (round 4: "Allow" in German, and back)
  const zone = page.getByRole("region", { name: "Alarm zone", exact: true });
  await expect(zone.locator('[data-row="d:demo-freigabe"] [data-act] button')).toHaveText("Allow");
  await expect(zone.locator('[data-row="d:demo-freigabe"] .a-why')).toContainText(/^Approval: Bash/);
  await expect(zone.locator('[data-row="d:demo-entscheidung"] [data-act] button')).toHaveText("Pause and rethink");
  await page.reload();
  await expect(page.getByRole("rowgroup", { name: "Done", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "DE" }).click();
  await expect(page.getByRole("region", { name: "Alarmzone" })).toBeVisible();
  // Escape closes the panel and gives the focus back to the gear
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Sprache" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Einstellungen" })).toBeFocused();
});
