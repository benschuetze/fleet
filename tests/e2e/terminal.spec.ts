import type { Page } from "@playwright/test";
import { expect, tab, test, withOverview } from "./fixtures";

const drawers = (page: Page) => page.getByRole("complementary", { name: /^Terminal: / });

test("Terminal in der Schublade: erfundene Ausgabe mit Freigabe, Eingabe im Echo; Esc schließt, Fokus zurück", async ({
  page,
}) => {
  const row = page
    .getByRole("region", { name: "Alarmzone" })
    .getByRole("article", { name: "Rundung im Warenkorb korrigieren" });
  // A session in Fleet's window has the terminal as its one action.
  const open = row.getByRole("button", { name: "Terminal" });
  await open.click();
  const drawer = page.getByRole("complementary", { name: "Terminal: Rundung im Warenkorb korrigieren" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Do you want to proceed?").first()).toBeVisible();
  await expect(drawer.getByText("Fleet", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("status")).toHaveText("Prozess läuft");
  // → moves into the terminal; what is typed comes back as the echo.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("ja bitte");
  await expect(drawer.getByText(/ja bitte/).first()).toBeVisible();
  // Release 6: Ctrl+[ is Claude's Esc (the drawer stays); Ctrl+← leaves the terminal for the row; Esc in the
  // terminal goes back to the overview, the drawer shuts and the focus returns.
  await page.keyboard.press("Control+BracketLeft");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Control+ArrowLeft");
  await expect(open).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(drawers(page)).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("Repos: Neue Session mit Auftrag öffnet die Schublade; es gibt immer nur eine", async ({ page }) => {
  await tab(page, /Repos & PRs/).click();
  // A repo in several worktrees has several rows; the first is enough.
  const form = page.getByRole("form", { name: "Neue Session in shop-frontend" }).first();
  await form.getByRole("textbox", { name: "Auftrag" }).fill("Tests für den Warenkorb reparieren");
  await form.getByRole("button", { name: "Neue Session" }).click();
  const drawer = page.getByRole("complementary", { name: "Terminal: Tests für den Warenkorb reparieren" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/Tests für den Warenkorb reparieren/).first()).toBeVisible();
  // Release 6.1.0: a session already works in shop-frontend's folder, so the new one gets a worktree of its own.
  await expect(
    page.getByText(/Worktree fleet\/tests-fur-den-warenkorb-reparier-[0-9a-f]{4} angelegt: Claude startet dort/),
  ).toBeVisible();
  // Release 6: a new session fills the screen and takes the keys at once; Esc leads back to the page.
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-tile="drawer"] .xterm')))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawers(page)).toHaveCount(0);
  // A second one: one terminal at a time.
  await form.getByRole("textbox", { name: "Auftrag" }).fill("Zweiter Auftrag");
  await form.getByRole("button", { name: "Neue Session" }).click();
  await expect(page.getByRole("complementary", { name: "Terminal: Zweiter Auftrag" })).toBeVisible();
  await expect(drawers(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Schließen" }).click();
  await expect(drawers(page)).toHaveCount(0);
});

test("Session, die anderswo noch laufen kann: geht im Fleet-Terminal sofort als eigener Zweig weiter (6.0.2)", async ({
  page,
}) => {
  // One session per project: both projects run in parallel against the same demo server.
  const name =
    test.info().project.name === "mobile" ? "Steuerbeträge je Position runden" : "Schema-Prüfung vor dem Import";
  await page.getByRole("button", { name }).first().click();
  await page.getByRole("group", { name: "Session öffnen in" }).getByRole("button", { name: "Fleet-Terminal" }).click();
  const drawer = page.getByRole("complementary", { name: `Terminal: ${name}` });
  // Terminal first (live 16.10.2026): no warning to click through; the status line says it is a branch of its own.
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(/eigener Zweig/);
  // The resumed session shows itself: its task and where it stopped, no approval it never asked for (practical test
  // 15 Oct: every resumed demo session showed a Bash approval for pnpm test)
  await expect(drawer.getByText(`> ${name}`).first()).toBeVisible();
  await expect(drawer.getByText("Do you want to proceed?")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawers(page)).toHaveCount(0);
});

test("Einstellungen nennen, ob das Terminal im Fenster verfügbar ist", async ({ page }) => {
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await expect(page.getByTestId("terminal-info")).toHaveText("verfügbar, bis 8 Sessions");
  await page.keyboard.press("Escape");
});

test("Beendeter Prozess: die Statuszeile der Schublade sagt es sofort, auch ohne Ende-Ereignis im Strom (B15)", async ({
  page,
}) => {
  const title = "Rundung im Warenkorb korrigieren";
  // The overview knows the start failed (code 1); the terminal stream never says so (lost, or not yet sent).
  await page.route("**/api/term/stream*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: `retry: 60000\n\nevent: out\ndata: ${Buffer.from("Error: something went wrong\r\n").toString("base64")}\n\n`,
    }),
  );
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.title === title);
    for (const p of o.processes || [])
      if (p.id === s?.id) Object.assign(p, { status: "failed", exitCode: 1, endedAt: Date.now(), pid: null });
  });
  const row = page.getByRole("region", { name: "Alarmzone" }).getByRole("article", { name: title });
  await row.getByRole("button", { name: "Terminal" }).click();
  const drawer = page.getByRole("complementary", { name: `Terminal: ${title}` });
  await expect(drawer.getByRole("status")).toHaveText("beendet (Code 1)");
  // Ended: no Ctrl+C, no End; continuing is the way on.
  await expect(drawer.getByRole("button", { name: "Ctrl+C" })).toHaveCount(0);
});
