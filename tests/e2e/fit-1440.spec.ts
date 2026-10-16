import type { Page } from "@playwright/test";
import type { Overview } from "../../shared/types";
import { expect, isMobile, overviewRoute, test } from "./fixtures";

// Practical test round 6: at 1440 px the alarm zone cut "Cache noch…", "Fleet f…" and repo names. At a common
// desktop width every kind, place and countdown stands whole.

test.beforeEach(async ({ page: _ }, info) => {
  test.skip(isMobile(info.project.name), "a desktop width");
});

test("Bei 1440 px steht in der Alarmzone jede Art, jeder Ort und jeder Countdown ganz", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const zone = page.getByRole("region", { name: "Alarmzone" });
  await expect(zone.locator("[data-row]").first()).toBeVisible();
  const cut = await zone
    .locator(".a-k, .a-age")
    .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent?.trim()));
  expect(cut).toEqual([]);
  // The place: the repo's name stands whole, a long branch after it may end in "…"
  const names = await zone.locator(".a-where").evaluateAll((els) =>
    els
      .filter((e) => {
        const b = e.querySelector("b");
        return b && b.getBoundingClientRect().right > e.getBoundingClientRect().right + 1;
      })
      .map((e) => e.textContent?.trim()),
  );
  expect(names).toEqual([]);
});

test("Bei 1440 px steht in der Repo-Schublade jedes Statuswort ganz", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = page.getByRole("region", { name: /Repos/ }).first();
  await bar.getByRole("button", { name: "data-pipeline", exact: true }).click({ modifiers: ["Shift"] });
  const drawer = page.getByRole("complementary", { name: "Repo: data-pipeline" });
  await expect(drawer.locator(".d-st").first()).toBeVisible();
  const cut = await drawer
    .locator(".d-st")
    .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
});

// Round 7: round 6's check looked at three selectors in the alarm zone and one in the repo drawer, and it ran in the
// default language and mode only. The testers measured the whole screen (scrollWidth > clientWidth) in both languages
// and both key modes and found repo names, "#112", status words and PR/count badges cut elsewhere. This scan takes
// every clipping element and allows only free text (titles, causes, branches), whose full value is in a title.

type Lang = "de" | "en";
type Mode = "vim" | "standard";
const FREE_TEXT = ".sr, .c-branch, .st-t, .c-task, .c-task *, .a-what, .a-what *, .a-why, .a-why *, .tile-h, .tile-h *";

async function setup(page: Page, lang: Lang, mode: Mode, width: number, height = 900) {
  await page.evaluate(
    ([l, m]) => {
      localStorage.setItem("fleet.lang", JSON.stringify(l));
      localStorage.setItem("fleet.keyMode", JSON.stringify(m));
    },
    [lang, mode] as const,
  );
  await page.setViewportSize({ width, height });
  await page.reload();
  await expect(page.getByText(/^Demo[ -]/)).toBeVisible();
  await expect(page.locator("[data-tile] [data-row]").first()).toBeVisible();
}

/**
 * Everything on the screen whose visible text runs past its box, minus free text and what a narrow board hides.
 * Measured by the text itself, not by scrollWidth: hidden screen-reader text (.sr) inflates that.
 */
const cutOff = (page: Page, scope = "body") =>
  page.evaluate(
    ([free, scope]) => {
      const under = (sel: string) =>
        scope
          .split(",")
          .map((s) => `${s.trim()} ${sel}`)
          .join(", ");
      const out: string[] = [];
      const textRight = (e: HTMLElement) => {
        let right = 0;
        const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent?.trim() || n.parentElement?.closest(".sr")) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          right = Math.max(right, r.getBoundingClientRect().right);
        }
        return right;
      };
      for (const e of Array.from(document.querySelectorAll<HTMLElement>(under("*")))) {
        // A box of one pixel is text for readers only (the context bar on the board at 1280 px).
        if (e.matches(free) || e.clientWidth <= 1 || e.scrollWidth <= e.clientWidth + 1) continue;
        const cs = getComputedStyle(e);
        if (cs.display === "inline" || cs.visibility === "hidden") continue;
        if (cs.overflowX === "visible" && cs.textOverflow !== "ellipsis") continue;
        if (e.closest(".settings-panel, .xterm, [hidden]")) continue;
        // A branch behind the repo name is free text; the name itself (<b>) is checked whole below.
        if (e.matches(".a-where")) continue;
        const box = e.getBoundingClientRect();
        if (textRight(e) <= box.right - Number.parseFloat(cs.paddingRight) + 1) continue;
        out.push(`${e.className || e.tagName}: ${(e.textContent || "").trim().slice(0, 40)}`);
      }
      for (const w of Array.from(document.querySelectorAll<HTMLElement>(under(".a-where")))) {
        const b = w.querySelector("b");
        if (b && b.getBoundingClientRect().right > w.getBoundingClientRect().right + 1)
          out.push(`a-where b: ${b.textContent}`);
      }
      return out;
    },
    [FREE_TEXT, scope] as const,
  );

