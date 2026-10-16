// The guarantee "a session that waits for you shows as wartet", on screen: a session of every kind of wait
// (tests/waiting-cases.test.ts derives them) stands in the Alarmzone with its question. Invented sessions.
import type { Page } from "@playwright/test";
import type { Ask } from "../../shared/types";
import { expect, isMobile, test, withOverview } from "./fixtures";

const alarms = (page: Page) => page.getByRole("region", { name: "Alarmzone" });

// What deriveStatus puts into `detail` and `ask` for each kind (tests/waiting-cases.test.ts); a permission has no
// ask, its detail names the tool.
const KINDS: { kind: string; title: string; text: string; ask: Ask["kind"] | null }[] = [
  { kind: "question", title: "Migration planen", text: "Welche Datenbank soll es werden?", ask: "question" },
  { kind: "plan", title: "Schema umbauen", text: "Plan freigeben?", ask: "question" },
  { kind: "directory", title: "Shop weiterbauen", text: "Ordner wählen: Der Shop liegt woanders.", ask: "question" },
  { kind: "access", title: "Notizen öffnen", text: "Zugriff freigeben (request access): Notizen", ask: "question" },
  { kind: "permission", title: "Logs aufräumen", text: "Freigabe für Bash", ask: null },
  {
    kind: "brake ran out",
    title: "Alte Logs löschen",
    text: "wartet in der App auf Freigabe für Bash",
    ask: null,
  },
  { kind: "box", title: "CSV-Export bauen", text: "PR #7 mergen, sobald die CI grün ist?", ask: "question" },
  { kind: "offer", title: "Bremse prüfen", text: "Neue Session oder hier? Bremse kürzen", ask: "question" },
  {
    kind: "text",
    title: "Export aufräumen",
    text: "Soll ich die alte Exportfunktion gleich mit entfernen?",
    ask: "question",
  },
];

test("Every kind of wait stands in the Alarmzone with its question", async ({ page }) => {
  await withOverview(page, (o) => {
    const base = o.sessions.find((s) => s.status === "working");
    if (!base) throw new Error("demo without a working session");
    const now = Date.now();
    // Only these sessions: the zone holds exactly one row per kind.
    o.decisions = [];
    o.sessions = o.sessions.filter((s) => s.status === "working" && !s.ci?.pr);
    for (const s of o.sessions) s.ci = null;
    o.repos = o.repos.map((r) => ({ ...r, ci: null }));
    if (o.usage) o.usage.limitHit = null;
    KINDS.forEach((k, i) => {
      o.sessions.push({
        ...base,
        id: `wait-${i}`,
        title: k.title,
        status: "needs_input",
        statusSource: "hook",
        ask: k.ask ? { kind: k.ask, text: k.text } : null,
        detail: k.text,
        failure: null,
        statusSince: now - (i + 1) * 60e3,
        lastActivity: now - (i + 1) * 60e3,
      });
    });
  });
  const zone = alarms(page);
  await expect(zone.getByRole("article")).toHaveCount(KINDS.length);
  for (const k of KINDS) {
    const row = zone.getByRole("article", { name: k.title, exact: true });
    await expect(row, k.kind).toContainText(k.text);
    // Without an open tool approval (`waits`) every kind waits for an answer in words: "Frage".
    await expect(row.getByText("Frage", { exact: true }), k.kind).toHaveCount(1);
  }
});

test("Die Auswahl bleibt auf ihrer Zeile, wenn die Alarmzone umsortiert (Runde 4)", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  let swap = false;
  await withOverview(page, (o) => {
    const loop = o.decisions.find((d) => d.id === "demo-entscheidung");
    const ask = o.decisions.find((d) => d.id === "demo-freigabe");
    // Before: the approval runs out first and stands above; after: it was asked again and moves below.
    if (loop && ask) ask.expiresAt = swap ? loop.expiresAt + 5000 : Math.min(ask.expiresAt, loop.expiresAt - 5000);
  });
  const row = page.locator('[data-row="d:demo-entscheidung"]');
  await row.focus();
  const nr = await row.getAttribute("data-nr");
  swap = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => row.getAttribute("data-nr")).not.toBe(nr);
  await expect(row).toBeFocused();
});

test("x auf einer wartenden Session fragt erst y/n; n lässt sie stehen (Runde 4)", async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  const row = page.getByRole("region", { name: "Alarmzone" }).locator('[data-kind="session"]:has(.g-waiting)').first();
  const key = String(await row.getAttribute("data-row"));
  await row.focus();
  await page.keyboard.press("x");
  const ask = page.getByRole("contentinfo").getByRole("alert");
  await expect(ask).toContainText("y/n");
  await page.keyboard.press("n");
  await expect(page.locator(`[data-row="${key}"]`)).toHaveCount(1);
  await page.locator(`[data-row="${key}"]`).focus();
  await page.keyboard.press("x");
  await expect(ask).toContainText("y/n");
  await page.keyboard.press("y");
  await expect(page.locator(`[data-row="${key}"]`)).toHaveCount(0);
  // The demo server is shared by every test that follows (the phone's too): bring it back
  await page.keyboard.press("u");
  await expect(page.locator(`[data-row="${key}"]`)).toHaveCount(1);
});

test("Eine Freigabe, die während y/n abläuft, sagt „zu spät“ statt still nichts zu tun (Runde 4)", async ({
  page,
}, info) => {
  test.skip(isMobile(info.project.name), "keyboard flow");
  let late = false;
  await withOverview(page, (o) => {
    const ask = o.decisions.find((d) => d.id === "demo-freigabe");
    if (ask && late) ask.expiresAt = Date.now() - 1000;
  });
  await page.locator('[data-row="d:demo-freigabe"]').focus();
  await page.keyboard.press("Enter");
  const status = page.getByRole("contentinfo");
  await expect(status.getByRole("alert")).toContainText("y/n");
  late = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('[data-row="d:demo-freigabe"] [data-act] button')).toHaveCount(0);
  await page.keyboard.press("y");
  await expect(status.getByRole("status")).toContainText(/zu spät|abgelaufen/);
});
