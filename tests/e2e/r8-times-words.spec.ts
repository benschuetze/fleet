import type { Page } from "@playwright/test";
import { expect, isMobile, tab, test, withOverview } from "./fixtures";

// Round 8: one "last active" time in every view, limits whose reset has passed, one wording in both languages.

test("Zuletzt aktiv: Session- und Repo-Schublade nennen für eine wartende Session denselben Wartebeginn, gerundet wie sonst", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "drawers are the same on the phone, the desktop is enough");
  let title = "";
  await withOverview(page, (o) => {
    const d = o.decisions.find((x) => o.sessions.find((y) => y.id === x.sessionId)?.project === "data-pipeline");
    const s = o.sessions.find((x) => x.id === d?.sessionId);
    if (!d || !s) throw new Error("demo without a Fleet question");
    title = String(s.title);
    // Fleet's question stands since 2 h 55 min while the transcript was touched just now.
    d.createdAt = Date.now() - (175 * 60e3 + 10e3);
    s.statusSince = d.createdAt;
    s.lastActivity = Date.now();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("region", { name: "Repos" })
    .getByRole("button", { name: "data-pipeline", exact: true })
    .click({ modifiers: ["Shift"] });
  const repo = page.getByRole("complementary", { name: "Repo: data-pipeline" });
  const item = repo.getByRole("listitem").filter({ hasText: title });
  await expect(item).toContainText("2 Std 55 Min");
  await expect(repo.getByText("gerade", { exact: true })).toHaveCount(0);
  await item.getByRole("button", { name: title }).click();
  const drawer = page.getByRole("complementary", { name: `Session: ${title}` });
  await expect(drawer.getByText(/zuletzt aktiv/)).toHaveText(/zuletzt aktiv 2 Std 55 Min/);
});

test("Limit: ein Fenster nach seinem Reset zeigt keinen alten Prozentwert, sondern „Reset vorbei“", async ({
  page,
}) => {
  await withOverview(page, (o) => {
    if (!o.usage?.limits?.five_hour || !o.usage.limits.seven_day) throw new Error("demo without limits");
    // 06:43 with a reset at 06:00 and the old 58 % (round 8)
    o.usage.limits.five_hour.used_percentage = 58;
    o.usage.limits.five_hour.resets_at = Math.floor((Date.now() - 43 * 60e3) / 1000);
    o.usage.limits.seven_day.resets_at = Math.floor((Date.now() - 60e3) / 1000);
  });
  const header = page.getByRole("group", { name: "Überblick" });
  await expect(header.getByRole("link", { name: /Reset vorbei/ })).toBeVisible();
  await expect(header.getByRole("progressbar", { name: "5-Stunden-Limit" })).toHaveCount(0);
  await expect(header.getByText(/58 %/)).toHaveCount(0);
  await tab(page, /Verbrauch/).click();
  await expect(page.getByTestId("limit-over")).toHaveCount(2);
  await expect(page.getByTestId("limit-over").first()).toHaveText("Reset vorbei, wartet auf neue Statuszeile");
  await expect(page.getByRole("progressbar", { name: "5-Stunden-Limit" })).toHaveCount(0);
  await expect(page.getByText(/Reset in 0 Min/)).toHaveCount(0);
});

async function english(page: Page) {
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.getByRole("group", { name: "Sprache" }).getByRole("button", { name: "EN" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Alarm zone", exact: true })).toBeVisible();
}

test("Englisch: „unmuted“ beim Aufheben, Daten als „16 Oct“, „tokens“ klein im Fließtext", async ({ page }) => {
  await english(page);
  const zone = page.getByRole("region", { name: "Alarm zone", exact: true });
  await zone.locator('[data-row^="d:"]').first().focus();
  await page.keyboard.press("s");
  await page.keyboard.press("y");
  await page.keyboard.press("u");
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText(/unmuted/);
  await expect(page.getByRole("contentinfo")).not.toContainText(/loud again/);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /Usage/ }).click();
  const text = await page.locator(".uview").innerText();
  // Day and month in numbers alone read as day/month or month/day: 10/10, 16/10
  expect(text).not.toMatch(/\b\d{1,2}\/\d{1,2}\b/);
  expect(text).toMatch(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  // After a number the unit is lower case in running text
  expect(text).not.toMatch(/\d\s+Tokens\b/);
});
