import type http from "node:http";
import path from "node:path";
import type { Session } from "../../shared/types";
import { loadConfig } from "../core/config";
import { noteUse } from "../core/featureuse";
import { readHere } from "../core/here";
import { tr } from "../core/lang";
import { FOLDER_RE, makeFolder } from "../core/newfolder";
import { fleetHome, ID_RE } from "../core/paths";
import {
  BUSY,
  baseRef,
  createWorktree,
  fleetWorktrees,
  mainRoot,
  planWorktree,
  removable,
  removeWorktree,
  runSetup,
  samePath,
  seedWorktree,
  wantsWorktree,
} from "../core/worktree";
import { requestNow } from "../handoff";
import { cleanPrompt, MAX_PROMPT } from "../process/args";
import { live, type StartResult, type TermEvent } from "../process/manager";
import type { ApiContext, Handler } from "./api";
import { BASE_HEADERS, HttpError, readJson, send } from "./security";

/**
 * /api/term/*: Fleet's own Claude sessions. Repo roots and sessions only from the overview; a `cwd` in a request
 * is ignored. Output goes out as server-sent events (Base64 chunks, the buffer first), input and resizing come in
 * as POST, so every write passes the same Host, Origin and X-Fleet check as the rest of the API.
 */

const MAX_INPUT = 8 * 1024;
/** One terminal per page is attached at a time; a few tabs may follow it. */
export const MAX_TERM_CLIENTS = 4;
/** Statuses where the session may still run in another window: continuing here needs a second click. */
const ELSEWHERE = ["working", "stale", "needs_input", "waiting"];

const id = (v: unknown): string => {
  if (typeof v !== "string" || !ID_RE.test(v))
    throw new HttpError(400, tr("id fehlt oder ungültig", "id missing or invalid"));
  return v;
};
const findSession = async (ctx: ApiContext, sid: string): Promise<Session | undefined> =>
  (await ctx.overview()).data.sessions.find((x) => x.id === sid);
const answer = (res: http.ServerResponse, r: StartResult, extra: Record<string, unknown> = {}) =>
  r.ok ? send(res, 200, { ok: true, id: r.id, ...extra }) : send(res, r.status, { error: r.error });

/** Continue a session in Fleet's window; shared by /api/term/resume and /api/open with the target "fleet". */
export async function resumeHere(res: http.ServerResponse, ctx: ApiContext, s: Session, force: boolean) {
  const cur = ctx.term.get(s.id);
  if (cur && live(cur) && cur.kind === "session") return answer(res, { ok: true, id: s.id }, { target: "fleet" });
  const cwd = s.cwd;
  if (!cwd || !path.isAbsolute(cwd))
    return send(res, 422, { error: tr("Session ohne Ordner", "Session without a folder") });
  // It may still run elsewhere (the desktop app, another terminal): two processes on one transcript put it at risk,
  // so it goes on here as a branch with an id of its own, and the other one stays as it is (live 16.10.2026: Enter
  // on a session waiting in the desktop app stopped at a warning). `force` takes the session itself over.
  const fork = !force && ELSEWHERE.includes(String(s.status));
  ctx.invalidate();
  answer(res, await ctx.term.start({ root: s.repoRoot || cwd, cwd, resume: s.id, fork, title: s.title || null }), {
    target: "fleet",
    ...(fork ? { forked: true } : {}),
  });
}

