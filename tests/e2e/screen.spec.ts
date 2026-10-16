import type { Page } from "@playwright/test";
import type { Overview, Session } from "../../shared/types";
import { expect, isMobile, tab, test, withOverview } from "./fixtures";

/**
 * The one screen (spec, "Ein Schirm im CLI-Look", rules 1–5, 13, 18): the page never scrolls, only a tile does, and
 * the bottom lines stay in the window.
 */

/** How far the page reaches past the window, down and across; both 0 when nothing scrolls the page. */
const overflow = (page: Page) =>
  page.evaluate(() => [
    document.documentElement.scrollHeight - window.innerHeight,
    document.documentElement.scrollWidth - window.innerWidth,
  ]);

const board = (page: Page) => page.locator('[data-tile="board"] .tile-b');

for (const [width, height] of [
  [1440, 900],
  [1024, 700],
] as const)
  test(`Kein Seitenscroll bei ${width} × ${height} auf jeder Ansicht; die Kachel scrollt, Status- und Kommandozeile sind die letzten Zeilen`, async ({
    page,
  }, info) => {
    test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
    await page.setViewportSize({ width, height });
    for (const path of ["/", "/repos", "/usage", "/activity"]) {
      await page.goto(path);
      await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
      await expect(board(page)).toBeVisible();
      await expect.poll(() => overflow(page), path).toEqual([0, 0]);
      const line = await page.getByRole("contentinfo").boundingBox();
      const cmd = await page
        .getByRole("combobox", { name: /Befehl/ })
        .locator("..")
        .boundingBox();
      expect((line?.y ?? 0) + (line?.height ?? 0), path).toBe(cmd?.y);
      expect((cmd?.y ?? 0) + (cmd?.height ?? 0), path).toBe(height);
    }
    // With more sessions than lines, "Now" is longer than the window: the watch board tile scrolls instead of the
    // page. (The demo fits since the alarm zone is a tile of its own, stage 12.6.)
    await page.goto("/");
    await withOverview(page, only(60));
    await expect(page.getByRole("region", { name: "Sessions" })).toBeVisible();
    expect(await board(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await board(page).hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => board(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await overflow(page)).toEqual([0, 0]);
  });

test("Wachtafel neben Repo-Leiste und Strom: ausgeblendete Spalten geben ihre Breite an die Aufgabe ab", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
  // Reported while taking the stage 12.3 screenshot: the branch column was hidden but kept its 16 columns.
  for (const [width, gone] of [
    [1440, ["Branch"]],
    [1280, ["Branch", "Cache"]],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    const head = page.getByRole("region", { name: "Sessions", exact: true }).getByRole("columnheader");
    for (const name of gone) await expect(head.filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(0);
    // The columns fill the table: no empty column after the last one (the bug left one as wide as the task). Measured
    // against the table, not in px: the CI runner's scroll bar and fonts make the board narrower than on a Mac.
    const edges = await page
      .getByRole("region", { name: "Sessions", exact: true })
      .locator("table")
      .evaluate((t) => {
        const act = t.querySelector("thead th.c-act")?.getBoundingClientRect();
        const task = t.querySelector("thead th.c-task")?.getBoundingClientRect();
        return { gap: t.getBoundingClientRect().right - (act?.right ?? 0), task: task?.width ?? 0 };
      });
    expect(Math.abs(edges.gap), `${width}: gap after the last column`).toBeLessThanOrEqual(1);
    // The task stays readable: at least 12 columns of the grid
    expect(edges.task, `${width}: task width`).toBeGreaterThanOrEqual(12 * 7.8);
  }
});

test("Handy 390 × 844: eine Kachel der Mitte, die Reiterzeile darüber, Kommandozeile im Fenster, kein Seitenscroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.getByRole("navigation", { name: "Kacheln" });
  /** The tiles of the middle in sight (rule 18: exactly one). */
  const shown = () =>
    page
      .locator(".middle > [data-tile]")
      .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).map((el) => el.dataset.tile));
  await expect(tabs.getByRole("button")).toHaveText(["1 Alarm", "2 Repos", "3 Wache", "4 Strom", "5 Schublade"]);
  await expect.poll(shown).toEqual(["board"]);
  await expect(tabs.getByRole("button", { name: "3 Wache" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
  expect(await overflow(page)).toEqual([0, 0]);
  // A tap on a tab shows that tile, and only that one
  await tabs.getByRole("button", { name: "4 Strom" }).click();
  await expect.poll(shown).toEqual(["stream"]);
  await expect(page.getByRole("region", { name: "Ereignisse" }).getByRole("listitem").first()).toBeVisible();
  await expect(tabs.getByRole("button", { name: "4 Strom" })).toHaveAttribute("aria-current", "true");
  await tabs.getByRole("button", { name: "2 Repos" }).click();
  await expect.poll(shown).toEqual(["repos"]);
  expect(await overflow(page)).toEqual([0, 0]);
  // The alarm zone stands above the middle on the phone too (stage 12.6): its tab goes into it, the middle stays
  const zone = page.getByRole("region", { name: "Alarmzone" });
  await expect(zone).toBeInViewport({ ratio: 1 });
  // It grows for the demo's waiting rows (B14), never past half the window
  expect((await zone.boundingBox())?.height).toBeLessThanOrEqual(844 / 2 + 1);
  await tabs.getByRole("button", { name: "1 Alarm" }).click();
  await expect(page.locator('[data-tile="alarm"][data-active]')).toHaveCount(1);
  await expect(tabs.getByRole("button", { name: "1 Alarm" })).toHaveAttribute("aria-current", "true");
  await expect.poll(shown).toEqual(["repos"]);
  // The drawer, shut, says how to open it, as the key 5 does
  await tabs.getByRole("button", { name: "5 Schublade" }).click();
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
    /Schublade ist zu – Enter auf einer Zeile öffnet sie$/,
  );
  // Another area has its one tile, whichever tab was in front on "Now"
  await tabs.getByRole("button", { name: "4 Strom" }).click();
  await expect.poll(shown).toEqual(["stream"]);
  await page.goto("/usage");
  await expect.poll(shown).toEqual(["board"]);
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
  expect(await overflow(page)).toEqual([0, 0]);
});

test("Kommandozeile: immer die letzte Zeile im Fenster, auch über Schublade und Log-Sicht; : fokussiert, Esc gibt den Fokus zurück", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const line = page.getByRole("combobox", { name: /Befehl/ });
  const suggestions = page.getByRole("listbox", { name: "Vorschläge" });
  /** The line's bottom edge is the window's: it is the last line, whole, in sight. */
  const atBottom = async () => {
    const b = await line.locator("..").boundingBox();
    return b ? Math.round(b.y + b.height) - (await page.evaluate(() => window.innerHeight)) : null;
  };
  const focusedNr = () => page.locator(":focus").getAttribute("data-nr");
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect.poll(atBottom).toBe(0);
    await page.locator('[data-nr="1"]').focus();
    await page.keyboard.press(":");
    await expect(line).toBeFocused();
    await expect(suggestions).toBeVisible();
    // At most eight suggestions, in the lines right above the command line
    expect(await suggestions.getByRole("option").count()).toBeLessThanOrEqual(8);
    const list = await suggestions.boundingBox();
    const box = await line.locator("..").boundingBox();
    expect(Math.round((list?.y ?? 0) + (list?.height ?? 0))).toBe(Math.round(box?.y ?? -1));
    await page.keyboard.press("Escape");
    await expect.poll(focusedNr).toBe("1");
    await expect(suggestions).toBeHidden();
    // `/` is the search in the same line
    await page.keyboard.press("/");
    await expect(line).toBeFocused();
    await page.keyboard.press("Escape");
    await expect.poll(focusedNr).toBe("1");
  }
  // The drawer leaves the bottom lines free
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toBeVisible();
  await expect.poll(atBottom).toBe(0);
  await expect(line).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Control+k");
  await expect(line).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Schließen" }).click();
  // So does the log view, and `:` reaches the line from there
  await page.keyboard.press("Shift+L");
  await expect(page.getByRole("region", { name: "Log-Sicht" })).toBeVisible();
  await expect(line).toBeInViewport({ ratio: 1 });
  await page.keyboard.press(":");
  await expect(line).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(line).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Log-Sicht" })).toHaveCount(0);
});

