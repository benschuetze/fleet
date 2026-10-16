// `fleet` typed in a folder (server/core/here.ts): Fleet opens for that folder. A known repo is chosen in the bar;
// a folder no repo covers is offered in the message row, with `:here`.
import { expect, test, withOverview } from "./fixtures";

test("fleet in a repo folder: the repo is chosen in the bar", async ({ page }) => {
  let name = "";
  await withOverview(page, (o) => {
    const r = o.repos.find((x) => x.sessions?.length) || o.repos[0];
    name = r?.name || "";
    o.here = { dir: `${r?.root}/src/deep`, at: 1_700_000_000_000 };
  });
  await expect(page).toHaveURL(new RegExp(`[?&]repo=${encodeURIComponent(name)}`));
  await expect(page.getByRole("note", { name: "Ordner" })).toHaveCount(0);
  // Once per call: after a reload the choice is not forced again.
  await page.goto("/");
  await expect(page).not.toHaveURL(/[?&]repo=/);
});

test("fleet in a folder without a repo: the message row offers Claude there, :here does it", async ({ page }) => {
  await withOverview(page, (o) => {
    o.here = { dir: "/Users/ben/neu/idee", at: 1_700_000_000_001 };
  });
  const note = page.getByRole("note", { name: "Ordner" });
  await expect(note).toContainText("Fleet für /Users/ben/neu/idee");
  await expect(note.getByRole("button", { name: "Claude hier starten" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press(":");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("here Tests reparieren");
  await expect(page.getByRole("listbox", { name: "Vorschläge" })).toContainText(
    "Claude in /Users/ben/neu/idee starten: Tests reparieren",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByText("Claude startet in /Users/ben/neu/idee")).toBeVisible();
});
