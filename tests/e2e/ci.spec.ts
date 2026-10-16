import { expect, isMobile, test, withOverview } from "./fixtures";

const ciRow = (page: import("@playwright/test").Page, region: string, name: RegExp) =>
  page.getByRole("region", { name: region }).getByRole("article", { name });

test("Pipelines: laufender Job als Zeile der Wachtafel, roter Lauf mit Tests, Log und Aktionen", async ({
  page,
}, info) => {
  // A running pipeline is one numbered line of the board group "CI läuft" (stage 12.2): ◌, the job now, Cancel.
  const live = page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("rowgroup", { name: "CI läuft" })
    .getByRole("row", { name: /^shop-frontend/ });
  await expect(live.getByText(/unit: pnpm test/)).toBeVisible();
  await expect(live.getByRole("img", { name: "CI läuft" })).toHaveText("◌");
  expect(Number(await live.getAttribute("data-nr"))).toBeGreaterThan(0);
  if (!isMobile(info.project.name)) await expect(live.getByRole("button", { name: "Abbrechen" })).toBeVisible();
  const red = ciRow(page, "Alarmzone", /PR #48/);
  // One action in the row; the title opens jobs, tests, log and the rest in the drawer (stage 12.6), nothing unfolds
  await expect(red.getByRole("button", { name: "Fix-Session starten" })).toBeVisible();
  await red.getByRole("button", { name: /^PR #48/ }).click();
  await expect(red.getByText("Rechnung mit drei Positionen: Summe stimmt auf den Cent")).toHaveCount(0);
  const drawer = page.getByRole("complementary", { name: /^CI: billing-service · PR #48/ });
  await expect(
    drawer.getByText("Rechnung mit drei Positionen: Summe stimmt auf den Cent", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByText(/fehlgeschlagen in „pnpm test:integration“/)).toBeVisible();
  await drawer.getByText("Log-Auszug").click();
  await expect(drawer.getByText("AssertionError: expected 1190.01 to equal 1190.00")).toBeVisible();
  await drawer.getByRole("button", { name: "Neu starten" }).click();
  await expect(page.getByText("Demo: Fehlgeschlagene Jobs neu gestartet")).toBeVisible();
  await drawer.getByRole("button", { name: "Fix-Session starten" }).click();
  await expect(page.getByText("Demo: Fix-Session geöffnet – Auftrag ist vorausgefüllt")).toBeVisible();
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await expect(drawer).toHaveCount(0);
});

test("Gleicher Grund bei allen Jobs steht einmal oben", async ({ page }) => {
  await ciRow(page, "Alarmzone", /^infra/)
    .getByRole("button", { name: /^Letzter Lauf/ })
    .click();
  const drawer = page.getByRole("complementary", { name: /^CI: infra/ });
  await expect(drawer.getByText(/^Alle fehlgeschlagenen Jobs: The job was not started/)).toBeVisible();
  await expect(drawer.getByText(/not started/)).toHaveCount(1);
});

test("CI konnte nicht starten: Mergen trotzdem möglich, mit Rückfrage", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "the buttons are in the opened card on a phone");
  // Reported: when GitHub never starts the jobs (billing), the PR could only be merged by hand
  const title = "Schema-Prüfung vor dem Import";
  let runId = 0;
  // Deliberately incomplete (no tests, no log): such a reply once took the whole dashboard down.
  await page.route(
    (url) => url.pathname === "/api/run",
    (route) =>
      route.fulfill({
        json: {
          id: runId,
          jobs: [
            {
              id: 1,
              name: "test",
              state: "failure",
              current: null,
              steps: [],
              notes: [
                "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
              ],
            },
          ],
        },
      }),
  );
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.title === title);
    if (!s?.ci?.pr) throw new Error("demo session without PR");
    s.ci.pr.ci = "failure";
    runId = s.ci.ci?.id ?? 4242;
    s.ci.ci = { ...s.ci.ci, id: runId, state: "failure" } as NonNullable<typeof s.ci.ci>;
  });
  const row = page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("rowgroup", { name: "Fertig", exact: true })
    .getByRole("row", { name: title });
  await row.getByRole("button", { name: "Trotzdem mergen" }).click();
  // Round 7: the question stands in the status line, as `:merge` asks it
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText(
    "CI lief nicht – PR #112 (3 Commits) nach main mergen? y/n",
  );
  await page.keyboard.press("y");
  await expect(page.getByText(/Demo: würde PR #112 mergen/)).toBeVisible();
});

test("Laufende Pipeline auf der Wachtafel: Shift+Enter (Detail) öffnet ihre CI-Schublade (Runde 3)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  const live = page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("rowgroup", { name: "CI läuft" })
    .getByRole("row", { name: /^shop-frontend/ });
  await live.focus();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByRole("complementary", { name: /^CI: shop-frontend/ })).toBeVisible();
});
