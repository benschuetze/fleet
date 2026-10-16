import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Overview } from "../../shared/types";
import * as brake from "../core/brake";
import { loadConfig } from "../core/config";
import { demoSources } from "../core/demo";
import { NOT_COUNTED, noteUse } from "../core/featureuse";
import { tr } from "../core/lang";
import { buildOverview, realSources } from "../core/overview";
import { fleetHome } from "../core/paths";
import { onRefresh } from "../core/swr";
import { createDemoTerminals } from "../process/demo-term";
import { createManager, type Terminals } from "../process/manager";
import { takePending } from "../process/pending";
import { type ApiContext, handleApi } from "./api";
import { presence } from "./presence";
import { BASE_HEADERS, Guard, HttpError, send } from "./security";
import { asset, indexPage, ROUTES } from "./static";
import { streamTerm } from "./term";
import { pairUrl, tokenCookie, tokenMatches } from "./token";

/**
 * The Fleet HTTP server: the dashboard, its JSON API and a server-sent-events stream that tells open pages
 * about changes the hooks wrote. Built on node:http only, so the running dashboard needs no node_modules.
 */

const MAX_CLIENTS = 16;

export interface FleetServer {
  server: http.Server;
  guard: Guard;
  terminal: Terminals;
  /** Starts watching ~/.claude-fleet for changes (pushes to open pages). */
  watch(): void;
  close(): void;
}

