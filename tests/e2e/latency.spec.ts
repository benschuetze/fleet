import fs from "node:fs";
import { test as base, expect } from "@playwright/test";
import { type FleetFixture, makeFleetFixture } from "../helpers/fleet-fixture";
import { startServer } from "../helpers/server";

/**
 * A session that starts waiting shows in the Alarmzone within 1.5 s, on a busy machine: the real server (not the
 * demo) on the invented load fixture (~150 sessions, long transcripts, repos with worktrees), the hook state
 * written like the hook does, the page told by the server's push.
 */

const test = base.extend<object, { load: { fx: FleetFixture; url: string } }>({
  load: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture signature
    async ({}, use) => {
      const fx = makeFleetFixture();
      const srv = await startServer({ claudeHome: fx.claudeHome, fleetHome: fx.fleetHome });
      // The first build reads every transcript once; that is the start, not a status change.
      await srv.request("/api/overview");
      // The real server wants a paired browser (server/http/token.ts): open it through the pairing link.
      const base = `http://127.0.0.1:${srv.port}`;
      await use({ fx, url: srv.token ? `${base}/pair?t=${srv.token}` : `${base}/` });
      await srv.stop();
      fs.rmSync(fx.root, { recursive: true, force: true });
    },
    { scope: "worker", timeout: 120_000 },
  ],
});

// One load server is enough: the push path is the same on the phone.
test.skip(({ isMobile }) => isMobile, "desktop only");

test("A new waiting request shows in the Alarmzone within 1.5 s with ~150 sessions", async ({ page, load }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(load.url);
  const alarm = page.getByRole("region", { name: "Alarmzone" });
  await expect(page.getByRole("region", { name: "Sessions" })).toBeVisible();
  const n = load.fx.ids.length - 1;
  const row = alarm.getByRole("article", { name: new RegExp(`Aufgabe ${n}:`) });
  await expect(row).toHaveCount(0);

  const t0 = Date.now();
  load.fx.writeHook(load.fx.ids[n] as string, "needs_input", "Freigabe für Bash");
  await expect(row).toBeVisible({ timeout: 1500 });
  expect(Date.now() - t0, "milliseconds until the Alarmzone shows it").toBeLessThan(1500);
  expect(errors, "Skriptfehler auf der Seite").toEqual([]);
});