/** The tile the focus is in: the innermost one, while some tiles still sit inside the middle (until stage 12.3). */
const focusedTile = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest("[data-tile]")?.getAttribute("data-tile") ?? null);

test("Kachelwechsel: 1–5 springen zu Alarm, Repos, Wachtafel, Strom, Schublade; Tab reihum; Alt+2 filtert", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  for (const [key, tile] of [
    ["3", "board"],
    ["1", "alarm"],
    ["2", "repos"],
    ["4", "stream"],
    ["3", "board"],
  ] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => focusedTile(page), `${key} → ${tile}`).toBe(tile);
    await expect(page.locator(`[data-tile="${tile}"][data-active]`)).toHaveCount(1);
    await expect(page.locator("[data-tile][data-active]")).toHaveCount(1);
  }
  // 3 lands on a row of the watch board, which is the selection
  await expect.poll(() => page.locator(":focus").getAttribute("data-zone")).toBe("board");
  // 5 with the drawer shut says how to open it
  await page.keyboard.press("5");
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
    /Schublade ist zu – Enter auf einer Zeile öffnet sie$/,
  );
  await expect.poll(() => focusedTile(page)).toBe("board");
  // Tab and Shift+Tab walk round the tiles on screen
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedTile(page)).toBe("stream");
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedTile(page)).toBe("alarm");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusedTile(page)).toBe("stream");
  // Open, the drawer is tile 5; Esc closes it and the selection is back on the board
  await page.keyboard.press("3");
  await expect.poll(() => focusedTile(page)).toBe("board");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toBeVisible();
  await page.keyboard.press("3");
  await page.keyboard.press("5");
  await expect.poll(() => focusedTile(page)).toBe("drawer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: /^Session: / })).toHaveCount(0);
  await expect.poll(() => focusedTile(page)).toBe("board");
  // The status filters are on Alt now
  await page.keyboard.press("Alt+2");
  await expect(page.getByTestId("status-filter")).toContainText("Fehler");
  await page.keyboard.press("Alt+0");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
});

