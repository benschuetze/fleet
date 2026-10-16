import { expect, isMobile, test } from "./fixtures";

// Release 6.1.0 (plan T1): `:wt <repo> [task]` starts a session in a worktree of its own next to the repo. The demo
// creates nothing on disk; the answer names the worktree it would have made.

test(":wt: Vorschlag „eigener Worktree“, Enter startet Claude dort und sagt Branch und Ordner", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const line = page.getByRole("combobox", { name: /Befehl/ });
  await line.click();
  await line.fill(":wt shop Login reparieren");
  const top = page.getByRole("listbox", { name: "Vorschläge" }).getByRole("option").first();
  await expect(top).toContainText("Neue Session in shop-frontend, eigener Worktree: Login reparieren");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
    /Worktree fleet\/login-reparieren-[0-9a-f]{4} angelegt: Claude startet dort/,
  );
  await page.keyboard.press("Escape");
});
