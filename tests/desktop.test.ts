// Desktop app: where a session continues, which PRs it opened, how to open it, which group it belongs to.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { loadConfig } from "../server/core/config";
import { type DesktopPr, desktopLink, parseSession, prFor, readDesktop, readGroups } from "../server/core/desktop";
import { buildOverview, type Sources } from "../server/core/overview";
import type { Config, GitInfo, TranscriptData } from "../shared/types";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const DESK = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Ablage wie die der App: <dir>/<org>/<konto>/local_<id>.json */
function desktopDir(sessions: ({ sessionId: string } & Record<string, unknown>)[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desk-"));
  const acc = path.join(dir, "org-1", "acc-1");
  fs.mkdirSync(acc, { recursive: true });
  for (const s of sessions) fs.writeFileSync(path.join(acc, `${s.sessionId}.json`), JSON.stringify(s));
  fs.writeFileSync(path.join(acc, "scheduled-tasks.json"), "{}");
  return dir;
}
const PRS = [
  {
    prNumber: 3,
    repo: "example/werkbank",
    host: "github.com",
    url: "https://github.com/example/werkbank/pull/3",
    branch: "feat/alt",
    state: "MERGED",
  },
  {
    prNumber: 7,
    repo: "example/werkbank",
    host: "github.com",
    url: "https://github.com/example/werkbank/pull/7",
    branch: "feat/neu",
    state: "OPEN",
  },
  {
    prNumber: 9,
    repo: "example/anderes",
    host: "github.com",
    url: "https://github.com/example/anderes/pull/9",
    branch: "x",
    state: "OPEN",
  },
];

test("Nach /clear oder frischem Start: die alte CLI-Session zeigt auf die neue", () => {
  const dir = desktopDir([
    { sessionId: DESK, cliSessionId: NEW, priorCliSessionIds: [OLD], title: "Werkbank umbauen", prs: PRS },
  ]);
  const d = readDesktop(dir);
  assert.strictEqual(d.successor.get(OLD), NEW);
  assert.strictEqual(d.byCli.get(OLD)?.desktopId, DESK, "auch die alte gehört zur selben App-Session");
  assert.strictEqual(d.byCli.get(NEW)?.cliSessionId, NEW);
  assert.strictEqual(d.successor.has(NEW), false);
});

test("Kaputte oder fremde Einträge werden ignoriert, nie geworfen", () => {
  assert.strictEqual(parseSession({ sessionId: "local_../../etc", cliSessionId: NEW }), null);
  assert.strictEqual(parseSession({ sessionId: DESK, cliSessionId: "kein-uuid" }), null);
  const s = parseSession({
    sessionId: DESK,
    cliSessionId: NEW,
    priorCliSessionIds: ["x", OLD],
    prs: [
      { prNumber: 1, repo: "a/b", host: "github.com", url: "javascript:alert(1)", branch: "--upload-pack=x" },
      "quatsch",
    ],
  });
  assert.deepStrictEqual(s?.prior, [OLD]);
  assert.strictEqual(s?.prs[0]?.url, null, "nur https-Links");
  assert.strictEqual(s?.prs[0]?.branch, null, "Branch wird geprüft");
  assert.deepStrictEqual(readDesktop(path.join(os.tmpdir(), `gibt-es-nicht-${Date.now()}`)).byCli.size, 0);
});

test("PR einer Session: erst der zum Branch, sonst der jüngste offene im selben Repo", () => {
  const prs = parseSession({ sessionId: DESK, cliSessionId: NEW, prs: PRS })?.prs as DesktopPr[];
  const remote = { host: "github.com", path: "example/werkbank" };
  assert.strictEqual(prFor(prs, remote, "feat/alt")?.number, 3);
  assert.strictEqual(prFor(prs, remote, "main")?.number, 7, "auf main zurück: offener PR bleibt sichtbar");
  assert.strictEqual(prFor(prs, { host: "github.com", path: "example/fremd" }, "main"), null);
});

test("Link zur App: bekannte Session direkt, sonst die CLI-Session importieren", () => {
  assert.strictEqual(desktopLink(DESK, NEW), `claude://claude.ai/epitaxy/${DESK}`);
  assert.strictEqual(desktopLink(null, NEW), `claude://resume?session=${NEW}`);
  assert.strictEqual(desktopLink('local_x"; rm -rf', "kaputt"), null);
});

test("Übersicht: Nachfolger und PR aus der App, obwohl die Session auf main steht", async () => {
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ov-"));
  const cfg: Config = {
    ...loadConfig(),
    _fleetHome: fleetHome,
    cloudSessions: [],
    extraRepos: [],
    hiddenProjects: [],
    _warnings: [],
  };
  const remote = {
    provider: "github" as const,
    trusted: true,
    host: "github.com",
    owner: "example",
    repo: "werkbank",
    path: "example/werkbank",
    webUrl: "https://github.com/example/werkbank",
  };
  const t = (id: string, at: number): TranscriptData => ({
    id,
    file: "",
    cwd: "/w/werkbank",
    gitBranch: "main",
    title: id === OLD ? "Alt" : "Neu",
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    lastTool: null,
    model: null,
    todos: null,
    startedAt: at,
    lastTimestamp: at,
    ctx: null,
    compactions: 0,
    mtime: at,
  });
  const now = Date.now();
  const ov = await buildOverview(cfg, {
    version: "test",
    sources: <Partial<Sources>>{
      readHookStates: async () => ({}),
      scanSessions: async () => [t(OLD, now - 3600e3), t(NEW, now - 60e3), t(OTHER, now - 60e3)],
      readEvents: async () => [],
      usageData: async () => ({ usage: null, perSession: {}, statusline: {} }),
      getAgents: () => ({ at: now, list: [], error: null, disabledUntil: 0 }),
      readMeta: () => ({ sessions: {} }),
      repoRoot: async () => "/w/werkbank",
      gitInfo: async (): Promise<GitInfo> => ({
        root: "/w/werkbank",
        name: "werkbank",
        branch: "main",
        dirty: 0,
        remote,
        lastCommit: null,
        behind: 0,
        ahead: 0,
        hasUpstream: true,
      }),
      prsFor: () => null,
      ciFor: (_r, b) =>
        b === "feat/neu"
          ? {
              pr: {
                number: 7,
                title: "Neu",
                url: "https://github.com/example/werkbank/pull/7",
                state: "open" as const,
                review: null,
                ci: "success" as const,
              },
            }
          : { ci: { state: "none" as const } },
      handoffFor: () => null,
      desktop: () =>
        readDesktop(
          desktopDir([
            { sessionId: DESK, cliSessionId: NEW, priorCliSessionIds: [OLD], title: "Werkbank umbauen", prs: PRS },
          ]),
        ),
    },
  });
  const byId = new Map(ov.sessions.map((s) => [s.id, s]));
  assert.deepStrictEqual(byId.get(OLD)?.next, { id: NEW, title: "Neu" });
  assert.strictEqual(byId.get(OLD)?.desktop?.current, false);
  assert.strictEqual(byId.get(NEW)?.desktop?.current, true);
  assert.strictEqual(byId.get(NEW)?.ci?.pr?.number, 7, "PR live über seinen Branch abgefragt");
  assert.strictEqual(byId.get(NEW)?.ci?.pr?.ci, "success");
  assert.strictEqual(byId.get(OTHER)?.ci?.pr, undefined, "fremde Session bekommt keinen PR");
});

test("Gruppen der Seitenleiste: jede Desktop-Session kennt ihr Projekt", () => {
  const dir = desktopDir([
    { sessionId: DESK, cliSessionId: NEW, priorCliSessionIds: [OLD], title: "Werkbank umbauen" },
  ]);
  const cfg = path.join(dir, "claude_desktop_config.json");
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      preferences: {
        epitaxyPrefs: {
          "dframe-group-scopes": {
            "org-1/acc-1": {
              groups: [
                { id: "cg-1", name: "Relaunch" },
                { id: "bad id!", name: "Kaputt" },
              ],
              assignments: {
                [`code:${DESK}`]: "cg-1",
                "code:local_kaputt": "cg-1",
                "code:local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": "bad id!",
              },
            },
          },
        },
      },
    }),
  );
  const d = readDesktop(dir, cfg);
  assert.deepStrictEqual(d.byCli.get(NEW)?.group, { id: "cg-1", name: "Relaunch" });
  assert.deepStrictEqual(
    d.byCli.get(OLD)?.group,
    { id: "cg-1", name: "Relaunch" },
    "auch die frühere CLI-Session gehört dazu",
  );
  assert.strictEqual(readGroups(cfg).size, 1, "ungültige IDs werden ignoriert");
  fs.writeFileSync(cfg, "{kaputt");
  assert.strictEqual(
    readDesktop(dir, cfg).byCli.get(NEW)?.group,
    null,
    "kaputte Einstellungen: keine Gruppe, kein Fehler",
  );
});

