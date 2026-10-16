// Scope freeze after 6.0.0 (docs/SCOPE.md): the source does not grow unnoticed, every API route belongs to a
// feature, and the feature counts work (server/core/featureuse.ts, server/core/scope.ts).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { NOT_COUNTED } from "../server/core/featureuse";
import { byFeature, FEATURES } from "../server/core/scope";
import { ROOT } from "./helpers/server";

function sourceLines(): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|css)$/.test(e.name) && !/\.test\./.test(e.name))
        n += fs.readFileSync(p, "utf8").split("\n").length - 1;
    }
  };
  for (const d of ["app", "server", "hooks", "shared"]) walk(path.join(ROOT, d));
  return n;
}

test("The source stays within the line budget of the frozen scope", () => {
  const budget = JSON.parse(fs.readFileSync(path.join(ROOT, "size-budget.json"), "utf8")).lines;
  const n = sourceLines();
  assert.ok(
    n <= budget,
    `${n} lines > budget ${budget}. Scope is frozen (docs/SCOPE.md): cut something, or raise size-budget.json with a reason.`,
  );
});

test("Every API route is a feature of the scope or deliberately not counted", () => {
  const routes = new Set<string>();
  for (const f of fs.readdirSync(path.join(ROOT, "server", "http")))
    for (const m of fs.readFileSync(path.join(ROOT, "server", "http", f), "utf8").matchAll(/"(\/api\/[a-z0-9/-]+)"/g))
      if (m[1]) routes.add(m[1]);
  const missing = [...routes].filter(
    (r) => !NOT_COUNTED.has(r) && !byFeature({ [`api:${r}`]: 1 }).features.some((f) => f.uses),
  );
  assert.deepStrictEqual(missing, [], "add them to FEATURES in server/core/scope.ts and to docs/SCOPE.md");
  assert.strictEqual(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length, "feature ids are unique");
});

test("Feature use: counts per key and day, only feature keys, written a few seconds later", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-use-"));
  process.env.CLAUDE_FLEET_HOME = home;
  try {
    const { flushUse, noteUse, readUse, usesSince } = await import("../server/core/featureuse");
    const t = new Date(2026, 9, 20, 12).getTime();
    noteUse("api:/api/diff", 1, t);
    noteUse("api:/api/diff", 2, t);
    noteUse("view:/usage", 1, t - 3 * 86400e3);
    noteUse("prompt:Baue den Export", 1, t); // not a feature key: never stored
    noteUse("key:hide", 0, t);
    flushUse();
    const u = readUse();
    assert.deepStrictEqual(u, { "api:/api/diff": { "2026-10-20": 3 }, "view:/usage": { "2026-10-17": 1 } });
    assert.deepStrictEqual(usesSince(u, "2026-10-18"), { "api:/api/diff": 3 });
    const r = byFeature({ ...usesSince(u, "2026-10-01"), "key:somethingNew": 4 });
    assert.strictEqual(r.features.find((f) => f.id === "diff")?.uses, 3);
    assert.strictEqual(r.features.find((f) => f.id === "usage")?.uses, 1);
    assert.strictEqual(r.features.find((f) => f.id === "week")?.uses, 0);
    assert.deepStrictEqual(r.unmapped, { "key:somethingNew": 4 });
    if (process.platform !== "win32")
      assert.strictEqual(fs.statSync(path.join(home, "feature-use.json")).mode & 0o777, 0o600);
  } finally {
    delete process.env.CLAUDE_FLEET_HOME;
  }
});

test("The real server counts features from the page and its own API, the demo nothing", { timeout: 20e3 }, async () => {
  const { startServer } = await import("./helpers/server");
  const srv = await startServer();
  try {
    const post = (body: object) =>
      srv.request("/api/use", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fleet": "1" },
        body: JSON.stringify(body),
      });
    assert.strictEqual((await post({ counts: { "view:/usage": 2, "cmd:merge": 1, "text:geheim": 5 } })).status, 200);
    await srv.request("/api/architecture?root=x");
    await srv.request("/api/overview");
    const f = path.join(srv.fleetHome, "feature-use.json");
    let u: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 80 && !u["api:/api/architecture"]; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        u = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {
        // not written yet
      }
    }
    const total = (k: string) => Object.values(u[k] || {}).reduce((a, b) => a + b, 0);
    assert.deepStrictEqual(
      [total("view:/usage"), total("cmd:merge"), total("api:/api/architecture"), total("api:/api/overview")],
      [2, 1, 1, 0],
      JSON.stringify(u),
    );
    assert.ok(!JSON.stringify(u).includes("geheim"), "no text, only feature keys");
  } finally {
    await srv.stop();
  }
});
