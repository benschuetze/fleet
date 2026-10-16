import fs from "node:fs";
import { expect, tab, test } from "./fixtures";

test("Aktivität: Puls und Zeitleiste stehen dort, nicht auf der Startseite", async ({ page }) => {
  await expect(page.getByRole("img", { name: /Tokens pro Minute/ })).toHaveCount(0);
  await tab(page, /Aktivität/).click();
  await expect(
    page.getByRole("img", { name: /Tokens pro Minute in der letzten Stunde, gestapelt nach Projekt/ }),
  ).toBeVisible();
  await expect(page.getByText("auf dich gewartet, alle Sessions zusammen (3 Std)")).toBeVisible();
});

test("Aktivität: eine Zeitleiste je Repo, ein Repo filtert den Verlauf", async ({ page }) => {
  await tab(page, /Aktivität/).click();
  const timeline = page.getByRole("region", { name: "Zeitleiste je Repo" });
  const lanes = timeline.getByRole("img", { name: /^\S+: \d+ Min gearbeitet, \d+ Min auf dich gewartet$/ });
  await expect(lanes.first()).toBeVisible();
  // One lane per repo: no repo name twice, even though several demo repos have more than one session.
  const names = (await lanes.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")?.split(":")[0]))).sort();
  expect(names.length).toBeGreaterThan(3);
  expect(new Set(names).size).toBe(names.length);
  await expect(timeline.getByRole("button", { name: /· 2 Sessions$/ }).first()).toBeVisible();

  const history = page.getByRole("region", { name: "Verlauf" });
  const shop = timeline.getByRole("button", { name: /^shop-frontend · / });
  await shop.click();
  await expect(shop).toHaveAttribute("aria-pressed", "true");
  await expect(history.getByText("Nur shop-frontend")).toBeVisible();
  // Text content, not the visible text: the phone hides the repo column.
  const rows = await history.getByRole("listitem").allTextContents();
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r).toContain("shop-frontend");
  await history.getByRole("button", { name: "alle zeigen" }).click();
  await expect(shop).toHaveAttribute("aria-pressed", "false");
  await expect(history.getByText("Nur shop-frontend")).toHaveCount(0);
});

test("Aktivität: der Verlauf kommt seitenweise", async ({ page }) => {
  await tab(page, /Aktivität/).click();
  const history = page.getByRole("region", { name: "Verlauf" });
  const rows = history.getByRole("list", { name: "Ereignisse" }).getByRole("listitem");
  await expect(rows).toHaveCount(40);
  // The button says how many more come; since round 5 the demo's history starts with each conversation, so fewer.
  const more = history.getByRole("button", { name: /^Ältere zeigen/ });
  const next = Number(/\((?:alle )?(\d+)/.exec((await more.textContent()) || "")?.[1]);
  expect(next).toBeGreaterThan(0);
  await more.click();
  await expect(rows).toHaveCount(40 + next);
});

test("Aktivität: Wochenbericht als Markdown und JSON herunterladen", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the same download on every width");
  await tab(page, /Aktivität/).click();
  for (const [name, re] of [
    ["Markdown", /^fleet-week-\d{4}-\d{2}-\d{2}\.md$/],
    ["JSON", /^fleet-week-\d{4}-\d{2}-\d{2}\.json$/],
  ] as const) {
    const wait = page.waitForEvent("download");
    await page.getByRole("link", { name }).click();
    const d = await wait;
    expect(d.suggestedFilename()).toMatch(re);
    const text = fs.readFileSync(String(await d.path()), "utf8");
    expect(text.length).toBeLessThan(15000);
    if (name === "JSON") expect(JSON.parse(text).schema).toBe("claude-fleet/week-report");
    else expect(text).toContain("## Häufigste Alarme");
  }
});

test("Runde 6: die Achse des Puls-Diagramms steht ganz im Bild, auch „100 Tsd.“", async ({ page }) => {
  await tab(page, /Aktivität/).click();
  const labels = page.locator("svg text.ax");
  await expect(labels.first()).toBeVisible();
  const left = await labels.evaluateAll((els) => Math.min(...els.map((e) => (e as SVGGraphicsElement).getBBox().x)));
  expect(left).toBeGreaterThanOrEqual(0);
});
