import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Release 6 (plan R3, R8): from any line that stands for a session (alarm zone, watch board, event stream, its
// drawer) one key leads into its terminal; the terminal fills the screen and takes the keys, Esc leads back to the
// overview and the session runs on. Ctrl+[ sends Claude its Esc.

const term = (page: Page) => page.getByRole("complementary", { name: /^Terminal: / });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const shown = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".middle > [data-tile]")]
      .filter((el) => el.getClientRects().length)
      .map((el) => el.dataset.tile),
  );
const inTerminal = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('[data-tile="drawer"] .xterm'));

/** The id of a demo session in Fleet's own window (server/core/demo.ts, demoTerminalSessions). */
async function fleetSession(page: Page, branch = "feat/checkout-redesign") {
  const o = await (await page.request.get("/api/overview")).json();
  return String(o.sessions.find((s: { branch?: string }) => s.branch === branch)?.id);
}

async function recordInput(page: Page) {
  const sent: string[] = [];
  await page.route("**/api/term/input", async (route) => {
    sent.push(Buffer.from(route.request().postDataJSON().data, "base64").toString());
    await route.fulfill({ json: { ok: true } });
  });
  return sent;
}

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
});

test("→ auf einer Zeile der Wachtafel: Terminal als Vollbild mit dem Fokus darin; Esc zurück, Session läuft weiter", async ({
  page,
}) => {
  const first = board(page).locator(`[data-row][data-session="${await fleetSession(page)}"]`);
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(term(page)).toBeVisible();
  // Full screen: the drawer is the one tile of the middle, the alarm zone stays above it
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await expect.poll(() => inTerminal(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(term(page)).toHaveCount(0);
  await expect.poll(() => shown(page)).toEqual(["repos", "board", "stream"]);
  await expect(first).toBeFocused();
});

test("Vim: i aus Alarmzone, Ereignisstrom und Session-Schublade springt ins Terminal; Ctrl+[ geht an Claude", async ({
  page,
}) => {
  await page.evaluate(() => localStorage.setItem("fleet.keyMode", JSON.stringify("vim")));
  await page.reload();
  await expect(page.getByTestId("key-mode")).toHaveText("NORMAL");
  const sent = await recordInput(page);

  // Alarm zone: the session waiting in Fleet's window
  await page
    .getByRole("region", { name: "Alarmzone" })
    .locator(`[data-row][data-session="${await fleetSession(page, "fix/cart-rounding")}"]`)
    .focus();
  await page.keyboard.press("i");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => inTerminal(page)).toBe(true);
  await page.keyboard.press("Control+BracketLeft");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => sent.join("")).toContain("\x1b");
  // Plan R13: it is Claude's own terminal, every command and key arrives as typed (slash commands, Shift+Tab; Ctrl+letters
  // checked in a real browser: headless Chromium on macOS does not hand them to xterm)
  await page.keyboard.type("/remote-control");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => sent.join("")).toContain("/remote-control\r");
  await expect.poll(() => sent.join("")).toContain("\x1b[Z");
  await expect(term(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(term(page)).toHaveCount(0);

  // Event stream: its lines stand for sessions (one running elsewhere asks first; Esc shuts that too)
  const line = page.getByRole("region", { name: "Ereignisse" }).locator("button[data-session]").first();
  await line.focus();
  await page.keyboard.press("i");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await page.keyboard.press("Escape");
  await expect(term(page)).toHaveCount(0);
  // The stream draws its lines anew on every refresh (CLAUDE.md): take the line again.
  await line.focus();
  // o on a stream line opens the session's drawer, i there leads on into the terminal
  await page.keyboard.press("o");
  const detail = page.getByRole("complementary", { name: /^Session: / });
  await expect(detail).toBeVisible();
  // Opened from the stream too, it shows the conversation and what the session does now
  await expect(detail.getByRole("list", { name: "Verlauf" })).toBeVisible();
  await expect(detail.getByTestId("session-now")).toBeInViewport();
  await page.keyboard.press("i");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await page.keyboard.press("Escape");
  await expect(term(page)).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("fleet.keyMode"));
});

test("Einmal pro Browser sagt die Statuszeile beim ersten Terminal, wohin Claudes Esc gewandert ist", async ({
  page,
}) => {
  // Without a reload: the fixture's init script would set the mark again.
  await page.evaluate(() => localStorage.removeItem("fleet.termEscNote"));
  const status = page.getByRole("contentinfo").getByRole("status");
  await board(page)
    .locator(`[data-row][data-session="${await fleetSession(page)}"]`)
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText(/Im Terminal führt Esc zurück zur Übersicht – Claudes Esc ist Ctrl\+\[$/);
  // In the terminal the status line names its keys
  await expect.poll(() => inTerminal(page)).toBe(true);
  await expect(page.getByTestId("tile-keys")).toHaveText(
    "Esc zurück · Ctrl+[ Esc an Claude · Ctrl+C abbrechen · Ctrl+← zur Liste",
  );
  // Once: the browser keeps that it was said
  expect(await page.evaluate(() => localStorage.getItem("fleet.termEscNote"))).toBe("1");
  await page.keyboard.press("Escape");
});

test("→ auf einer Session außerhalb des Fensters: sie wird dort fortgesetzt, auch als Vollbild (Runde 3)", async ({
  page,
}) => {
  const o = await (await page.request.get("/api/overview")).json();
  const ids = new Set(((o.processes || []) as { sessionId?: string }[]).map((p) => p.sessionId));
  const other = (o.sessions as { id: string; source?: string; status?: string }[]).find(
    (s) => !ids.has(s.id) && s.source !== "cloud" && s.source !== "cowork" && s.status === "working",
  );
  test.skip(!other, "the demo has no local session outside Fleet's window");
  const row = board(page).locator(`[data-row][data-session="${other?.id}"]`);
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await expect.poll(() => inTerminal(page)).toBe(true);
});

test("In der Session-Schublade führt → ins Terminal, wie die Statuszeile sagt (Runde 4)", async ({ page }) => {
  const row = board(page).locator(`[data-row][data-session="${await fleetSession(page)}"]`);
  await row.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: /^Session: / });
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("tile-keys")).toContainText("→ Terminal");
  await page.keyboard.press("ArrowRight");
  await expect(term(page)).toBeVisible();
  await expect.poll(() => inTerminal(page)).toBe(true);
  await page.keyboard.press("Escape");
});

test("Der Knopf im Terminal-Rahmen heißt, was er tut: im Vollbild „Verkleinern“, sonst „Vollbild“ (Runde 4)", async ({
  page,
}) => {
  const row = board(page).locator(`[data-row][data-session="${await fleetSession(page)}"]`);
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  const button = term(page).getByRole("button", { name: "Verkleinern" });
  await button.click();
  await expect.poll(() => shown(page)).not.toEqual(["drawer"]);
  await term(page).getByRole("button", { name: "Vollbild" }).click();
  await expect.poll(() => shown(page)).toEqual(["drawer"]);
  await page.keyboard.press("Escape");
});
