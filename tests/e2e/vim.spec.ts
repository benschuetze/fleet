import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Stage 7 of the control room: a second key map for Vim users on top of stage 4. Same actions, other keys, and
// the status line always says which state the keys are in (NORMAL, INSERT, COMMAND, VISUAL).

const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const status = (page: Page) => page.getByRole("contentinfo").getByRole("status");
const mode = (page: Page) => page.getByTestId("key-mode");
const focusedNr = (page: Page) => page.locator(":focus").getAttribute("data-nr");

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

/** Vim chosen in this browser, as the settings switch stores it. */
async function vimMode(page: Page) {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(mode(page)).toHaveText("NORMAL");
}

/** Hiding and pinning go to the server shared by all tests: catch them here and only record what was sent. */
async function recordMeta(page: Page) {
  const sent: { id: string; hidden?: boolean; pinned?: boolean }[] = [];
  await page.route("**/api/meta", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  return sent;
}

test("Release 6: ein Browser ohne gespeicherten Modus startet in Vim (NORMAL)", async ({ browser }, info) => {
  // A context of its own: the fixture's page saves "standard" for the older tests.
  const ctx = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await expect(mode(page)).toHaveText("NORMAL");
  await expect(page.getByTestId("tile-keys")).toHaveText(/^jk wählen/);
  await ctx.close();
});

test("Vim in den Einstellungen: NORMAL, j/k mit Zählpräfix, G und gg, Tastenhilfe in Vim, bleibt nach Neuladen", async ({
  page,
}) => {
  await expect(mode(page)).toHaveText("STANDARD");
  await page.getByRole("button", { name: "Einstellungen" }).click();
  await page.getByRole("group", { name: "Tastaturmodus" }).getByRole("button", { name: "Vim" }).click();
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");
  await expect(status(page)).toHaveText(/Tastaturmodus: Vim$/);
  await page.keyboard.press("j");
  await expect.poll(() => focusedNr(page)).toBe("1");
  await page.keyboard.press("3");
  await expect(page.getByTestId("pending-keys")).toHaveText("3…");
  await page.keyboard.press("j");
  await expect.poll(() => focusedNr(page)).toBe("4");
  await page.keyboard.press("k");
  await expect.poll(() => focusedNr(page)).toBe("3");
  // Round 7: G is the last row of the tile the selection is in (the alarm zone), not of the whole screen
  const rows = await page.locator('[data-zone="alarm"][data-nr]').count();
  await page.keyboard.press("Shift+G");
  await expect.poll(() => focusedNr(page)).toBe(String(rows));
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect.poll(() => focusedNr(page)).toBe("1");
  await page.keyboard.press("5");
  await page.keyboard.press("Shift+G");
  await expect.poll(() => focusedNr(page)).toBe("5");
  // The help shows the keys of the active mode, as Vim writes them
  await page.keyboard.press("?");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Tastenhilfe" });
  await expect(help.getByRole("heading", { name: /VIM/ })).toBeVisible();
  await help.getByRole("searchbox", { name: "Tasten durchsuchen" }).fill("Anfang");
  await expect(help.getByText("gg", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(mode(page)).toHaveText("NORMAL");
  // Standard keys a Vim user would hit by habit do nothing: m is the start of "mp", not a merge
  await board(page).getByRole("row", { name: "Schema-Prüfung vor dem Import" }).focus();
  await page.keyboard.press("m");
  await expect(page.getByTestId("pending-keys")).toHaveText("m…");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("contentinfo").getByRole("alert")).toHaveCount(0);
});

test(": ist die Kommandozeile (COMMAND) – dieselbe Palette, mode standard schaltet zurück", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: /Befehl/ }).fill("mode vim");
  await page.keyboard.press("Enter");
  await expect(mode(page)).toHaveText("NORMAL");
  await page.keyboard.press(":");
  const line = page.getByRole("combobox", { name: /Befehl/ });
  await expect(line).toBeFocused();
  await expect(line).toHaveValue("");
  await expect(mode(page)).toHaveText("COMMAND");
  // Suggestions name the Vim key of an action, not the standard one
  await line.fill("Mergen");
  await expect(page.getByRole("option", { name: /Mergen \(Bestätigung\)/ })).toContainText("gm");
  await line.fill("filter wartet");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-filter")).toContainText("wartet");
  await expect(mode(page)).toHaveText("NORMAL");
  // In Vim Ctrl+K belongs to the event stream; the palette is ":" (and ⌘K on a Mac)
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("region", { name: "Ereignisse" }).getByRole("button").first()).toBeFocused();
  await expect(line).not.toBeFocused();
  await page.keyboard.press(":");
  await line.fill(":mode standard");
  await page.keyboard.press("Enter");
  await expect(mode(page)).toHaveText("STANDARD");
});

