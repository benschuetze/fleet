// Security audit H1: other local processes (a Claude session taken over by a prompt injection, with curl) must not
// reach the API of the real Fleet. Every /api/ request needs the token cookie a paired browser got (token.ts).
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { startServer } from "./helpers/server";

const JSON_HDR = { "Content-Type": "application/json", "X-Fleet": "1" };
const UNPAIRED = { Cookie: "" };

describe("API token (real server)", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => srv.stop());

  test("the token lives in Fleet's home, readable by the user only", () => {
    const f = path.join(srv.fleetHome, "token");
    assert.match(srv.token, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  });

  test("without the cookie: reads, writes, streams and approvals are refused; health stays open", async () => {
    for (const p of ["/api/overview", "/api/stream", "/api/term/stream?id=x", "/api/log"])
      assert.strictEqual((await srv.request(p, { headers: UNPAIRED })).status, 401, p);
    for (const p of ["/api/decision", "/api/term/input", "/api/presence", "/api/merge-pr", "/api/term/new"])
      assert.strictEqual(
        (await srv.request(p, { method: "POST", headers: { ...JSON_HDR, ...UNPAIRED }, body: "{}" })).status,
        401,
        p,
      );
    const wrong = await srv.request("/api/overview", {
      headers: { Cookie: "fleet_t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual((await srv.request("/api/health", { headers: UNPAIRED })).status, 200, "launchers check it");
    assert.strictEqual((await srv.request("/api/overview")).status, 200, "a paired browser");
  });

  test("pairing: only the right link sets the cookie, HttpOnly and SameSite=Strict", async () => {
    const bad = await srv.request("/pair?t=falsch", { headers: UNPAIRED });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual(bad.headers["set-cookie"], undefined);
    const ok = await srv.request(`/pair?t=${srv.token}`, { headers: UNPAIRED });
    assert.strictEqual(ok.status, 303);
    assert.strictEqual(ok.headers.location, "/");
    const c = String(ok.headers["set-cookie"]);
    assert.ok(c.startsWith(`fleet_t=${srv.token};`));
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
  });

  test("the token survives a restart: a paired browser stays paired", async () => {
    const again = await startServer({ fleetHome: srv.fleetHome });
    try {
      assert.strictEqual(again.token, srv.token);
    } finally {
      await again.stop();
    }
  });
});

describe("API token (demo)", () => {
  test("the demo has no real effects and needs no token", async () => {
    const demo = await startServer({ args: ["--demo"] });
    try {
      assert.strictEqual((await demo.request("/api/overview", { headers: UNPAIRED })).status, 200);
      const pair = await demo.request("/pair?t=x", { headers: UNPAIRED });
      assert.deepStrictEqual([pair.status, pair.headers.location], [303, "/"]);
    } finally {
      await demo.stop();
    }
  });
});
