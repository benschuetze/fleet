import { expect, tab, test } from "./fixtures";

// One state, one word, on every view (round 7).
test("Verlauf: jedes Warten heißt „wartet · …“, kein „Jetzt“, kein Fehler ohne Grund (Runde 7)", async ({ page }) => {
  await tab(page, /Aktivität/).click();
  const history = page.getByRole("region", { name: "Verlauf" });
  const rows = history.getByRole("list", { name: "Ereignisse" }).getByRole("listitem");
  await expect(rows.first()).toBeVisible();
  const words = (
    await rows.evaluateAll((els) => els.map((e) => e.querySelector(".what")?.textContent?.trim() || ""))
  ).map((w) => w.trim());
  for (const w of words) {
    expect(w, w).not.toMatch(/^(Freigabe|Frage|Jetzt)(\s|$)/i);
    // An error line names its reason.
    if (/^Fehler/i.test(w)) expect(w.replace(/^Fehler\s*/i, "").length, w).toBeGreaterThan(0);
  }
});

test("Repos: keine „keine aktiv“-Zelle, derselbe Zustand heißt überall gleich (Runde 7)", async ({ page }) => {
  await tab(page, /Repos/).click();
  const text = await page.locator(".uview").innerText();
  expect(text.toLowerCase()).not.toContain("keine aktiv");
  expect(text.toLowerCase()).not.toContain("wartet auf dich");
});

test("Aktivität: „Ältere zeigen“ nennt, wie viele noch verborgen sind (Runde 7)", async ({ page }) => {
  await tab(page, /Aktivität/).click();
  const history = page.getByRole("region", { name: "Verlauf" });
  const rows = history.getByRole("list", { name: "Ereignisse" }).getByRole("listitem");
  await expect(rows).toHaveCount(40);
  const more = history.getByRole("button", { name: /^Ältere zeigen/ });
  const left = Number(/(\d+) weitere/.exec((await more.textContent()) || "")?.[1]);
  expect(left).toBeGreaterThan(0);
  await more.click();
  await expect(rows).toHaveCount(40 + Math.min(40, left));
});
