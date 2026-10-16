import type http from "node:http";
import type { FleetEvent, Meta, Overview, Session } from "../../shared/types";
import { readArchitecture } from "../core/architecture";
import * as brake from "../core/brake";
import { loadConfig } from "../core/config";
import { demoArchitecture, demoRun } from "../core/demo";
import { noteUse } from "../core/featureuse";
import { chooseLanguage, tr } from "../core/lang";
import * as launch from "../core/launch";
import { ID_RE } from "../core/paths";
import * as pipeline from "../core/pipeline";
import { briefing } from "../core/projects";
import * as providers from "../core/providers";
import { reportMarkdown, weekReport } from "../core/report";
import { transcriptOf } from "../core/sessions";
import { updateMeta } from "../core/state";
import { freshStart, mergeNow, setFresh } from "../handoff";
import type { StartRequest, Terminals } from "../process/manager";
import { CONFLICT_GET } from "./conflict";
import { DIFF_GET } from "./diff";
import { LOG_GET } from "./log";
import { type Presence, TAB_RE } from "./presence";
import { HttpError, readJson, send } from "./security";
import { resumeHere, TERM_POST } from "./term";

/**
 * The JSON API of the dashboard. Every folder, repo, PR and session id that leads to an action comes from
 * Fleet's own overview, never from the request: the request only names which entry of the overview is meant.
 */

export interface ApiContext {
  demo: boolean;
  version: string;
  overview(): Promise<{ body: string; etag: string; data: Overview }>;
  /** The hook events Fleet still has (the overview passes on only the newest). */
  events(): Promise<FleetEvent[]>;
  invalidate(): void;
  pushChange(): void;
  /** Fleet's own processes (server/process): the manager, or the scripted terminal in demo mode. */
  term: Terminals;
  /** Which tabs are in front: only they let the hook hold approvals (presence.ts). */
  presence: Presence;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: ApiContext) => Promise<void>;

const BUSY = ["working", "stale", "needs_input"];

function target(v: unknown): launch.Target {
  if (!launch.isTarget(v)) throw new HttpError(400, tr("unbekanntes Ziel", "unknown target"));
  return v;
}
function sessionId(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v))
    throw new HttpError(400, tr("id fehlt oder ungültig", "id missing or invalid"));
  return v;
}
/** Starts a new session with a prompt; answers 422 when the target cannot do it here. */
async function openNew(
  res: http.ServerResponse,
  ctx: ApiContext,
  t: launch.Target,
  cwd: string,
  prompt: string,
  turn?: StartRequest["turn"],
) {
  if (t === "fleet") {
    const r = await ctx.term.start({
      root: cwd,
      cwd,
      prompt,
      title: prompt.split("\n")[0]?.slice(0, 200) || null,
      turn,
    });
    ctx.invalidate();
    return r.ok ? send(res, 200, { ok: true, target: t, proc: r.id }) : send(res, r.status, { error: r.error });
  }
  const steps = launch.planNew(t, cwd, prompt, launch.detect());
  if (!steps.length)
    return send(res, 422, {
      error: tr(`${launch.LABELS[t]} ist hier nicht verfügbar`, `${launch.LABELS[t]} is not available here`),
    });
  launch.run(steps);
  send(res, 200, { ok: true, target: t });
}
const findSession = async (ctx: ApiContext, id: string): Promise<Session | undefined> =>
  (await ctx.overview()).data.sessions.find((x) => x.id === id);

