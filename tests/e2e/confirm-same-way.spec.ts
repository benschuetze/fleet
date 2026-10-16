import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Round 7: every way to do the same thing asks the same question and reports the same way: the drawer's Hide, x, ×
// and V+x on a waiting session; x and s on an approval; the merge button and `:merge`; `u` walks back every step.
// Writes to the shared demo server are caught and only recorded.

const zone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("main", { name: "Wachtafel" });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const ask = (page: Page) => page.getByRole("contentinfo").getByRole("alert");
const mode = (page: Page) => page.getByTestId("key-mode");

async function recordMeta(page: Page) {
  const sent: { id: string; hidden?: boolean }[] = [];
  await page.route("**/api/meta", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  return sent;
}

async function vimMode(page: Page) {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(mode(page)).toHaveText("NORMAL");
}

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Schublade: Ausblenden einer wartenden Session fragt wie x, danach steht die Auswahl auf der nächsten Zeile (Runde 7)", async ({
  page,
}) => {
  const sent = await recordMeta(page);
  const row = zone(page).locator('[data-row][data-kind="session"]').first();
  const id = await row.getAttribute("data-session");
  await row.locator("[data-opener]").click();
  await page.getByRole("complementary").getByRole("button", { name: "Ausblenden", exact: true }).click();
  await expect(ask(page)).toContainText("wartet auf dich – trotzdem ausblenden? y/n");
  expect(sent).toEqual([]);
  await page.keyboard.press("y");
  await expect.poll(() => sent).toContainEqual({ id, hidden: true });
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-row"))).toBe(true);
});

test("V+x mit einer wartenden Session nennt, dass sie wartet; Gruppenzeilen bleiben und das wird gesagt (Runde 7)", async ({
  page,
}) => {
  await vimMode(page);
  const sent = await recordMeta(page);
  const waiting = zone(page).locator('[data-row][data-kind="session"]').first();
  const title = (await waiting.getAttribute("aria-label")) || "";
  await waiting.focus();
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText(/auf dich – 2 markierte Sessions trotzdem ausblenden\? y\/n/);
  expect(title).not.toBe("");
  await page.keyboard.press("n");
  expect(sent).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");

  // A group row (Duplicates) in the selection: x must not be silent
  const dup = page.locator('[data-row][data-kind="dup"]').first();
  const above = page.locator('[data-zone="board"][data-kind="session"]').last();
  await above.focus();
  await page.keyboard.press("Shift+V");
  await dup.focus();
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText(/markierte Sessions? ausblenden\? y\/n/);
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/ausgeblendet – u holt sie zurück; 1 Zeile ohne Session bleibt/);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
});

test("x und s auf einer Freigabe fragen gleich, die Meldung sagt „sie“ (Runde 7)", async ({ page }) => {
  const approval = zone(page).locator('[data-row^="d:"]').first();
  await approval.focus();
  await page.keyboard.press("x");
  await expect(ask(page)).toContainText(/für 1 h stummschalten\? y\/n/);
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Abgebrochen/);
  await page.keyboard.press("s");
  await expect(ask(page)).toContainText(/für 1 h stummschalten\? y\/n/);
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/stumm bis .* u holt sie zurück/);
  await page.keyboard.press("u");
  await expect(status(page)).toHaveText(/Stummschaltung aufgehoben/);
});

test("u geht jeden Schritt dieses Besuchs zurück, rückwärts, und nennt die Session (Runde 7)", async ({ page }) => {
  const sent = await recordMeta(page);
  const rows = board(page).locator('[data-row][data-kind="session"]');
  const a = await rows.nth(0).getAttribute("data-session");
  const b = await rows.nth(1).getAttribute("data-session");
  const nameA = (await rows.nth(0).getAttribute("aria-label")) || "";
  await rows.nth(0).focus();
  await page.keyboard.press("x");
  await expect.poll(() => sent.length).toBe(1);
  await rows.nth(1).focus();
  await page.keyboard.press("x");
  await expect.poll(() => sent.length).toBe(2);
  await page.keyboard.press("u");
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toEqual({ id: sent[1]?.id, hidden: false });
  await expect(status(page)).toHaveText(/: wieder eingeblendet$/);
  await page.keyboard.press("u");
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3]).toEqual({ id: sent[0]?.id, hidden: false });
  expect([sent[0]?.id, sent[1]?.id].sort()).toEqual([a, b].sort());
  expect(nameA).not.toBe("");
  await page.keyboard.press("u");
  await expect(status(page)).toHaveText(/Nichts rückgängig zu machen/);
});

test("u macht Ausblenden und Stummschalten nacheinander rückgängig (Runde 7)", async ({ page }) => {
  const sent = await recordMeta(page);
  const row = board(page).locator('[data-row][data-kind="session"]').first();
  await row.focus();
  await page.keyboard.press("x");
  await expect.poll(() => sent.length).toBe(1);
  const ci = zone(page).locator('[data-row][data-kind="ci"]').first();
  await ci.focus();
  await page.keyboard.press("x");
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/stumm bis/);
  await page.keyboard.press("u");
  await expect(status(page)).toHaveText(/Stummschaltung aufgehoben/);
  await page.keyboard.press("u");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({ id: sent[0]?.id, hidden: false });
});

test("Mergen-Knopf einer Zeile fragt in der Statuszeile wie :merge, und die Frage bleibt (Runde 7)", async ({
  page,
}) => {
  const name = "Schema-Prüfung vor dem Import";
  const row = board(page).getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "Mergen" }).click();
  await expect(ask(page)).toContainText("PR #112 (3 Commits) nach main mergen? y/n");
  // It used to vanish after 5 s without a word
  await page.waitForTimeout(5600);
  await expect(ask(page)).toContainText("PR #112 (3 Commits) nach main mergen? y/n");
  await page.keyboard.press("Escape");
  await expect(status(page)).toHaveText(/Abgebrochen/);
  await row.getByRole("button", { name: "Mergen" }).click();
  await page.keyboard.press("y");
  await expect(page.getByText("Demo: würde PR #112 mergen")).toBeVisible();
});

test("Konfliktschublade einer Gruppe: „zusammenfassen“ und „mergen“ widersprechen sich nicht (Runde 7)", async ({
  page,
}) => {
  const dup = page.locator('[data-row][data-kind="dup"]').first();
  await dup.locator("[data-opener]").click();
  const d = page.getByRole("complementary");
  await expect(d.getByText(/nach ihrem Turn lassen sie sich zu einer Session zusammenfassen/)).toBeVisible();
  await expect(d.getByText(/nichts zu mergen/)).toHaveCount(0);
});
