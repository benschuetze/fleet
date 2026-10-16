import type { Page } from "@playwright/test";
import { expect, isMobile, test } from "./fixtures";

// Ben, 15 Oct: in the details of an item (the drawer: a session's folder and conversation, the conflict and duplicate
// drawers) a path stands whole and wraps onto the next line when it does not fit, never cut with "…". Lists stay one
// line per item (alarm zone, watch board, stream, repo bar, log view, the diff's file list).

/** Elements of `selector` that cut their text: an ellipsis, or text wider than the box that hides it. */
const cut = (page: Page, selector: string) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll<HTMLElement>(sel)]
        .filter((el) => el.getClientRects().length)
        .filter((el) => {
          const c = getComputedStyle(el);
          return c.textOverflow === "ellipsis" || (c.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1);
        })
        .map((el) => (el.textContent || "").trim().slice(0, 60)),
    selector,
  );

test.beforeEach(async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "the narrow desktop is enough: the same rules hold on the phone");
  await page.setViewportSize({ width: 900, height: 720 });
});

test("Pfade in der Session-Schublade stehen ganz, notfalls umbrochen", async ({ page }) => {
  const row = page.locator('[data-row][data-kind="session"]').filter({ hasText: "Rundung im Warenkorb korrigieren" });
  await row.focus();
  await page.keyboard.press("Shift+Enter");
  const drawer = page.getByRole("complementary", { name: /^Session: / });
  await expect(drawer).toBeVisible();
  expect(await cut(page, ".mono.path, .sd-chat li")).toEqual([]);
});

test("Listen bleiben einzeilig: eine Zeile je Eintrag in Alarmzone, Wachtafel und Log-Sicht", async ({ page }) => {
  const tall = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".screen [data-row], .log-line")]
        .filter((el) => el.getClientRects().length && !el.querySelector(".reply"))
        .filter((el) => el.getBoundingClientRect().height > 21)
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").slice(0, 60)),
    );
  expect(await tall()).toEqual([]);
  await page.keyboard.press("Shift+L");
  await expect(page.locator(".log-text").first()).toBeVisible();
  expect(await tall()).toEqual([]);
});

test("Pfade in Konflikt- und Doppelt-Schublade stehen ganz", async ({ page }) => {
  const dup = page.locator('[data-row][data-kind="dup"]').first();
  await dup.focus();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByRole("complementary")).toBeVisible();
  expect(await cut(page, ".dup-list li, .c-row > button, .c-hunks h3, .c-side > *")).toEqual([]);
});
