// Bug B3: the hook held every approval 45 s whenever any Fleet page was connected, even a hidden background tab,
// and the desktop app showed nothing meanwhile. The mark `ui-active` now means "a Fleet tab is visible and
// focused": only the tab's own report sets it, a plain connection does not.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { startServer } from "./helpers/server";

const JSON_HDR = { "Content-Type": "application/json", "X-Fleet": "1" };

describe("Presence: the brake waits only while a Fleet tab is in front", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let mark: string;
  beforeAll(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-presence-"));
    srv = await startServer({ claudeHome: path.join(tmp, "claude"), fleetHome: path.join(tmp, "fleet") });
    mark = path.join(srv.fleetHome, "ui-active");
  });
  afterAll(() => srv.stop());

  const report = (tab: string, active: boolean, headers: Record<string, string> = JSON_HDR) =>
    srv.request("/api/presence", { method: "POST", headers, body: JSON.stringify({ tab, active }) });

  test("An open stream alone (a background tab) sets no mark", async () => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/api/stream",
          headers: { Host: `localhost:${srv.port}`, Cookie: `fleet_t=${srv.token}` },
        },
        resolve,
      );
      req.on("error", reject);
    });
    try {
      assert.strictEqual(res.statusCode, 200, "the stream is open");
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(fs.existsSync(mark), false, "connected is not looking");
    } finally {
      res.destroy();
    }
  });

  test("Only with Fleet's own header and a valid tab id", async () => {
    assert.strictEqual((await report("tab-a1b2c3", true, { "Content-Type": "application/json" })).status, 403);
    assert.strictEqual((await report("../x", true)).status, 400);
    assert.strictEqual(
      (await srv.request("/api/presence", { method: "POST", headers: JSON_HDR, body: '{"tab":"tab-a1b2c3"}' })).status,
      400,
      "active must be a boolean",
    );
    assert.strictEqual(fs.existsSync(mark), false);
  });

  test("A focused tab sets the mark; it goes when the last focused tab leaves", async () => {
    assert.strictEqual((await report("tab-aaaaaa", true)).status, 200);
    assert.ok(fs.existsSync(mark), "visible and focused: approvals may wait in Fleet");
    // Switching between two Fleet tabs: the second reports before the first one's blur arrives.
    await report("tab-bbbbbb", true);
    await report("tab-aaaaaa", false);
    assert.ok(fs.existsSync(mark), "another Fleet tab is still in front");
    await report("tab-bbbbbb", false);
    assert.strictEqual(fs.existsSync(mark), false, "user went to the app: its prompt shows at once");
  });
});

test("Demo mode never sets the mark", async () => {
  const srv = await startServer({ args: ["--demo"] });
  try {
    const r = await srv.request("/api/presence", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ tab: "tab-demo01", active: true }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(fs.existsSync(path.join(srv.fleetHome, "ui-active")), false);
  } finally {
    await srv.stop();
  }
});