test("Statuszeile: Modus links, rechts die fünf Tasten der aktiven Kachel; ihr Rahmen in --sel folgt dem Fokus", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const line = page.getByRole("contentinfo");
  const keys = page.getByTestId("tile-keys");
  const frame = (id: string) =>
    page.locator(`[data-tile="${id}"]`).evaluate((el) => getComputedStyle(el, "::before").borderTopColor);
  const sel = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--sel)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  await expect(line).toHaveText(/^STANDARD/);
  for (const [key, tile, text] of [
    ["3", "board", "↑↓ wählen · Enter Details · → Terminal · d Diff · ? alle"],
    // The row in focus may be Fleet's approval (its own keys, keyboard.spec), depending on the demo's clock.
    [
      "1",
      "alarm",
      /^↑↓ wählen · (Enter Aktion · Shift\+Enter Details · → Terminal|y erlauben · a für Session · n ablehnen) · \? alle$/,
    ],
    ["2", "repos", "↑↓ wählen · Enter filtern · Shift+Enter Details · n neu · ? alle"],
    ["4", "stream", "↑↓ wählen · Enter zur Zeile · g r zum Repo · → Terminal · ? alle"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(keys, tile).toHaveText(text);
  }
  // Rule 6: only the active tile's frame is in --sel.
  expect(await frame("stream")).toBe(sel);
  expect(await frame("board")).not.toBe(sel);
  // The command line has three keys of its own while it has the focus.
  await page.keyboard.press(":");
  await expect(keys).toHaveText("↑↓ wählen · Enter ausführen · Esc zurück");
  await page.keyboard.press("Escape");
  await expect(keys).toHaveText(/Enter zur Zeile/);
  // A click into a tile makes it the active one, keys and frame with it.
  const repos = page.locator('[data-tile="repos"] .tile-b');
  const box = await repos.boundingBox();
  await repos.click({ position: { x: 4, y: (box?.height ?? 40) - 4 } });
  await expect(page.locator('[data-tile="repos"][data-active]')).toHaveCount(1);
  await expect(keys).toHaveText(/Enter filtern/);
  expect(await frame("repos")).toBe(sel);
  expect(await frame("stream")).not.toBe(sel);
});

