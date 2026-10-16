import type { Route } from "@playwright/test";
import { expect, overviewRoute, test } from "./fixtures";

// The test helpers themselves. Reported by a red `pnpm check`: `withOverview` threw "Response has been disposed"
// when the page reloaded while its route was still reading the answer for the page before; the request it served
// was gone, and the throw failed a test that had nothing wrong.

/** A route whose request went away with the page: Playwright disposes the answer, every call on it fails. */
function goneRoute(fulfilled: string[]): Route {
  const gone = () => Promise.reject(new Error("apiResponse.json: Response has been disposed"));
  return {
    request: () => ({ headers: () => ({}) }),
    fetch: async () => ({ json: gone, headers: () => ({}) }),
    fulfill: async () => {
      fulfilled.push("fulfill");
    },
  } as unknown as Route;
}

test("withOverview: eine Antwort, deren Seite schon neu geladen ist, bricht keinen Test ab", async () => {
  const fulfilled: string[] = [];
  await overviewRoute(() => {})(goneRoute(fulfilled));
  // Nothing is left to answer: the request belonged to the page before.
  expect(fulfilled).toEqual([]);
});

test("withOverview: andere Fehler im Handler bleiben Fehler", async () => {
  const broken = {
    request: () => ({ headers: () => ({}) }),
    fetch: async () => ({ json: async () => ({}), headers: () => ({}) }),
  } as unknown as Route;
  await expect(
    overviewRoute(() => {
      throw new Error("Fehler in der Änderung");
    })(broken),
  ).rejects.toThrow("Fehler in der Änderung");
});
