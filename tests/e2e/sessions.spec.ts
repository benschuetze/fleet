import type { Page } from "@playwright/test";
import { expect, isMobile, search, test } from "./fixtures";

const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const done = (page: Page, name: string) =>
  board(page).getByRole("rowgroup", { name: "Fertig", exact: true }).getByRole("row", { name });
const asks = (page: Page, name: string) =>
  page.getByRole("region", { name: "Alarmzone" }).getByRole("article", { name });
/** The opened view of a session: its drawer (stage 12.5: lines in the drawer tile, no card). */
const opened = (page: Page, name: string | RegExp) =>
  page.getByRole("complementary", {
    name: typeof name === "string" ? `Session: ${name}` : new RegExp(`^Session: .*${name.source}`),
  });

test("Cache-Countdown bei wartenden Sessions, danach Kosten und frisch weitermachen", async ({ page }, info) => {
  await expect(asks(page, "Doku für Farb-Tokens").getByText(/^Cache noch \d{1,2}:\d\d$/)).toBeVisible();
  // On a phone the cache column is hidden; the opened view has the action
  if (isMobile(info.project.name)) return;
  // Beside the repo bar and the stream (stage 12.3) the board has its cache column from the plan's 1440 × 900 on;
  // in the 1280 px of the default desktop it drops after the branch.
  await page.setViewportSize({ width: 1440, height: 900 });
  const old = done(page, "Schema-Prüfung vor dem Import");
  await expect(
    old.getByRole("cell").filter({ hasText: /Cache abgelaufen, nächster Aufruf ≈ [\d,]+ (Tsd\.|Mio\.) Tokens$/ }),
  ).toHaveCount(1);
  // The cache explanation is a tooltip on the number, not text
  await expect(old.getByTitle(/^Cache abgelaufen – der nächste Aufruf/)).toBeVisible();
  await old.getByRole("button", { name: "Schema-Prüfung vor dem Import" }).click();
  const card = opened(page, "Schema-Prüfung vor dem Import");
  await card.getByRole("button", { name: /^Frisch starten/ }).click();
  await card.getByRole("group", { name: "Frisch starten in" }).getByRole("button", { name: "Desktop-App" }).click();
  await expect(page.getByText("Demo: würde frisch starten in Desktop-App")).toBeVisible();
});

test("Ergebnis: Commits, Dateien, Tests, PR; Mergen mit Rückfrage als die eine Aktion der Zeile", async ({
  page,
}, info) => {
  const name = "Schema-Prüfung vor dem Import";
  await done(page, name).getByRole("button", { name }).click();
  const card = opened(page, name);
  await expect(card.getByText("3 Commits")).toBeVisible();
  // As many files as the checkout's diff shows (round 4: "6 files" beside a diff of 2)
  const o = await (await page.request.get("/api/overview")).json();
  const id = o.sessions.find((s: { title?: string }) => s.title === name)?.id;
  const diff = await (await page.request.get(`/api/diff?id=${encodeURIComponent(id)}`)).json();
  await expect(card.getByText(`${diff.files.length} Dateien`)).toBeVisible();
  await expect(card.getByText("✓ Tests grün")).toBeVisible();
  await expect(card.getByRole("link", { name: "PR #112 offen" })).toBeVisible();
  await card.getByRole("button", { name: "Schließen" }).click();
  await expect(card).toHaveCount(0);
  if (isMobile(info.project.name)) return;
  const row = done(page, name);
  await row.getByRole("button", { name: "Mergen" }).click();
  // The confirmation says what goes where, in the status line like `:merge` (round 7)
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText(
    "PR #112 (3 Commits) nach main mergen? y/n",
  );
  await page.keyboard.press("y");
  await expect(page.getByText("Demo: würde PR #112 mergen")).toBeVisible();
});