test("Esc aus der Kommandozeile geht in die vorige Kachel, auch wenn ihre Zeile inzwischen neu gezeichnet wurde", async ({
  page,
}, info) => {
  // Reported by a red `pnpm check`: the stream redraws its lines on a refresh (the demo dates its events from now),
  // the line the focus came from was gone, and Esc landed on the watch board instead of the stream (rule 4).
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  // The events keep the times of the first answer, so nothing is drawn anew by chance (the demo dates them from now,
  // a refresh between two steps took the focus under load). Each `redraw()` dates them a second later in the next
  // answer only: that one refresh draws the stream's lines anew.
  let shift = 0;
  let bumps = 0;
  const redraw = () => {
    bumps = 1;
  };
  let first: number[] | null = null;
  let since: Map<string, number> | null = null;
  let asked: Map<string, number> | null = null;
  await withOverview(page, (o) => {
    if (bumps > 0) {
      bumps -= 1;
      shift += 1000;
    }
    first ??= o.events.map((e) => e.at);
    o.events.forEach((e, i) => {
      e.at = (first?.[i] ?? e.at) + shift;
    });
    // The stream ends with a session's current status at statusSince, which the demo dates from now too: freeze it.
    since ??= new Map(o.sessions.map((x) => [x.id, x.statusSince ?? 0]));
    for (const x of o.sessions) x.statusSince = (since.get(x.id) ?? x.statusSince ?? 0) + shift;
    // A session Fleet holds a question for ends the stream at the question's start (round 4): freeze that as well.
    asked ??= new Map(o.decisions.map((d) => [d.id, d.createdAt]));
    for (const d of o.decisions) d.createdAt = (asked.get(d.id) ?? d.createdAt) + shift;
  });
  await page.keyboard.press("4");
  await expect.poll(() => focusedTile(page)).toBe("stream");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).dataset.before = "";
  });
  await page.keyboard.press(":");
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeFocused();
  // A refresh while the command line is open: the line that had the focus is drawn anew.
  redraw();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('[data-tile="stream"] [data-before]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect.poll(() => focusedTile(page)).toBe("stream");
  await expect(page.getByTestId("tile-keys")).toHaveText(/Enter zur Zeile/);
  // Seen under load: the line is drawn anew before `:`, the focus has fallen to the page. Esc still goes back to the
  // tile that was active, not to the watch board.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).dataset.before = "";
  });
  redraw();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('[data-tile="stream"] [data-before]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press(":");
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => focusedTile(page)).toBe("stream");
});

test(":12 Enter wählt Zeile 12; + schaltet die aktive Kachel auf Vollbild und zurück", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  await page.keyboard.press(":");
  await page.keyboard.type("12");
  await expect(page.getByRole("option", { name: "Zeile 12 wählen" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.locator(":focus").getAttribute("data-nr")).toBe("12");
  await expect(page.locator(":focus")).toBeInViewport();
  await page.keyboard.press("+");
  await expect(page.locator(".middle[data-zoom]")).toHaveCount(1);
  await page.keyboard.press("+");
  await expect(page.locator(".middle[data-zoom]")).toHaveCount(0);
  await expect.poll(() => page.locator(":focus").getAttribute("data-nr")).toBe("12");
});

/**
 * Only working sessions: `n` copies of one demo session with their own ids and numbered titles, and nothing else
 * that would add a line (no alarms, duplicates, handoffs, CI, limit). The copies are made up like the demo itself.
 */
const only = (n: number) => (o: Overview) => {
  const base = o.sessions.find((s) => s.status === "working" && !s.proc);
  if (!base) throw new Error("demo has no working session");
  o.sessions = Array.from({ length: n }, (_, i) => ({
    ...base,
    id: `${base.id}-x${i}`,
    title: `Aufgabe ${i + 1} von ${n}`,
    ci: null,
    conflict: null,
    loop: null,
    statusSince: Date.now() - (i + 1) * 60e3,
  }));
  o.decisions = [];
  o.duplicates = [];
  o.repos = o.repos.map((r) => ({ ...r, ci: null, handoff: null }));
  if (o.usage) o.usage.limitHit = null;
};

test("60 Sessions: die Seite scrollt nicht, die Wachtafel scrollt und sagt in der Rahmenzeile, wo sie steht", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await withOverview(page, only(60));
  const rows = page.getByRole("rowgroup", { name: "Arbeitet" }).locator("tr[data-row]");
  await expect(rows).toHaveCount(60);
  expect(await overflow(page)).toEqual([0, 0]);
  expect(await board(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const pos = page.locator('[data-tile="board"] .tile-h').getByTestId("tile-pos");
  await expect(pos).toHaveText(/^1–\d+\/60$/);
  // End selects the last row and brings it into sight; the frame line follows.
  await rows.first().focus();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toBeInViewport();
  await expect(pos).toHaveText(/^\d+–60\/60$/);
  expect(await overflow(page)).toEqual([0, 0]);
  await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport();
});

test("30 Sessions passen bei 1440 × 900 in die Wachtafel, jede Zeile eine Rasterzeile", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
  await page.setViewportSize({ width: 1440, height: 900 });
  await withOverview(page, only(30));
  const rows = page.getByRole("rowgroup", { name: "Arbeitet" }).locator("tr[data-row]");
  await expect(rows).toHaveCount(30);
  const heights = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([20]));
  // Rule 13: the watch board's tile holds its 30 rows, head and group line without scrolling. Since stage 12.6 the
  // alarm zone is a tile of its own and the token section is gone: nothing else stands in the board's tile.
  const fit = await board(page).evaluate((el) => [el.scrollHeight, el.clientHeight]);
  expect(fit[0]).toBe(fit[1]);
  await expect(page.locator('[data-tile="board"] .tile-h').getByTestId("tile-pos")).toHaveCount(0);
  for (const row of [rows.first(), rows.last()]) await expect(row).toBeInViewport({ ratio: 1 });
  expect(await overflow(page)).toEqual([0, 0]);
});

