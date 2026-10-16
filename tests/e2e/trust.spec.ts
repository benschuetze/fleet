import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Release 6, the yardstick of the test run (plan, "Erwartungstreue"): every number agrees with its counterpart, and a
// filter never leaves one place saying "nothing" while another place shows what was asked for (Ben's finding: filter
// "error", an empty board saying "no session is working", three errors right above it).

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const stream = (page: Page) => page.getByRole("region", { name: "Ereignisse" });
const counter = async (page: Page, name: RegExp) =>
  Number(
    (
      await page.getByRole("group", { name: "Überblick" }).getByRole("button", { name }).first().getAttribute("title")
    )?.match(/^\d+/)?.[0] ?? -1,
  );

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "the counts are the same on the phone; the desktop shows all places at once");
});

test("Kopfzeile = Alarmzone = Wachtafel: wartet, Fehler, CI, arbeitet, fertig", async ({ page }) => {
  const waiting = await zone(page).locator("[data-row]:has(.g-waiting)").count();
  const errors = await zone(page).getByText("Fehler", { exact: true }).count();
  const ci = await zone(page).locator('[data-row][data-kind="ci"]').count();
  expect(waiting).toBeGreaterThan(0);
  expect(await counter(page, /warten auf dich/)).toBe(waiting);
  expect(await counter(page, /Fehler/)).toBe(errors);
  expect(await counter(page, /CI/)).toBe(ci);
  const group = (name: string) => board(page).getByRole("rowgroup", { name, exact: true }).locator("[data-row]");
  expect(await counter(page, /arbeite/)).toBe(await group("Arbeitet").count());
  expect(await counter(page, /fertig/)).toBe(await group("Fertig").count());
});

for (const [key, word, rows] of [
  ["Alt+2", "mit Fehler", "Fehler"],
  ["Alt+1", "die auf dich warten", null],
] as const)
  test(`Filter ${key}: die Wachtafel sagt, wie viele oben stehen; Alarmzone und Strom zeigen nur diese`, async ({
    page,
  }) => {
    await page.keyboard.press(key);
    const n = rows
      ? await zone(page).getByText(rows, { exact: true }).count()
      : await zone(page).locator("[data-row]:has(.g-waiting)").count();
    expect(n).toBeGreaterThan(0);
    // Never "no session is working" under a filter while the alarm zone shows what was asked for
    await expect(board(page)).toContainText(`${n} Sessions ${word} – sie stehen oben in der Alarmzone (1).`);
    await expect(board(page)).not.toContainText("Gerade arbeitet keine Session");
    // Every row the alarm zone keeps belongs to the filter
    expect(await zone(page).locator("[data-row]").count()).toBe(n);
    // The stream follows the filter: only events of these sessions, and it says it is filtered
    const ids = await zone(page)
      .locator("[data-row]")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session || "").filter(Boolean));
    const decisions = await zone(page).locator('[data-row][data-kind="decision"]').count();
    await expect(stream(page)).toContainText("gefiltert");
    const lines = await stream(page)
      .locator("button[data-session]")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.session || ""));
    if (!decisions) for (const id of lines) expect(ids).toContain(id);
    await page.keyboard.press("Alt+0");
    await expect(stream(page)).not.toContainText("gefiltert");
  });