test("Projekt über mehrere Repos: Sessions im Elternordner zählen die Repos, in denen sie gearbeitet haben", async () => {
  const cfg: Config = { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] };
  const now = Date.now();
  const remote = (n: string) => ({
    provider: "github" as const,
    trusted: true,
    host: "github.com",
    owner: "example",
    repo: n,
    path: `example/${n}`,
    webUrl: `https://github.com/example/${n}`,
  });
  const ROOTS: Record<string, string | null> = {
    "/w": null,
    "/w/app": "/w/app",
    "/w/app/src": "/w/app",
    "/w/api": "/w/api",
    "/w/.wt/x/app": "/w/.wt/x/app",
  };
  const t = (id: string, dirs: string[]): TranscriptData => ({
    id,
    file: "",
    cwd: "/w",
    dirs,
    gitBranch: null,
    title: id,
    summary: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    lastTool: null,
    model: null,
    todos: null,
    startedAt: now,
    lastTimestamp: now,
    ctx: null,
    compactions: 0,
    mtime: now,
  });
  const ov = await buildOverview(cfg, {
    version: "test",
    sources: <Partial<Sources>>{
      readHookStates: async () => ({}),
      scanSessions: async () => [
        t(NEW, ["/w", "/w/app/src", "/w/.wt/x/app"]),
        t(OLD, ["/w/api"]),
        t(OTHER, ["/w/geheim"]),
      ],
      readEvents: async () => [],
      usageData: async () => ({ usage: null, perSession: {}, statusline: {} }),
      getAgents: () => ({ at: now, list: [], error: null, disabledUntil: 0 }),
      readMeta: () => ({ sessions: {} }),
      repoRoot: async (d: string) => ROOTS[d] ?? null,
      gitInfo: async (r: string): Promise<GitInfo> => ({
        root: r,
        name: path.basename(r),
        branch: "main",
        dirty: 0,
        remote: remote(path.basename(r)),
        lastCommit: null,
        behind: 0,
        ahead: 0,
        hasUpstream: true,
      }),
      prsFor: () => null,
      ciFor: () => null,
      handoffFor: () => null,
      desktop: () => {
        const group = { id: "cg-1", name: "Relaunch" };
        const s = (id: string) => ({
          desktopId: DESK,
          cliSessionId: id,
          prior: [],
          title: null,
          model: null,
          archived: false,
          lastActivityAt: 0,
          prs: [],
          group,
        });
        return {
          byCli: new Map([
            [NEW, s(NEW)],
            [OLD, s(OLD)],
          ]),
          successor: new Map(),
        };
      },
    },
  });
  assert.strictEqual(ov.projects.length, 1);
  const p = ov.projects[0];
  assert.ok(p);
  assert.strictEqual(p.name, "Relaunch");
  assert.deepStrictEqual(p.sessions.sort(), [NEW, OLD].sort(), "nur Sessions der Gruppe");
  assert.deepStrictEqual(p.repos, ["/w/app", "/w/api"], "Worktree desselben Repos zählt nicht doppelt");
  assert.ok(
    ov.sessions.every((s) => !("dirs" in s)),
    "Arbeitsordner gehen nicht an die Oberfläche",
  );
});
