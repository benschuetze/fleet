import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, isMobile, test, withOverview } from "./fixtures";

const alarms = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const group = (page: Page, name: string) => board(page).getByRole("rowgroup", { name, exact: true });

/** The status mark of each session row in a container: [row name, state, character]. */
const pictures = (_page: Page, rows: ReturnType<Page["locator"]>) =>
  rows.evaluateAll((els) =>
    els.map((el) => {
      const marks = [...el.querySelectorAll("[data-testid=glyph]")];
      return [
        el.getAttribute("aria-label"),
        marks.map((g) => g.getAttribute("data-glyph")).join(","),
        marks.map((g) => g.textContent).join(","),
      ];
    }),
  );

/** Spec, "Ein Schirm im CLI-Look", rule 11: one character per state. */
const CHAR: Record<string, string> = { waiting: "?", working: "●", done: "✓", error: "✗", resting: "·" };

const theme = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name }).click();
  await page.keyboard.press("Escape");
};

test("Zeichen: jede Session trägt genau ein Statuszeichen, und es sagt dasselbe wie ihr Platz und ihr Wort", async ({
  page,
}) => {
  // Errors in the alarm zone: the red ✗, and the word next to it.
  const zone = alarms(page).locator("article");
  const errors = zone.filter({ hasText: /^\d+\s*✗\s*Fehler/ });
  const waits = zone.filter({ hasText: /^\d+\s*\?\s*(Frage|Freigabe|Fleet fragt)/ });
  expect(await errors.count()).toBeGreaterThan(0);
  expect(await waits.count()).toBeGreaterThan(0);
  for (const [name, g, c] of await pictures(page, errors)) expect([g, c], String(name)).toEqual(["error", "✗"]);
  for (const [name, g, c] of await pictures(page, waits)) expect([g, c], String(name)).toEqual(["waiting", "?"]);
  await expect(errors.first().getByText("Fehler", { exact: true })).toBeVisible();
  // Signal colour only in the mark of an alarm: red for an error, orange for waiting, never grey.
  const colour = (rows: typeof zone) =>
    rows
      .first()
      .getByTestId("glyph")
      .evaluate((el) => getComputedStyle(el).color);
  const grey = await group(page, "Fertig")
    .getByTestId("glyph")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(await colour(errors)).not.toBe(grey);
  expect(await colour(waits)).not.toBe(grey);
  expect(await colour(errors)).not.toBe(await colour(waits));
  // A red pipeline is no session: it says "CI rot" and gets no mark (one mark means one session status).
  const ci = zone.filter({ hasText: /^\d+\s*CI rot/ });
  expect(await ci.count()).toBeGreaterThan(0);
  for (const [name, g] of await pictures(page, ci)) expect(g, String(name)).toBe("");

  for (const [rows, g, word] of [
    [group(page, "Arbeitet").locator("tr[aria-label]"), "working", /arbeitet|Fleet-Job/],
    [group(page, "Fertig").locator("tr[aria-label]"), "done", /fertig/],
  ] as const) {
    expect(await rows.count()).toBeGreaterThan(0);
    for (const [name, pic, c] of await pictures(page, rows)) expect([pic, c], String(name)).toEqual([g, CHAR[g]]);
    // Text before shape: the mark carries its word, and the activity column next to it says it in short.
    const first = rows.first();
    await expect(first.getByRole("img", { name: word })).toBeVisible();
    if (g === "done") await expect(first.getByRole("cell", { name: "fertig", exact: true })).toBeVisible();
  }
  await board(page).getByRole("button", { name: /Ruht/ }).click();
  const resting = group(page, "Ruht").locator("tr[aria-label]");
  expect(await resting.count()).toBeGreaterThan(0);
  for (const [name, g, c] of await pictures(page, resting)) expect([g, c], String(name)).toEqual(["resting", "·"]);
  // No sprites any more: no picture, no waves.
  await expect(page.locator(".ship, .waves")).toHaveCount(0);
});

test("Zeichen: nichts bewegt sich, ● arbeitet und steht; auch auf dem Handy sichtbar", async ({ page }) => {
  // Spec rule 16: working stands still (the age column is what lives); blinking is for new alarms only.
  const motion = () =>
    page
      .locator("[data-testid=glyph]")
      .evaluateAll((els) =>
        els.map((el) => ({ g: el.getAttribute("data-glyph"), moving: getComputedStyle(el).animationName !== "none" })),
      );
  const all = await motion();
  expect(all.filter((x) => x.g === "working").length).toBeGreaterThan(0);
  // What stood there when the page came up is no news: not even the alarms blink.
  for (const x of all) expect(x.moving, `${x.g}`).toBe(false);
  // One character fits every width: unlike the ship it stays on the phone.
  await expect(group(page, "Arbeitet").locator("[data-testid=glyph]").first()).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const x of await motion()) expect(x.moving, `${x.g} with reduced motion`).toBe(false);
});

