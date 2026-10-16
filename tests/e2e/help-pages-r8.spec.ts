import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Round 8: `?` lists only keys that do something on the page it is pressed on: no stream key without the stream, no
// status filter or folding of Resting without the watch board of "Now" (the complete list, `??`, stays complete).

const PAGES = ["/", "/repos", "/usage", "/activity"];

async function helpText(page: Page, mode: "standard" | "vim", path: string): Promise<string> {
  await page.evaluate((m) => localStorage.setItem("fleet.keyMode", JSON.stringify(m)), mode);
  await page.goto(path);
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toBeVisible();
  const text = (await help.locator("dl").allTextContents()).join("\n");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  return text;
}

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

for (const mode of ["standard", "vim"] as const) {
  test(`${mode}: die Hilfe jeder Seite nennt nur Tasten, die dort etwas tun (Runde 8)`, async ({ page }) => {
    for (const path of PAGES) {
      const text = await helpText(page, mode, path);
      const tiles = await page.locator("[data-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tile")));
      const now = path === "/";
      const where = `${mode} ${path}`;
      expect(text.includes("Ereignisstrom"), `${where}: Ereignisstrom ${tiles}`).toBe(tiles.includes("stream"));
      expect(text.includes("Kachel 2: Repo-Leiste"), `${where}: Repo-Leiste`).toBe(
        mode === "standard" && tiles.includes("repos"),
      );
      expect(text.includes("Filter: wartet"), `${where}: Filter`).toBe(now);
      expect(text.includes("Filter aufheben"), `${where}: Filter aufheben`).toBe(now);
      expect(text.includes("Ruht"), `${where}: Ruht`).toBe(now && mode === "vim");
      expect(text.includes("Alles zuklappen"), `${where}: zM`).toBe(now && mode === "vim");
      // What every page keeps
      expect(text, where).toContain("Kommandozeile");
      expect(text, where).toContain("Zeile runter");
    }
  });
}
