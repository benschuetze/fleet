/**
 * Runtime smoke test for the built release: Node built-ins only, no node_modules. CI runs it on every OS and on
 * Node 18, 22 and 24 without `pnpm install`, which proves the promise "no runtime dependencies".
 *   node scripts/smoke.mjs        (after pnpm build)
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (f) => path.join(root, "dist", f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-smoke-"));
const env = {
  ...process.env,
  CLAUDE_FLEET_HOME: path.join(tmp, "fleet"),
  CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
  FLEET_LANG: "en",
};

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });

const run = (file, input) =>
  execFileSync(process.execPath, [dist(file)], { input, env, encoding: "utf8", timeout: 10_000 });

let server;
try {
  assert.match(
    execFileSync(process.execPath, [dist("fleet.cjs"), "version"], { env, encoding: "utf8" }),
    /\d+\.\d+\.\d+/,
  );

  server = spawn(process.execPath, [dist("fleet.cjs"), "serve", "--demo", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  let health;
  for (let i = 0; i < 100 && health?.status !== 200; i++) {
    health = await get("/api/health").catch(() => null);
    if (health?.status !== 200) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(health?.status, 200, "server answers");
  const h = JSON.parse(health.body);
  assert.equal(typeof h.terminal?.available, "boolean", "health says whether the terminal works");
  assert.equal(typeof h.processes?.interactive, "number");
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"] ?? "", /script-src[^;]*sha256-/, "CSP with hashes");
  const overview = JSON.parse((await get("/api/overview")).body);
  assert.ok(overview.demo && overview.sessions.length > 0, "demo overview has sessions");

  // Hook and status line: never throw, always exit 0, even on garbage.
  run(
    "hook.cjs",
    JSON.stringify({ hook_event_name: "SessionStart", session_id: "smoke", cwd: tmp, source: "startup" }),
  );
  run(
    "hook.cjs",
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: "smoke", cwd: tmp, tool_name: "Read", tool_input: {} }),
  );
  run("hook.cjs", "not json");
  run("statusline.cjs", JSON.stringify({ session_id: "smoke", model: { display_name: "Opus" } }));
  console.log(`smoke ok: Node ${process.version}, ${process.platform}`);
} finally {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
