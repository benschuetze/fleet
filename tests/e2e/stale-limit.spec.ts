import { expect, isMobile, test, withOverview } from "./fixtures";

// Live on 16.10.2026: the header said "Week 56 %" from a status line of 00:00 while the app said 86 % at 09:20. The
// desktop app writes no status line; an old percentage is only a floor, and Fleet says so.

test("Eine alte Statuszeile zeigt das Limit als Untergrenze mit Stand, ohne Prognose", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "the header shows the limit on the desktop");
  const nine = Date.now() - 9 * 3600e3;
  await withOverview(page, (o) => {
    if (o.usage?.limits) o.usage.limits.at = nine;
  });
  const chip = page
    .getByRole("banner")
    .getByRole("link", { name: /Woche|5h|Limit/ })
    .first();
  await expect(chip).toContainText(/≥\s?\d+ %/);
  await expect(chip).toHaveAttribute("title", /Stand \d\d:\d\d/);
  await page.goto("/usage");
  await expect(page.getByTestId("limit-stale").first()).toContainText(/Stand \d\d:\d\d/);
  await expect(page.getByText(/Beim jetzigen Tempo/)).toHaveCount(0);
});

test("Eine frische Statuszeile zeigt das Limit ohne Untergrenze", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "the header shows the limit on the desktop");
  const chip = page
    .getByRole("banner")
    .getByRole("link", { name: /Woche|5h|Limit/ })
    .first();
  await expect(chip).toContainText(/\d+ %/);
  await expect(chip).not.toContainText("≥");
});
