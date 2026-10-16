import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Starts the real, built server (dist/fleet.cjs) in an isolated environment: its own Claude and Fleet folders,
 * a free port, no desktop app data, no tokens. Tests talk to it over raw HTTP so they can set any header.
 */

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = a && typeof a === "object" ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw HTTP request with any headers (fetch would set Host and Origin itself). */
export function request(
  port: number,
  p: string,
  o: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: o.method || "GET",
        headers: { Host: `localhost:${port}`, ...(o.headers || {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    if (o.body) req.write(o.body);
    req.end();
  });
}

export async function startServer(
  opts: { args?: string[]; claudeHome?: string; fleetHome?: string; env?: Record<string, string> } = {},
) {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-srv-"));
  const claudeHome = opts.claudeHome || path.join(tmp, "claude");
  const fleetHome = opts.fleetHome || path.join(tmp, "fleet");
  fs.mkdirSync(path.join(claudeHome, "projects"), { recursive: true });
  fs.mkdirSync(fleetHome, { recursive: true });
  // The agent view would call the real `claude`: never in tests.
  if (!fs.existsSync(path.join(fleetHome, "config.json")))
    fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false }));
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "dist", "fleet.cjs"), "serve", "--no-repair", "--port", String(port), ...(opts.args || [])],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        FLEET_LANG: "de",
        CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_FLEET_HOME: fleetHome,
        CLAUDE_DESKTOP_SESSIONS_DIR: "",
        CLAUDE_DESKTOP_CONFIG: "",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        // No real claude in tests: without a test double the terminal is off.
        CLAUDE_FLEET_PTY: "off",
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (d) => {
    log += d;
  });
  child.stderr.on("data", (d) => {
    log += d;
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    const r = await request(port, "/api/health").catch(() => null);
    if (r && r.status === 200) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Server does not start:\n${log}`);
    await new Promise((res) => setTimeout(res, 100));
  }
  // The real server wants the token cookie on every API request (server/http/token.ts): tests act as a paired browser.
  const token = (() => {
    try {
      return fs.readFileSync(path.join(fleetHome, "token"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const cookie: Record<string, string> = token ? { Cookie: `fleet_t=${token}` } : {};
  const stop = () =>
    new Promise<void>((res) => {
      child.once("exit", () => res());
      child.kill();
    });
  return {
    port,
    claudeHome,
    fleetHome,
    stop,
    token,
    /** As a paired browser; pass `Cookie` in the headers to override (`Cookie: ""` = unpaired). */
    request: (p: string, o: Parameters<typeof request>[2] = {}) =>
      request(port, p, { ...o, headers: { ...cookie, ...(o.headers || {}) } }),
  };
}