const GET: Record<string, Handler> = {
  ...CONFLICT_GET,
  ...DIFF_GET,
  ...LOG_GET,
  "/api/health": async (_req, res, _url, ctx) =>
    send(res, 200, {
      ok: true,
      app: "claude-fleet",
      version: ctx.version,
      pid: process.pid,
      demo: ctx.demo,
      terminal: ctx.term.state(),
      processes: ctx.term.counts(),
    }),
  "/api/overview": async (req, res, _url, ctx) => {
    const { body, etag } = await ctx.overview();
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    send(res, 200, body, "application/json; charset=utf-8", { ETag: etag });
  },
  // The week report as a download: Markdown to read or hand to Claude, JSON for tools (spec: "Analyse-Export").
  "/api/report/week": async (_req, res, url, ctx) => {
    const format = url.searchParams.get("format") || "md";
    if (format !== "md" && format !== "json")
      return send(res, 400, { error: tr("Format md oder json", "format md or json") });
    const r = weekReport((await ctx.overview()).data, await ctx.events());
    const disposition = {
      "Content-Disposition": `attachment; filename="fleet-week-${r.period.to}.${format}"`,
      "Cache-Control": "no-store",
    };
    if (format === "json") return send(res, 200, `${JSON.stringify(r, null, 1)}\n`, undefined, disposition);
    send(res, 200, reportMarkdown(r), "text/markdown; charset=utf-8", disposition);
  },
  // Details of a pipeline run; the repo only from our own overview, the id only digits.
  "/api/run": async (_req, res, url, ctx) => {
    const id = Number(url.searchParams.get("id"));
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === url.searchParams.get("root"));
    if (repo?.remote?.provider !== "github" || !Number.isInteger(id) || id <= 0)
      return send(res, 404, { error: tr("Lauf nicht gefunden", "run not found") });
    send(res, 200, ctx.demo ? demoRun(repo.name, id) : await pipeline.runDetails(repo.remote, id));
  },
  // A repo's architecture notes for the repo drawer; the folder only from our own overview.
  "/api/architecture": async (_req, res, url, ctx) => {
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === url.searchParams.get("root"));
    if (!repo) return send(res, 404, { error: tr("Repo nicht gefunden", "repo not found") });
    send(res, 200, ctx.demo ? demoArchitecture(repo.remote?.repo || repo.name) : readArchitecture(repo.root));
  },
};

