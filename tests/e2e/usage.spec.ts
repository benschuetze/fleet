import { expect, tab, test, withOverview } from "./fixtures";

test("Verbrauch: Diagramm, Tabelle und wo Tokens verloren gehen", async ({ page }) => {
  await tab(page, /Verbrauch/).click();
  await expect(page.getByRole("img", { name: /Tokens pro Tag/ })).toBeVisible();
  const waste = page.getByRole("region", { name: "Wo Tokens verloren gehen" });
  await expect(waste.getByText(/Sparpotenzial/)).toBeVisible();
  await expect(waste.getByText(/4× komplett neu in den Cache/)).toBeVisible();
  await page.getByRole("button", { name: "Tabelle" }).click();
  await expect(page.getByRole("columnheader", { name: "Summe" })).toBeVisible();
  // The page never scrolls (stage 12), the tile does: the table must not push the screen (round 3: scrollTop 90)
  for (const height of [720, 768, 900]) {
    await page.setViewportSize({ width: page.viewportSize()?.width || 1280, height });
    const fit = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".screen");
      return { over: el ? el.scrollHeight - el.clientHeight : -1, top: el?.scrollTop ?? -1, page: window.scrollY };
    });
    expect(fit, `height ${height}`).toEqual({ over: 0, top: 0, page: 0 });
  }
});

test("Tokens: Limit in der Kopfzeile, der Hebel mit einem Klick in der Schublade der Session", async ({ page }) => {
  // Stage 12.6: no token section under the board any more; the limit is in the header, the lever in the session
  await expect(page.getByRole("region", { name: "Tokens" })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Überblick" }).getByRole("progressbar", { name: "5-Stunden-Limit" }),
  ).toHaveAttribute("aria-valuenow", "58");
  await page.getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" }).first().click();
  const box = page.getByRole("complementary", { name: "Session: Checkout auf die neuen Komponenten umstellen" });
  // Wanted: choose the target right at "Frisch starten", then Fleet opens the new session there
  await box.getByRole("button", { name: /Frisch starten · liest jetzt 874 Tsd\.\/Aufruf/ }).click();
  const pick = box.getByRole("group", { name: "Frisch starten in" });
  await expect(pick.getByRole("button", { name: "VS Code" })).toBeVisible();
  await pick.getByRole("button", { name: "Desktop-App" }).click();
  await expect(page.getByText("Demo: würde frisch starten in Desktop-App")).toBeVisible();
});

test("Ohne Statuszeile keine geschätzten Prozent: Treffer mit Reset und die Tokens", async ({ page }) => {
  // Reported: the estimate said 80 % when the limit had long been reached
  const reset = Date.now() + 2 * 3600e3;
  await withOverview(page, (o) => {
    if (!o.usage) throw new Error("demo without usage");
    o.usage.limits = null;
    o.usage.limitHit = { kind: "five_hour", at: Date.now() - 20 * 60e3, resetsAt: reset };
    o.usage.block = {
      start: Date.now() - 3 * 3600e3,
      end: reset,
      first: Date.now() - 3 * 3600e3,
      tok: 1234567,
      cost: 41.2,
      burnPerMin: 5000,
    } as NonNullable<typeof o.usage.block>;
  });
  const overview = page.getByRole("group", { name: "Überblick" });
  await expect(overview.getByRole("link", { name: /Limit/ })).toBeVisible();
  await expect(overview.getByText("%")).toHaveCount(0);
  await tab(page, /Verbrauch/).click();
  const card = page.getByRole("region", { name: "Limit", exact: true });
  await expect(card.getByText("Erreicht")).toBeVisible();
  await expect(card.getByText(/Tokens seit \d\d:\d\d in deinen Claude-Code-Sessions/)).toBeVisible();
  await expect(card.getByText(/rät ihn nicht/)).toBeVisible();
  await expect(card.getByText(/\d %/)).toHaveCount(0);
  await expect(page.getByRole("progressbar", { name: "5-Stunden-Limit" })).toHaveCount(0);
  await expect(card.getByTestId("limit-approx")).toHaveText(/Tokens, 7 Tage \(Näherung, kein Limitwert\)/);
});