/** The alarm zone, tile 1 (stage 12.6): its region, its scrolling body and the position in its frame line. */
const alarmZone = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const alarmBody = (page: Page) => page.locator('[data-tile="alarm"] .tile-b');
const alarmFrame = (page: Page) => page.locator('[data-tile="alarm"] .tile-h');

/**
 * Every working or waiting demo session fails: far more alarms than the zone's three lines, and none waiting, so the
 * zone keeps its three lines (it grows only for waiting rows, B14).
 */
const manyErrors = (o: Overview) => {
  for (const s of o.sessions)
    if (s.status === "working" || s.status === "needs_input")
      Object.assign(s, { status: "error", detail: "Turn fehlgeschlagen" });
  o.decisions = [];
};

test("Alarmzone: viele Alarme scrollen in der Kachel, nie die Seite; sechs Zeilen, Position in der Rahmenzeile", async ({
  page,
}, info) => {
  const phone = isMobile(info.project.name);
  const sizes: (readonly [number, number])[] = phone
    ? [[390, 844]]
    : [
        [1440, 900],
        [1024, 700],
      ];
  await withOverview(page, manyErrors);
  const rows = alarmZone(page).getByRole("article");
  const n = await rows.count();
  expect(n).toBeGreaterThan(8);
  await expect(alarmZone(page)).toContainText(new RegExp(`^1 Alarmzone ${n}`));
  const pos = alarmFrame(page).getByTestId("tile-pos");
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    // Rule 2: frame line plus six lines (release 6), whatever stands there; the rest scrolls inside the tile
    await expect
      .poll(() => alarmBody(page).evaluate((el) => [el.clientHeight, el.scrollHeight > el.clientHeight]))
      .toEqual([120, true]);
    await expect(pos).toHaveText(`1–6/${n}`);
    await expect(rows.nth(6)).not.toBeInViewport();
    expect(await overflow(page)).toEqual([0, 0]);
    await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
    // Scrolled to its end, the frame line says so; the page stays where it was
    await alarmBody(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(pos).toHaveText(`${n - 5}–${n}/${n}`);
    await expect(rows.last()).toBeInViewport({ ratio: 1 });
    expect(await overflow(page)).toEqual([0, 0]);
    await alarmBody(page).evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  if (phone) return;
  // By keyboard: ↓ past the sixth line brings the seventh into sight, inside the tile
  await rows.nth(5).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(6)).toBeFocused();
  await expect(rows.nth(6)).toBeInViewport({ ratio: 1 });
  await expect(pos).toHaveText(`2–7/${n}`);
  expect(await overflow(page)).toEqual([0, 0]);
});

/**
 * `errors` old failures (from yesterday) and `waiting` sessions that wait for an answer, nothing else in the alarm
 * zone: the window that hid Ben's requests below stale errors (B14). Made-up copies of a demo session.
 */
