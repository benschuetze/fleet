import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
// One port per checkout: with reuseExistingServer, parallel sessions in several worktrees would otherwise share one
// demo server and test each other's code (and lose it when the other run ends). FLEET_E2E_PORT overrides it.
const PORT =
  Number(process.env.FLEET_E2E_PORT) ||
  4800 + ([...process.cwd()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 200);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // Demo mode: made-up data; it touches neither ~/.claude nor ~/.claude-fleet. Runs the bundled server, the same
  // file users run, so the test also proves the build works without node_modules.
  webServer: {
    command: `node dist/fleet.cjs serve --demo --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { FLEET_LANG: "de" },
    reuseExistingServer: !CI,
    timeout: 15_000,
  },
});
