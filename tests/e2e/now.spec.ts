import type { Page } from "@playwright/test";
import { expect, isMobile, search, tab, test, withOverview } from "./fixtures";

/** The clear button × of an alarm row (release 6): on the desktop; under 100 columns its room goes to the title. */
const clear = () => (isMobile(test.info().project.name) ? [] : ["×"]);

const alarms = (page: Page) => page.getByRole("region", { name: "Alarmzone" });
const board = (page: Page) => page.getByRole("region", { name: "Sessions", exact: true });
const group = (page: Page, name: string) => board(page).getByRole("rowgroup", { name, exact: true });

test("Alarmzone: Freigaben und Fragen am Ende des Turns, auch ohne Fragezeichen; Fertig steht in der Wachtafel", async ({
  page,
}) => {
  const zone = alarms(page);
  await expect(zone.getByText("Freigabe für Bash: pnpm e2e --project=chromium")).toBeVisible();
  // Spec case: "an der ersten Stelle, an der ich dein Ja brauche" waits, it is not done
  const eit = zone.getByRole("article", { name: "Eitplanken-Aufträge Guardrails" });
  await expect(eit.getByText(/an der ich dein Ja brauche/)).toBeVisible();
  // A sentence that wants a yes is a question in words; only a tool call the app holds is an approval
  await expect(eit.getByText("Frage", { exact: true })).toBeVisible();
  await expect(
    zone.getByRole("article", { name: "Rundung im Warenkorb korrigieren" }).getByText("Freigabe", { exact: true }),
  ).toBeVisible();
  await expect(
    zone.getByRole("article", { name: "Doku für Farb-Tokens" }).getByText("Soll ich den PR aufmachen?"),
  ).toBeVisible();
  // The stuck session was paused by Fleet: one row at the top with its one answer, not twice
  await expect(zone.getByRole("article", { name: /Fleet hat angehalten: 6× derselbe Bash-Aufruf/ })).toBeVisible();
  await expect(zone.getByRole("article").filter({ hasText: /6× derselbe Bash-Aufruf/ })).toHaveCount(1);
  await expect(group(page, "Fertig").getByRole("row", { name: "Schema-Prüfung vor dem Import" })).toBeVisible();
  // One place per session: what stands in the alarm zone is not on the board as well
  for (const name of ["Eitplanken-Aufträge Guardrails", "Doku für Farb-Tokens", "Funnel-Auswertung je Kanal"])
    await expect(board(page).getByRole("row", { name })).toHaveCount(0);
  await expect(
    group(page, "Arbeitet").getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" }),
  ).toBeVisible();
});

