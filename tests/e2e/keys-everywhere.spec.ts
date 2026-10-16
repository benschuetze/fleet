import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Release 6 (plan R11): every view by keyboard. The other views have lines (`data-line`): j/k or the arrows walk them,
// Enter presses a line's opener, a line that stands for a session takes the session keys (o drawer, i terminal,
// d diff). A view without lines still scrolls by keys; so does the drawer.

const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return {
      line: !!a?.hasAttribute("data-line"),
      session: a?.dataset.session || null,
      tile: a?.closest<HTMLElement>("[data-tile]")?.dataset.tile || null,
    };
  });

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Aktivität: 3 in die Kachel, j/k laufen durch den Verlauf, Enter öffnet die Session, d den Diff, i das Terminal", async ({
  page,
}) => {
  await page.goto("/activity");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await page.keyboard.press("3");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focused(page)).toMatchObject({ line: true, tile: "board" });
  const first = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).not.toBe(first);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe(first);
  // To a line of a session the overview knows
  await page.locator('[data-tile="board"] [data-line][data-session]').first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toHaveCount(0);
  await page.locator('[data-tile="board"] [data-line][data-session]').first().focus();
  await page.keyboard.press("d");
  await expect(page.getByRole("region", { name: /^Änderungen: / })).toBeVisible();
  await page.keyboard.press("Escape");
  // A session without an open approval: Fleet's own question (demo-02) never opens a branch (16.10.2026).
  await page.locator('[data-tile="board"] [data-line][data-session="demo-11"]').first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
});

test("Verbrauch und Repos: Zeilen per Tastatur; Enter auf einem Repo zeigt seine Sessions auf Jetzt", async ({
  page,
}) => {
  await page.goto("/usage");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await page.keyboard.press("3");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focused(page)).toMatchObject({ line: true, tile: "board" });
  await page.keyboard.press("End");
  await expect.poll(() => focused(page)).toMatchObject({ line: true });
  await page.goto("/repos");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await page.keyboard.press("3");
  const repoRow = page.locator('[data-tile="board"] tr[data-line]').first();
  await repoRow.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/\?repo=/);
});

test("Vim: j/k ohne Fokus wirken in der aktiven Kachel; die Schublade scrollt mit j", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.goto("/activity");
  await expect(page.getByTestId("key-mode")).toHaveText("NORMAL");
  // Ctrl+L works from the body too (round 8): it makes the alarm zone the active tile, and j starts in it
  await page.keyboard.press("Control+l");
  await expect.poll(() => page.locator("[data-tile][data-active]").getAttribute("data-tile")).toBe("alarm");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("j");
  await expect.poll(() => focused(page)).toMatchObject({ tile: "alarm" });
  // A long drawer scrolls by j
  await page.locator('[data-tile="board"] [data-line][data-session]').first().focus();
  await page.keyboard.press("o");
  const body = page.locator('[data-tile="drawer"] .tile-b');
  await expect(body).toBeVisible();
  await page
    .getByRole("complementary", { name: /^Session: / })
    .getByRole("button", { name: "Schließen" })
    .focus();
  const before = await body.evaluate((el) => el.scrollTop);
  const room = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  await page.keyboard.press("j");
  if (room > 0) await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await page.keyboard.press("q");
  await page.evaluate(() => localStorage.removeItem("fleet.keyMode"));
});