const errorsAndWaiting = (errors: number, waiting: number) => (o: Overview) => {
  const base = o.sessions.find((s) => s.status === "working" && !s.proc);
  if (!base) throw new Error("demo has no working session");
  const at = Date.now();
  const copy = (i: number, status: "error" | "needs_input", since: number): Session => ({
    ...base,
    id: `${base.id}-b14-${i}`,
    title: status === "error" ? `Alter Fehler ${i + 1}` : `Frage ${i + 1}`,
    status,
    detail: status === "error" ? "Anmeldung abgelaufen" : "wartet auf deine Antwort",
    ci: null,
    conflict: null,
    loop: null,
    next: undefined,
    statusSince: since,
  });
  o.sessions = [
    ...Array.from({ length: errors }, (_, i) => copy(i, "error", at - 86_400_000 + i * 60e3)),
    ...Array.from({ length: waiting }, (_, i) => copy(errors + i, "needs_input", at - (i + 1) * 60e3)),
  ];
  o.decisions = [];
  o.duplicates = [];
  o.repos = o.repos.map((r) => ({ ...r, ci: null, handoff: null }));
  if (o.usage) o.usage.limitHit = null;
};

/** The header's ?N: the button "N warten auf dich" in the overview group. */
const waitingCounter = (page: Page) =>
  page.getByRole("group", { name: "Überblick" }).getByRole("button", { name: /warten auf dich$/ });

for (const [width, height] of [
  [800, 600],
  [1440, 900],
] as const)
  test(`Alarmzone bei ${width} × ${height}: 5 Wartende stehen vor 3 alten Fehlern und alle im Blick (B14)`, async ({
    page,
  }, info) => {
    test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
    await page.setViewportSize({ width, height });
    await withOverview(page, errorsAndWaiting(3, 5));
    const rows = alarmZone(page).getByRole("article");
    await expect(rows).toHaveCount(8);
    // Waiting first, newest first, numbered on in the order on screen; then the errors.
    await expect(rows.nth(0)).toHaveAccessibleName("Frage 4");
    for (let i = 0; i < 5; i++) {
      await expect(rows.nth(i)).toContainText(/Frage|Freigabe/);
      await expect(rows.nth(i).locator(".nr")).toHaveText(String(i + 1));
      // The zone grows for every waiting row: none waits out of sight.
      await expect(rows.nth(i)).toBeInViewport({ ratio: 1 });
    }
    await expect(rows.nth(5)).toContainText(/Fehler/);
    await expect(rows.nth(5).locator(".nr")).toHaveText("6");
    // ?N equals the waiting rows; nothing waiting lies below, so the frame line does not say so.
    await expect(waitingCounter(page)).toHaveAccessibleName("5 warten auf dich");
    await expect(alarmFrame(page).getByTestId("tile-below")).toHaveCount(0);
    expect(await overflow(page)).toEqual([0, 0]);
    await expect(page.getByRole("combobox", { name: /Befehl/ })).toBeInViewport({ ratio: 1 });
  });

test("Alarmzone: mehr Wartende als die halbe Höhe – die Rahmenzeile sagt „+N wartend darunter“ (B14)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "window sizes of the desktop; the phone has its own test");
  await page.setViewportSize({ width: 800, height: 600 });
  await withOverview(page, errorsAndWaiting(3, 20));
  const rows = alarmZone(page).getByRole("article");
  await expect(rows).toHaveCount(23);
  await expect(waitingCounter(page)).toHaveAccessibleName("20 warten auf dich");
  // Half the window in whole rows at most, so the middle keeps its place.
  const h = await alarmBody(page).evaluate((el) => el.clientHeight);
  expect(h % 20).toBe(0);
  expect(h).toBeGreaterThan(3 * 20);
  expect(h).toBeLessThanOrEqual(300);
  const seen = h / 20;
  const below = alarmFrame(page).getByTestId("tile-below");
  await expect(below).toHaveText(`+${20 - seen} wartend darunter`);
  // Scrolled down, the count follows; at the end only errors are left below.
  await alarmBody(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(below).toHaveCount(0);
  expect(await overflow(page)).toEqual([0, 0]);
  await expect(page.locator('[data-tile="board"]')).toBeInViewport();
});