for (const lang of ["de", "en"] as const) {
  for (const mode of ["vim", "standard"] as const) {
    test(`Bei 1440 px ist auf dem ganzen Schirm kein Repo-Name, keine Nummer, kein Statuswort und keine Zahl abgeschnitten (${lang}, ${mode}, Runde 7)`, async ({
      page,
    }) => {
      await setup(page, lang, mode, 1440);
      expect(await cutOff(page)).toEqual([]);
      // The board alone (`+`) has room for everything it has, too
      await page.locator('[data-tile="board"] [data-row]').first().focus();
      await page.keyboard.press("+");
      await expect(page.locator(".middle[data-zoom]")).toBeVisible();
      expect(await cutOff(page)).toEqual([]);
      await page.keyboard.press("+");
    });
  }
}

for (const lang of ["de", "en"] as const) {
  test(`Bei 1280 px steht die Rückfrage zum Mergen ganz in der Statuszeile (${lang}, Runde 7)`, async ({ page }) => {
    await setup(page, lang, "standard", 1280);
    const row = page.locator('[data-tile="board"] tr[data-row]', { hasText: /112/ }).first();
    await row.getByRole("button", { name: /^(Mergen|Merge)$/ }).click();
    const ask = page.getByRole("contentinfo").getByRole("alert");
    await expect(ask).toContainText(/#112 \(3 Commits?\)/i);
    const fit = await ask.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const text = el.querySelector<HTMLElement>(".sl-ask-t") || el;
      return { whole: text.scrollWidth <= text.clientWidth + 1, inside: r.right <= innerWidth + 1 };
    });
    expect(fit).toEqual({ whole: true, inside: true });
    await expect(ask.getByRole("button", { name: /^(Ja|Yes)/ })).toBeInViewport({ ratio: 1 });
    await expect(ask.getByRole("button", { name: /^(Nein|No)/ })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("y");
    await expect(page.getByText(/Demo: (würde PR #112 mergen|would merge PR #112)/)).toBeVisible();
  });

  test(`Bei 1280 px steht die Frage von :cleanup ganz da, und das alte Ergebnis steht nicht daneben (${lang}, Runde 7)`, async ({
    page,
  }) => {
    await setup(page, lang, "standard", 1280);
    const old = Date.now() - 14 * 3600e3;
    await page.route(
      "**/api/overview",
      overviewRoute((o) => {
        for (const s of o.sessions.filter((x) => x.status === "error" || x.status === "stale"))
          Object.assign(s, { lastActivity: old, statusSince: old });
      }),
    );
    await page.reload();
    await expect(page.locator("[data-tile] [data-row]").first()).toBeVisible();
    const line = page.getByRole("combobox", { name: /(Befehl|command)/i });
    const cmd = async () => {
      await line.click();
      await line.fill(":cleanup");
      await page.keyboard.press("Enter");
    };
    // A result stands in the line first (Cancelled), then the question comes
    await cmd();
    await page.keyboard.press("n");
    await expect(page.getByRole("contentinfo").getByRole("status")).not.toBeEmpty();
    await cmd();
    const ask = page.getByRole("contentinfo").getByRole("alert");
    await expect(ask).toContainText("y/n");
    const fit = await ask.evaluate((el) => {
      const text = el.querySelector<HTMLElement>(".sl-ask-t") || el;
      return {
        whole: text.scrollWidth <= text.clientWidth + 1,
        inside: el.getBoundingClientRect().right <= innerWidth + 1,
      };
    });
    expect(fit).toEqual({ whole: true, inside: true });
    await expect(ask.getByRole("button", { name: /^(Ja|Yes)/ })).toBeInViewport({ ratio: 1 });
    // The old result gives way while the question stands
    await expect(page.getByRole("contentinfo").getByRole("status")).toBeEmpty();
    await page.keyboard.press("n");
  });
}

for (const lang of ["de", "en"] as const) {
  for (const mode of ["vim", "standard"] as const) {
    test(`Bei 1024 px: Name und Version haben ein Leerzeichen, die Kopfzeile passt, das Zahnrad bleibt in ihr (${lang}, ${mode}, Runde 7)`, async ({
      page,
    }) => {
      await setup(page, lang, mode, 1024, 768);
      const m = await page.evaluate(() => {
        const q = (s: string) => document.querySelector(s)?.getBoundingClientRect();
        const hd = document.querySelector<HTMLElement>(".hd");
        const name = q(".hd-name");
        // The version's own space is part of its box: the visible gap runs to its first digit.
        const vt = document.querySelector(".hd-ver")?.lastChild;
        const ver = vt ? document.createRange() : null;
        if (vt) ver?.selectNodeContents(vt);
        const gear = q(".hd-gear");
        const msg = q(".msgrow");
        return {
          over: hd ? hd.scrollWidth - hd.clientWidth : -1,
          space: ver && name ? ver.getBoundingClientRect().left - name.right : -1,
          gearBottom: gear?.bottom ?? 0,
          gearRight: gear?.right ?? 0,
          msgTop: msg?.top ?? 0,
        };
      });
      expect(m.over).toBeLessThanOrEqual(0);
      expect(m.space).toBeGreaterThanOrEqual(5);
      expect(m.gearBottom).toBeLessThanOrEqual(m.msgTop || 40);
      expect(m.gearRight).toBeLessThanOrEqual(1024);
    });
  }
}

// Round 8: the alarm zone's countdown column was 17 columns: "Cache abgelaufen – nächster Aufruf ≈ 64 Tsd. Tokens"
// ended in "Cache abgelauf…" and "seit 2 Std 57 Min" in "…57 M…". The demo had none of the two cases at that moment,
// so the test makes them: an expired cache, a long wait and a long error.
const longest = (o: Overview) => {
  const now = Date.now();
  let i = 0;
  for (const s of o.sessions) {
    if (s.status === "needs_input") {
      // Every second waiting session has an expired cache, the others a running one (both texts are on the screen)
      s.cache = { ttl: "1h", until: i++ % 2 ? now - 60e3 : now + 57 * 60e3, rebuild: 1.25 };
      if (s.context) Object.assign(s.context, { tokens: 164000, size: 200000, pct: 82 });
      s.statusSince = now - (2 * 60 + 57) * 60e3;
    } else if (s.status === "error" || s.status === "stale") s.statusSince = now - (26 * 60 + 57) * 60e3;
  }
};

/** Every cell of an alarm row but the free text (title and cause, the branch behind the repo name). */
const cutCells = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-tile="alarm"] .arow > *'))
      .filter((e) => !e.matches(".a-what, .a-where"))
      .filter((e) => e.scrollWidth > e.clientWidth || e.getBoundingClientRect().right > innerWidth)
      .map((e) => `${e.className}: ${e.textContent?.trim()} (${e.scrollWidth} > ${e.clientWidth})`),
  );

for (const lang of ["de", "en"] as const) {
  for (const width of [1440, 1280]) {
    test(`Bei ${width} px ist in der Alarmzone keine Zelle abgeschnitten, auch nicht mit abgelaufenem Cache und langem Alter (${lang}, Runde 8)`, async ({
      page,
    }) => {
      await page.route("**/api/overview", overviewRoute(longest));
      await setup(page, lang, "standard", width);
      await expect(page.locator('[data-tile="alarm"] .a-cache').first()).toBeVisible();
      // Both cases are really on the screen, or the check proves nothing
      const text = await page.locator('[data-tile="alarm"] .a-age').allTextContents();
      expect(text.some((x) => /Tsd\.|k\b/.test(x))).toBe(true);
      expect(text.some((x) => /\d+ (Std|h) \d+ (Min|min)/.test(x))).toBe(true);
      expect(await cutCells(page)).toEqual([]);
    });
  }
}

// The board's repo and PR cells and the repo bar's PR marks at 1280 px (round 8: "billing-service" 125 px in 117,
// "#231 Entwurf ◌" 101 in 78, "#48✗+2" 54 in 39). Below 1280 px the old widths stay.
for (const lang of ["de", "en"] as const) {
  test(`Bei 1280 px sind in Wachtafel und Repo-Leiste Repo-Name, PR und PR-Marken ganz (${lang}, Runde 8)`, async ({
    page,
  }) => {
    await setup(page, lang, "standard", 1280);
    // The message row cuts its long hints with "…" at this width on purpose; the board and the repo bar may not.
    expect(await cutOff(page, '[data-tile="board"], [data-tile="repos"]')).toEqual([]);
  });
}

test("Der Kopf trägt zwischen Name und Version ein echtes Leerzeichen und sieht gleich aus (Runde 8)", async ({
  page,
}) => {
  await setup(page, "de", "standard", 1440);
  const m = await page.evaluate(() => {
    const name = document.querySelector(".hd-name")?.getBoundingClientRect();
    const ver = document.querySelector(".hd-ver");
    const r = document.createRange();
    if (ver?.lastChild) r.selectNodeContents(ver.lastChild);
    return {
      text: ver?.parentElement?.textContent ?? "",
      space: name ? r.getBoundingClientRect().left - name.right : -1,
    };
  });
  expect(m.text).toMatch(/^Claude Fleet \S*\d+\.\d+\.\d+/);
  expect(m.space).toBeGreaterThanOrEqual(5);
});