test("Blinken: nur ein neuer Alarm blinkt, dreimal mit 1 Hz, dann steht er; bei reduzierter Bewegung nie", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "the refresh is a key (Alt+R)");
  let late = false;
  let name = "";
  // A working session that fails after the page came up (made-up demo data, changed on the way to the browser).
  await withOverview(page, (o) => {
    // Not one Fleet asks about: that one stands at its question only.
    const asked = new Set(o.decisions.map((d) => d.sessionId));
    const s = o.sessions.find((x) => x.status === "working" && !x.proc && !x.next && !x.ci?.pr && !asked.has(x.id));
    if (!s) return;
    name = s.title || "";
    if (late) Object.assign(s, { status: "error", detail: "Turn fehlgeschlagen", statusSince: Date.now() });
  });
  const marks = alarms(page).getByTestId("glyph");
  const moving = () =>
    marks.evaluateAll((els) => els.filter((el) => getComputedStyle(el).animationName !== "none").length);
  expect(await marks.count()).toBeGreaterThan(0);
  expect(await moving()).toBe(0);

  late = true;
  await page.keyboard.press("Alt+r");
  const mark = alarms(page).getByRole("article", { name, exact: true }).getByTestId("glyph");
  await expect(mark).toHaveAttribute("data-glyph", "error");
  await expect.poll(() => mark.evaluate((el) => getComputedStyle(el).animationName)).toBe("fleet-new");
  expect(await mark.evaluate((el) => getComputedStyle(el).animationIterationCount)).toBe("3");
  // Only the new one: the alarms that were there stand still.
  expect(await moving()).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await mark.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Three beats, then it stands.
  await expect.poll(() => mark.evaluate((el) => el.getAnimations().length), { timeout: 6000 }).toBe(0);
});

test("Zeichenraster: eine Zeile ist 20 px, ein Dichte-Schalter gibt es nicht mehr, auch kein altes Dichte-Merkmal", async ({
  page,
}) => {
  // Spec rules 7 and 15: one line height for the whole screen; the density switch fell with stage 12.4. A browser
  // that still has `fleet.density` from before stays on the grid.
  await page.evaluate(() => localStorage.setItem("fleet.density", JSON.stringify("normal")));
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Zeilendichte" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.density)).toBeUndefined();
  const row = group(page, "Arbeitet").locator("tr[aria-label]").first();
  expect(Math.round((await row.boundingBox())?.height || 0)).toBe(20);
  const alarm = alarms(page).locator("article").first();
  // An alarm row is one line of the grid too (stage 12.6), Fleet's questions included
  for (const el of await alarms(page).locator("article").all())
    expect(Math.round((await el.boundingBox())?.height || 0), String(await el.getAttribute("aria-label"))).toBe(20);
  expect(await alarm.evaluate((el) => getComputedStyle(el).lineHeight)).toBe("20px");

  // Light mode passes axe on the grid as well.
  await theme(page, "Hell");
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
  await page.evaluate(() => localStorage.removeItem("fleet.density"));
});

test("Hell-Modus: Signaltext bleibt lesbar, wenn die Alarmzeile gewählt ist", async ({ page }) => {
  // Reported by the light-mode check: orange and red text on the selected row's tint fell below 4.5:1.
  await theme(page, "Hell");
  // Fleet's question is an alarm row too (stage 12.6): its title is no session's name, so focus goes by the opener.
  for (const kind of [/^\d+\s*\?\s*Fleet/, /^\d+\s*\?\s*(Frage|Freigabe|Fleet fragt)/, /^\d+\s*✗\s*Fehler/]) {
    const row = alarms(page).getByRole("article").filter({ hasText: kind }).first();
    const name = String(await row.getAttribute("aria-label"));
    await row.locator("[data-opener]").focus();
    const result = await new AxeBuilder({ page })
      .include(`article[aria-label="${name.replace(/"/g, '\\"')}"]`)
      .withRules(["color-contrast"])
      .analyze();
    expect(
      result.violations.flatMap((v) => v.nodes.map((n) => n.failureSummary)),
      name,
    ).toEqual([]);
  }
});

test("Zeichenbalken liegen auf dem Raster: jedes █/░ eine Spalte, Balken und Zahl ganz in ihrer Zelle", async ({
  page,
}, info) => {
  // Seen while checking stage 12.7: the bundled JetBrains Mono subsets have no block characters, the browser took
  // them from SF Mono (18 % wider) and even from Menlo 0.2 px too wide for the cell: the context ended in "…".
  test.skip(isMobile(info.project.name), "the phone hides the context column");
  // At 1440 px: at 1280 px the board shows the context as a number, the bar is for readers only (6.0.1).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const bars = page.getByRole("progressbar", { name: /Kontextfenster|5-Stunden-Limit|Wochenlimit/ });
  await expect(bars.first()).toBeVisible();
  const seen = await bars.evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length && /^[█░]+$/.test(el.textContent || ""))
      .map((el) => {
        // One grid column: a digit in the bar's own font and size. The text's own width comes from a range: the
        // element's box would include an ellipsis drawn after it.
        const probe = document.createElement("span");
        probe.textContent = "0".repeat(el.textContent?.length || 0);
        probe.style.whiteSpace = "pre";
        el.after(probe);
        const want = probe.getBoundingClientRect().width;
        probe.remove();
        const text = document.createRange();
        text.selectNodeContents(el);
        // Clipped: the cell's laid-out content is wider than its box (scrollWidth rounds a sub-pixel overflow away,
        // while the browser already draws the ellipsis).
        const cell = el.closest("td");
        let clipped = false;
        if (cell) {
          const all = document.createRange();
          all.selectNodeContents(cell);
          const pad = Number.parseFloat(getComputedStyle(cell).paddingLeft);
          clipped = all.getBoundingClientRect().width + pad > cell.getBoundingClientRect().width + 0.01;
        }
        return { name: el.getAttribute("aria-label"), ratio: text.getBoundingClientRect().width / want, clipped };
      }),
  );
  expect(seen.filter((b) => b.name === "Kontextfenster").length).toBeGreaterThan(0);
  for (const b of seen) {
    expect(b.ratio, String(b.name)).toBeGreaterThan(0.97);
    expect(b.ratio, String(b.name)).toBeLessThan(1.03);
    expect(b.clipped, `${b.name}: bar and number fit their cell`).toBe(false);
  }
});