export const TERM_POST: Record<string, Handler> = {
  "/api/term/new": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === j.root);
    if (!repo) return send(res, 404, { error: tr("Repo nicht gefunden", "repo not found") });
    const p = cleanPrompt(j.prompt);
    if (!p.ok) return send(res, 400, { error: p.error });
    const title = p.text.trim().split("\n")[0]?.slice(0, 200) || null;
    // Release 6.1.0 (plan T1): a second session in the repo, or `:wt`, gets a worktree of its own next to the repo.
    const cfg = loadConfig().worktree;
    const { sessions } = (await ctx.overview()).data;
    const liveCwds = ctx.term
      .list()
      .filter((x) => live(x) && x.kind === "session")
      .map((x) => x.cwd);
    const explicit = j.worktree === true;
    ctx.invalidate();
    if (!wantsWorktree(repo.root, sessions, liveCwds, cfg, explicit))
      return answer(res, await ctx.term.start({ root: repo.root, cwd: repo.root, prompt: p.text, title }));
    // A session in a worktree shows that worktree as a repo too: new worktrees always grow from the main folder.
    const main = ctx.demo ? repo.root : await mainRoot(repo.root);
    const plan = planWorktree(main, p.text);
    // The demo creates nothing on disk: the scripted terminal starts as before and the answer names the worktree.
    if (ctx.demo)
      return answer(res, await ctx.term.start({ root: repo.root, cwd: repo.root, prompt: p.text, title }), {
        worktree: { ...plan, base: "origin/main", copied: 0, setup: null },
      });
    if (!explicit) noteUse("use:worktree:auto");
    const base = await baseRef(main, cfg.fetch);
    const made = base
      ? await createWorktree(main, plan, base)
      : ({ ok: false, error: tr("kein Standard-Branch", "no default branch") } as const);
    if (!made.ok) {
      const why = tr(`Worktree ging nicht: ${made.error}`, `Worktree did not work: ${made.error}`);
      // Asked for on purpose: nothing starts on top of the session already there. Automatic: the main folder, with why.
      if (explicit) return send(res, 422, { error: why });
      const r = await ctx.term.start({ root: repo.root, cwd: repo.root, prompt: p.text, title });
      return answer(res, r, { worktreeError: made.error });
    }
    const key = Object.keys(cfg.repos).find((k) => samePath(k, main));
    const own = (key && cfg.repos[key]) || { setup: "", include: [] };
    const copied = await seedWorktree(main, plan.dir, own.include);
    const setup =
      own.setup && runSetup(plan.dir, own.setup, path.join(fleetHome(), "logs", `worktree-${plan.name}.log`))
        ? own.setup
        : null;
    answer(res, await ctx.term.start({ root: main, cwd: plan.dir, prompt: p.text, title }), {
      worktree: { ...plan, base: made.base, copied: copied.length, setup },
    });
  },
  // `:cleanup` (plan T1.4): Fleet's own worktrees of a repo that may go; with `remove`, those of them go. Only
  // worktrees on the recomputed list can go, whatever the request names.
  "/api/worktrees": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === j.root);
    if (!repo) return send(res, 404, { error: tr("Repo nicht gefunden", "repo not found") });
    if (ctx.demo) return send(res, 200, { ok: true, main: repo.root, candidates: [], removed: [], failed: [] });
    const main = await mainRoot(repo.root);
    const base = await baseRef(main);
    if (!base) return send(res, 200, { ok: true, main, candidates: [], removed: [], failed: [] });
    const liveCwds = ctx.term
      .list()
      .filter((x) => live(x))
      .map((x) => x.cwd);
    // A session that works or waits in a worktree outside Fleet's window keeps it too.
    for (const s of (await ctx.overview()).data.sessions) if (s.cwd && BUSY.has(String(s.status))) liveCwds.push(s.cwd);
    const candidates = [];
    for (const wt of await fleetWorktrees(main))
      if ((await removable(main, wt, base, liveCwds)).ok) candidates.push(wt);
    const asked = Array.isArray(j.remove) ? j.remove.filter((x: unknown): x is string => typeof x === "string") : [];
    const removed: string[] = [];
    const failed: { dir: string; error: string }[] = [];
    for (const wt of candidates.filter((c) => asked.some((d) => samePath(d, c.dir)))) {
      const r = await removeWorktree(main, wt);
      if (r.ok) removed.push(wt.dir);
      else failed.push({ dir: wt.dir, error: r.error });
    }
    if (asked.length) ctx.invalidate();
    send(res, 200, { ok: true, main, candidates, removed, failed });
  },
  // Release 6 (plan R7): a session in a new project folder. The request names the folder only; the path comes from
  // the overview's projects folder, never from the request. The demo creates nothing on disk.
  "/api/term/new-folder": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const p = cleanPrompt(j.prompt);
    if (!p.ok) return send(res, 400, { error: p.error });
    const base = (await ctx.overview()).data.projectsDir;
    if (!base || !path.isAbsolute(base))
      return send(res, 422, { error: tr("Kein Projektordner bekannt", "No projects folder known") });
    const name = typeof j.name === "string" ? j.name : "";
    const f = ctx.demo
      ? FOLDER_RE.test(name)
        ? ({ ok: true, dir: path.posix.join(base, name), created: true } as const)
        : ({ ok: false, status: 400, error: tr("Ordnername ungültig", "Invalid folder name") } as const)
      : await makeFolder(base, name, tr);
    if (!f.ok) return send(res, f.status, { error: f.error });
    ctx.invalidate();
    const title = p.text.trim().split("\n")[0]?.slice(0, 200) || name;
    answer(res, await ctx.term.start({ root: f.dir, cwd: f.dir, prompt: p.text, title }), {
      folder: f.dir,
      created: f.created,
    });
  },
  // `fleet` typed in a folder (server/core/here.ts): Claude starts in exactly that folder, never one the request names.
  "/api/term/here": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const p = cleanPrompt(j.prompt);
    if (!p.ok) return send(res, 400, { error: p.error });
    if (ctx.demo) return send(res, 200, { ok: true, demo: true });
    const here = readHere();
    if (!here || here.dir !== j.dir)
      return send(res, 409, {
        error: tr(
          "Ordner nicht mehr aktuell – fleet dort neu aufrufen",
          "Folder no longer current; run fleet there again",
        ),
      });
    ctx.invalidate();
    const title = p.text.trim().split("\n")[0]?.slice(0, 200) || path.basename(here.dir);
    answer(res, await ctx.term.start({ root: here.dir, cwd: here.dir, prompt: p.text, title }), { folder: here.dir });
  },
  "/api/term/resume": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const s = await findSession(ctx, id(j.id));
    if (!s || (s.source !== "local" && !ctx.demo))
      return send(res, 404, { error: tr("Session nicht gefunden", "session not found") });
    await resumeHere(res, ctx, s, j.force === true);
  },
  "/api/term/input": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const pid = id(j.id);
    if (typeof j.data !== "string") throw new HttpError(400, tr("data fehlt", "data missing"));
    const data = Buffer.from(j.data, "base64");
    if (data.length > MAX_INPUT) throw new HttpError(413, "too large");
    if (!ctx.term.write(pid, data))
      return send(res, 404, { error: tr("kein laufender Prozess", "no running process") });
    send(res, 200, { ok: true });
  },
  "/api/term/resize": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const pid = id(j.id);
    const cols = Number(j.cols);
    const rows = Number(j.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200)
      throw new HttpError(400, tr("Größe ungültig", "invalid size"));
    if (!ctx.term.resize(pid, cols, rows))
      return send(res, 404, { error: tr("kein laufender Prozess", "no running process") });
    send(res, 200, { ok: true });
  },
  "/api/term/kill": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const pid = id(j.id);
    if (j.signal !== "int" && j.signal !== "term") throw new HttpError(400, tr("signal ungültig", "invalid signal"));
    if (!ctx.term.kill(pid, j.signal))
      return send(res, 404, { error: tr("kein laufender Prozess", "no running process") });
    ctx.invalidate();
    send(res, 200, { ok: true });
  },
  // Answer a session in one line. Only Fleet's own sessions can be written to; there is no bridge to other apps.
  "/api/reply": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const sid = id(j.id);
    if (typeof j.text !== "string" || !j.text.trim() || j.text.length > MAX_PROMPT)
      throw new HttpError(
        400,
        tr(`Text fehlt oder länger als ${MAX_PROMPT} Zeichen`, `Text missing or longer than ${MAX_PROMPT}`),
      );
    const s = await findSession(ctx, sid);
    const p = ctx.term.get(sid);
    if (!s && !p) return send(res, 404, { error: tr("Session nicht gefunden", "session not found") });
    if (!p || !live(p) || p.kind !== "session")
      return send(res, 422, {
        error: tr("Session läuft extern – keine Brücke dorthin", "The session runs elsewhere; there is no bridge"),
      });
    // One line: a line break inside would send the text early.
    const text = j.text.replace(/\0/g, "").replace(/[\r\n]+/g, " ");
    ctx.term.write(sid, Buffer.from(`${text}\r`));
    send(res, 200, { ok: true });
  },
  // Fleet's own job in a finished session: write the handoff now, headless, with exact costs.
  "/api/job": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    if (j.kind !== "handoff") throw new HttpError(400, tr("unbekannter Job", "unknown job"));
    const s = await findSession(ctx, id(j.id));
    if (!s || (s.source !== "local" && !ctx.demo))
      return send(res, 404, { error: tr("Session nicht gefunden", "session not found") });
    const cur = ctx.term.get(s.id);
    if ((cur && live(cur)) || ["working", "stale", "needs_input"].includes(String(s.status)))
      return send(res, 409, {
        error: tr(
          "Die Session arbeitet gerade – nach ihrem Turn geht es",
          "The session is working; it works after its turn",
        ),
      });
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, id: s.id });
    if (!s.cwd || !path.isAbsolute(s.cwd))
      return send(res, 422, { error: tr("Session ohne Ordner", "Session without a folder") });
    const prompt = requestNow(
      { session_id: s.id, cwd: s.cwd },
      tr("Du hast in Fleet „Übergabe jetzt“ gewählt", 'You chose "Handoff now" in Fleet'),
      Date.now(),
    );
    const r = await ctx.term.job({ kind: "handoff", id: s.id, root: s.repoRoot || s.cwd, cwd: s.cwd, prompt });
    ctx.invalidate();
    answer(res, r);
  },
};

