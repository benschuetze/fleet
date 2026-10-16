import { test as base, expect, type Page, type Route } from "@playwright/test";
import type { Overview } from "../../shared/types";

/**
 * Every test starts on "Jetzt" in demo mode and fails on any script error on the page: "stable" means not a single
 * uncaught error, in no test.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Vim is the default since release 6; the tests were written for the standard keys and name Vim where they
    // mean it (vim.spec.ts sets it). Only when nothing is saved, so a test that switches keeps its mode on reload.
    await page.addInitScript(() => {
      // Pages without storage (about:blank, a download) throw on the access; they have no keys to set.
      try {
        if (localStorage.getItem("fleet.keyMode") === null)
          localStorage.setItem("fleet.keyMode", JSON.stringify("standard"));
        // The one-time note on Esc in the terminal (release 6) would cover other results; jump.spec checks it.
        if (localStorage.getItem("fleet.termEscNote") === null) localStorage.setItem("fleet.termEscNote", "1");
      } catch {}
    });
    await page.goto("/");
    await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
    await use(page);
    expect(errors, "Skriptfehler auf der Seite").toEqual([]);
    // Errors caught by a section's boundary do not reach pageerror; the fallback text shows them.
    await expect(page.locator("[data-crashed]"), "Abschnitt mit Renderfehler").toHaveCount(0);
  },
});
export { expect };

/** Changes the server's answer before the page sees it, for cases the demo data does not have. */
export async function withOverview(page: Page, change: (o: Overview) => void) {
  await page.route("**/api/overview", overviewRoute(change));
  await page.reload();
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
}

/**
 * The route behind `withOverview`: the server's full answer (no ETag), changed. A reload (`withOverview` itself, or
 * a test) can take the page away while an answer for it is still being read; Playwright then disposes that answer.
 * The request is gone with its page and there is nothing left to answer, so that one case ends quietly. Any other
 * error, the change's included, still fails the test.
 */
export const overviewRoute = (change: (o: Overview) => void) => async (route: Route) => {
  let o: Overview;
  let res: Awaited<ReturnType<Route["fetch"]>>;
  try {
    res = await route.fetch({ headers: { ...route.request().headers(), "if-none-match": "" } });
    o = (await res.json()) as Overview;
  } catch (e) {
    if (gone(e)) return;
    throw e;
  }
  change(o);
  try {
    await route.fulfill({ response: res, json: o, headers: { ...res.headers(), etag: "" } });
  } catch (e) {
    if (!gone(e)) throw e;
  }
};

/** Playwright's errors for a request whose page, context or answer no longer exists. */
const gone = (e: unknown) =>
  e instanceof Error &&
  // "Test ended": the route still fetched while Playwright tore the test down (main's CI, 15 Oct).
  /has been disposed|has been closed|Target page, context or browser|Test ended/.test(e.message);

export const tab = (page: Page, name: RegExp | string) =>
  page.getByRole("navigation", { name: "Bereiche" }).getByRole("link", { name });

export const isMobile = (name: string) => name === "mobile";

/**
 * Searches the sessions through the command line (stage 12.4: no search box in the header any more): `/` and the
 * words, as on a phone where the line is tapped. An empty text clears a search in force.
 */
export async function search(page: Page, text: string) {
  const line = page.getByRole("combobox", { name: /Befehl/ });
  await line.click();
  await line.fill(text ? `/${text}` : "");
}

/**
 * Brings a tile of the middle in sight. Under 100 columns (the phone) the middle shows one tile at a time (spec
 * rule 17): tap its tab. On the desktop the three stand side by side and nothing happens.
 */
export async function showTile(page: Page, tab: "1 Alarm" | "2 Repos" | "3 Wache" | "4 Strom") {
  if (!isMobile(test.info().project.name)) return;
  await page.getByRole("navigation", { name: "Kacheln" }).getByRole("button", { name: tab }).click();
}
