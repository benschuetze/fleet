import { expect, tab, test } from "./fixtures";

test("Repos & PRs: Branch, PR und CI je Repo", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  const row = page.getByRole("row").filter({ hasText: "fix/tax-rounding" });
  await expect(row.getByText("PR #48 offen")).toBeVisible();
  await expect(row.getByText("PR-CI rot", { exact: true })).toBeVisible();
  // The same finding not twice
  await expect(row.getByText("CI rot", { exact: true })).toHaveCount(0);
});

test("Projekte: Gruppe der Desktop-App mit ihren Repos, Briefing per Klick", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  const card = page.getByRole("article", { name: "Checkout-Relaunch" });
  await expect(card.getByText(/5 Sessions/)).toBeVisible();
  for (const repo of ["shop-frontend", "billing-service", "design-system"])
    await expect(card.getByText(repo)).toBeVisible();
  // Fleet's own terminal is the preferred target when it is available.
  await card.getByRole("button", { name: "Projekt-Briefing in Fleet-Terminal" }).click();
  await expect(page.getByText("Demo: würde in Fleet-Terminal ein Projekt-Briefing öffnen")).toBeVisible();
});

test("Offene PRs: auch ohne Session mergen, rote CI nur bestätigt, gestapelte warten", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  const docs = page.getByRole("article", { name: "Offene PRs in docs-site" });
  await docs.getByRole("button", { name: "Mergen" }).click();
  // The confirmation names commits and target branch, in the status line as `:merge` asks (round 7)
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText(
    "PR #14 (3 Commits) nach main mergen? y/n",
  );
  await page.keyboard.press("y");
  await expect(page.getByText("Demo: würde PR #14 mergen")).toBeVisible();

  const billing = page.getByRole("article", { name: "Offene PRs in billing-service" });
  // By its link: the row of #51 names #48 as well ("Konflikt mit #48")
  const red = billing.getByRole("listitem").filter({ has: page.getByRole("link", { name: /^#48 / }) });
  await expect(red.getByText("Rot: test (ubuntu-latest), lint")).toBeVisible();
  await red.getByRole("button", { name: "Trotzdem mergen" }).click();
  // Merging past red CI says so in the question, and its button title says it bypasses CI
  await expect(red.getByRole("button", { name: "Trotzdem mergen" })).toHaveAttribute("title", /an der CI vorbei/);
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText(
    "CI ist rot – trotzdem: PR #48 (1 Commit) nach main mergen? y/n",
  );
  // Esc takes the question back
  await page.keyboard.press("Escape");
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(/Abgebrochen/);
  await expect(red.getByRole("button", { name: "Trotzdem mergen" })).toBeVisible();

  // Draft and stacked PR: the button is there, but disabled with the reason
  const stacked = billing.getByRole("listitem").filter({ has: page.getByRole("link", { name: /^#52 / }) });
  await expect(stacked.getByText("wartet auf #51")).toBeVisible();
  await expect(stacked.getByRole("button", { name: /^Mergen: wartet auf #51/ })).toBeDisabled();
  // The disabled button says why on screen, not only in its title (round 3: it read "Merge")
  await expect(stacked.getByRole("button", { name: /^Mergen: wartet auf #51/ })).not.toHaveText("Mergen");
  const draft = page.getByRole("article", { name: "Offene PRs in shop-frontend" }).getByRole("listitem");
  await expect(draft.getByRole("button", { name: /^Mergen: Entwurf/ })).toBeDisabled();
  await expect(draft.getByRole("button", { name: /^Mergen: Entwurf/ })).not.toHaveText("Mergen");
});

test("Runde 5: die Merge-Frage bleibt stehen, bis man antwortet; ein PR-Review heißt überall gleich", async ({
  page,
}) => {
  await tab(page, /Repos & PRs/).click();
  const docs = page.getByRole("article", { name: "Offene PRs in docs-site" });
  await docs.getByRole("button", { name: "Mergen" }).click();
  const ask = page.getByRole("contentinfo").getByRole("alert");
  await expect(ask).toContainText("PR #14 (3 Commits) nach main mergen? y/n");
  // It went after 6 s without a word; now it waits for the answer (Esc, a click elsewhere or the yes).
  await page.waitForTimeout(6500);
  await expect(ask).toContainText("PR #14 (3 Commits) nach main mergen? y/n");
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(/Abgebrochen/);
  // "FREIGEGEBEN" in the list of open PRs, "APPROVED" in the table: one word in German
  await expect(page.getByText("approved", { exact: true })).toHaveCount(0);
  await expect(page.getByText("freigegeben", { exact: true }).first()).toBeVisible();
});

test("Runde 6: die Session-Zahl einer Zeile sagt, dass sie für diesen Checkout gilt", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  await expect(page.getByText(/Sessions? in diesem Checkout/).first()).toBeVisible();
  await expect(page.getByText(/Sessions? gesamt/)).toHaveCount(0);
});
