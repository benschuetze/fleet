import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config";
import { flushUse } from "../core/featureuse";
import { storeSystemLanguage, tr } from "../core/lang";
import { APP_DIR } from "../core/paths";
import { ensureHooks, isLiveFleet, writeRuntime } from "../core/selfheal";
import { augmentPath } from "../core/toolpath";
import { createFleetServer, openBrowser } from "../http/server";
import { loadToken, pairUrl } from "../http/token";
import { version } from "./version";

/** `fleet serve [--demo] [--port N] [--open] [--no-repair]`: runs the dashboard in the foreground. */
export function serve(args: string[]): void {
  const demo = args.includes("--demo");
  if (demo) {
    // The demo writes pins and notes to a throwaway folder, never to ~/.claude-fleet.
    process.env.CLAUDE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fleet-demo-"));
  }
  // Background services get a minimal PATH; gh and claude often live in ~/.local/bin or Homebrew.
  augmentPath();
  if (!demo) storeSystemLanguage();
  const VERSION = version();
  const cfg = loadConfig();
  const i = args.indexOf("--port");
  const fixedPort = i >= 0 ? Number(args[i + 1]) : null;
  if (fixedPort !== null && (!Number.isInteger(fixedPort) || fixedPort < 1 || fixedPort > 65535)) {
    console.error(tr("--port braucht eine Zahl zwischen 1 und 65535", "--port needs a number between 1 and 65535"));
    process.exit(2);
  }
  const firstPort = fixedPort || cfg.port;
  const shownHost = cfg.host === "::1" ? "[::1]" : cfg.host;
  const urlFor = (p: number) => `http://${shownHost === "127.0.0.1" ? "localhost" : shownHost}:${p}`;
  let port = firstPort;

  const fleet = createFleetServer({ demo, version: VERSION, onUrl: () => urlFor(port) });
  const { server } = fleet;

  // Is Claude Fleet already running on the port? Then only open the browser instead of failing.
  const probe = (p: number) =>
    new Promise<boolean>((resolve) => {
      const r = http.get(
        {
          host: cfg.host === "::1" ? "::1" : "127.0.0.1",
          port: p,
          path: "/api/health",
          headers: { Host: `localhost:${p}` },
          timeout: 1500,
        },
        (res) => {
          let d = "";
          res.on("data", (c) => {
            d += c;
          });
          res.on("end", () => {
            try {
              resolve(isLiveFleet(JSON.parse(d)));
            } catch {
              resolve(false);
            }
          });
        },
      );
      r.on("error", () => resolve(false));
      r.on("timeout", () => {
        r.destroy();
        resolve(false);
      });
    });

  const listen = () => {
    fleet.guard.allowPort(port);
    // Every API request of the real Fleet needs the token cookie (token.ts, audit H1); the demo has no real effects.
    if (!demo) fleet.guard.requireToken(loadToken());
    server.listen(port, cfg.host);
  };
  server.on("listening", () => {
    // Does Fleet still fit the Claude Code versions in use? A child process (it reads every recent transcript), a
    // minute after start and every six hours; the message row warns from its file (core/compat.ts).
    if (!demo && !args.includes("--no-repair")) {
      const check = () => {
        const c = spawn(process.execPath, [path.join(APP_DIR, "dist", "fleet.cjs"), "compat", "--save", "--quiet"], {
          stdio: "ignore",
          windowsHide: true,
        });
        c.on("error", () => {});
      };
      setTimeout(check, 60e3).unref();
      setInterval(check, 6 * 3600e3).unref();
    }
    const url = urlFor(port);
    const term = fleet.terminal.state();
    if (!demo)
      writeRuntime({
        port,
        url,
        pid: process.pid,
        version: VERSION,
        startedAt: Date.now(),
        dir: APP_DIR,
        terminal: term.available,
      });
    console.log(
      `Claude Fleet ${VERSION}${demo ? tr(" (Demo, erfundene Daten)", " (demo, invented data)") : ""} ${tr("läuft auf", "runs on")} ${url}${port !== firstPort ? ` (${tr("Port", "port")} ${firstPort} ${tr("war belegt", "was taken")})` : ""}`,
    );
    console.log(
      `Config: ${cfg._path}${fs.existsSync(cfg._path) ? "" : tr(" (nicht vorhanden – Standardwerte)", " (missing, using defaults)")}`,
    );
    if (!demo) console.log(`Transcripts: ${path.join(cfg.claudeHome, "projects")}`);
    console.log(
      `${tr("Terminal im Fenster", "Terminal in the window")}: ${term.available ? tr("verfügbar", "available") : `${tr("nicht verfügbar", "not available")} (${term.why})`}`,
    );
    fleet.watch();
    if (args.includes("--open")) openBrowser(pairUrl(url));
  });
  server.on("error", async (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE" && e.code !== "EACCES") {
      console.error(e);
      process.exit(1);
    }
    // The demo always moves to the next port; the real Fleet never starts twice.
    if (!demo && (await probe(port))) {
      console.log(`${tr("Claude Fleet läuft bereits auf", "Claude Fleet is already running on")} ${urlFor(port)}`);
      if (args.includes("--open")) openBrowser(pairUrl(urlFor(port)));
      process.exit(0);
    }
    if (!fixedPort && port < firstPort + 20) {
      port++;
      setTimeout(listen, 50);
      return;
    }
    console.error(
      tr(`Kein freier Port gefunden (${firstPort}…${port}).`, `No free port found (${firstPort}…${port}).`),
    );
    process.exit(3);
  });

  // Self-healing of the hooks (folder moved, Node updated, hooks deleted, new version …).
  if (!demo && !args.includes("--no-repair")) {
    const msg = ensureHooks();
    if (msg) console.log(msg);
  }
  listen();

  const shutdown = () => {
    flushUse();
    fleet.close();
    setTimeout(() => process.exit(0), 1500).unref();
    server.on("close", () => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => console.error("[fleet]", e));
}