export function createFleetServer({
  demo,
  version,
  onUrl,
}: {
  demo: boolean;
  version: string;
  onUrl?: () => string;
}): FleetServer {
  const guard = new Guard();
  // Fleet's own processes; their changes reach open pages like hook changes do.
  const term: Terminals = demo
    ? createDemoTerminals()
    : createManager({ config: loadConfig, onChange: () => pushChange() });
  const procSources = { processes: () => term.list(), terminal: () => term.state() };
  // Cache the result briefly and share a running build (several tabs, one computation). Every hook event
  // invalidates; builds never run side by side: one that is outdated by a newer event is followed by exactly one
  // more, which all requests of the meantime share (a burst of events used to start a build per request, and the
  // builds slowed each other down to seconds).
  type Built = { body: string; etag: string; data: Overview };
  let gen = 0;
  let done: { gen: number; at: number; p: Promise<Built> } | null = null;
  let running: { gen: number; p: Promise<Built> } | null = null;
  let queued: Promise<Built> | null = null;
  const build = (): Promise<Built> => {
    const g = gen;
    const p = buildOverview(
      loadConfig(),
      demo ? { version, demo: true, sources: { ...demoSources(), ...procSources } } : { version, sources: procSources },
    ).then((o) => {
      const body = JSON.stringify(o);
      return { body, etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"`, data: o };
    });
    running = { gen: g, p };
    p.then(
      () => {
        done = { gen: g, at: Date.now(), p };
      },
      () => {},
    ).finally(() => {
      if (running?.p === p) running = null;
    });
    return p;
  };
  const overview = (): Promise<Built> => {
    if (done && done.gen === gen && Date.now() - done.at < 1000) return done.p;
    if (running && running.gen === gen) return running.p;
    if (!running) return build();
    if (!queued) {
      const after = running.p.catch(() => {});
      queued = after.then(() => {
        queued = null;
        return overview();
      });
    }
    return queued;
  };
  const invalidate = () => {
    gen++;
  };

  /* Live push (server-sent events) */
  const clients = new Set<http.ServerResponse>();
  let pushTimer: NodeJS.Timeout | undefined;
  const pushChange = () => {
    invalidate();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      for (const c of clients) c.write("data: change\n\n");
    }, 100);
  };
  // A slow part (git, a session's result) answered late or changed in the background: show it.
  const unRefresh = onRefresh(() => pushChange());
  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 25e3);
  ping.unref();
  // Only a visible, focused tab lets the hook wait for approvals in the dashboard (brake.uiActive, bug B3).
  const look = presence({ demo });

  // The week report needs more history than the overview passes on: the same source, the same limit.
  const readEvents = (demo && demoSources().readEvents) || realSources.readEvents;
  const events = () => readEvents(loadConfig(), 3000);
  const ctx: ApiContext = { demo, version, overview, events, invalidate, pushChange, term, presence: look };
  const termClients = new Set<http.ServerResponse>();

  /** New sessions the hook left for Fleet's window (a fresh start); only in repos of the overview. */
  const startPending = async () => {
    if (demo) return;
    const list = takePending();
    if (!list.length) return;
    const repos = new Set((await overview()).data.repos.map((r) => r.root));
    for (const p of list) {
      if (!repos.has(p.root)) {
        console.error(`[fleet] fresh start: ${p.root} is no known repo, not started`);
        continue;
      }
      const r = await term.start({
        root: p.root,
        cwd: p.root,
        prompt: p.prompt,
        title: p.prompt.split("\n")[0] || null,
      });
      if (!r.ok) console.error(`[fleet] fresh start in ${p.root}: ${r.error}`);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const denied = guard.check(req, url.pathname);
      if (denied) return send(res, denied.status, { error: denied.error });
      const get = req.method === "GET" || req.method === "HEAD";
      // Pairing a browser: the link from `fleet start`/`fleet open` sets the token cookie (token.ts, audit H1).
      if (get && url.pathname === "/pair") {
        const token = guard.tokenValue();
        if (!token) return send(res, 303, "", "text/plain; charset=utf-8", { Location: "/" }); // the demo
        if (!tokenMatches(url.searchParams.get("t"), token))
          return send(
            res,
            403,
            "Wrong or old link. Open Fleet again with: node dist/fleet.cjs open",
            "text/plain; charset=utf-8",
          );
        return send(res, 303, "", "text/plain; charset=utf-8", { Location: "/", "Set-Cookie": tokenCookie(token) });
      }
      if (get && url.pathname === "/api/stream") {
        if (clients.size >= MAX_CLIENTS) return send(res, 503, { error: "too many connections" });
        res.writeHead(200, {
          ...BASE_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write("retry: 3000\n\n");
        clients.add(res);
        // No mark here: when the stream holder closes, the next tab takes over within moments, and a tab that
        // closes reports itself as gone (presence.ts); a crash ages out after UI_FRESH_MS.
        req.on("close", () => clients.delete(res));
        return;
      }
      if (get && url.pathname === "/api/term/stream") return streamTerm(req, res, url, ctx, termClients);
      if (url.pathname.startsWith("/api/")) {
        // Which features are used (docs/SCOPE.md); polling, streams and typing do not count.
        if (!demo && !NOT_COUNTED.has(url.pathname)) noteUse(`api:${url.pathname}`);
        if (!(await handleApi(req, res, url, ctx))) send(res, 404, { error: "not found" });
        return;
      }
      if (!get) return send(res, 405, { error: "method not allowed" }, undefined, { Allow: "GET, HEAD" });
      if (ROUTES.has(url.pathname) || url.pathname === "/index.html") {
        const p = indexPage();
        if (!p)
          return send(
            res,
            503,
            tr("Die Oberfläche ist noch nicht gebaut: pnpm build", "The dashboard is not built yet: pnpm build"),
            "text/plain; charset=utf-8",
          );
        return send(res, 200, p.buf, "text/html; charset=utf-8", { "Content-Security-Policy": p.csp });
      }
      const a = asset(url.pathname);
      if (!a) return send(res, 404, { error: "not found" });
      return send(
        res,
        200,
        a.buf,
        a.type,
        a.immutable ? { "Cache-Control": "public, max-age=31536000, immutable" } : {},
      );
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = err instanceof HttpError ? err.status : e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? tr("interner Fehler", "internal error") : String(e.message) });
    }
  });
  server.headersTimeout = 10e3;
  server.requestTimeout = 30e3;
  server.keepAliveTimeout = 5e3;
  server.maxHeadersCount = 50;

  /**
   * New brake decision: an open dashboard announces it itself (browser notification). Without one, Fleet shows a
   * system notification and opens the dashboard, because the session only waits for a limited time.
   */
  const announced = new Set<string>();
  let announceTimer: NodeJS.Timeout | undefined;
  const announceDecisions = () => {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const now = Date.now();
      const fresh = brake
        .list(now)
        .filter((d) => d.status === "open" && !announced.has(d.id) && now - d.createdAt < 30e3);
      for (const d of fresh) announced.add(d.id);
      const d = fresh[0];
      if (!d || clients.size) return;
      systemNotify(
        tr("Claude Fleet: Session angehalten", "Claude Fleet: session paused"),
        `${d.title} – ${tr("Entscheidung im Dashboard", "decide in the dashboard")}`,
      );
      if (brake.readConfig().openFleet && onUrl) openBrowser(pairUrl(onUrl(), "#decision"));
    }, 300);
  };

  const watchers: fs.FSWatcher[] = [];
  const tryWatch = (p: string, fn: (event: string, file: string | null) => void) => {
    try {
      const w = fs.watch(p, fn);
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // not watchable: the page polls anyway
    }
  };

  return {
    server,
    guard,
    terminal: term,
    watch() {
      const home = fleetHome();
      const state = path.join(home, "state");
      const decisions = brake.decisionDir();
      for (const d of [state, decisions]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      tryWatch(state, (_e, f) => {
        if (!f || f.endsWith(".json")) pushChange();
      });
      tryWatch(home, (_e, f) => {
        // here.json: `fleet` typed in a folder, the open page follows at once (core/here.ts).
        if (!f || f === "events.jsonl" || f === "handoffs.json" || f.startsWith("here.json")) pushChange();
        if (!f || f === "handoffs.json") startPending().catch((e) => console.error("[fleet] pending:", e));
      });
      if (!demo) term.restore();
      startPending().catch((e) => console.error("[fleet] pending:", e));
      tryWatch(decisions, (_e, f) => {
        if (!f || f.endsWith(".json")) {
          pushChange();
          announceDecisions();
        }
      });
      overview().catch(() => {}); // warm the caches
    },
    close() {
      term.close();
      for (const w of watchers) w.close();
      for (const c of clients) c.end();
      for (const c of termClients) c.end();
      clearInterval(ping);
      unRefresh();
      server.close();
    },
  };
}

/** System notification without a shell; texts go to AppleScript as arguments, never into the source. */
function systemNotify(title: string, body: string) {
  try {
    if (process.platform === "darwin") {
      execFile(
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          body.slice(0, 200),
        ],
        { windowsHide: true, timeout: 5000 },
        () => {},
      ).on("error", () => {});
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, body.slice(0, 200)], { timeout: 5000 }, () => {}).on("error", () => {});
    }
  } catch {
    // no notification, the dashboard still shows it
  }
}

export function openBrowser(url: string): void {
  const [cmd, a] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    execFile(cmd as string, a as string[], { windowsHide: true }, () => {}).on("error", () => {});
  } catch {
    // the URL is printed anyway
  }
}
