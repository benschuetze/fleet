import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tr } from "../core/lang";
import { APP_DIR, fleetHome } from "../core/paths";
import { isLiveFleet, readRuntime } from "../core/selfheal";
import { openBrowser } from "../http/server";
import { pairUrl } from "../http/token";
import { version } from "./version";

/**
 * Carefree start, no open terminal needed:
 *   fleet start            running already? open the browser. Otherwise start in the background and open.
 *   fleet start --no-open  only make sure Fleet runs (autostart)
 *   fleet status | stop | restart
 *   fleet supervise        (internal) watches the server and restarts it after crashes and updates
 * Log: ~/.claude-fleet/fleet.log
 */

const CLI = path.join(APP_DIR, "dist", "fleet.cjs");
const home = () => {
  const h = fleetHome();
  fs.mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
};
const LOG = () => path.join(home(), "fleet.log");
const SUP_PID = () => path.join(home(), "supervisor.pid");
const STOP = () => path.join(home(), "stop.request");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const readPid = () => {
  try {
    return Number(fs.readFileSync(SUP_PID(), "utf8")) || 0;
  } catch {
    return 0;
  }
};

function log(line: string) {
  try {
    try {
      if (fs.statSync(LOG()).size > 1024 * 1024) fs.renameSync(LOG(), `${LOG()}.old`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(LOG(), `[${new Date().toISOString()}] ${line}\n`, { mode: 0o600 });
  } catch {
    // logging is best effort
  }
}

interface Health {
  app: string;
  version: string;
  pid: number;
  processes?: { interactive?: number };
}
/** Claude sessions running in Fleet's window; they end with the server. */
const running = (h: Health | null) => Number(h?.processes?.interactive) || 0;
const UPDATE_PENDING = () => path.join(home(), "update-pending.json");

function health(port: number | undefined): Promise<Health | null> {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const r = http.get(
      { host: "127.0.0.1", port, path: "/api/health", headers: { Host: `localhost:${port}` }, timeout: 1500 },
      (res) => {
        let d = "";
        res.on("data", (c) => {
          d += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            resolve(isLiveFleet(j) ? j : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    r.on("error", () => resolve(null));
    r.on("timeout", () => {
      r.destroy();
      resolve(null);
    });
  });
}

/** Finds a running instance: the last used port first, then the default range. */
async function findRunning() {
  const rt = readRuntime();
  const ports = [rt.port, 4777, ...Array.from({ length: 20 }, (_, i) => 4778 + i)].filter(
    (p, i, a): p is number => !!p && a.indexOf(p) === i,
  );
  for (const p of ports) {
    const h = await health(p);
    if (h) return { port: p, url: `http://localhost:${p}`, ...h };
  }
  return null;
}

/* ---------- Supervisor: keeps the server alive ---------- */
async function supervise(args: string[]) {
  const other = readPid();
  if (other && other !== process.pid && alive(other)) {
    log(`Supervisor already running (PID ${other}).`);
    return;
  }
  fs.writeFileSync(SUP_PID(), String(process.pid), { mode: 0o600 });
  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(SUP_PID());
    } catch {
      // already gone
    }
  };
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarting = false; // a restart the supervisor triggers itself
  const stop = () => {
    stopping = true;
    child?.kill();
    cleanup();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", cleanup);
  // Stop signal by file (Windows has no SIGTERM between processes without a console).
  setInterval(() => {
    if (fs.existsSync(STOP())) {
      try {
        fs.unlinkSync(STOP());
      } catch {
        // gone already
      }
      log("Stop requested.");
      stop();
    }
  }, 1000);

  log(`Supervisor started (PID ${process.pid}, Node ${process.version}).`);
  // Updates without manual work: when the build changes, the server restarts. package.json counts too,
  // otherwise the server would report the old version after a pure version bump.
  const codeStamp = () => {
    try {
      const dist = path.join(APP_DIR, "dist");
      return [path.join(APP_DIR, "package.json"), ...fs.readdirSync(dist).map((f) => path.join(dist, f))]
        .map((f) => fs.statSync(f).mtimeMs)
        .join(",");
    } catch {
      return "";
    }
  };
  let stamp = codeStamp();
  let waiting = 0;
  setInterval(async () => {
    const now = codeStamp();
    if (!now || (now === stamp && !waiting)) return;
    stamp = now;
    // A restart ends every Claude session in Fleet's window: the update waits until none runs.
    const n = running(await health(readRuntime().port));
    if (n) {
      if (n !== waiting) log(`New version detected, waiting for ${n} running session(s) in Fleet's window.`);
      waiting = n;
      try {
        fs.writeFileSync(UPDATE_PENDING(), JSON.stringify({ sessions: n, at: Date.now() }));
      } catch {
        // the banner is a courtesy
      }
      return;
    }
    waiting = 0;
    fs.rmSync(UPDATE_PENDING(), { force: true });
    log("New version detected, restarting the server.");
    if (child) {
      restarting = true;
      child.kill();
    }
  }, 5000);
  const crashes: number[] = [];
  while (!stopping) {
    const out = fs.openSync(LOG(), "a", 0o600);
    const started = Date.now();
    const proc = spawn(process.execPath, [CLI, "serve", ...args.filter((a) => a !== "--open")], {
      cwd: APP_DIR,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child = proc;
    const code = await new Promise<number | null>((r) => {
      proc.on("exit", (c) => r(c));
      proc.on("error", (e) => {
        log(`Start failed: ${e.message}`);
        r(1);
      });
    });
    fs.closeSync(out);
    child = null;
    if (stopping) break;
    if (restarting) {
      restarting = false;
      log("Restarted after update.");
      await sleep(300);
      continue;
    }
    // 0 = another Fleet instance runs already: nothing to do.
    if (code === 0 && (await findRunning())) {
      log("Another instance is active, supervisor exits.");
      break;
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - (crashes[0] ?? now) > 10 * 60e3) crashes.shift();
    const wait = Date.now() - started > 60e3 ? 1000 : Math.min(60e3, 1000 * 2 ** Math.min(crashes.length, 6));
    log(`Server exited (code ${code}), restarting in ${Math.round(wait / 1000)} s.`);
    await sleep(wait);
  }
  cleanup();
  process.exit(0);
}

/* ---------- Starter ---------- */
async function ensureRunning() {
  const running = await findRunning();
  if (running) return running;
  if (!alive(readPid()))
    spawn(process.execPath, [CLI, "supervise"], {
      cwd: APP_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await findRunning();
    if (r) return r;
  }
  return null;
}

async function stopAll() {
  const pid = readPid();
  if (alive(pid)) fs.writeFileSync(STOP(), "1");
  for (let i = 0; i < 16; i++) {
    if (!alive(pid) && !(await findRunning())) return true;
    await sleep(250);
  }
  if (alive(pid)) {
    try {
      process.kill(pid);
    } catch {
      // gone in between
    }
  }
  const r = await findRunning();
  if (r?.pid) {
    try {
      process.kill(r.pid);
    } catch {
      // gone in between
    }
  }
  try {
    fs.unlinkSync(STOP());
  } catch {
    // no request left
  }
  await sleep(500);
  return !(await findRunning());
}

const tail = (file: string, n = 15) => {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n");
  } catch {
    return tr("(kein Log)", "(no log)");
  }
};

/** An old server answering a newer CLI (practical test 15 Oct): say so, with the way out; "" when they agree. */
export function versionNote(running: string, cli: string): string {
  return running === cli
    ? ""
    : tr(
        `⚠ Diese CLI ist ${cli}, es läuft aber ${running}. \`fleet restart\` startet die neue Version.`,
        `⚠ This CLI is ${cli} but ${running} is running. \`fleet restart\` starts the new version.`,
      );
}

export async function launcher(cmd: string, args: string[]): Promise<number> {
  if (cmd === "supervise") {
    await supervise(args);
    return 0;
  }
  if (cmd === "status") {
    const r = await findRunning();
    console.log(
      r
        ? `✔ Claude Fleet ${r.version} ${tr("läuft auf", "runs on")} ${r.url}`
        : tr("✖ Claude Fleet läuft nicht.", "✖ Claude Fleet is not running."),
    );
    const note = r ? versionNote(r.version, version()) : "";
    if (note) console.log(note);
    return r ? 0 : 1;
  }
  if (cmd === "stop" || cmd === "restart") {
    const n = running(await findRunning());
    if (n && !args.includes("--force")) {
      console.error(
        tr(
          `✖ In Fleets Fenster laufen ${n} Claude-Session(s); sie würden enden. Mit --force trotzdem ${cmd === "stop" ? "stoppen" : "neu starten"}.`,
          `✖ ${n} Claude session(s) run in Fleet's window and would end. Use --force to ${cmd} anyway.`,
        ),
      );
      return 1;
    }
    const ok = await stopAll();
    console.log(
      ok
        ? tr("✔ Claude Fleet gestoppt.", "✔ Claude Fleet stopped.")
        : tr("⚠ Claude Fleet ließ sich nicht vollständig stoppen.", "⚠ Claude Fleet could not be stopped completely."),
    );
    if (cmd === "stop") return ok ? 0 : 1;
  }
  // An old version or another folder is active (update, moved): restart cleanly.
  const cur = await findRunning();
  const rt = readRuntime();
  if (
    cur &&
    !running(cur) &&
    (cur.version !== version() || (rt.dir && path.resolve(rt.dir) !== path.resolve(APP_DIR)))
  ) {
    log(`Replacing the outdated instance (${cur.version}).`);
    await stopAll();
  }
  const r = await ensureRunning();
  if (!r) {
    console.error(
      `${tr("✖ Claude Fleet ließ sich nicht starten. Letzte Log-Zeilen", "✖ Claude Fleet could not start. Last log lines")} (${LOG()}):\n${tail(LOG())}`,
    );
    return 1;
  }
  console.log(`✔ Claude Fleet ${tr("läuft auf", "runs on")} ${r.url}`);
  if (!args.includes("--no-open")) openBrowser(pairUrl(r.url));
  return 0;
}
