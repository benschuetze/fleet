import { expect, isMobile, test, withOverview } from "./fixtures";

// Live on 16.10.2026: every row said "VS Code" (one click on it in a drawer had made it the target for all), and
// Enter or i on "Approval: Edit" of a session waiting in the desktop app stopped at a warning. Terminal first: Enter
// and i open Fleet's terminal; a session still running elsewhere goes on there as a branch of its own.

const FORK = "0f1e2d3c-4b5a-4968-8776-655443322110";

test.beforeEach(async ({ page }, info) => {
  test.skip(isMobile(info.project.name), "keyboard flows are for the desktop");
  // A browser where VS Code was picked once in a drawer
  await page.addInitScript(() => localStorage.setItem("fleet.openTarget", JSON.stringify("vscode")));
});

async function setup(page: import("@playwright/test").Page) {
  const resumed: { id: string; force?: boolean }[] = [];
  await page.route("**/api/term/resume", async (route) => {
    resumed.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, id: FORK, target: "fleet", forked: true } });
  });
  let title = "";
  await withOverview(page, (o) => {
    // A question, not an approval: an approval held in the app never forks (live 16.10.2026, approval.spec cases).
    const s = o.sessions.find((x) => x.status === "needs_input" && x.waits !== "approval");
    if (!s) throw new Error("no waiting session in the demo");
    // Waits in the desktop app, not in Fleet's window
    s.desktop = { id: "local_5b1567a7-e1f1-4ce6-a4c4-dda6f917f08b", title: s.title || null, current: true };
    s.proc = undefined;
    title = String(s.title);
  });
  const row = page.getByRole("region", { name: "Alarmzone" }).getByRole("article", { name: title, exact: true });
  return { resumed, row };
}

test("Enter auf einer Session, die in der Desktop-App wartet, öffnet sie im Fleet-Terminal – als eigener Zweig", async ({
  page,
}) => {
  const { resumed, row } = await setup(page);
  await expect(row.getByRole("button", { name: "Terminal", exact: true })).toBeVisible();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => resumed.length).toBe(1);
  expect(resumed[0]?.force).toBeFalsy();
  await expect(page.getByRole("contentinfo").getByRole("status")).toHaveText(/eigener Zweig/);
});

test("Ein einmal gewähltes VS Code benennt keine Zeile um; die Desktop-Session bietet zuerst das Fleet-Terminal an", async ({
  page,
}) => {
  const { row } = await setup(page);
  const alarm = page.getByRole("region", { name: "Alarmzone" });
  await expect(alarm.getByRole("button", { name: "VS Code", exact: true })).toHaveCount(0);
  await row.focus();
  await page.keyboard.press("Shift+Enter"); // o in Vim
  const open = page.getByRole("group", { name: "Session öffnen in" });
  await expect(open.getByRole("button").first()).toHaveText(/Fleet/);
  await expect(open.getByRole("button", { name: "VS Code" })).toHaveCount(0);
});