const POST: Record<string, Handler> = {
  // Views, commands and keys the page used (core/featureuse.ts): counts only, never text; the demo counts nothing.
  "/api/use": async (req, res, _url, ctx) => {
    const j = await readJson(req, 8000);
    const c = j.counts && typeof j.counts === "object" ? (j.counts as Record<string, unknown>) : {};
    if (!ctx.demo) for (const [k, n] of Object.entries(c).slice(0, 100)) if (typeof n === "number") noteUse(k, n);
    send(res, 200, { ok: true });
  },
  ...TERM_POST,
  "/api/language": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const now = chooseLanguage(j.lang);
    if (!now) return send(res, 400, { error: tr("Nur de oder en", "Only de or en") });
    // Every open tab loads the new words at once (round 6: Activity kept the old ones until the next view).
    ctx.pushChange();
    send(res, 200, { ok: true, lang: now });
  },
  "/api/meta": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const id = sessionId(j.id);
    const patch: Meta = {};
    if ("pinned" in j) patch.pinned = !!j.pinned;
    if ("hidden" in j) patch.hidden = !!j.hidden;
    if ("note" in j) patch.note = String(j.note ?? "").slice(0, 2000);
    const r = await updateMeta(loadConfig(), id, patch);
    ctx.invalidate();
    send(res, 200, r);
  },
  "/api/open": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const id = sessionId(j.id);
    const t = target(j.target);
    const s = await findSession(ctx, id);
    if (!s || (s.source !== "local" && !ctx.demo))
      return send(res, 404, { error: tr("Session nicht gefunden", "session not found") });
    if (t === "fleet") return resumeHere(res, ctx, s, j.force === true);
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, target: t });
    const steps = launch.plan(t, { id: s.id, cwd: s.cwd || null, desktopId: s.desktop?.id }, launch.detect());
    if (!steps.length)
      return send(res, 422, {
        error: tr(`${launch.LABELS[t]} ist hier nicht verfügbar`, `${launch.LABELS[t]} is not available here`),
      });
    launch.run(steps);
    send(res, 200, { ok: true, target: t });
  },
  // Continue with a repo's handoff in a new session.
  "/api/continue": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const t = target(j.target);
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === j.root && r.handoff);
    if (!repo) return send(res, 404, { error: tr("keine Übergabe in diesem Repo", "no handoff in this repo") });
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, target: t });
    await openNew(res, ctx, t, repo.root, tr("Mach mit der Übergabe weiter", "Continue from the handoff"));
  },
  // A new session across all repos of a project.
  "/api/project-brief": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const t = target(j.target);
    const data = (await ctx.overview()).data;
    const p = data.projects.find((x) => x.id === j.id);
    const b = p && briefing(p, data.repos);
    if (!b)
      return send(res, 404, {
        error: tr("Projekt nicht gefunden oder ohne Repos", "project not found or without repos"),
      });
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, target: t });
    await openNew(res, ctx, t, b.cwd, b.prompt, "brief");
  },
  "/api/run": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const id = Number(j.id);
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === j.root);
    if (repo?.remote?.provider !== "github" || !Number.isInteger(id) || id <= 0)
      return send(res, 404, { error: tr("Lauf nicht gefunden", "run not found") });
    if (!["rerun", "cancel", "fix"].includes(String(j.action)))
      return send(res, 400, { error: tr("unbekannte Aktion", "unknown action") });
    if (j.action === "fix") {
      const t = target(j.target);
      if (ctx.demo) return send(res, 200, { ok: true, demo: true });
      const d = await pipeline.runDetails(repo.remote, id);
      if ("error" in d) return send(res, 502, { error: d.error });
      return openNew(res, ctx, t, repo.root, pipeline.fixPrompt(repo.name, d), "fix");
    }
    if (ctx.demo) return send(res, 200, { ok: true, demo: true });
    const r = await pipeline.runAction(repo.remote, id, j.action === "cancel" ? "cancel" : "rerun");
    ctx.invalidate();
    r.ok ? send(res, 200, { ok: true }) : send(res, 502, { error: r.error });
  },
  // Several sessions of a repo into one; repo and sessions only from our own overview.
  "/api/merge-sessions": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const dup = (await ctx.overview()).data.duplicates.find((d) => d.root === j.root);
    if (!dup)
      return send(res, 404, {
        error: tr("keine doppelten Sessions in diesem Repo", "no duplicate sessions in this repo"),
      });
    if (dup.busy)
      return send(res, 409, {
        error: tr(
          "Eine der Sessions arbeitet noch – nach ihrem Turn geht es",
          "One of the sessions is still working; it works after its turn",
        ),
      });
    const t = launch.isTarget(j.target) ? j.target : "desktop";
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, target: t });
    const claudeHome = loadConfig().claudeHome;
    const r = mergeNow({
      root: dup.root,
      sessions: await Promise.all(
        dup.sessions.map(async (x) => ({
          sid: x.id,
          title: x.title,
          transcript: await transcriptOf(claudeHome, x.id),
        })),
      ),
      now: Date.now(),
    });
    if ("error" in r) return send(res, 422, { error: r.error });
    ctx.invalidate();
    await openNew(res, ctx, t, r.root, r.prompt);
  },
  // Merges the PR of a finished session; PR and repo from our own overview. `force` only when CI never started.
  "/api/merge": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const s = await findSession(ctx, sessionId(j.id));
    const pr = s?.ci?.pr;
    if (!s || !pr || pr.state !== "open" || !s.remote)
      return send(res, 404, { error: tr("kein offener PR zu dieser Session", "no open PR for this session") });
    const force = j.force === true;
    if (force) {
      const run = s.ci?.ci?.id;
      const details =
        run && s.remote.provider === "github" && !ctx.demo ? await pipeline.runDetails(s.remote, run) : null;
      const notStarted = ctx.demo || (details && !("error" in details) && pipeline.notStarted(details));
      if (!notStarted)
        return send(res, 409, {
          error: tr(
            "Die CI ist gelaufen – Mergen ohne grüne CI gibt es nur, wenn sie gar nicht starten konnte",
            "CI did run; merging without green CI is only offered when it could not start at all",
          ),
        });
    }
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, number: pr.number });
    const r = await providers.mergePr(s.remote, Number(pr.number), { admin: force });
    ctx.invalidate();
    r.ok ? send(res, 200, { ok: true, number: pr.number }) : send(res, 502, { error: r.error });
  },
  // Merges any open PR of a repo from the PR list. Repo and PR come from our own overview; red, running or
  // missing CI only with `force` (the second click in the dashboard), a stacked PR only after the lower one.
  "/api/merge-pr": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const n = j.number;
    if (typeof j.root !== "string" || typeof n !== "number" || !Number.isInteger(n) || n <= 0)
      throw new HttpError(400, tr("root oder number fehlt", "root or number missing"));
    const repo = (await ctx.overview()).data.repos.find((r) => r.root === j.root);
    const pr = repo?.prs?.prs?.find((p) => p.number === n);
    if (!repo?.remote || !pr)
      return send(res, 404, { error: tr("kein offener PR mit dieser Nummer", "no open PR with this number") });
    if (pr.draft) return send(res, 409, { error: tr("PR ist ein Entwurf", "PR is a draft") });
    if (!pr.onDefault)
      return send(res, 409, {
        error: pr.stackedOn
          ? tr(`Baut auf #${pr.stackedOn} auf – erst den mergen`, `Builds on #${pr.stackedOn}: merge that one first`)
          : tr(`Zielt auf ${pr.base}, nicht auf den Hauptbranch`, `Targets ${pr.base}, not the default branch`),
      });
    const force = j.force === true;
    if (pr.ci !== "success" && !force)
      return send(res, 409, {
        error: tr("CI ist nicht grün – nur mit Bestätigung", "CI is not green: only after confirming"),
      });
    if (ctx.demo) return send(res, 200, { ok: true, demo: true, number: pr.number });
    const r = await providers.mergePr(repo.remote, pr.number, { admin: force && pr.ci !== "success" });
    ctx.invalidate();
    r.ok ? send(res, 200, { ok: true, number: pr.number }) : send(res, 502, { error: r.error });
  },
  "/api/fresh": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const s = await findSession(ctx, sessionId(j.id));
    if (!s || (s.source !== "local" && !ctx.demo))
      return send(res, 404, { error: tr("Session nicht gefunden", "session not found") });
    if (ctx.demo)
      return send(res, 200, { ok: true, demo: true, mode: BUSY.includes(String(s.status)) ? "turn-end" : "ask" });
    if (j.on === false) {
      setFresh(s.id, false);
      ctx.invalidate();
      return send(res, 200, { ok: true, pending: false });
    }
    const r = await freshStart(
      { id: s.id, cwd: s.cwd, status: s.status, desktopId: s.desktop?.id },
      typeof j.target === "string" ? j.target : null,
      {
        fleet: ctx.term.state().available,
        job: async (o) => (await ctx.term.job({ kind: "fresh", root: s.repoRoot || o.cwd, ...o })).ok,
      },
    );
    ctx.invalidate();
    r.ok ? send(res, 200, r) : send(res, 422, { error: r.error });
  },
  "/api/presence": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    if (typeof j.tab !== "string" || !TAB_RE.test(j.tab) || typeof j.active !== "boolean")
      throw new HttpError(400, tr("tab oder active fehlt oder ungültig", "tab or active missing or invalid"));
    ctx.presence.report(j.tab, j.active);
    send(res, 200, { ok: true });
  },
  "/api/decision": async (req, res, _url, ctx) => {
    const j = await readJson(req);
    const id = sessionId(j.id);
    if (ctx.demo) {
      const d = (await ctx.overview()).data.decisions.find((x) => x.id === id);
      if (!d) return send(res, 404, { error: tr("Entscheidung nicht gefunden", "decision not found") });
      return d.options.some((o) => o.id === j.answer)
        ? send(res, 200, { ok: true, demo: true })
        : send(res, 400, { error: tr("ungültige Antwort", "invalid answer") });
    }
    const r = brake.answer(id, j.answer);
    if (!r.ok) return send(res, r.status, { error: r.error });
    ctx.pushChange();
    send(res, 200, { ok: true, status: r.decision.status });
  },
};

/** Answers an API request; false when the path is not part of the API. */
export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ApiContext,
): Promise<boolean> {
  const get = req.method === "GET" || req.method === "HEAD";
  const h = get ? GET[url.pathname] : req.method === "POST" ? POST[url.pathname] : undefined;
  if (h) {
    await h(req, res, url, ctx);
    return true;
  }
  if (
    GET[url.pathname] ||
    POST[url.pathname] ||
    url.pathname === "/api/stream" ||
    url.pathname === "/api/term/stream"
  ) {
    send(res, 405, { error: "method not allowed" }, undefined, { Allow: POST[url.pathname] ? "POST" : "GET, HEAD" });
    return true;
  }
  return false;
}
