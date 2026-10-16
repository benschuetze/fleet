import { expect, test } from "./fixtures";

/*
 * The review's frozen Activity tab (title stayed the raw URL, nothing rendered): every open Fleet tab held its own
 * server-sent-events connection, and the browser allows six connections per host. From the sixth tab on, the next
 * page load waited forever. All tabs of a browser now share one stream.
 */
test("Viele offene Fleet-Tabs: ein weiterer Tab lädt Aktivität trotzdem", async ({ page, context }, info) => {
  test.skip(info.project.name === "mobile", "one browser is enough");
  const extra = [];
  for (let i = 0; i < 7; i++) {
    const p = await context.newPage();
    await p.goto("/");
    await expect(p.getByText(/^Demo-Modus/)).toBeVisible();
    extra.push(p);
  }
  const last = await context.newPage();
  await last.goto("/activity", { timeout: 10_000 });
  await expect(last).toHaveTitle(/Claude Fleet/, { timeout: 10_000 });
  await expect(last.getByRole("heading", { name: "Verlauf" })).toBeVisible({ timeout: 10_000 });
  const holders = () =>
    last.evaluate(async () => {
      const q = await navigator.locks.query();
      return [q.held?.filter((l) => l.name === "fleet-stream").length, q.pending?.length];
    });
  expect(await holders()).toEqual([1, 8]);
  for (const p of extra) await p.close();
  await expect.poll(holders).toEqual([1, 1]);
  // The tab holding the stream (the first one) leaves: the remaining one takes it over.
  await page.goto("about:blank");
  await expect.poll(holders).toEqual([1, 0]);
  await page.goto("/");
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
  await last.close();
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length)).toBe(1);
  await expect(page.getByText(/^Demo-Modus/)).toBeVisible();
});