/**
 * GET /api/term/stream?id=: the output as server-sent events. The buffer comes first so a page that attaches
 * late sees the whole screen; output is batched every 16 ms (a TUI redraws in many small writes).
 */
export function streamTerm(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ApiContext,
  clients: Set<http.ServerResponse>,
) {
  const pid = url.searchParams.get("id") || "";
  if (!ID_RE.test(pid)) return send(res, 400, { error: tr("id fehlt oder ungültig", "id missing or invalid") });
  if (clients.size >= MAX_TERM_CLIENTS) return send(res, 503, { error: "too many connections" });
  let pending: Buffer[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending.length) return;
    res.write(`event: out\ndata: ${Buffer.concat(pending).toString("base64")}\n\n`);
    pending = [];
  };
  let started = false;
  const on = (e: TermEvent) => {
    if (!started) return;
    if (e.type === "out") {
      pending.push(e.data);
      timer ??= setTimeout(flush, 16);
    } else {
      flush();
      res.write(`event: exit\ndata: ${JSON.stringify({ code: e.code })}\n\n`);
    }
  };
  // Headers first, then the buffer the attach call replays synchronously.
  const probe = ctx.term.get(pid);
  if (!probe) return send(res, 404, { error: tr("kein Prozess", "no process") });
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write("retry: 2000\n\n");
  started = true;
  const detach = ctx.term.attach(pid, on);
  if (!detach) {
    res.end();
    return;
  }
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25e3);
  req.on("close", () => {
    clearInterval(ping);
    clearTimeout(timer);
    clients.delete(res);
    detach();
  });
}
