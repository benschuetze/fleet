import { expect, isMobile, test } from "./fixtures";

// Release 6 (plan R7): `:new <name> [task]` starts Claude in a new project folder, straight into the full-screen
// terminal. The demo creates nothing on disk; its projects folder is invented.

test(":new mit neuem Namen: Vorschlag „Neuer Ordner …“, Enter startet Claude dort im Vollbild-Terminal", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const line = page.getByRole("combobox", { name: /Befehl/ });
  await line.click();
  await line.fill(":new rezepte Baue eine Rezept-App");
  const top = page.getByRole("listbox", { name: "Vorschläge" }).getByRole("option").first();
  await expect(top).toContainText("Neuer Ordner /home/demo/projects/rezepte: Baue eine Rezept-App");
  await page.keyboard.press("Enter");
  const term = page.getByRole("complementary", { name: /^Terminal: / });
  await expect(term).toBeVisible();
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
    /Neuer Ordner \/home\/demo\/projects\/rezepte: Claude startet/,
  );
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-tile="drawer"] .xterm')))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(term).toHaveCount(0);
});
