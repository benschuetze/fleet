import { expect, isMobile, test } from "./fixtures";

// Round 8: the older-events button of Activity is a line of its tile: j/k, G and End reach it, Enter shows more.

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Aktivität: der Knopf „Ältere zeigen“ ist mit j, G und Enter erreichbar (Runde 8)", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.goto("/activity");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  const events = page.getByRole("list", { name: "Ereignisse" }).getByRole("listitem");
  const more = page.getByRole("button", { name: /^Ältere zeigen/ });
  await expect(more).toBeVisible();
  const before = await events.count();
  // G ends on the button, not on the line above it
  await page.keyboard.press("Shift+G");
  await expect(more).toBeFocused();
  // k leaves it for the last line, j comes back to it
  await page.keyboard.press("k");
  await expect(events.last()).toBeFocused();
  await page.keyboard.press("j");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => events.count()).toBeGreaterThan(before);
});

test("Standard: End erreicht den Knopf „Ältere zeigen“ auch auf der Aktivitätsseite, die Taste ist die der Zeilen (Runde 8)", async ({
  page,
}) => {
  await page.goto("/activity");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  const more = page.getByRole("button", { name: /^Ältere zeigen/ });
  await page.keyboard.press("3");
  await page.keyboard.press("End");
  await expect(more).toBeFocused();
  await expect(page.getByTestId("tile-keys")).toContainText("Enter");
});
