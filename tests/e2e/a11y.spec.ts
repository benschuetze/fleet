import AxeBuilder from "@axe-core/playwright";
import { expect, tab, test } from "./fixtures";

const TABS = [/Jetzt/, /Repos & PRs/, /Verbrauch/, /Aktivität/];

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) in allen Ansichten`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    for (const name of TABS) {
      await tab(page, name).click();
      await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(
        result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`),
        String(name),
      ).toEqual([]);
    }
  });
}

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit offenem Terminal in der Schublade`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("region", { name: "Alarmzone" })
      .getByRole("article", { name: "Rundung im Warenkorb korrigieren" })
      .getByRole("button", { name: "Terminal" })
      .click();
    const drawer = page.getByRole("complementary", { name: /^Terminal: / });
    await expect(drawer.getByText("Do you want to proceed?").first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit offener Übergabe-Schublade (Stufe 12.2)`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    await page
      .getByRole("region", { name: "Sessions", exact: true })
      .getByRole("rowgroup", { name: "Übergabe bereit" })
      .getByRole("row", { name: "mobile-app" })
      .getByRole("button", { name: /^Übergabe / })
      .click();
    const drawer = page.getByRole("complementary", { name: "Übergabe: mobile-app" });
    await expect(drawer.getByRole("listitem").first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
  });
}

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit Session- und Fleet-Frage-Schublade (Stufe 12.5)`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    const axe = async () => {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    };
    await page.getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" }).first().click();
    const session = page.getByRole("complementary", { name: /^Session: / });
    await expect(session.getByRole("textbox", { name: "Notiz" })).toBeVisible();
    await axe();
    await session.getByRole("button", { name: "Schließen" }).click();
    await page
      .getByRole("region", { name: "Alarmzone" })
      .locator('[data-row="d:demo-entscheidung"]')
      .getByTitle("Alle Antworten in der Schublade")
      .click();
    const question = page.getByRole("complementary", { name: /^Fleet-Frage: / });
    await expect(question.getByRole("list", { name: "Antworten" })).toBeVisible();
    await axe();
    // Stage 12.6: a red pipeline's jobs, tests and log
    await question.getByRole("button", { name: "Schließen" }).click();
    await page
      .getByRole("region", { name: "Alarmzone" })
      .getByRole("article", { name: /PR #48/ })
      .getByRole("button", { name: /^PR #48/ })
      .click();
    const ci = page.getByRole("complementary", { name: /^CI: / });
    await expect(ci.getByText("Log-Auszug")).toBeVisible();
    await axe();
  });
}

test("Handybreite: kein seitliches Scrollen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const name of TABS) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, String(name)).toBeLessThanOrEqual(0);
  }
});

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit Tastenhilfe, Befehlspalette und Inline-Antwort`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    const axe = async (what: string) => {
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(
        result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`),
        what,
      ).toEqual([]);
    };
    await page.keyboard.press("?");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Tastenhilfe" })).toBeVisible();
    await axe("Tastenhilfe");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: /Befehl/ }).fill("merge");
    await axe("Befehlspalette");
    await page.keyboard.press("Escape");
    // Vim's `:` line is the same palette with a colon in front
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: /Befehl/ }).fill("mode vim");
    await page.keyboard.press("Enter");
    await page.keyboard.press(":");
    await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeFocused();
    await axe("Kommandozeile (Vim)");
    await page.getByRole("combobox", { name: /Befehl/ }).fill("mode standard");
    await page.keyboard.press("Enter");
    // The watch board drops this row's columns on a phone, but the row itself is there
    const live = page
      .getByRole("region", { name: "Sessions", exact: true })
      .getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });
    await live.focus();
    await page.keyboard.press("r");
    await expect(page.getByRole("textbox", { name: /^Antwort an / })).toBeFocused();
    await axe("Inline-Antwort");
    await page.keyboard.press("Escape");
  });
}

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) in der Log-Sicht, auch auf dem Handy ohne seitliches Scrollen`, async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+L");
    const log = page.getByRole("region", { name: "Log-Sicht" });
    await expect.poll(() => log.getByRole("listitem").count()).toBeGreaterThan(50);
    // A red and an orange line are among them (crm-sync's limit, shop-frontend waiting for its yes).
    await expect(log.getByText("Fehler", { exact: true }).first()).toBeVisible();
    await expect(log.getByText("wartet", { exact: true }).first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.keyboard.press("Escape");
  });
}

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) in der Diff-Sicht (Release 6), auch auf dem Handy ohne seitliches Scrollen`, async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    const line = page.getByRole("combobox", { name: /Befehl/ });
    // The cart session: its diff has src/cart.ts (each demo session shows its own files)
    await page
      .locator('[data-row][data-kind="session"]')
      .filter({ hasText: "Rundung im Warenkorb korrigieren" })
      .focus();
    await line.click();
    await line.fill(":diff");
    await page.keyboard.press("Enter");
    const view = page.getByRole("region", { name: /^Änderungen: / });
    await expect(view.getByRole("article", { name: "src/cart.ts" })).toBeVisible();
    await page.keyboard.press("/");
    await page.getByRole("searchbox", { name: "Im Diff suchen" }).fill("total");
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("Direkt aufgerufene Unterseite lädt ohne Umweg", async ({ page }) => {
  await page.goto("/usage");
  await expect(tab(page, /Verbrauch/)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("img", { name: /Tokens pro Tag/ })).toBeVisible();
});
