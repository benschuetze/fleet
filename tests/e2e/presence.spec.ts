import { expect, test } from "./fixtures";

/*
 * Bug B3: any open Fleet page, even a background tab, let the hook hold every approval 45 s while the desktop app
 * showed nothing. Each tab now reports whether it is in front; leaving reports at once.
 */
test("Ein Tab meldet, ob er vorn ist; Verlassen meldet er sofort", async ({ page }) => {
  const reports: { tab: string; active: boolean }[] = [];
  await page.route("**/api/presence", async (route) => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reports.at(-1)?.active).toBe(true);
  const tab = reports.at(-1)?.tab;
  expect(tab).toMatch(/^tab-[a-z0-9]+$/);
  // Back to the app: the window loses focus.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => reports.at(-1)).toEqual({ tab, active: false });
  // A hidden tab never counts as in front.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300); // nothing to wait for: proves that no report follows
  expect(reports.filter((r) => r.active).length).toBe(1);
});
