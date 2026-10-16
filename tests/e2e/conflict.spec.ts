import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, tab, test } from "./fixtures";

// Stage 8: what two sessions or PRs both change, in the conflict drawer (folder tree, hunks side by side, ways out).
const drawer = (page: Page) => page.getByRole("complementary", { name: /^Konflikt: / });

test("Doppelt → Konflikt-Schublade: Satz, Ordnerbaum mit A und B, Hunks nebeneinander, Esc schließt", async ({
  page,
}) => {
  // A duplicate is a row of the watch board (stage 12.2); its title opens the conflict drawer.
  const open = page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("rowgroup", { name: "Doppelt" })
    .getByRole("row", { name: "design-system" })
    .getByRole("button", { name: /^2 Sessions/ });
  await open.click();
  const d = drawer(page);
  await expect(d).toBeVisible();
  await expect(d.getByText("1 Datei in src/tokens/ von beiden geändert.")).toBeVisible();
  await expect(d.getByText(/demselben Branch und Commit/)).toBeVisible();
  // Only folders with a file both changed are open; the rest is folded with its count
  const tree = d.getByRole("list", { name: "Geänderte Dateien" });
  await expect(tree.getByRole("button", { name: /^tokens\// })).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("button", { name: /^components\// })).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("button", { name: /^docs\// })).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("button", { name: "Button.tsx: nur A" })).toHaveCount(0);
  await tree.getByRole("button", { name: /^docs\// }).click();
  await expect(tree.getByRole("button", { name: "tokens.md: nur B" })).toBeVisible();
  await tree.getByRole("button", { name: "colors.ts: beide" }).click();
  const hunks = d.getByRole("region", { name: "Änderungen in src/tokens/colors.ts" });
  await expect(hunks.getByRole("region", { name: "Seite A" })).toContainText("roundTax");
  await expect(hunks.getByRole("region", { name: "Seite B" })).toContainText("taxFor");
  // The ways out: open B to pause it (no branch of its own to rebase here)
  await expect(
    d.getByRole("group", { name: "Auswege" }).getByRole("button", { name: /B öffnen und anhalten/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("PR-Liste: Konflikt-Punkt an beiden PRs, Schublade mit echtem Merge-Konflikt und den Auswegen", async ({
  page,
}) => {
  await tab(page, /Repos & PRs/).click();
  const prs = page.getByRole("article", { name: "Offene PRs in billing-service" });
  await expect(prs.getByRole("button", { name: "Konflikt mit #48" })).toBeVisible();
  await prs.getByRole("button", { name: "Konflikt mit #51" }).click();
  const d = drawer(page);
  await expect(d).toHaveAttribute("aria-label", "Konflikt: #48 ↔ #51");
  await expect(
    d.getByText("1 Datei in src/invoice/ von beiden geändert, 1 echter Merge-Konflikt in totals.ts."),
  ).toBeVisible();
  await expect(d.getByRole("button", { name: "totals.ts: beide, Merge-Konflikt" })).toBeVisible();
  const ways = d.getByRole("group", { name: "Auswege" });
  await expect(ways.getByText("A zuerst: #48")).toBeVisible();
  // #48 has red CI: merging stays the two-step "anyway"
  await expect(ways.getByRole("button", { name: "Trotzdem mergen" })).toBeVisible();
  await expect(ways.getByRole("button", { name: "Rebase-Session starten" })).toBeVisible();
  await d.getByRole("button", { name: "Schließen" }).click();
  await expect(d).toHaveCount(0);
});

for (const theme of ["Hell", "Dunkel"]) {
  test(`Barrierefreiheit (axe, ${theme}) mit offener Konflikt-Schublade`, async ({ page }) => {
    await page.getByRole("button", { name: "Einstellungen" }).click();
    await page.getByRole("group", { name: "Farbschema" }).getByRole("button", { name: theme }).click();
    await page.keyboard.press("Escape");
    await tab(page, /Repos & PRs/).click();
    await page
      .getByRole("article", { name: "Offene PRs in billing-service" })
      .getByRole("button", { name: "Konflikt mit #51" })
      .click();
    await drawer(page).getByRole("button", { name: "totals.ts: beide, Merge-Konflikt" }).click();
    await expect(drawer(page).getByRole("region", { name: "Seite B" })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}× ${v.help}`)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
