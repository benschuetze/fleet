import type { Page } from "@playwright/test";
import { expect, isMobile, tab, test, withOverview } from "./fixtures";

// Stage 4 of the control room: hands stay on the keyboard. Every action has a key, the selection is the focused
// row, destructive keys ask in the status line, and nothing a key does moves a session to a second place.

const alarms = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const focusedNr = (page: Page) => page.locator(":focus").getAttribute("data-nr");

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("Pfeile wählen Zeilen, „:3 Enter“ wählt Zeile 3, Enter öffnet die Schublade, Esc schließt sie", async ({
  page,
}) => {
  // The board is active after loading (round 3: the first key stays there); 1 goes to the alarm zone's first row
  await page.keyboard.press("1");
  await expect.poll(() => focusedNr(page)).toBe("1");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedNr(page)).toBe("2");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedNr(page)).toBe("1");
  // Stage 12: a row number goes through the command line (`:3`), digits alone are tile keys
  await page.keyboard.press(":");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusedNr(page)).toBe("3");
  // A row of the watch board: Enter opens its drawer (stage 12: nothing unfolds in the row), Esc closes it, the
  // selection stays
  const row = board(page).getByRole("row", { name: "Schema-Prüfung vor dem Import" });
  const nr = await row.getAttribute("data-nr");
  await page.keyboard.press(":");
  await page.keyboard.type(String(nr));
  await page.keyboard.press("Enter");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: "Session: Schema-Prüfung vor dem Import" });
  await expect(drawer).toBeVisible();
  await expect(board(page).getByRole("article", { name: "Schema-Prüfung vor dem Import" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(row).toBeFocused();
  // Round 7: Home and End stay in the tile; the board's first row is not the alarm zone's row 1
  await page.keyboard.press("End");
  const last = await focusedNr(page);
  await page.keyboard.press("Home");
  const first = await focusedNr(page);
  expect(Number(last)).toBeGreaterThan(5);
  expect(Number(first)).toBeGreaterThan(1);
  await expect(page.locator(":focus")).toHaveAttribute("data-zone", "board");
});

test("Statusfilter Alt+1–5: nur Sessions mit dem Status, jede an ihrem Ort; Alt+0 zeigt alle", async ({ page }) => {
  await page.keyboard.press("Alt+2");
  await expect(page.getByTestId("status-filter")).toContainText("Fehler");
  const zone = alarms(page);
  await expect(zone.getByRole("article", { name: "Funnel-Auswertung je Kanal" })).toBeVisible();
  // Waiting sessions, red CI and the board step aside
  await expect(zone.getByRole("article", { name: "Doku für Farb-Tokens" })).toHaveCount(0);
  await expect(zone.getByText("CI rot", { exact: true })).toHaveCount(0);
  await expect(board(page).getByRole("row", { name: "Schema-Prüfung vor dem Import" })).toHaveCount(0);
  // Numbers still count from 1 on what is shown
  const nrs = await page.locator("[data-nr]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-nr"))));
  expect(nrs).toEqual(nrs.map((_, i) => i + 1));
  await page.keyboard.press("Alt+4");
  await expect(page.getByTestId("status-filter")).toContainText("fertig");
  await expect(board(page).getByRole("row", { name: "Schema-Prüfung vor dem Import" })).toBeVisible();
  await expect(zone.getByRole("article", { name: "Funnel-Auswertung je Kanal" })).toHaveCount(0);
  await page.keyboard.press("Alt+0");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await expect(zone.getByRole("article", { name: "Doku für Farb-Tokens" })).toBeVisible();
  // The digits alone filter nothing any more (stage 12): 2 goes to the repo bar
  await page.keyboard.press("2");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await expect(page.locator('[data-tile="repos"][data-active]')).toHaveCount(1);
  // Typing in the search is typing, not a key
  await page.keyboard.press("/");
  await page.keyboard.type("1");
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeFocused();
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("? zeigt die Tasten der Auswahl, ? noch einmal alle mit Suche; Esc schließt, Fokus zurück", async ({ page }) => {
  await page.keyboard.press("1");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { name: "Alarmzone" })).toBeVisible();
  await expect(help.getByRole("heading", { name: "Kommandozeile" })).toHaveCount(0);
  // The first help after the release 6 update says once what is new
  const changed = help.getByRole("note");
  await expect(changed).toHaveText(/^Neu in 6\.0: → Terminal · d Diff · x wegräumen · :cleanup · :new · \? alle$/);
  await page.keyboard.press("?");
  const search = help.getByRole("searchbox", { name: "Tasten durchsuchen" });
  await expect(search).toBeFocused();
  await expect(help.getByRole("heading", { name: "Kommandozeile" })).toBeVisible();
  await search.fill("mergen");
  await expect(help.getByText("Mergen (Bestätigung)")).toBeVisible();
  await expect(help.getByText("Zeile hoch")).toHaveCount(0);
  // The conflict key works since stage 8: listed like any other key, without a stage
  await search.fill("Konflikt");
  await expect(help.getByText("Zum Konflikt")).toBeVisible();
  await expect(help.getByText(/ab Stufe/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect.poll(() => focusedNr(page)).toBe("1");
  // Once seen, the note does not come back, not even after reloading
  await page.reload();
  await expect(alarms(page)).toBeVisible();
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(changed).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("⌘K/Ctrl+K: Funktionscode, Befehl mit Argument, conflict a b öffnet die Konflikt-Schublade", async ({ page }) => {
  await page.keyboard.press("Control+k");
  // The command line in the last line of the screen, its suggestions right above it (stage 12)
  const input = page.getByRole("combobox", { name: /Befehl/ });
  const pal = page.getByRole("listbox", { name: "Vorschläge" });
  await expect(input).toBeFocused();
  await input.fill("REP");
  await expect(pal.getByRole("option")).not.toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(pal).toBeHidden();
  await expect(input).not.toBeFocused();
  await expect(tab(page, /Repos/)).toHaveAttribute("aria-current", "page");
  // Back with the area's command (stage 12: Alt+1 is a filter now), then a command with an argument
  await page.keyboard.press(":");
  await input.fill("now");
  await page.keyboard.press("Enter");
  await expect(tab(page, /Jetzt/)).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Control+k");
  await input.fill("filter wartet");
  await expect(pal.getByRole("option").first()).toHaveText(/Filter: wartet/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-filter")).toContainText("wartet");
  await page.keyboard.press("Alt+0");
  // conflict <a> <b>: two PRs by number open the conflict drawer, A and B in the typed order
  await page.keyboard.press("Control+k");
  await input.fill("conflict 48 51");
  await expect(pal.getByRole("option").first()).toHaveText(/Konflikt zeigen: #48 ↔ #51/);
  await page.keyboard.press("Enter");
  const conflict = page.getByRole("complementary", { name: "Konflikt: #48 ↔ #51" });
  await expect(conflict.getByText(/1 echter Merge-Konflikt in totals\.ts/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(conflict).toHaveCount(0);
  // Without sides it lists the known conflicts
  await page.keyboard.press("Control+k");
  await input.fill("conf ");
  await expect(pal.getByRole("option", { name: /Konflikt zeigen: Sichtbarer Fokusrahmen/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Stummschalten fragt in der Statuszeile: n bricht ab, y nimmt den Alarm für 1 h aus der Alarmzone", async ({
  page,
}) => {
  const zone = alarms(page);
  const row = zone.getByRole("article", { name: "Funnel-Auswertung je Kanal" });
  await row.focus();
  await page.keyboard.press("s");
  const ask = page.getByRole("contentinfo").getByRole("alert");
  await expect(ask).toContainText("für 1 h stummschalten? y/n");
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Abgebrochen$/);
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("s");
  await page.keyboard.press("y");
  await expect(row).toHaveCount(0);
  // Muted means gone for the hour, not moved to the board
  await expect(board(page).getByRole("row", { name: "Funnel-Auswertung je Kanal" })).toHaveCount(0);
  await zone.getByRole("button", { name: "wieder zeigen" }).click();
  await expect(row).toBeVisible();
});

test("r antwortet inline einer Session im Fleet-Terminal; ohne Terminal sagt die Taste, warum nicht", async ({
  page,
}) => {
  const live = board(page).getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });
  await live.focus();
  await page.keyboard.press("r");
  const input = page.getByRole("textbox", { name: "Antwort an Checkout auf die neuen Komponenten umstellen" });
  await expect(input).toBeFocused();
  await input.fill("Bitte noch die Tests laufen lassen");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(/Antwort an Checkout auf die neuen Komponenten umstellen gesendet$/);
  await expect(input).toHaveCount(0);
  await expect(live).toBeFocused();
  // Esc drops a reply without sending
  await page.keyboard.press("r");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  const done = board(page).getByRole("row", { name: "Schema-Prüfung vor dem Import" });
  await done.focus();
  await page.keyboard.press("r");
  await expect(status(page)).toHaveText(/Inline antworten geht bei Sessions im Fleet-Terminal/);
  // g k on a session without a conflict says so instead of opening an empty drawer
  await page.keyboard.press("g");
  await page.keyboard.press("k");
  await expect(status(page)).toHaveText(/Kein Konflikt in dieser Zeile$/);
  await expect(page.getByRole("complementary", { name: /^Konflikt: / })).toHaveCount(0);
});

test("Enter öffnet die Schublade der Session, g r springt zu ihrem Repo, dort Shift+Enter die Repo-Schublade", async ({
  page,
}) => {
  const row = board(page).getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });
  await row.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: "Session: Checkout auf die neuen Komponenten umstellen" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("r");
  const bar = page.getByRole("region", { name: "Repos" });
  const shop = bar.getByRole("button", { name: "shop-frontend", exact: true });
  await expect(shop).toBeFocused();
  // The arrows walk the repo bar's own lines (stage 12.3), not the board's rows
  await page.keyboard.press("ArrowDown");
  await expect(bar.locator("[data-opener]:focus")).toHaveCount(1);
  await expect(shop).not.toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(shop).toBeFocused();
  await page.keyboard.press("Shift+Enter");
  const repo = page.getByRole("complementary", { name: "Repo: shop-frontend" });
  await expect(repo.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Schließen" }).click();
  // The palette reaches the same drawer by name
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("arch shop-front");
  await page.keyboard.press("Enter");
  await expect(repo).toBeVisible();
  await page.getByRole("button", { name: "Schließen" }).click();
});

test("g k öffnet die Konflikt-Schublade der Session: gemeinsame Dateien, sonst der PR-Konflikt; Esc zurück zur Zeile", async ({
  page,
}) => {
  const row = board(page).getByRole("row", { name: "Sichtbarer Fokusrahmen für Tastaturbedienung" });
  await row.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("k");
  const shared = page.getByRole("complementary", {
    name: "Konflikt: Sichtbarer Fokusrahmen für Tastaturbedienung ↔ Doku für Farb-Tokens",
  });
  await expect(shared.getByText("1 Datei in src/tokens/ von beiden geändert.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shared).toHaveCount(0);
  await expect(row).toBeFocused();
  // A session whose PR git cannot merge with another open PR: the PR pair
  await page.locator("[data-nr]", { hasText: "Steuerbeträge je Position runden" }).first().focus();
  await page.keyboard.press("g");
  await page.keyboard.press("k");
  await expect(page.getByRole("complementary", { name: "Konflikt: #48 ↔ #51" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Alt+D ist frei und :density gibt es nicht mehr (Stufe 12, Regel 15): keine Dichte", async ({ page }) => {
  await expect(page.getByRole("group", { name: "Zeilendichte" })).toHaveCount(0);
  await page.keyboard.press("Alt+d");
  await expect(status(page)).not.toHaveText(/Dichte/);
  await page.keyboard.press(":");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("density");
  await expect(page.getByRole("listbox", { name: "Vorschläge" })).not.toContainText("Dichte");
  await page.keyboard.press("Escape");
});

test("Meldungszeile: einmal „Neu in 6.0“ mit Modus, ausgeblendet bleibt sie weg (Stufe 12.4, Release 6)", async ({
  page,
}) => {
  const hint = page.getByRole("note", { name: "Tastatur" });
  await expect(hint).toHaveText(
    /^Neu in 6\.0: → Terminal · d Diff · x wegräumen · :cleanup · :new · \? alle · Modus Standard wechseln$/,
  );
  // One line under the header, together with the demo notice.
  const demo = page.getByText(/^Demo-Modus/);
  expect((await hint.boundingBox())?.y).toBe((await demo.boundingBox())?.y);
  const box = await hint.boundingBox();
  expect(box && box.y >= 20 && box.y + box.height <= 40, JSON.stringify(box)).toBe(true);
  // A narrow window cuts the list of keys, never the mode switch (on the Linux runner 1280 px already cut it).
  await page.setViewportSize({ width: 800, height: 900 });
  await hint.getByRole("button", { name: "wechseln" }).click();
  await expect(
    page.getByRole("group", { name: "Tastaturmodus" }).getByRole("button", { name: "Standard" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Tastatur-Hinweis ausblenden" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(page.getByRole("note", { name: "Tastatur" })).toHaveCount(0);
});

test("n in der Repo-Leiste: ohne gewählte Zeile sagt die Statuszeile, was fehlt; mit Zeile startet die Session (B15)", async ({
  page,
}) => {
  const bar = page.getByRole("region", { name: "Repos" });
  // The bar's body has the focus, no line is selected: before, n did nothing at all.
  await page.locator('[data-tile="repos"] .tile-b').focus();
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Erst eine Repo-Zeile wählen \(↑↓\)$/);
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
  // With a line selected, n starts a new session there in Fleet's terminal.
  await bar.getByRole("row", { name: "analytics", exact: true }).getByRole("button", { name: "analytics" }).focus();
  await page.keyboard.press("n");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
});

test("Meldungszeile: ein Browser ohne Token-Cookie sagt, wie man ihn verbindet (Audit H1)", async ({ page }) => {
  await page.route("**/api/overview", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"not paired"}' }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("noch nicht mit Fleet verbunden");
  await expect(page.getByRole("alert")).toContainText("node dist/fleet.cjs open");
  await expect(page.getByRole("alert")).not.toContainText("nicht erreichbar");
});

test("Enter on an approval asks y/n first: n sends nothing, y allows; a click stays the explicit yes", async ({
  page,
}) => {
  const row = alarms(page).getByRole("article", { name: "Freigabe: Bash" });
  const sent = page.getByText("Demo: „Erlauben“ ginge jetzt an die Session");
  await row.focus();
  await page.keyboard.press("Enter");
  const ask = page.getByRole("contentinfo").getByRole("alert");
  await expect(ask).toContainText("Freigabe: Bash: pnpm add -D p-limit – Erlauben? y/n");
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Abgebrochen$/);
  await expect(sent).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("y");
  await expect(sent).toBeVisible();
});

// Live 16.10.2026: Enter on an approval the app held forked the session into Fleet's terminal ("Interrupted").
test("y, a and n answer Fleet's approval at once, as in Claude Code's own prompt; the status line names them", async ({
  page,
}) => {
  for (const [key, label] of [
    ["y", "Erlauben"],
    ["a", "Immer für diese Session"],
    ["n", "Ablehnen"],
  ] as const) {
    await page.reload();
    const row = alarms(page).getByRole("article", { name: "Freigabe: Bash" });
    await row.focus();
    await expect(page.getByRole("contentinfo")).toContainText("y erlauben");
    await expect(page.getByRole("contentinfo")).toContainText("n ablehnen");
    await page.keyboard.press(key);
    await expect(page.getByText(`Demo: „${label}“ ginge jetzt an die Session`)).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("alert")).toHaveCount(0);
  }
});

test("→ on Fleet's own approval row opens no branch of the session it holds", async ({ page }) => {
  const row = alarms(page).getByRole("article", { name: "Freigabe: Bash" });
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
  // From its session's line in the event stream, too: the hook holds the call, a branch would show it as interrupted.
  const own = page
    .getByRole("region", { name: "Ereignisse" })
    .getByRole("button", { name: "data-pipeline wartet auf dich · Nächtlichen Import parallelisieren" });
  await own.focus();
  await page.keyboard.press("ArrowRight");
  await expect(status(page)).toHaveText(/Die Freigabe wartet in Fleet – y, a oder n auf ihrer Zeile mit Countdown/);
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
});

test("An approval the app holds: y, a, n say where it waits; Enter, → and the drawer's terminal open no branch", async ({
  page,
}) => {
  // The demo's cart session runs in Fleet's terminal; here it runs in the desktop app, which holds the approval.
  await withOverview(page, (o) => {
    for (const s of o.sessions) if (s.id === "demo-07") s.proc = null;
  });
  const row = alarms(page).getByRole("article", { name: "Rundung im Warenkorb korrigieren" });
  await expect(row.getByRole("button", { name: "In der App öffnen" })).toBeVisible();
  await row.focus();
  await expect(page.getByRole("contentinfo")).toContainText("Enter Aktion");
  for (const key of ["y", "a", "n"]) {
    await page.keyboard.press(key);
    await expect(status(page)).toHaveText(
      /Die Freigabe wartet in der Claude-App – Fleet kann sie dort nicht beantworten/,
    );
  }
  // n stays "new session" on other rows; here it started nothing.
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
});

test("A question the app holds (AskUserQuestion): Enter opens it in the app, never a branch (live 16.10.2026)", async ({
  page,
}) => {
  await withOverview(page, (o) => {
    for (const s of o.sessions)
      if (s.id === "demo-07") {
        s.proc = null;
        s.waits = "question";
        s.detail = "Soll die Testdatei rot oder blau heißen?";
        s.hook = {
          ...(s.hook || { sessionId: s.id, event: "PermissionRequest", detail: "", at: Date.now() }),
          status: "needs_input",
          waitFor: [{ key: "AskUserQuestion:a1", since: Date.now() }],
        } as NonNullable<typeof s.hook>;
      }
  });
  const row = alarms(page).getByRole("article", { name: "Rundung im Warenkorb korrigieren" });
  await expect(row.getByRole("button", { name: "In der App öffnen" })).toBeVisible();
  await row.focus();
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/Die Frage wartet in der Claude-App/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
});

test("An approval in a terminal Fleet does not know: the row says so instead of forking", async ({ page }) => {
  await withOverview(page, (o) => {
    for (const s of o.sessions)
      if (s.id === "demo-07") {
        s.proc = null;
        s.desktop = undefined;
      }
  });
  const row = alarms(page).getByRole("article", { name: "Rundung im Warenkorb korrigieren" });
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(
    /Die Freigabe wartet im Fenster, in dem die Session läuft – Fleet kann sie dort nicht beantworten$/,
  );
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toHaveCount(0);
});

test("An approval in Fleet's own terminal: Enter goes in, y points there", async ({ page }) => {
  const row = alarms(page).getByRole("article", { name: "Rundung im Warenkorb korrigieren" });
  await row.focus();
  await page.keyboard.press("y");
  await expect(status(page)).toHaveText(/Die Freigabe steht im Fleet-Terminal/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
});

test("The last result stays with its view: another view, the log or the diff start with an empty status", async ({
  page,
}) => {
  const row = alarms(page).getByRole("article", { name: "Funnel-Auswertung je Kanal" });
  await row.focus();
  await page.keyboard.press("s");
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Abgebrochen$/);
  await page.keyboard.press("Shift+L");
  await expect(status(page)).toHaveText("");
  await page.keyboard.press("Shift+L");
  await page.keyboard.press(":");
  await page.keyboard.type("usage");
  await page.keyboard.press("Enter");
  await expect(status(page)).not.toContainText("Abgebrochen");
});

test("Ein Ergebnis in der Statuszeile ist ganz lesbar; die Kacheltasten geben nach (Runde 3)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  await page.setViewportSize({ width: 900, height: 720 });
  await page.keyboard.press("1");
  await page.keyboard.press("x");
  await page.keyboard.press("y");
  const last = page.locator(".sl-last");
  await expect(last).not.toHaveText("");
  const cut = await last.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(cut).toBe(false);
});

test("Erste Pfeiltaste nach dem Laden bleibt in der aktiven Kachel (Runde 3: sprang in die Alarmzone)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  const active = await page.evaluate(
    () => document.querySelector<HTMLElement>("[data-tile][data-active]")?.dataset.tile,
  );
  await page.keyboard.press("ArrowDown");
  const tile = await page.evaluate(() => document.activeElement?.closest<HTMLElement>("[data-tile]")?.dataset.tile);
  expect(tile).toBe(active);
});

test("Alt+0 hebt alle Filter auf, auch das gewählte Repo; der Repo-Kopf nennt die Wahl (Runde 4)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  await page.goto("/?repo=billing-service");
  const head = page.getByRole("region", { name: "Repos" }).getByRole("button", { name: /billing-service.*aufheben/ });
  await expect(head).toBeVisible();
  await expect(head).toContainText("billing-service");
  await page.keyboard.press("Alt+1");
  await page.keyboard.press("Alt+0");
  await expect(page).not.toHaveURL(/repo=/);
  await expect(page.getByRole("contentinfo").getByRole("status")).toContainText("aufgehoben");
});
