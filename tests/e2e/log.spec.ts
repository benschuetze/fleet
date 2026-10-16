import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Stage 11: the log view (Shift+L). Every step of every session on one screen, back to the same place, the row
// numbers of "Now" as a filter, at most 500 lines, new lines without reloading, signals in the colour grammar.

const logView = (page: Page) => page.getByRole("region", { name: "Log-Sicht" });
const steps = (page: Page) => logView(page).getByRole("listitem");
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const focusedNr = (page: Page) => page.locator(":focus").getAttribute("data-nr");
const sessionsShown = (page: Page) =>
  steps(page).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-session")))]);

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Shift+L öffnet die Log-Sicht über jeder Ansicht; Shift+L und Esc führen zurück, Auswahl und Scroll bleiben", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1171, height: 600 });
  await page.keyboard.press("1");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedNr(page)).toBe("3");
  // The page never scrolls (stage 12): the watch board tile does.
  const tile = page.locator('[data-tile="board"] .tile-b');
  const scrollY = () => tile.evaluate((el) => el.scrollTop);
  await tile.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(scrollY).toBeGreaterThan(0);
  const scrolled = await scrollY();
  for (const back of ["Shift+L", "Escape"]) {
    await page.keyboard.press("Shift+L");
    await expect(logView(page)).toBeVisible();
    await expect(logView(page).getByRole("list", { name: "Schritte aller Sessions" })).toBeFocused();
    await expect(page.getByTestId("log-filter")).toContainText("LOG · alle Sessions");
    await expect.poll(() => steps(page).count()).toBeGreaterThan(50);
    // Headless runs and sessions outside the overview's repos appear too.
    expect(await sessionsShown(page)).toContain("c0ffee12-3a4b-4c5d-8e9f-0a1b2c3d4e5f");
    await page.keyboard.press(back);
    await expect(logView(page)).toHaveCount(0);
    await expect.poll(() => focusedNr(page), back).toBe("3");
    expect(await scrollY(), back).toBe(scrolled);
  }
  // From another view as well (stage 12: the areas are commands, Alt+3 is a filter now).
  await page.keyboard.press(":");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("usage");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Bereiche" }).getByRole("link", { name: /Verbrauch/ }),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Shift+L");
  await expect(logView(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(logView(page)).toHaveCount(0);
});

test("Vim-Modus: dieselbe Taste Shift+L, Esc zurück", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByTestId("key-mode")).toHaveText("NORMAL");
  // The rows come with the first overview, after the page: a j before them moves nothing (failed on the CI runner).
  await expect(page.locator("[data-nr]").first()).toBeVisible();
  // The first j starts in the active tile (the board, round 3), the second moves one row on
  const first = Number(await board(page).locator("[data-nr]").first().getAttribute("data-nr"));
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect.poll(() => focusedNr(page)).toBe(String(first + 1));
  await page.keyboard.press("Shift+L");
  await expect(logView(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => focusedNr(page)).toBe(String(first + 1));
  await page.evaluate(() => localStorage.removeItem("fleet.keyMode"));
});

test("Zeilennummer der Wachtafel filtert die Log-Sicht, 0 zeigt wieder alle; der Filter steht in der Statuszeile", async ({
  page,
}) => {
  const row = board(page).getByRole("rowgroup", { name: "Arbeitet" }).locator("[data-nr][data-session]").first();
  const nr = String(await row.getAttribute("data-nr"));
  const id = String(await row.getAttribute("data-session"));
  await page.keyboard.press("Shift+L");
  await expect.poll(() => steps(page).count()).toBeGreaterThan(50);
  await page.keyboard.type(nr);
  await expect(page.getByTestId("log-filter")).toContainText(`nur Zeile ${nr}`);
  await expect.poll(() => sessionsShown(page)).toEqual([id]);
  // A digit typed within a second continues the number (12); "0" alone must wait for that second to pass.
  await page.waitForTimeout(1100);
  await page.keyboard.press("0");
  await expect(page.getByTestId("log-filter")).toContainText("LOG · alle Sessions");
  await expect.poll(async () => (await sessionsShown(page)).length).toBeGreaterThan(5);
  // Closing drops the filter: next time the log shows all again.
  await page.keyboard.type(nr);
  await expect.poll(() => sessionsShown(page)).toEqual([id]);
  await page.keyboard.press("Shift+L");
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("log-filter")).toContainText("alle Sessions");
});

