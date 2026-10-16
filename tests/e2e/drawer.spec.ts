import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

/**
 * The drawer as tile 5 (spec, "Ein Schirm im CLI-Look", rule 10): Enter opens it in the event stream's place, 60
 * columns, inside the screen; it scrolls for itself, `+` shows it alone, Esc closes it and the focus is back on the
 * watch board. Under 100 columns it stands in front of the middle, with the tab "5 Schublade" current.
 */

/** The tiles of the middle in sight, in order. */
const shown = (page: Page) =>
  page
    .locator(".middle > [data-tile]")
    .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.dataset.tile));

const overflow = (page: Page) =>
  page.evaluate(() => [
    document.documentElement.scrollHeight - window.innerHeight,
    document.documentElement.scrollWidth - window.innerWidth,
  ]);

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not in sight`);
  return b;
};

const sessionRow = (page: Page) =>
  page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });

test("Schublade als Kachel: an Stelle des Stroms, im Schirm, + zeigt sie allein, Esc zurück in die Wachtafel", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "the phone has its own test");
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => shown(page)).toEqual(["repos", "board", "stream"]);
    await sessionRow(page).focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("complementary", { name: "Session: Checkout auf die neuen Komponenten umstellen" });
    await expect(drawer).toBeVisible();
    // In the stream's place: the right column of the middle, its frame in --sel as the active tile
    await expect.poll(() => shown(page)).toEqual(["repos", "board", "drawer"]);
    await expect(page.locator('[data-tile="drawer"][data-active]')).toHaveCount(1);
    const middle = await box(page, ".middle");
    const d = await box(page, '[data-tile="drawer"]');
    const b = await box(page, '[data-tile="board"]');
    expect(Math.round(d.x + d.width)).toBe(Math.round(middle.x + middle.width));
    expect(Math.round(d.y + d.height)).toBe(Math.round(middle.y + middle.height));
    // Wider than the stream's 36 columns, and the watch board keeps the rest
    expect(d.width).toBeGreaterThan(b.width / 3);
    expect(b.width).toBeGreaterThan(0);
    expect(await overflow(page)).toEqual([0, 0]);
    // The key of the stream says where it went
    await page.keyboard.press("4");
    await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
      /Die Schublade steht an Stelle des Stroms – Esc schließt sie$/,
    );
    // `+` shows the drawer alone, and back
    await page.keyboard.press("5");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest("[data-tile]")?.getAttribute("data-tile")))
      .toBe("drawer");
    await page.keyboard.press("+");
    await expect.poll(() => shown(page)).toEqual(["drawer"]);
    expect(Math.round((await box(page, '[data-tile="drawer"]')).width)).toBe(Math.round(middle.width));
    await page.keyboard.press("+");
    await expect.poll(() => shown(page)).toEqual(["repos", "board", "drawer"]);
    // Esc closes it; the selection is back on the row of the board, the stream back in its place
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(sessionRow(page)).toBeFocused();
    await expect.poll(() => shown(page)).toEqual(["repos", "board", "stream"]);
  }
});

test("Schublade scrollt für sich: die Seite bleibt, der Kachelkörper scrollt, die Reiter der Schublade bleiben stehen", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "the phone has its own test");
  // A low window: the repo's architecture is longer than the tile
  await page.setViewportSize({ width: 1024, height: 400 });
  await page
    .getByRole("region", { name: "Repos" })
    .getByRole("button", { name: "shop-frontend", exact: true })
    .click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  await drawer.getByRole("tab", { name: "Architektur" }).click();
  await expect(drawer.getByRole("heading", { name: "shop-frontend – Architektur" })).toBeVisible();
  const body = page.locator('[data-tile="drawer"] .tile-b');
  await expect.poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const tabs = drawer.getByRole("tablist", { name: "Repo-Ansichten" });
  const top = (await tabs.boundingBox())?.y;
  await body.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The body scrolls, the page does not, and the tabs stay where they were
  expect((await tabs.boundingBox())?.y).toBe(top);
  expect(await overflow(page)).toEqual([0, 0]);
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
});

test("Terminal in der Kachel: öffnet als Vollbild, xterm passt sich an, ohne Vollbild schmaler", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "the phone has its own test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("region", { name: "Alarmzone" })
    .getByRole("article", { name: "Rundung im Warenkorb korrigieren" })
    .getByRole("button", { name: "Terminal" })
    .click();
  const drawer = page.getByRole("complementary", { name: "Terminal: Rundung im Warenkorb korrigieren" });
  await expect(drawer.getByText("Do you want to proceed?").first()).toBeVisible();
  const screenW = () => page.locator('[data-tile="drawer"] .xterm-screen').evaluate((el) => el.clientWidth);
  const tileW = async () => (await box(page, '[data-tile="drawer"]')).width;
  // Release 6: the terminal opens full screen; it fits into the tile, never past its edge
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  // In full screen the frame's button says what it does: shrink (round 4: "Vollbild" made it smaller)
  await expect(drawer.getByRole("button", { name: "Verkleinern" })).toBeVisible();
  expect(await screenW()).toBeLessThanOrEqual(await tileW());
  const full = await screenW();
  // Shrunk: back in its column, narrower, and still inside its tile
  await drawer.getByRole("button", { name: "Verkleinern" }).click();
  await expect.poll(() => shown(page)).toEqual(["repos", "board", "drawer"]);
  await expect.poll(screenW).toBeLessThan(full);
  expect(await screenW()).toBeLessThanOrEqual(await tileW());
  await drawer.getByRole("button", { name: "Vollbild" }).click();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await expect.poll(screenW).toBe(full);
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
});

test("Handy: die Schublade steht vor der Mitte, Reiter 5 ist aktiv; die anderen Reiter holen ihre Kachel", async ({
  page,
}, info) => {
  test.skip(!isMobile(info.project.name), "the phone's one-tile middle");
  const tabs = page.getByRole("navigation", { name: "Kacheln" });
  const open = page
    .getByRole("region", { name: "Alarmzone" })
    .getByRole("article", { name: "Rundung im Warenkorb korrigieren" })
    .getByRole("button", { name: "Terminal" });
  await open.click();
  const drawer = page.getByRole("complementary", { name: "Terminal: Rundung im Warenkorb korrigieren" });
  await expect(drawer).toBeVisible();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await expect(tabs.getByRole("button", { name: "5 Schublade" })).toHaveAttribute("aria-current", "true");
  expect(await overflow(page)).toEqual([0, 0]);
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
  // The stream stays a tile of its own on the phone; the drawer waits behind it
  await tabs.getByRole("button", { name: "4 Strom" }).click();
  await expect.poll(() => shown(page)).toEqual(["stream"]);
  await tabs.getByRole("button", { name: "5 Schublade" }).click();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  // Closed, the watch board is in front again, and the focus is back where the drawer was opened (the alarm zone)
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
  await expect.poll(() => shown(page)).toEqual(["board"]);
  await expect(open).toBeFocused();
  await expect(tabs.getByRole("button", { name: "1 Alarm" })).toHaveAttribute("aria-current", "true");
});

/**
 * What breaks the grid in the drawer's body: another face or size, a line height off the grid, a rounded corner, a
 * shadow. One entry per offending element, empty when all lie on the grid.
 */
const offGrid = (page: Page) =>
  page.locator('[data-tile="drawer"] .tile-b').evaluate((body) => {
    const grid = getComputedStyle(body);
    return [...body.querySelectorAll<HTMLElement>("*")]
      .filter((el) => el.getClientRects().length > 0)
      .flatMap((el) => {
        const cs = getComputedStyle(el);
        const bad = [
          cs.fontFamily !== grid.fontFamily && `font ${cs.fontFamily}`,
          cs.fontSize !== grid.fontSize && `size ${cs.fontSize}`,
          cs.lineHeight !== grid.lineHeight && `line ${cs.lineHeight}`,
          cs.borderRadius !== "0px" && `radius ${cs.borderRadius}`,
          cs.boxShadow !== "none" && `shadow ${cs.boxShadow}`,
        ].filter(Boolean);
        return bad.length ? [`${el.tagName.toLowerCase()}.${el.className}: ${bad.join(", ")}`] : [];
      });
  });

test("Session in der Schublade: Zeilen auf dem Raster, keine Karte; Aufgaben, Kontext als Zeichenbalken, Notiz", async ({
  page,
}) => {
  const name = "Checkout auf die neuen Komponenten umstellen";
  await page.getByRole("button", { name }).first().click();
  const drawer = page.getByRole("complementary", { name: `Session: ${name}` });
  // A task, not the answer in the conversation that names it too
  await expect(drawer.getByRole("list", { name: "Aufgaben" }).getByText("Unit-Tests anpassen")).toBeVisible();
  // Rules 7–9: one face, one size, whole lines; no card, no rounded tag, no icon button
  await expect(drawer.getByRole("article")).toHaveCount(0);
  expect(await offGrid(page)).toEqual([]);
  expect(await page.locator('[data-tile="drawer"] .tile-b').evaluate((el) => getComputedStyle(el).lineHeight)).toBe(
    "20px",
  );
  // The context as a bar of characters, like on the watch board
  const bar = drawer.getByRole("progressbar", { name: "Kontextfenster" });
  await expect(bar).toHaveText(/^[█░]{12}$/);
  await expect(bar).toHaveAttribute("aria-valuenow", "87");
  // Pin and hide are words now
  await expect(drawer.getByRole("button", { name: "Anpinnen" })).toHaveText("Anpinnen");
  await expect(drawer.getByRole("textbox", { name: "Notiz" })).toBeVisible();
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
});

test("Fleet-Frage in der Schublade: alle Antworten als Zeilen, die empfohlene benannt, ein Klick antwortet", async ({
  page,
}) => {
  const zone = page.getByRole("region", { name: "Alarmzone" });
  // Fleet's question opens like a session: its title in the alarm row
  // The brake's question by name: since round 3 each question has its own countdown, so their order varies
  await zone.locator('[data-row="d:demo-entscheidung"]').getByTitle("Alle Antworten in der Schublade").click();
  const drawer = page.getByRole("complementary", { name: /^Fleet-Frage: / });
  await expect(drawer.getByText("Fleet hat angehalten: 6× derselbe Bash-Aufruf")).toBeVisible();
  await expect(drawer.getByText(/wartet noch \d:\d\d/)).toBeVisible();
  const answers = drawer.getByRole("list", { name: "Antworten" });
  await expect(answers.getByRole("button")).toHaveText([
    "Innehalten und neu ansetzen",
    "An Opus-Subagent geben",
    "Weiter so",
    "Anhalten",
  ]);
  // The recommended one says so, each hint stands under its answer
  await expect(answers.getByRole("listitem").first()).toContainText("empfohlen");
  await expect(answers.getByText("Claude fasst zusammen, was nicht klappt, und fragt dich")).toBeVisible();
  expect(await offGrid(page)).toEqual([]);
  await answers.getByRole("button", { name: "Weiter so" }).click();
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText("Weiter so");
  await expect(answers.getByRole("button", { name: "Weiter so" })).toHaveAttribute("aria-pressed", "true");
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
  // By keyboard: the drawer action on the question's row (Vim `o`, here through the command line)
  await page.locator('[data-row="d:demo-entscheidung"]').focus();
  await page.keyboard.press(":");
  await page.keyboard.type("Schublade öffnen");
  await page.keyboard.press("Enter");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("Übergabe in der Schublade: Zeilen auf dem Raster", async ({ page }) => {
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("rowgroup", { name: "Übergabe bereit" })
    .getByRole("row", { name: "mobile-app" })
    .getByRole("button", { name: /^Übergabe / })
    .click();
  const drawer = page.getByRole("complementary", { name: "Übergabe: mobile-app" });
  await expect(drawer.getByRole("listitem").first()).toBeVisible();
  expect(await offGrid(page)).toEqual([]);
  await drawer.getByRole("button", { name: "Schließen" }).click();
});

test("Roter Lauf in der Schublade: Jobs, Tests und Log als Zeilen auf dem Raster; Vim o öffnet sie von der Zeile", async ({
  page,
}) => {
  const row = page.getByRole("region", { name: "Alarmzone" }).getByRole("article", { name: /PR #48/ });
  await row.getByRole("button", { name: /^PR #48/ }).click();
  const drawer = page.getByRole("complementary", { name: /^CI: billing-service · PR #48/ });
  await expect(drawer.getByText(/fehlgeschlagen in „pnpm test:integration“/)).toBeVisible();
  await drawer.getByText("Log-Auszug").click();
  await expect(drawer.getByText(/AssertionError/)).toBeVisible();
  expect(await offGrid(page)).toEqual([]);
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
  // By keyboard: the drawer action on the row (Vim `o`, here through the command line); the drawer keeps the focus
  await row.focus();
  await page.keyboard.press(":");
  await page.keyboard.type("Schublade öffnen");
  await page.keyboard.press("Enter");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Schließen" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("Opening a session from any list shows its conversation and, in sight, what it does right now", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "the phone has its own test");
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = "Checkout auf die neuen Komponenten umstellen";
  const drawer = page.getByRole("complementary", { name: `Session: ${name}` });
  const check = async () => {
    await expect(drawer).toBeVisible();
    const chat = drawer.getByRole("list", { name: "Verlauf" });
    await expect(chat.getByRole("listitem").first()).toBeVisible();
    await expect(chat.getByRole("listitem").first()).toContainText("Du");
    // The last line says what Claude does now, from the running call, and the drawer scrolled to it like a chat
    const now = drawer.getByTestId("session-now");
    await expect(now).toContainText("Jetzt:");
    await expect(now).toBeInViewport();
    const running = chat.getByRole("listitem").last();
    await expect(running).toContainText("läuft");
    const tool = (await running.locator("b").textContent()) || "";
    await expect(now).toContainText(tool);
    await drawer.getByRole("button", { name: "Schließen" }).click();
    await expect(drawer).toHaveCount(0);
  };
  // Watch board: Enter on the row, and a click on its title
  await sessionRow(page).focus();
  await page.keyboard.press("Enter");
  await check();
  await sessionRow(page).locator("[data-opener]").click();
  await check();
  // Command line: `:` and the row's number
  const nr = await sessionRow(page).getAttribute("data-nr");
  await page.keyboard.press(":");
  await page.keyboard.type(String(nr));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await check();
});
