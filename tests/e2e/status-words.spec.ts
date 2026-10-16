import { expect, tab, test } from "./fixtures";

/**
 * One status word per session in every view (practical test, 15 Oct): a session Fleet holds a question for is
 * waiting ("wartet · Freigabe", "wartet · Fleet fragt") on Now, on Repos & PRs and on the usage page, never "arbeitet" or "keine Rückmeldung" there.
 */

test("Repos & PRs: a session with an open approval waits, as on Now", async ({ page }) => {
  await expect(
    page
      .getByRole("region", { name: "Alarmzone" })
      .getByRole("article")
      .filter({ hasText: "Nächtlichen Import parallelisieren" }),
  ).toBeVisible();
  await tab(page, /Repos & PRs/).click();
  const row = page.getByRole("row").filter({ hasText: "perf/batch-import" });
  await expect(row).toContainText("wartet · Freigabe");
  await expect(row).not.toContainText("arbeitet");
});

test("Verbrauch: a session Fleet paused waits, as on Now", async ({ page }) => {
  await page.keyboard.press(":");
  await page.keyboard.type("usage");
  await page.keyboard.press("Enter");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Flaky Login-Test stabilisieren" })
    .filter({ hasText: "wartet · Fleet fragt" });
  await expect(row).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "keine Rückmeldung" })).toHaveCount(0);
});