test("Alarmzone: der Statusfilter engt sie ein, die Zahl in der Rahmenzeile folgt; auf jeder Ansicht", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const rows = alarmZone(page).getByRole("article");
  const all = await rows.count();
  await expect(alarmZone(page)).toContainText(new RegExp(`^1 Alarmzone ${all}`));
  // Alt+2: errors only; Fleet's questions, waiting sessions, red CI and the limit step aside
  await page.keyboard.press("Alt+2");
  await expect(page.getByTestId("status-filter")).toContainText("Fehler");
  await expect(rows.filter({ hasNotText: /^\d+\s*✗\s*Fehler/ })).toHaveCount(0);
  const errors = await rows.count();
  expect(errors).toBeGreaterThan(0);
  expect(errors).toBeLessThan(all);
  await expect(alarmZone(page)).toContainText(new RegExp(`^1 Alarmzone ${errors}`));
  // Alt+1: waiting only, Fleet's questions among them
  await page.keyboard.press("Alt+1");
  await expect(rows.filter({ hasText: /^\d+\s*✗/ })).toHaveCount(0);
  await expect(alarmZone(page).locator('article[data-kind="decision"]').first()).toBeVisible();
  // Another view keeps the zone, under the same filter, outside the view's own tile
  await page.keyboard.press(":");
  await page.keyboard.type("usage");
  await page.keyboard.press("Enter");
  await expect(tab(page, /Verbrauch/)).toHaveAttribute("aria-current", "page");
  await expect(rows.filter({ hasText: /^\d+\s*✗/ })).toHaveCount(0);
  await expect(alarmZone(page).locator('article[data-kind="decision"]').first()).toBeVisible();
  await expect(page.getByRole("main").getByRole("region", { name: "Alarmzone" })).toHaveCount(0);
  await page.keyboard.press("Alt+0");
  await expect.poll(() => rows.count()).toBe(all);
});

test("Alarmzone: stummgeschaltete Alarme zählen in der Rahmenzeile, ein Klick dort zeigt sie wieder", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  const rows = alarmZone(page).getByRole("article");
  const all = await rows.count();
  const frame = alarmFrame(page);
  await expect(frame.getByRole("button", { name: /stumm/ })).toHaveCount(0);
  for (const name of ["Funnel-Auswertung je Kanal", "Doku für Farb-Tokens"]) {
    await alarmZone(page).getByRole("article", { name }).focus();
    await page.keyboard.press("s");
    await page.keyboard.press("y");
    await expect(alarmZone(page).getByRole("article", { name })).toHaveCount(0);
  }
  const unmute = frame.getByRole("button", { name: "2 stumm – wieder zeigen" });
  await expect(unmute).toHaveText("2 stumm");
  await expect(alarmZone(page)).toContainText(new RegExp(`^1 Alarmzone ${all - 2}`));
  // In the frame line, one line high: muting adds no line to the zone or the page
  expect((await frame.boundingBox())?.height).toBe(20);
  expect(await overflow(page)).toEqual([0, 0]);
  await unmute.click();
  await expect.poll(() => rows.count()).toBe(all);
  await expect(frame.getByRole("button", { name: /stumm/ })).toHaveCount(0);
});

test("Phone: every alarm row's cause gets at least eight columns, and the settings gear is in sight", async ({
  page,
}, info) => {
  test.skip(!isMobile(info.project.name), "phone only");
  const zone = page.getByRole("region", { name: "Alarmzone" });
  await expect(zone.getByRole("article").first()).toBeVisible();
  // Relative to the row's number column (4 ch): the cause is at least twice as wide (practical test: 2 characters).
  const widths = await zone.locator("[data-nr]").evaluateAll((rows) =>
    rows.map((r) => {
      const why = r.querySelector(".a-why")?.getBoundingClientRect().width ?? 0;
      const nr = r.querySelector(".nr")?.getBoundingClientRect().width ?? 1;
      return why / nr;
    }),
  );
  expect(widths.length).toBeGreaterThan(3);
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("banner").getByRole("button", { name: "Einstellungen" })).toBeInViewport();
});

test("Die Kopfzeile passt ab 1024 px ganz ins Fenster, auch auf Deutsch, der längeren Sprache (Runde 4)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "desktop widths");
  for (const width of [1024, 1100, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    const over = await page.evaluate(() => {
      const hd = document.querySelector<HTMLElement>(".hd");
      return hd ? hd.scrollWidth - hd.clientWidth : -1;
    });
    expect(over, `${width} px`).toBeLessThanOrEqual(0);
  }
});
