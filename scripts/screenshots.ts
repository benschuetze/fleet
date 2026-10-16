/**
 * Screenshots for the READMEs from demo mode (made-up data), German into docs/, English into docs/en/.
 * Starts the bundled server itself on a free port. Needs `pnpm build` first.
 *   pnpm screenshots
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { freePort, ROOT, request } from "../tests/helpers/server";

const TEXT = {
  de: {
    out: "docs",
    sessions: "Sessions",
    alarms: "Alarmzone",
    terminalRow: "Rundung im Warenkorb korrigieren",
    terminal: /^Terminal: /,
    help: "Tastenhilfe",
    duplicates: "Doppelt",
    conflictButton: "Konflikt",
    conflict: /^Konflikt: /,
    both: /: beide$/,
    usage: /Verbrauch/,
    balance: "Fleet-Bilanz, 7 Tage",
    repos: /Repos & PRs/,
    activity: /Aktivität/,
    timeline: "Zeitleiste je Repo",
    changes: /^Änderungen: /,
    files: {
      now: "jetzt",
      terminal: "terminal",
      keys: "tasten",
      conflict: "konflikt",
      usage: "verbrauch",
      repos: "repos",
      activity: "aktivitaet",
      diff: "diff",
    },
  },
  en: {
    out: "docs/en",
    sessions: "Sessions",
    alarms: "Alarm zone",
    terminalRow: "Fix rounding in the cart",
    terminal: /^Terminal: /,
    help: "Key help",
    duplicates: "Duplicates",
    conflictButton: "Conflict",
    conflict: /^Conflict: /,
    both: /: both$/,
    usage: /Usage/,
    balance: "Fleet balance, 7 days",
    repos: /Repos & PRs/,
    activity: /Activity/,
    timeline: "Timeline per repo",
    changes: /^Changes: /,
    files: {
      now: "now",
      terminal: "terminal",
      keys: "keys",
      conflict: "conflict",
      usage: "usage",
      repos: "repos",
      activity: "activity",
      diff: "diff",
    },
  },
} as const;

const settle = (page: Page) => page.waitForTimeout(400); // fonts and the SSE update after a click; nothing to wait on

async function shoot(page: Page, port: number, lang: keyof typeof TEXT, theme: "dark" | "light") {
  const x = TEXT[lang];
  const out = path.join(ROOT, x.out);
  const file = (name: string) => path.join(out, `${name}.png`);
  fs.mkdirSync(out, { recursive: true });
  await page.goto(`http://127.0.0.1:${port}/`);
  // Hide the demo notice: the pictures are about the dashboard
  await page.addStyleTag({ content: ".msgrow{display:none!important}" });
  await page.getByRole("region", { name: x.sessions }).waitFor();
  // One screen (stage 12): the window is the picture, the tiles scroll inside it.
  await settle(page);
  await page.screenshot({ path: file(`${x.files.now}-${theme}`) });
  if (theme === "light") return;

  // Claude in Fleet's own window: the waiting session's one action opens the terminal drawer
  await page
    .getByRole("region", { name: x.alarms })
    .getByRole("article", { name: x.terminalRow })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  const term = page.getByRole("complementary", { name: x.terminal });
  await term.getByText("Do you want to proceed?").first().waitFor();
  await settle(page);
  await page.screenshot({ path: file(x.files.terminal) });
  await term.getByRole("button", { name: /^(Schließen|Close)$/ }).click();
  await term.waitFor({ state: "detached" });

  // What a session changed (release 6): the diff view, full screen, from the first session row with g d (Vim)
  await page.getByRole("region", { name: x.sessions }).locator("[data-nr]").first().focus();
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await page.getByRole("region", { name: x.changes }).getByRole("article").first().waitFor();
  await page.keyboard.press("n");
  await settle(page);
  await page.screenshot({ path: file(x.files.diff) });
  await page.keyboard.press("Escape");

  // The key help for where the selection is
  await page.getByRole("region", { name: x.sessions }).locator("[data-nr]").first().focus();
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: x.help }).waitFor();
  await settle(page);
  await page.screenshot({ path: file(x.files.keys) });
  await page.keyboard.press("Escape");

  // What two sessions both change, with the hunks of the shared file (a duplicate is a row of the board)
  await page
    .getByRole("region", { name: x.sessions, exact: true })
    .getByRole("rowgroup", { name: x.duplicates, exact: true })
    .getByRole("button", { name: x.conflictButton, exact: true })
    .first()
    .click();
  const conflict = page.getByRole("complementary", { name: x.conflict });
  await conflict.getByRole("button", { name: x.both }).first().click();
  await settle(page);
  await page.screenshot({ path: file(x.files.conflict) });
  await page.keyboard.press("Escape");

  await page.getByRole("navigation").getByRole("link", { name: x.usage }).click();
  await page.getByRole("region", { name: x.balance }).waitFor();
  await settle(page);
  await page.screenshot({ path: file(x.files.usage) });

  await page.getByRole("navigation").getByRole("link", { name: x.repos }).click();
  await page.getByRole("table").first().waitFor();
  await settle(page);
  await page.screenshot({ path: file(x.files.repos) });

  await page.getByRole("navigation").getByRole("link", { name: x.activity }).click();
  await page.getByRole("region", { name: x.timeline }).waitFor();
  await settle(page);
  await page.screenshot({ path: file(x.files.activity) });
}

// One server per language: the demo data is written in the server's language.
const browser = await chromium.launch();
try {
  for (const lang of ["de", "en"] as const) {
    const port = await freePort();
    const server = spawn(
      process.execPath,
      [path.join(ROOT, "dist", "fleet.cjs"), "serve", "--demo", "--port", String(port)],
      { stdio: "ignore", env: { ...process.env, FLEET_LANG: lang } },
    );
    try {
      for (let i = 0; i < 50; i++) {
        if ((await request(port, "/api/health").catch(() => null))?.status === 200) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      for (const theme of ["dark", "light"] as const) {
        const page = await browser.newPage({
          // The spec's acceptance size (rule 13); wide enough for the event stream beside the watch board
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 2,
          colorScheme: theme,
          locale: lang === "de" ? "de-DE" : "en-GB",
          timezoneId: "Europe/Berlin",
        });
        // Headless Chromium reports light: the theme is chosen explicitly
        await page.addInitScript((th) => {
          localStorage.setItem("fleet.theme", JSON.stringify(th));
          // The one-time note on Esc in the terminal is no part of the pictures.
          localStorage.setItem("fleet.termEscNote", "1");
        }, theme);
        await shoot(page, port, lang, theme);
        await page.close();
      }
    } finally {
      server.kill();
    }
  }
  console.log("Screenshots in docs/ and docs/en/");
} finally {
  await browser.close();
}