test("Fleet-Bilanz in der Kopfzeile: Vorzeichen, Methode im Tooltip, Klick führt zur Aufschlüsselung", async ({
  page,
}) => {
  const overview = page.getByRole("group", { name: "Überblick" });
  const chip = overview.getByRole("link", { name: /^Fleet 7 T/ });
  await expect(chip).toContainText("+");
  const tip = String(await chip.getAttribute("title"));
  for (const part of [/gekostet/, /gespart/, /Bilanz/, /Schätzung gegen einen nicht eingetretenen Fall/])
    expect(tip).toMatch(part);
  // One header line (stage 12.4): on screen only the balance; spent and saved are in the tooltip and on "Usage".
  await expect(chip.locator(":scope > :not(.sr)")).toHaveText(["Fleet 7 T", /^[+−][\d,]+/]);
  await chip.click();
  await expect(tab(page, /Verbrauch/)).toHaveAttribute("aria-current", "page");
  const card = page.getByRole("region", { name: "Fleet-Bilanz, 7 Tage" });
  await expect(card).toBeVisible();
  const measures = card.getByRole("region", { name: "Maßnahmen" });
  await expect(measures.getByRole("cell", { name: "Übergaben schreiben" })).toBeVisible();
  await expect(measures.getByRole("cell", { name: /^Frisch gestartet/ })).toBeVisible();
  await expect(card.getByText(/Nicht gemessen: Haiku statt Opus/)).toBeVisible();
  // The honest comparison of the independent review: a fresh start against /compact at the same point.
  await expect(card.getByTestId("bal-compact")).toContainText(
    /^Gegen \/compact an denselben 4 Stellen: \/compact ≈ .+, Übergaben schreiben .+ → \+.+ · Wochen: node dist\/fleet\.cjs balance$/,
  );
});

test("Abo: keine Dollar in Kopfzeile und auf Jetzt; API-Abrechnung zeigt sie wie bisher", async ({ page }) => {
  const overview = page.getByRole("group", { name: "Überblick" });
  await expect(overview).not.toContainText("$");
  await expect(page.getByRole("main")).not.toContainText("$");
  await withOverview(page, (o) => {
    o.billing = "api";
    if (o.usage) o.usage.limits = null;
  });
  await expect(overview.getByRole("link", { name: /\$ ?heute/ })).toBeVisible();
});

test("Limit-Balken in der Kopfzeile: das bindende Fenster mit Reset, beide im Tooltip", async ({ page }) => {
  await withOverview(page, (o) => {
    if (!o.usage?.limits?.five_hour || !o.usage.limits.seven_day) throw new Error("demo without limits");
    o.usage.limits.five_hour.used_percentage = 40;
    o.usage.limits.seven_day.used_percentage = 95;
  });
  const chip = page.getByRole("group", { name: "Überblick" }).getByRole("link", { name: /Woche/ });
  await expect(chip.getByRole("progressbar", { name: "Wochenlimit" })).toHaveAttribute("aria-valuenow", "95");
  await expect(chip).toContainText("95 %");
  await expect(chip).toContainText("bis");
  const tip = String(await chip.getAttribute("title"));
  expect(tip).toMatch(/5-Stunden-Limit 40 %/);
  expect(tip).toMatch(/Wochenlimit 95 %/);
});

test("Limit erreicht, aber Sessions arbeiten weiter: läuft über Guthaben, mit den Tokens seit dem Treffer", async ({
  page,
}) => {
  const at = Date.now() - 40 * 60e3;
  await withOverview(page, (o) => {
    if (!o.usage) throw new Error("demo without usage");
    o.usage.limits = null;
    o.usage.limitHit = { kind: "seven_day", at, resetsAt: Date.now() + 2 * 86400e3 };
    o.usage.overage = { since: at, tok: 2_400_000, cost: 3.1, n: 42 };
  });
  const chip = page.getByRole("group", { name: "Überblick" }).getByRole("link", { name: /Woche/ });
  await expect(chip).toContainText(/läuft über Guthaben · 2,4 Mio\. Tokens seit \d\d:\d\d/);
  await tab(page, /Verbrauch/).click();
  const card = page.getByRole("region", { name: "Limit", exact: true });
  await expect(card.getByTestId("overage")).toContainText(
    /Läuft über Guthaben: 2,4 Mio\. Tokens seit \d\d:\d\d \(42 Aufrufe\)/,
  );
});

test("Wo Tokens verloren gehen: a stronger model's tip names its extra cost, not 'unter 1 Cent'", async ({ page }) => {
  await page.keyboard.press(":");
  await page.keyboard.type("usage");
  await page.keyboard.press("Enter");
  const lost = page.getByRole("region", { name: "Wo Tokens verloren gehen" });
  const up = lost.getByRole("row").filter({ hasText: /Kostet .* mehr/ });
  await expect(up).toHaveCount(1);
  await expect(up).toContainText(/\+1,50\s\$ Kosten/);
  await expect(up).not.toContainText("unter 1 Cent");
});