test("Fehler in der Alarmzone: unter allem Wartenden, Ursache in einem Satz, genau eine Aktion", async ({ page }) => {
  // Tile 1 of the screen, above the middle (stage 12.6): not part of the watch board's main region
  const zone = alarms(page);
  await expect(zone).toContainText(/^1 Alarmzone \d+/);
  await expect(page.getByRole("main").getByRole("region", { name: "Alarmzone" })).toHaveCount(0);
  // Fleet's own questions (they expire) come first, then the sessions waiting for you, then the errors (B14: old
  // errors pushed waiting requests out of sight)
  await expect(zone.getByRole("article").first()).toHaveAttribute("data-kind", "decision");
  await expect(zone.locator('article[data-kind="session"]').first()).toContainText(/Frage|Freigabe|Fleet fragt/);
  const kinds = await zone
    .locator('article[data-kind="session"]')
    .getByTestId("glyph")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-glyph")));
  expect(kinds.indexOf("error")).toBeGreaterThan(0);
  expect(kinds.slice(kinds.indexOf("error"))).not.toContain("waiting");
  // Reported: "Failed to authenticate" sat under "Ruht"; the session ended, the transcript still knows why
  const auth = zone.getByRole("article", { name: "Funnel-Auswertung je Kanal" });
  await expect(auth.getByText("Anmeldung abgelaufen")).toBeVisible();
  await expect(auth.getByRole("button")).toHaveText(["Funnel-Auswertung je Kanal", "Neu anmelden", ...clear()]);
  const limit = zone.getByRole("article", { name: "Webhooks für Kontaktänderungen" });
  await expect(limit.getByText(/Limit erreicht, frei ab \d\d:\d\d$/)).toBeVisible();
  await expect(limit.getByRole("button", { name: "Fortsetzen" })).toBeVisible();
  const api = zone.getByRole("article", { name: "Laufzeit auf Node 24 anheben" });
  await expect(api.getByText("API-Fehler: overloaded: 529 Overloaded")).toBeVisible();
  await api.getByRole("button", { name: "Neu starten" }).click();
  // Restarting goes into Fleet's own terminal (the preferred target); the result stays in the status line
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(
    /Laufzeit auf Node 24 anheben: im Fleet-Terminal$/,
  );
  await expect(page.getByRole("complementary", { name: "Terminal: Laufzeit auf Node 24 anheben" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("STANDARD");
  await page.getByRole("button", { name: "Schließen" }).click();
  // Its emergency handoff waits behind the error row, not a second time under "Übergabe bereit"
  await expect(group(page, "Übergabe bereit").getByRole("row", { name: "billing-service" })).toBeVisible();
  await expect(group(page, "Übergabe bereit").getByRole("row", { name: "crm-sync" })).toHaveCount(0);
});

test("Leere Alarmzone sagt in einem Satz, dass nichts ansteht", async ({ page }) => {
  await withOverview(page, (o) => {
    o.decisions = [];
    o.sessions = o.sessions.filter((s) => s.status === "working" && !s.ci?.pr);
    for (const s of o.sessions) s.ci = null;
    o.repos = o.repos.map((r) => ({ ...r, ci: null }));
    if (o.usage) o.usage.limitHit = null;
  });
  await expect(alarms(page).getByText(/^Nichts zu tun/)).toBeVisible();
  await expect(alarms(page).getByRole("article")).toHaveCount(0);
});

test("Limit ab 90 % aus der Statuszeile steht als Alarm, mit einer Aktion", async ({ page }) => {
  await withOverview(page, (o) => {
    if (!o.usage?.limits?.five_hour) throw new Error("demo without limits");
    o.usage.limits.five_hour.used_percentage = 93;
  });
  const row = alarms(page).getByRole("article", { name: "5-Stunden-Limit" });
  await expect(row.getByText(/^zu 93 %/)).toBeVisible();
  await row.getByRole("link", { name: "Zum Verbrauch" }).click();
  await expect(tab(page, /Verbrauch/)).toHaveAttribute("aria-current", "page");
});

test("Fleet-Bilanz drei Tage negativ: eine Alarmzeile, als letzte nummeriert, eine Aktion; positiv keine", async ({
  page,
}) => {
  const calm = (o: Parameters<Parameters<typeof withOverview>[1]>[0]) => {
    o.decisions = [];
    o.sessions = o.sessions.filter((s) => s.status === "working" && !s.ci?.pr);
    for (const s of o.sessions) s.ci = null;
    o.repos = o.repos.map((r) => ({ ...r, ci: null }));
    if (o.usage) o.usage.limitHit = null;
  };
  // The demo balance is positive: nothing to do
  await withOverview(page, calm);
  await expect(alarms(page).getByText(/^Nichts zu tun/)).toBeVisible();
  await withOverview(page, (o) => {
    if (!o.usage?.balance) throw new Error("demo without balance");
    o.usage.balance.alarm = { net: -85_000, cost: 90_000, since: "2026-10-12" };
  });
  const zone = alarms(page);
  const row = zone.getByRole("article", { name: "Fleet-Bilanz negativ" });
  await expect(row.getByText(/^3 Tage negativ: −85 Tsd\. Tokens/)).toBeVisible();
  // Last on screen, so it carries the highest number of the zone, and the numbers still run without gaps
  const lead = (texts: string[]) => texts.map((x) => Number(/^\s*(\d+)/.exec(x)?.[1] ?? Number.NaN));
  const rows = zone.getByRole("article");
  await expect(rows.last()).toHaveAccessibleName("Fleet-Bilanz negativ");
  const nums = lead(await rows.allInnerTexts());
  expect(nums).toEqual(nums.map((_, i) => i + 1));
  await row.getByRole("link", { name: "Zum Verbrauch" }).click();
  await expect(page.getByRole("region", { name: "Fleet-Bilanz, 7 Tage" })).toBeVisible();
});

test("Eine Quelle für alle Zähler, CI-Rot am Repo statt bei den Wartenden", async ({ page }) => {
  // Reported: different numbers per tab, and sessions sat under "Braucht dich" because of red CI
  const overview = page.getByRole("group", { name: "Überblick" });
  const read = () =>
    Promise.all(
      ["warten auf dich", "Fehler", "CI rot", "arbeiten", "fertig"].map((label) =>
        overview
          .getByTitle(new RegExp(`^\\d+ ${label}`))
          .locator("b")
          .innerText(),
      ),
    );
  const onNow = await read();
  const zone = alarms(page);
  await expect(zone.locator("article").filter({ hasText: /^\d+\s*✗\s*Fehler/ })).toHaveCount(Number(onNow[1]));
  await expect(zone.locator("article").filter({ hasText: /^\d+\s*CI rot/ })).toHaveCount(Number(onNow[2]));
  await expect(group(page, "Arbeitet").locator("tr[aria-label]")).toHaveCount(Number(onNow[3]));
  await expect(group(page, "Fertig").locator("tr[aria-label]")).toHaveCount(Number(onNow[4]));
  for (const name of [/Repos & PRs/, /Verbrauch/, /Aktivität/]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
    expect(await read()).toEqual(onNow);
  }
  await tab(page, /Jetzt/).click();
  await expect(zone.getByRole("article", { name: "Steuerbeträge je Position runden", exact: true })).not.toContainText(
    "CI rot",
  );
  await expect(zone.getByRole("article", { name: /^billing-service · PR #48/ })).toBeVisible();
});

test("Signale einmal: roter PR nur in der Alarmzone, nicht noch einmal in der Fertig-Zeile", async ({ page }) => {
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.title === "Schema-Prüfung vor dem Import");
    if (!s?.ci?.pr) throw new Error("demo session without PR");
    s.ci.pr.ci = "failure";
  });
  await expect(alarms(page).getByRole("article", { name: /^data-pipeline · PR #112/ })).toBeVisible();
  const row = group(page, "Fertig").getByRole("row", { name: "Schema-Prüfung vor dem Import" });
  await expect(row.getByRole("link", { name: "#112" })).toBeVisible();
  await expect(row.getByText("CI rot")).toHaveCount(0);
});

test("Signale einmal: rote CI, an der eine Session arbeitet, steht an dieser Zeile statt als Alarm", async ({
  page,
}) => {
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.title === "Schema-Prüfung vor dem Import");
    if (!s?.ci?.pr) throw new Error("demo session without PR");
    s.ci.pr.ci = "failure";
    s.status = "working";
  });
  await expect(alarms(page).getByRole("article", { name: /PR #112/ })).toHaveCount(0);
  const row = group(page, "Arbeitet").getByRole("row", { name: "Schema-Prüfung vor dem Import" });
  await expect(row.getByText("CI rot")).toBeVisible();
});

test("Ruht eingeklappt mit Zahl, aufgeklappt je Repo, Zustand bleibt; Archiv nur über die Suche", async ({ page }) => {
  const rest = group(page, "Ruht");
  const fold = rest.getByRole("button", { name: /Ruht · 3/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(rest.getByRole("row", { name: "Terraform-Module aufteilen" })).toHaveCount(0);
  await fold.click();
  await expect(rest.getByRole("rowheader", { name: "infra · 2" })).toBeVisible();
  await expect(rest.getByRole("rowheader", { name: "shop-frontend · 1" })).toBeVisible();
  await expect(rest.getByRole("row", { name: "Terraform-Module aufteilen" })).toBeVisible();
  await page.reload();
  await expect(group(page, "Ruht").getByRole("button", { name: /Ruht · 3/ })).toHaveAttribute("aria-expanded", "true");
  // The demo server is shared: fold it again
  await group(page, "Ruht")
    .getByRole("button", { name: /Ruht · 3/ })
    .click();
  // Closed, archived in the desktop app, or replaced by a newer session: not on "Now"
  for (const name of ["Alte Exportskripte entfernen", "Prompt-Bibliothek sortieren", "Abhängigkeiten aktualisieren"])
    await expect(page.getByRole("row", { name })).toHaveCount(0);
  await expect(board(page).getByText("Archiv · 3 – über die Suche erreichbar")).toBeVisible();
  await search(page, "Exportskripte");
  await expect(group(page, "Archiv").getByRole("row", { name: "Alte Exportskripte entfernen" })).toBeVisible();
  await search(page, "");
});

test("Wachtafel: eine Zeile je Session, lange Werte ohne Umbruch, Kontext als Balken", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "columns are hidden on a phone");
  const row = group(page, "Arbeitet").getByRole("row", { name: "Checkout auf die neuen Komponenten umstellen" });
  await expect(row.getByRole("progressbar", { name: "Kontextfenster" })).toHaveAttribute("aria-valuenow", "87");
  const heights = await board(page)
    .locator("tr[aria-label]")
    .evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThanOrEqual(30);
  await expect(row.getByRole("link", { name: "#231" })).toBeVisible();
});

test("Wachtafel: eine zu lange Aufgabe endet mit Auslassungszeichen statt hart abgeschnitten", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "columns are hidden on a phone");
  const long = "Checkout auf die neuen Komponenten umstellen und dabei alle alten Varianten der Seite entfernen";
  await withOverview(page, (o) => {
    const s = o.sessions.find((x) => x.title === "Checkout auf die neuen Komponenten umstellen");
    if (s) s.title = long;
  });
  const opener = group(page, "Arbeitet").getByRole("row", { name: long }).getByRole("button", { name: long });
  // The ellipsis only shows when the button itself is as narrow as its cell; otherwise the cell clips mid-letter.
  const fit = await opener.evaluate((b) => ({
    button: b.getBoundingClientRect().width,
    cell: (b.parentElement as HTMLElement).clientWidth,
    clipped: b.scrollWidth > b.clientWidth,
  }));
  expect(fit.button).toBeLessThanOrEqual(fit.cell);
  expect(fit.clipped).toBe(true);
});

test("Nummerierte Zeilen: die Alarmzone zählt ab 1, die Wachtafel zählt weiter, jede Nummer genau einmal", async ({
  page,
}) => {
  const lead = (texts: string[]) => texts.map((x) => Number(/^\s*(\d+)/.exec(x)?.[1] ?? Number.NaN));
  const zone = alarms(page);
  // Fleet's questions are alarm rows like the others (stage 12.6), first in the zone
  await expect(zone.getByRole("article").first()).toHaveAttribute("data-kind", "decision");
  const rows = lead(await zone.getByRole("article").allInnerTexts());
  const onBoard = lead(await board(page).locator("tr[aria-label] > td:first-child").allInnerTexts());
  const all = [...rows, ...onBoard];
  expect(all.length).toBeGreaterThan(10);
  expect(all).toEqual(all.map((_, i) => i + 1));
  // Folded resting rows have no number yet; unfolded they number on
  await group(page, "Ruht")
    .getByRole("button", { name: /Ruht · 3/ })
    .click();
  const more = lead(await board(page).locator("tr[aria-label] > td:first-child").allInnerTexts());
  expect(more).toEqual(more.map((_, i) => all.length - onBoard.length + i + 1));
  expect(more.length).toBe(onBoard.length + 3);
  await group(page, "Ruht")
    .getByRole("button", { name: /Ruht · 3/ })
    .click();
});

test("Meldungszeile: eine Warnung des Servers steht in der Zeile unter dem Kopf, vor dem Demo-Hinweis", async ({
  page,
}) => {
  await withOverview(page, (o) => {
    o.warnings = ["Hooks fehlen – node dist/fleet.cjs install-hooks"];
  });
  const warning = page.getByRole("alert").filter({ hasText: "Hooks fehlen" });
  await expect(warning).toBeVisible();
  const box = await warning.boundingBox();
  expect(box && box.y >= 20 && box.y + box.height <= 40, JSON.stringify(box)).toBe(true);
  const demo = await page.getByText(/^Demo-Modus/).boundingBox();
  expect(box && demo && demo.y === box.y && demo.x > box.x).toBe(true);
});

// BUGANALYSE B2: without the terminal one can neither answer nor start sessions, and only fleet.log said why.
test("Meldungszeile: ohne Terminal im Fenster steht der Grund dort, nicht wenn es abgeschaltet ist", async ({
  page,
}) => {
  const why = "Claude-CLI (claude) nicht gefunden (weder im PATH noch in der Desktop-App)";
  await withOverview(page, (o) => {
    o.terminal = { available: false, max: 8, why };
  });
  await expect(page.getByRole("alert")).toHaveText(`Terminal im Fenster nicht verfügbar: ${why}`);
  await withOverview(page, (o) => {
    o.terminal = { available: false, off: true, max: 8, why: "in der Config abgeschaltet" };
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Kopfzeile: nur das Zahnrad; Benachrichtigungen, Sprache und Farbschema liegen dahinter", async ({ page }) => {
  const header = page.getByRole("banner");
  await expect(header.getByRole("button", { name: "Desktop-Benachrichtigungen" })).toBeHidden();
  await header.getByRole("button", { name: "Einstellungen" }).click();
  await expect(header.getByRole("button", { name: "Desktop-Benachrichtigungen" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  for (const name of ["Sprache", "Farbschema"]) await expect(header.getByRole("group", { name })).toBeVisible();
});

test("Kopfzeile ist eine Textzeile: Zähler als Zeichen, ein Klick springt zur Stelle", async ({ page }) => {
  // Reported: the row of numbers and the heading "Jetzt" took a whole line without leading anywhere
  expect((await page.getByRole("heading", { name: "Jetzt", level: 1 }).boundingBox())?.height ?? 0).toBeLessThanOrEqual(
    1,
  );
  // Stage 12.4: name, areas, counters, limit, balance and gear on one line of the grid; the search went to `/`.
  const header = page.getByRole("banner");
  expect((await header.boundingBox())?.height).toBe(20);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  const overview = page.getByRole("group", { name: "Überblick" });
  await expect(overview.getByTitle(/^\d+ warten auf dich/)).toHaveText(/^\?\d+$/);
  await expect(overview.getByRole("link", { name: /offene PRs/ })).toHaveText(/^#\d+$/);
  await expect(overview.getByRole("progressbar", { name: "5-Stunden-Limit" })).toHaveText(/^█+░+$/);
  await tab(page, /Aktivität/).click();
  expect((await overview.getByRole("link", { name: /Limit/ }).boundingBox())?.height).toBe(20);
  await overview.getByRole("button", { name: /fertig/ }).click();
  await expect(tab(page, /Jetzt/)).toHaveAttribute("aria-current", "page");
  const heading = page.getByRole("heading", { name: "Fertig · 3" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  // The alarm zone stands on every view (stage 12.6): the counter selects its first error row, wherever one is
  await tab(page, /Verbrauch/).click();
  await overview.getByRole("button", { name: /Fehler/ }).click();
  await expect(tab(page, /Verbrauch/)).toHaveAttribute("aria-current", "page");
  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("data-zone", "alarm");
  await expect(focused.getByText("Fehler", { exact: true })).toBeVisible();
  await expect(focused).toBeInViewport({ ratio: 1 });
  await overview.getByRole("button", { name: /CI rot/ }).click();
  await expect(focused).toHaveAttribute("data-kind", "ci");
  await overview.getByRole("link", { name: /offene PRs/ }).click();
  await expect(tab(page, /Repos & PRs/)).toHaveAttribute("aria-current", "page");
});

test("Neue Session geöffnet, wartet auf Enter: steht oben, mit Nochmal öffnen", async ({ page }) => {
  // A handoff is one line of the watch board (stage 12.2): ↷, repo, time and steps, one action.
  const row = group(page, "Übergabe bereit").locator("tr[aria-label]").first();
  await expect(row).toHaveAttribute("aria-label", "billing-service");
  await expect(row.getByRole("img", { name: "Übergabe bereit" })).toHaveText("↷");
  await expect(row.getByRole("cell", { name: "geöffnet", exact: true })).toBeVisible();
  await row.getByRole("button", { name: /^Übergabe \d\d:\d\d · 2 nächste Schritte$/ }).click();
  const drawer = page.getByRole("complementary", { name: "Übergabe: billing-service" });
  await expect(
    drawer.getByText("In Desktop-App geöffnet – dort steht der Auftrag, mit Enter abschicken."),
  ).toBeVisible();
  await expect(drawer.getByText("Nochmal öffnen in")).toBeVisible();
});

test("Übergabe bereit: nächste Schritte je Repo in der Schublade, ein Klick in die neue Session", async ({ page }) => {
  const row = group(page, "Übergabe bereit").getByRole("row", { name: "mobile-app" });
  await expect(row.getByRole("cell", { name: "bereit", exact: true })).toBeVisible();
  // Enter on the row opens the handoff drawer, as on a session row (spec rule 10)
  await row.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("complementary", { name: "Übergabe: mobile-app" });
  await expect(drawer.getByRole("listitem").first()).toHaveText(
    "Eigenes Testkonto je Testdatei anlegen (fixtures/accounts.ts)",
  );
  await expect(drawer.getByText(/Kontextfenster ist zu 87 % voll/)).toBeVisible();
  // All available targets in the drawer, not only the last one chosen
  for (const t of ["Fleet-Terminal", "Desktop-App", "VS Code", "Terminal"])
    await expect(drawer.getByRole("button", { name: t, exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByText("Demo: würde in Terminal eine neue Session öffnen")).toBeVisible();
});

test("Bremse: Fleet fragt mit Frist in einer Zeile, Enter gibt die empfohlene Antwort", async ({ page }, info) => {
  const row = alarms(page).getByRole("article", { name: /Fleet hat angehalten: 6× derselbe Bash-Aufruf/ });
  await expect(row.getByText(/^\d:\d\d$/)).toBeVisible();
  // One row (rule 9): the session's title opens the drawer with every answer, the one action is the recommended one;
  // × clears it away (release 6)
  await expect(row.getByRole("button")).toHaveText([
    "Flaky Login-Test stabilisieren",
    "Innehalten und neu ansetzen",
    ...clear(),
  ]);
  if (isMobile(info.project.name)) await row.getByRole("button", { name: "Innehalten und neu ansetzen" }).click();
  else {
    await row.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText("Demo: „Innehalten und neu ansetzen“ ginge jetzt an die Session")).toBeVisible();
  await expect(row.getByRole("button", { name: "Innehalten und neu ansetzen" })).toBeDisabled();
});

test("Freigabe direkt aus Fleet: Befehl in der Zeile, alle Antworten in der Schublade, erlauben", async ({ page }) => {
  const ask = alarms(page).getByRole("article", { name: "Freigabe: Bash" });
  await expect(ask.getByText("Freigabe: Bash: pnpm add -D p-limit")).toBeVisible();
  await expect(ask.getByRole("button", { name: "Immer für diese Session" })).toHaveCount(0);
  await ask.getByTitle("Alle Antworten in der Schublade").click();
  const drawer = page.getByRole("complementary", { name: /^Fleet-Frage: / });
  await expect(drawer.getByRole("button", { name: "Immer für diese Session" })).toBeVisible();
  await drawer.getByRole("button", { name: "Schließen" }).click();
  await ask.getByRole("button", { name: "Erlauben" }).click();
  await expect(page.getByText("Demo: „Erlauben“ ginge jetzt an die Session")).toBeVisible();
});

test("Abgelaufene Freigabe verschwindet sofort, die App fragt dann selbst", async ({ page }) => {
  // Reported: "abgelaufen – die App fragt jetzt selbst" stayed on the page
  await withOverview(page, (o) => {
    const at = Date.now() - 60e3;
    o.decisions.push({
      id: "expired-demo",
      sessionId: o.sessions[0]?.id ?? "demo-00",
      kind: "permission",
      title: "Freigabe: Bash",
      text: "rm -rf dist",
      options: [{ id: "allow", label: "Erlauben" }],
      recommended: "allow",
      createdAt: at,
      expiresAt: at + 45e3,
      status: "expired",
      project: "shop-frontend",
      sessionTitle: "",
    } as (typeof o.decisions)[number]);
  });
  await expect(page.getByText("rm -rf dist")).toHaveCount(0);
});

test("Doppelt nur mit Dateischnitt; gleicher Branch ohne gemeinsame Datei steht grau unter Parallel", async ({
  page,
}) => {
  // A duplicate is one line of the watch board (spec rule 9); the group and the merge are in the drawer.
  const dups = group(page, "Doppelt");
  const row = dups.getByRole("row", { name: "design-system" });
  await expect(row).toContainText("2 Sessions · gleiche Dateien: src/tokens/colors.ts");
  await expect(row).toContainText("1 wartet, 1 arbeitet");
  await expect(row.getByRole("img", { name: "doppelt" })).toHaveText("⇄");
  await row.getByRole("button", { name: /^2 Sessions/ }).click();
  const drawer = page.getByRole("complementary", { name: /^Konflikt: / });
  // While one still works, nothing is merged (design-system: one is running)
  await expect(
    drawer.getByRole("heading", { name: "2 offene Sessions im selben Checkout · 1 wartet, 1 arbeitet" }),
  ).toBeVisible();
  await expect(drawer.getByText(/Eine arbeitet noch/)).toBeVisible();
  // The explanation is no running text: an "i" shows it on demand
  await expect(drawer.getByText(/Jede hat ihren eigenen Kontext/)).toBeHidden();
  await drawer.getByRole("button", { name: "Warum doppelt?" }).click();
  await expect(drawer.getByText(/Jede hat ihren eigenen Kontext/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer.getByText(/Jede hat ihren eigenen Kontext/)).toBeHidden();
  // One Escape, one layer: the tip closes, the drawer under it stays.
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Schließen" }).click();
  // Same branch, different files: no duplicate, but still there to merge, grey under "Parallel"
  await expect(dups.locator("tr[aria-label]")).toHaveCount(1);
  const parallel = group(page, "Parallel").getByRole("row", { name: "docs-site" });
  await expect(parallel).toContainText("gleicher Branch: feat/deploy-preview");
  await expect(parallel.getByRole("img", { name: "parallel" })).toBeVisible();
  // Enter on the row opens the same drawer (spec rule 10), as on a session row.
  await parallel.focus();
  await page.keyboard.press("Enter");
  // Both are done: the words of Now, not "alle warten" (internal `waiting` means done)
  await expect(drawer.getByRole("heading", { name: "parallel, ohne Überschneidung · alle fertig" })).toBeVisible();
  await expect(
    drawer.getByRole("region", { name: "Sessions der Gruppe" }).getByText("Suchindex neu aufbauen"),
  ).toBeVisible();
  await expect(drawer.getByText("Parallel, ohne Überschneidung: keine Datei von beiden geändert.")).toBeVisible();
  await drawer.getByRole("group", { name: "Zusammenfassen in" }).getByRole("button", { name: "Desktop-App" }).click();
  await expect(page.getByText("Demo: würde zusammenfassen und in Desktop-App öffnen")).toBeVisible();
});

test("Suche filtert Sessions, Esc leert sie", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "keyboard shortcut");
  await page.keyboard.press("/");
  await page.keyboard.type("billing");
  await expect(page.getByRole("button", { name: "Rechnungen als PDF/A-3 exportieren" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Checkout auf die neuen Komponenten umstellen" }).first(),
  ).toBeVisible();
});