test("Konfliktwarnung: zwei Sessions an derselben Datei, Worktree-Befehl per Klick", async ({ page, context }) => {
  const name = /Sichtbarer Fokusrahmen/;
  const row = board(page).getByRole("row", { name });
  await expect(row.getByText("Konflikt?")).toBeVisible();
  await row.getByRole("button", { name }).click();
  const card = opened(page, name);
  await expect(
    card.getByText(/Gleichzeitig mit „Doku für Farb-Tokens“.*gleiche Dateien: src\/tokens\/colors\.ts/),
  ).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await card.getByRole("button", { name: "Worktree-Befehl kopieren" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /git worktree add '..\/design-system-parallel' -b 'fix\/focus-ring-parallel'/,
  );
});

test("Zeile per Tastatur öffnen: Aufgaben, Effizienz, Übergabe-Prompt, Ordner mit ~", async ({ page, context }) => {
  const name = "Checkout auf die neuen Komponenten umstellen";
  const title = page.getByRole("button", { name }).first();
  await title.focus();
  await page.keyboard.press("Enter");
  // The details open in the drawer (stage 12), which takes the focus
  const drawer = page.getByRole("complementary", { name: `Session: ${name}` });
  await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // The title stands in the frame line; the focus is on the drawer's own button
  const card = drawer;
  await expect(card.getByRole("button", { name: "Schließen" })).toBeFocused();
  await expect(card.getByRole("list", { name: "Aufgaben" }).getByText("Unit-Tests anpassen")).toBeVisible();
  await expect(card.getByText("Jetzt übergeben")).toBeVisible();
  await expect(card.getByText(/874 Tsd\. von 1 Mio\. Tokens/)).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await card.getByRole("button", { name: "Übergabe-Prompt kopieren" }).click();
  await expect(page.getByText("Übergabe-Prompt kopiert")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("HANDOFF.md");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(board(page).getByRole("row", { name })).toBeVisible();
  await expect(title).toBeFocused();
});

test("Modell-Tipp mit Befehl zum Wechseln", async ({ page }) => {
  const name = /Kurze Fragen zur Deploy-Konfiguration/;
  await page.getByRole("button", { name }).first().click();
  const card = opened(page, name);
  await expect(card.getByText("Haiku 5.5 reicht")).toBeVisible();
  await expect(card.getByText(/etwa .* \$ weniger/)).toBeVisible();
  await expect(card.getByRole("button", { name: "/model haiku kopieren" })).toBeVisible();
});

test("Notiz wird gespeichert und bleibt nach dem Neuladen", async ({ page }, info) => {
  // Own text per project and run: all tests share one demo server
  const text = `Erst nach dem Design-Review mergen (${info.project.name} ${Date.now()})`;
  await page.getByRole("button", { name: "Doku für Farb-Tokens" }).first().click();
  const note = page.getByRole("textbox", { name: "Notiz" });
  await note.fill(text);
  await note.blur();
  await expect(page.getByText("Notiz gespeichert")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Doku für Farb-Tokens" }).first().click();
  await expect(page.getByRole("textbox", { name: "Notiz" })).toHaveValue(text);
});

test("Öffnen im Fleet-Terminal, in Desktop-App, VS Code oder Terminal; die Wahl bleibt gemerkt", async ({ page }) => {
  const name = "Checkout auf die neuen Komponenten umstellen";
  const group = () => page.getByRole("group", { name: "Session öffnen in" });
  await page.getByRole("button", { name }).first().click();
  // Fleet's own window comes first; the programs stay selectable.
  await expect(group().getByRole("button", { name: "Fleet-Terminal" })).toHaveAttribute("aria-pressed", "true");
  await expect(group().getByRole("button", { name: "Desktop-App" })).toBeEnabled();
  await group().getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByText("Demo: würde in Terminal öffnen")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name }).first().click();
  await expect(group().getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Back to the default for the other tests on the shared demo server (the preference lives in this browser only)
  await page.evaluate(() => localStorage.removeItem("fleet.openTarget"));
});

test("Abgelöste Session nur über die Suche: zeigt, wo es weitergeht, und öffnet die neue", async ({ page }) => {
  const name = /Abhängigkeiten aktualisieren/;
  await expect(page.getByRole("row", { name })).toHaveCount(0);
  await search(page, "Abhängigkeiten");
  const row = page.getByRole("row", { name });
  await expect(row.getByText("abgelöst", { exact: true })).toBeVisible();
  await row.getByRole("button", { name }).click();
  await expect(page.getByText("Weiter in neuer Session: Flaky Login-Test stabilisieren")).toBeVisible();
  await page
    .getByRole("group", { name: "Neue Session öffnen in" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await expect(page.getByText("Demo: würde in Terminal öffnen")).toBeVisible();
});