test("Each log line shows its row on Now; the number of Fleet's question (row 1) filters to its session", async ({
  page,
}) => {
  const q = page.getByRole("region", { name: "Alarmzone" }).locator('[data-kind="decision"][data-owner]').first();
  const nr = String(await q.getAttribute("data-nr"));
  const id = String(await q.getAttribute("data-owner"));
  await page.keyboard.press("Shift+L");
  await expect.poll(() => steps(page).count()).toBeGreaterThan(50);
  // The number shown before a session's lines is the one to type
  await expect(
    steps(page)
      .and(page.locator(`[data-session="${id}"]`))
      .first()
      .getByTestId("log-nr"),
  ).toHaveText(nr);
  await expect(page.getByTestId("log-filter")).toContainText("Nr. Zeile auf Jetzt");
  await page.keyboard.type(nr);
  await expect(page.getByTestId("log-filter")).toContainText(`nur Zeile ${nr}`);
  await expect.poll(() => sessionsShown(page)).toEqual([id]);
});

test("Höchstens 500 Zeilen, neue erscheinen ohne Neuladen; Fehler rot, die wartende Session einmal orange", async ({
  page,
}) => {
  const line = (seq: number, session: string, kind = "tool", text = `Schritt ${seq}`) => ({
    seq,
    at: 1_800_000_000_000 + seq * 1000,
    session,
    kind,
    tool: kind === "tool" ? "Read" : null,
    text,
  });
  let calls = 0;
  // The server "writes" a new step once the first 500 lines were checked; the view's next poll must bring it.
  let written = false;
  await page.route("**/api/log*", async (route) => {
    calls++;
    const first = calls === 1;
    const lines = first
      ? [
          ...Array.from({ length: 697 }, (_, i) => line(i + 1, i % 2 ? "e2e-a" : "e2e-b")),
          line(698, "e2e-b", "error", "Exit code 1 · 2 failed"),
          line(699, "e2e-a", "text", "Soll ich den PR mergen?"),
        ]
      : written
        ? [line(1000, "e2e-b", "tool", "neuer Schritt")]
        : [];
    await route.fulfill({
      json: {
        epoch: "e2e",
        seq: written ? 1000 : 699,
        lines,
        sessions: { "e2e-a": { name: "Checkout", project: "shop" }, "e2e-b": { name: null, project: "billing" } },
        waiting: ["e2e-a"],
      },
    });
  });
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("log-count")).toHaveText("500 / 500");
  await expect(steps(page)).toHaveCount(500);
  const red = steps(page).filter({ hasText: "Exit code 1" });
  await expect(red.getByText("Fehler", { exact: true })).toBeVisible();
  const orange = steps(page).filter({ has: page.getByText("wartet", { exact: true }) });
  await expect(orange).toHaveCount(1);
  await expect(orange).toContainText("Soll ich den PR mergen?");
  // The poll brings the new step; the oldest goes, 500 stay.
  written = true;
  await expect(steps(page).last()).toContainText("neuer Schritt");
  await expect(steps(page)).toHaveCount(500);
  await expect(steps(page).filter({ hasText: "Schritt 199" })).toHaveCount(0);
  await expect(steps(page).filter({ hasText: "Schritt 201" })).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("LOG in der Befehlspalette, die Log-Tasten in der Tastenhilfe", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("LOG");
  await page.keyboard.press("Enter");
  await expect(logView(page)).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help.getByText("Wieder alle Sessions")).toBeVisible();
  await expect(help.getByText(/^Log-Sicht: alle Schritte/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(logView(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(logView(page)).toHaveCount(0);
});