test("V markiert Zeilen, x fragt und blendet alle aus, u holt sie zurück; dd, mp und . wiederholt", async ({
  page,
}) => {
  await vimMode(page);
  const sent = await recordMeta(page);
  // The first row of the watch board: two more sessions follow it
  const rows = page.locator('[data-zone="board"]');
  const all = await rows.count();
  const first = rows.first();
  await first.focus();
  await page.keyboard.press("Shift+V");
  await expect(mode(page)).toHaveText("VISUAL · 1");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(mode(page)).toHaveText("VISUAL · 3");
  await page.keyboard.press("x");
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText("3 markierte Sessions ausblenden? y/n");
  await page.keyboard.press("y");
  await expect.poll(() => sent.filter((m) => m.hidden === true).length).toBe(3);
  await expect(status(page)).toHaveText(/3 Sessions ausgeblendet – u holt sie zurück$/);
  await expect(mode(page)).toHaveText("NORMAL");
  const ids = sent.map((m) => m.id);
  await page.keyboard.press("u");
  await expect.poll(() => sent.filter((m) => m.hidden === false).map((m) => m.id)).toEqual(ids);
  // The rows must be back before the next marking: rows coming back between V and j widen it (CI on 16.10.2026).
  await expect(rows).toHaveCount(all);
  // Escape leaves the marking without doing anything
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("j");
  await expect(mode(page)).toHaveText("VISUAL · 2");
  await page.keyboard.press("Escape");
  await expect(mode(page)).toHaveText("NORMAL");
  // dd hides the selected row, "." does it again on the next one
  sent.length = 0;
  await first.focus();
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await expect.poll(() => sent.length).toBe(1);
  await page.keyboard.press("j");
  await page.keyboard.press(".");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[0]?.id).not.toBe(sent[1]?.id);
  sent.length = 0;
  await first.focus();
  await page.keyboard.press("m");
  await page.keyboard.press("p");
  await expect.poll(() => sent.map((m) => "pinned" in m)).toEqual([true]);
});

test("INSERT in der Antwortzeile, Ctrl+[ zurück; o, g k und q für die Schubladen; Ctrl+J und ]a zur Alarmzone", async ({
  page,
}) => {
  await vimMode(page);
  const live = board(page).getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });
  await live.focus();
  await page.keyboard.press("a");
  const input = page.getByRole("textbox", { name: "Antwort an Checkout auf die neuen Komponenten umstellen" });
  await expect(input).toBeFocused();
  await expect(mode(page)).toHaveText("INSERT");
  await page.keyboard.press("Control+[");
  await expect(input).toHaveCount(0);
  await expect(live).toBeFocused();
  await expect(mode(page)).toHaveText("NORMAL");
  await page.keyboard.press("o");
  const drawer = page.getByRole("complementary", { name: "Session: Checkout auf die neuen Komponenten umstellen" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("q");
  await expect(drawer).toHaveCount(0);
  await expect(live).toBeFocused();
  await page.keyboard.press("Control+j");
  await expect.poll(() => page.locator(":focus").getAttribute("data-zone")).toBe("alarm");
  await expect.poll(() => focusedNr(page)).toBe("1");
  await page.keyboard.press("]");
  await page.keyboard.press("a");
  await expect.poll(() => focusedNr(page)).toBe("2");
  await page.keyboard.press("[");
  await page.keyboard.press("a");
  await expect.poll(() => focusedNr(page)).toBe("1");
  // i goes into Claude's terminal: INSERT, the keys belong to Claude until Ctrl+← gives them back
  await live.focus();
  await page.keyboard.press("i");
  await expect(page.getByRole("complementary", { name: /^Terminal: / })).toBeVisible();
  await expect(mode(page)).toHaveText("INSERT");
  await page.keyboard.press("Control+ArrowLeft");
  await expect(mode(page)).toHaveText("NORMAL");
  await page.getByRole("button", { name: "Schließen" }).click();
  // g k is the same in Vim: the conflict drawer, q closes it. The closed terminal hands focus back late: wait for it.
  await expect(live).toBeFocused();
  const focusRing = board(page).getByRole("row", { name: "Sichtbarer Fokusrahmen für Tastaturbedienung" });
  await focusRing.focus();
  await expect(focusRing).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("k");
  const conflict = page.getByRole("complementary", { name: /^Konflikt: Sichtbarer Fokusrahmen/ });
  await expect(conflict).toBeVisible();
  await expect(mode(page)).toHaveText("NORMAL");
  await page.keyboard.press("q");
  await expect(conflict).toHaveCount(0);
  // n without a search says how to search first
  await live.focus();
  await page.keyboard.press("n");
  await expect(status(page)).toHaveText(/Erst mit \/ suchen$/);
});
