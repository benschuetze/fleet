import type { Page } from "@playwright/test";
import { expect, isMobile, overviewRoute, search, test } from "./fixtures";

// Practical test round 7: keys act inside the focused place, and the help and the status line say what the keys
// there do.

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const tileKeys = (page: Page) => page.getByTestId("tile-keys");
const focusZone = (page: Page) => page.locator(":focus").getAttribute("data-zone");
const vim = async (page: Page) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.locator("[data-nr]").first()).toBeVisible();
};

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Home und End bleiben in der Kachel: End in der Alarmzone endet in der Alarmzone, Home auf der Wachtafel auf der Wachtafel (Runde 7)", async ({
  page,
}) => {
  const alarmRows = zone(page).locator("[data-row]");
  const boardRows = board(page).locator("[data-row]");
  await page.keyboard.press("1");
  await expect.poll(() => focusZone(page)).toBe("alarm");
  await page.keyboard.press("End");
  await expect(alarmRows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(alarmRows.first()).toBeFocused();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await expect(alarmRows.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(alarmRows.last()).toBeFocused();
  // The board: Home is its first row, not alarm 1
  await page.keyboard.press("3");
  await page.keyboard.press("Home");
  await expect(boardRows.first()).toBeFocused();
  await page.keyboard.press("PageUp");
  await expect(boardRows.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(boardRows.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(boardRows.last()).toBeFocused();
});

test("Vim: gg und G bleiben in der Kachel (Runde 7)", async ({ page }) => {
  await vim(page);
  const alarmRows = zone(page).locator("[data-row]");
  const boardRows = board(page).locator("[data-row]");
  await alarmRows.first().focus();
  await page.keyboard.press("Shift+g");
  await expect(alarmRows.last()).toBeFocused();
  await page.keyboard.press("j");
  await expect(alarmRows.last()).toBeFocused();
  await boardRows.nth(2).focus();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(boardRows.first()).toBeFocused();
  await page.keyboard.press("k");
  await expect(boardRows.first()).toBeFocused();
});

test("Die Repo-Schublade, mit der Maus oder Shift+Enter geöffnet, wechselt gleich die Reiter mit ← → (Runde 7)", async ({
  page,
}) => {
  const bar = page.getByRole("region", { name: /Repos/ }).first();
  await bar.getByRole("button", { name: "shop-frontend", exact: true }).click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  await expect(drawer.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
  // The focus sits on Close, not on a tab
  await expect(drawer.getByRole("button", { name: "Schließen" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(drawer.getByRole("tab", { name: "Architektur" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(drawer.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
});

test("Vim: h und l wechseln die Reiter der Repo-Schublade auch gleich nach dem Öffnen mit der Maus (Runde 7)", async ({
  page,
}) => {
  await vim(page);
  const bar = page.getByRole("region", { name: /Repos/ }).first();
  await bar.getByRole("button", { name: "shop-frontend", exact: true }).click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  await expect(drawer.getByRole("button", { name: "Schließen" })).toBeFocused();
  await page.keyboard.press("l");
  await expect(drawer.getByRole("tab", { name: "Architektur" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("h");
  await expect(drawer.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
});

test("Ein Hinweis der Statuszeile („Erst eine Zeile wählen“) verschwindet mit der nächsten Taste (Runde 7)", async ({
  page,
}) => {
  await vim(page);
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-tile="board"] .tile-b')?.focus());
  await page.keyboard.press("Shift+v");
  await expect(status(page)).toContainText(/Erst eine/);
  await page.keyboard.press("j");
  await expect(status(page)).not.toContainText(/Erst eine/);
});

test("u setzt die Auswahl auf die zurückgeholte Zeile (Runde 7)", async ({ page }) => {
  const hidden = new Set<string>();
  await page.route("**/api/meta", async (route) => {
    const m = route.request().postDataJSON() as { id: string; hidden?: boolean };
    if (m.hidden) hidden.add(m.id);
    else hidden.delete(m.id);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(
    "**/api/overview",
    overviewRoute((o) => {
      for (const s of o.sessions) if (hidden.has(s.id)) s.meta = { ...(s.meta || {}), hidden: true };
    }),
  );
  await page.reload();
  const rows = board(page).locator('[data-row][data-kind="session"]');
  await expect(rows.first()).toBeVisible();
  const id = await rows.first().getAttribute("data-session");
  await rows.first().focus();
  await page.keyboard.press("x");
  const ask = page.getByRole("contentinfo").getByRole("alert");
  if (await ask.isVisible().catch(() => false)) await page.keyboard.press("y");
  await expect(board(page).locator(`[data-row][data-session="${id}"]`)).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(board(page).locator(`[data-row][data-session="${id}"]`)).toBeFocused();
});

test("Hilfe in der Alarmzone: Enter steht einmal da, als Aktion; x einmal (Runde 7)", async ({ page }) => {
  await zone(page).locator('[data-row][data-kind="session"]').first().focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toContainText("Die eine Aktion der Zeile ausführen");
  // The drawer keeps Shift+Enter only; Enter is the alarm row's action
  await expect(help.locator("dl > div").filter({ hasText: "Schublade öffnen" }).locator("kbd")).toHaveText([
    "Shift+Enter",
  ]);
  await expect(help.getByText(/Alarm wegräumen/)).toHaveCount(1);
  await expect(help.getByText("Ausblenden (markierte Zeilen: alle)")).toHaveCount(0);
  // "+" is written as +
  await expect(help.locator("kbd", { hasText: "Shift++" })).toHaveCount(0);
  await expect(help.locator("kbd", { hasText: /^\+$/ })).toHaveCount(1);
});

test("Hilfe auf der Alarmzone ohne gewählte Zeile nennt Enter als Aktion (Runde 7)", async ({ page }) => {
  await page.keyboard.press("1");
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const body = el?.closest("[data-tile]")?.querySelector<HTMLElement>(".tile-b");
    body?.focus();
  });
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toContainText("Die eine Aktion der Zeile ausführen");
});

test("Hilfe auf der Wachtafel (Standard) nennt → und d; im Strom Enter zur Zeile (Runde 7)", async ({ page }) => {
  await page.keyboard.press("3");
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-tile="board"] .tile-b')?.focus());
  await page.keyboard.press("?");
  let help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toContainText("Im Terminal im Fenster öffnen");
  await expect(help).toContainText("Änderungen und Dateien der Session");
  await page.keyboard.press("Escape");
  await page.keyboard.press("4");
  await page.keyboard.press("?");
  help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toContainText("Zur betroffenen Zeile springen");
});

test("Hilfe auf Repos und Verbrauch nennt nur Kacheln, die es dort gibt (Runde 7)", async ({ page }) => {
  for (const path of ["/repos", "/usage"]) {
    await page.goto(path);
    await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
    await page.keyboard.press("3");
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Tastenhilfe" });
    await expect(help).toBeVisible();
    await expect(help).not.toContainText("Kachel 2: Repo-Leiste");
    await expect(help).not.toContainText("Kachel 5: Schublade");
    await expect(help).toContainText("Kachel 3: Wachtafel");
    await page.keyboard.press("Escape");
  }
});

test("Vim: Hilfe in VISUAL nennt x (Runde 7)", async ({ page }) => {
  await vim(page);
  await board(page).locator('[data-row][data-kind="session"]').first().focus();
  await page.keyboard.press("Shift+v");
  await expect(page.getByTestId("key-mode")).toHaveText(/VISUAL/);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Tastenhilfe" })).toContainText(/Ausblenden/);
});

test("Ein Klick auf eine andere Zeile zeigt ihre Session in der offenen Schublade (Runde 7)", async ({ page }) => {
  const rows = board(page).locator('[data-row][data-kind="session"]');
  await rows.nth(0).locator("button.opener").click();
  const first = await rows.nth(0).getAttribute("aria-label");
  const second = rows.nth(1);
  const name = await second.getAttribute("aria-label");
  expect(name).not.toBe(first);
  await expect(page.getByRole("complementary", { name: `Session: ${first}` })).toBeVisible();
  await second.locator("td").first().click();
  await expect(page.getByRole("complementary", { name: `Session: ${name}` })).toBeVisible();
  // That row keeps the selection
  await expect(second).toBeFocused();
});

test("Esc nimmt die Suche und danach den Statusfilter weg (Runde 7)", async ({ page }) => {
  await search(page, "Schema");
  await page.keyboard.press("Enter");
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("1");
  await page.keyboard.press("Escape");
  await expect(status(page)).toContainText("Suche gelöscht");
  await page.keyboard.press("Alt+2");
  await expect(page.getByTestId("status-filter")).toContainText("Fehler");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
});

test("Statuszeile eines Terminals in der Schublade nennt nicht die Tasten der Session-Schublade (Runde 7)", async ({
  page,
}) => {
  const row = board(page).locator('[data-row][data-kind="session"]').first();
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
  await page.getByRole("complementary").getByRole("button", { name: "Schließen" }).focus();
  await expect(tileKeys(page)).not.toContainText(/Notiz|note/);
});
