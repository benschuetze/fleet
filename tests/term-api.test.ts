// /api/term/* against the real, built server: the guard, the demo terminal, and real processes with an invented claude.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Overview } from "../shared/types";
import { fakeClaude, waitFor } from "./helpers/fake-claude";
import { startServer } from "./helpers/server";

const JSONH = { "Content-Type": "application/json", "X-Fleet": "1" };
const UUID = "6d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Reads a server-sent-events stream for a while; returns the decoded output and the exit events. */
function stream(srv: { port: number; token: string }, id: string, until: (out: string) => boolean, ms = 5000) {
  return new Promise<{ status: number; out: string; exits: string[] }>((resolve) => {
    let out = "";
    const exits: string[] = [];
    let raw = "";
    const req = http.get(
      {
        host: "127.0.0.1",
        port: srv.port,
        path: `/api/term/stream?id=${encodeURIComponent(id)}`,
        headers: { Host: `localhost:${srv.port}`, ...(srv.token ? { Cookie: `fleet_t=${srv.token}` } : {}) },
      },
      (res) => {
        res.setEncoding("utf8");
        const done = () => {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode || 0, out, exits });
        };
        const timer = setTimeout(done, ms);
        res.on("data", (c: string) => {
          raw += c;
          const parts = raw.split("\n\n");
          raw = parts.pop() || "";
          for (const p of parts) {
            const ev = /^event: (\w+)$/m.exec(p)?.[1];
            const data = /^data: (.*)$/m.exec(p)?.[1] || "";
            if (ev === "out") out += Buffer.from(data, "base64").toString("utf8");
            if (ev === "exit") exits.push(data);
          }
          if (until(out) || exits.length) done();
        });
        res.on("end", done);
      },
    );
    req.on("error", () => resolve({ status: 0, out, exits }));
  });
}

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  // The repo root as git (and so the overview) names it. On Windows the temp folder is an 8.3 short path
  // (RUNNER~1) that only the native realpath expands; the server compares roots exactly.
  return fs.realpathSync.native(dir);
}

test("Terminal API: guard, sizes, ids; the demo answers with invented output and echoes, starts nothing", async () => {
  const srv = await startServer({ args: ["--demo"] });
  try {
    const post = (p: string, body: unknown, headers: Record<string, string> = JSONH) =>
      srv.request(p, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const root = ov.repos[0]?.root as string;
    assert.strictEqual((await post("/api/term/new", { root }, { "Content-Type": "application/json" })).status, 403);
    assert.strictEqual(
      (await post("/api/term/new", { root }, { "X-Fleet": "1", "Content-Type": "text/plain" })).status,
      415,
    );
    assert.strictEqual((await post("/api/term/input", { id: "../etc", data: b64("y") })).status, 400);
    assert.strictEqual((await post("/api/term/new", { root: "/nicht/da" })).status, 404);
    assert.strictEqual((await post("/api/term/resume", { id: "unbekannt" })).status, 404);
    assert.strictEqual((await post("/api/term/new", { root, prompt: "x".repeat(21000) })).status, 413);
    assert.strictEqual((await post("/api/term/new", { root, prompt: "x".repeat(4001) })).status, 400);
    assert.strictEqual((await post("/api/term/resize", { id: "demo-01", cols: 5, rows: 24 })).status, 400);
    assert.strictEqual((await post("/api/term/kill", { id: "demo-01", signal: "KILL" })).status, 400);
    assert.strictEqual((await srv.request("/api/term/stream?id=../x")).status, 400);

    const health = JSON.parse((await srv.request("/api/health")).body);
    assert.strictEqual(health.terminal.available, true);
    assert.deepStrictEqual(Object.keys(health.processes), ["interactive", "jobs"]);
    // Two demo sessions run in Fleet's window: one waiting for a yes, one at work.
    assert.deepStrictEqual(
      ov.sessions
        .filter((s) => s.proc)
        .map((s) => s.status)
        .sort(),
      ["needs_input", "working"],
    );
    assert.strictEqual(ov.openTargets[0]?.id, "fleet");

    const r = JSON.parse((await post("/api/term/new", { root, prompt: "Tests grün machen", cwd: "/etc" })).body);
    assert.ok(r.ok && /^demo-term-\d+$/.test(r.id));
    // The page stays attached while it types (a demo session only lives as long as its drawer).
    const s1 = stream(srv, r.id, (o) => /Do you want to proceed\?[\s\S]*y$/.test(o));
    await new Promise((res) => setTimeout(res, 300));
    assert.strictEqual((await post("/api/term/input", { id: r.id, data: b64("y") })).status, 200);
    const s = await s1;
    assert.strictEqual(s.status, 200);
    assert.match(s.out, /Tests grün machen/);
    assert.match(s.out, /y$/, "the input is echoed");
    // An external session: no bridge.
    const ext = ov.sessions.find((s) => !s.proc && s.source === "local") as { id: string };
    const reply = await post("/api/reply", { id: ext.id, text: "ja" });
    assert.strictEqual(reply.status, 422);
    assert.match(JSON.parse(reply.body).error, /extern/);
  } finally {
    await srv.stop();
  }
});

test("Real processes (invented claude, pipes): new, linked row, stream, reply, kill, health counts", async () => {
  const fake = fakeClaude();
  const repo = gitRepo();
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false, extraRepos: [repo] }));
  const srv = await startServer({
    fleetHome,
    env: { CLAUDE_FLEET_PTY: "pipe", FLEET_TEST_CLAUDE: fake.file, FAKE_CLAUDE_LOG: fake.log },
  });
  try {
    const post = (p: string, body: unknown) =>
      srv.request(p, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
    const overview = async () => JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.strictEqual((await overview()).terminal.available, true);
    const r = JSON.parse((await post("/api/term/new", { root: repo, prompt: "Tests grün machen", cwd: "/etc" })).body);
    assert.ok(r.ok, JSON.stringify(r));
    const s = await stream(srv, r.id, (o) => o.includes("Do you want to proceed?"));
    assert.match(s.out, /Erfundenes Claude/);
    const call = fake.calls().find((c) => c.args[0] === "--session-id");
    assert.deepStrictEqual(call?.args, ["--session-id", r.id, "Tests grün machen"]);
    assert.strictEqual(
      fs.realpathSync.native(call?.cwd || ""),
      repo,
      "the folder comes from the overview, not the request",
    );
    let ov = await overview();
    assert.ok(ov.processes.some((p) => p.id === r.id && p.status === "running"));
    const row = ov.sessions.find((x) => x.id === r.id);
    assert.ok(row?.proc, "the process has a row before its transcript exists");
    assert.strictEqual(row?.title, "Tests grün machen");
    // The approval on screen decides nothing; the fake fires no hook, so 10 s after the spawn it waits (rule S).
    await new Promise((res) => setTimeout(res, 1900));
    ov = await overview();
    assert.strictEqual(ov.sessions.find((x) => x.id === r.id)?.status, "working");
    let st = "";
    for (let i = 0; i < 60 && st !== "needs_input"; i++) {
      await new Promise((res) => setTimeout(res, 250));
      st = (await overview()).sessions.find((x) => x.id === r.id)?.status || "";
    }
    assert.strictEqual(st, "needs_input");
    assert.strictEqual(
      (await overview()).sessions.find((x) => x.id === r.id)?.detail,
      "wartet beim Start – bitte ansehen",
    );

    assert.strictEqual((await post("/api/reply", { id: r.id, text: "weiter\nmit Zeile" })).status, 200);
    const echo = await stream(srv, r.id, (o) => o.includes("echo:weiter mit Zeile"));
    assert.match(echo.out, /echo:weiter mit Zeile/, "one line, sent with Enter");
    assert.strictEqual(JSON.parse((await srv.request("/api/health")).body).processes.interactive, 1);
    assert.strictEqual((await post("/api/term/kill", { id: r.id, signal: "term" })).status, 200);
    let h = { processes: { interactive: 1 } };
    for (let i = 0; i < 50 && h.processes.interactive; i++) {
      await new Promise((res) => setTimeout(res, 100));
      h = JSON.parse((await srv.request("/api/health")).body);
    }
    assert.strictEqual(h.processes.interactive, 0);
    const end = await stream(srv, r.id, () => false, 2000);
    assert.strictEqual(end.exits.length, 1, "a late page gets the buffer and the end");
    assert.strictEqual((await post("/api/term/input", { id: r.id, data: b64("x") })).status, 404);
  } finally {
    await srv.stop();
  }
}, 40_000);

test("After a restart: an interrupted session stands with a way to continue; a pending fresh start starts once", async () => {
  const fake = fakeClaude();
  const repo = gitRepo();
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false, extraRepos: [repo] }));
  fs.writeFileSync(
    path.join(fleetHome, "processes.json"),
    JSON.stringify([
      { id: UUID, root: repo, cwd: repo, startedAt: Date.now() - 60e3, pid: 999999, title: "Alter Auftrag" },
    ]),
  );
  fs.writeFileSync(
    path.join(fleetHome, "handoffs.json"),
    JSON.stringify({
      byDir: {
        [repo]: {
          sessionId: "alt",
          requestedAt: Date.now(),
          reason: "x",
          key: "manual:1",
          file: path.join(repo, "HANDOFF.md"),
          openIn: "fleet",
          pendingStart: true,
          pendingPrompt: "Mach mit der Übergabe weiter",
        },
      },
    }),
  );
  const srv = await startServer({
    fleetHome,
    env: { CLAUDE_FLEET_PTY: "pipe", FLEET_TEST_CLAUDE: fake.file, FAKE_CLAUDE_LOG: fake.log },
  });
  try {
    await waitFor(
      () => fake.calls().some((c) => c.args.includes("Mach mit der Übergabe weiter")),
      8000,
      "pending start",
    );
    const reg = JSON.parse(fs.readFileSync(path.join(fleetHome, "handoffs.json"), "utf8"));
    assert.strictEqual(reg.byDir[repo].pendingStart, undefined, "taken once");
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const s = ov.sessions.find((x) => x.id === UUID);
    assert.deepStrictEqual(
      [s?.status, s?.detail, s?.proc?.status],
      ["idle", "durch Fleet-Neustart unterbrochen", "interrupted"],
    );
    const r = await srv.request("/api/term/resume", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ id: UUID }),
    });
    assert.strictEqual(r.status, 200, r.body);
    await waitFor(() => fake.calls().some((c) => c.args[0] === "--resume" && c.args[1] === UUID), 5000, "resume");
    assert.strictEqual(
      fake.calls().filter((c) => c.args.includes("Mach mit der Übergabe weiter")).length,
      1,
      "no second start",
    );
  } finally {
    await srv.stop();
  }
});

test("Without a pty module the terminal is off with a reason; everything else works as before", async () => {
  const repo = gitRepo();
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false, extraRepos: [repo] }));
  const srv = await startServer({ fleetHome });
  try {
    const h = JSON.parse((await srv.request("/api/health")).body);
    assert.deepStrictEqual([h.terminal.available, typeof h.terminal.why], [false, "string"]);
    const r = await srv.request("/api/term/new", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ root: repo }),
    });
    assert.strictEqual(r.status, 422);
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.deepStrictEqual(ov.openTargets.find((t) => t.id === "fleet")?.ok, false);
    assert.ok(
      ov.repos.some((x) => x.root === repo),
      "the overview is unchanged",
    );
  } finally {
    await srv.stop();
  }
});

test("New folder (release 6): created under projectsDir with git, Claude starts there; the request names only the folder", async () => {
  const fake = fakeClaude();
  const base = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-projects-"))), "code");
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false, projectsDir: base }));
  const srv = await startServer({
    fleetHome,
    env: { CLAUDE_FLEET_PTY: "pipe", FLEET_TEST_CLAUDE: fake.file, FAKE_CLAUDE_LOG: fake.log },
  });
  try {
    const post = (p: string, body: unknown) =>
      srv.request(p, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.strictEqual(ov.projectsDir, base);
    for (const name of ["../escape", ".git", "a/b", ""])
      assert.strictEqual((await post("/api/term/new-folder", { name, prompt: "x" })).status, 400, name);
    assert.ok(!fs.existsSync(path.join(base, "..", "escape")));
    const r = JSON.parse(
      (await post("/api/term/new-folder", { name: "rezepte", prompt: "Baue eine Rezept-App", root: "/etc" })).body,
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.created, true);
    const dir = path.join(base, "rezepte");
    assert.ok(fs.existsSync(path.join(dir, ".git")), "git init ran");
    await waitFor(() => fake.calls().some((c) => c.args[0] === "--session-id"));
    const call = fake.calls().find((c) => c.args[0] === "--session-id");
    assert.deepStrictEqual(call?.args, ["--session-id", r.id, "Baue eine Rezept-App"]);
    assert.strictEqual(fs.realpathSync.native(call?.cwd || ""), dir);
    // Again: the folder is there, Claude starts in it, nothing is made anew.
    const again = JSON.parse((await post("/api/term/new-folder", { name: "rezepte", prompt: "" })).body);
    assert.strictEqual(again.created, false);
    for (const id of [r.id, again.id]) await post("/api/term/kill", { id, signal: "term" });
  } finally {
    await srv.stop();
  }
});

test("A session that may still run elsewhere goes on in Fleet's terminal as a branch of its own; force takes it over", async () => {
  // Live on 16.10.2026: Enter on a session waiting in the desktop app stopped at a warning. Terminal first: it opens,
  // as a fork with an id of its own, and the desktop app's transcript stays untouched.
  const fake = fakeClaude();
  const repo = gitRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-fork-"));
  const claudeHome = path.join(tmp, "claude");
  const id = "7e2d3c4b-5f60-4b7c-9d8e-0f1a2b3c4d5e";
  const dir = path.join(claudeHome, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      {
        type: "user",
        sessionId: id,
        cwd: repo,
        timestamp: at(60),
        message: { role: "user", content: "Tests reparieren" },
      },
      {
        type: "assistant",
        sessionId: id,
        cwd: repo,
        timestamp: at(30),
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-5-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: "text", text: "Die Tests sind grün. Soll ich den PR aufmachen?" }],
        },
      },
    ]
      .map((x) => `${JSON.stringify(x)}\n`)
      .join(""),
  );
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(path.join(fleetHome, "config.json"), JSON.stringify({ useAgentView: false, extraRepos: [repo] }));
  const srv = await startServer({
    claudeHome,
    fleetHome,
    env: { CLAUDE_FLEET_PTY: "pipe", FLEET_TEST_CLAUDE: fake.file, FAKE_CLAUDE_LOG: fake.log },
  });
  try {
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.ok(
      ["needs_input", "waiting"].includes(String(ov.sessions.find((x) => x.id === id)?.status)),
      "waits elsewhere",
    );
    const r = await srv.request("/api/term/resume", { method: "POST", headers: JSONH, body: JSON.stringify({ id }) });
    assert.strictEqual(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.forked, true);
    assert.notStrictEqual(j.id, id);
    await waitFor(() => fake.calls().some((c) => c.args.includes("--fork-session")), 5000, "fork");
    const call = fake.calls().find((c) => c.args.includes("--fork-session"));
    assert.deepStrictEqual(call?.args.slice(0, 5), ["--resume", id, "--fork-session", "--session-id", j.id]);
    // Taking the session itself over stays possible
    const f = await srv.request("/api/term/resume", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ id, force: true }),
    });
    assert.strictEqual(f.status, 200, f.body);
    assert.strictEqual(JSON.parse(f.body).id, id);
    await waitFor(
      () =>
        fake.calls().some((c) => c.args[0] === "--resume" && c.args.length >= 2 && !c.args.includes("--fork-session")),
      5000,
      "take over",
    );
  } finally {
    await srv.stop();
  }
}, 30_000);

test("Worktrees (6.1.0): :wt makes one next to the repo and starts Claude there; only finished ones can go", async () => {
  const fake = fakeClaude();
  const repo = gitRepo();
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  fs.writeFileSync(path.join(repo, ".gitignore"), "local.json\n");
  fs.writeFileSync(path.join(repo, "local.json"), "{}\n");
  g("add", ".gitignore");
  g("commit", "-q", "-m", "base");
  g("remote", "add", "origin", repo);
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-term-home-"));
  fs.writeFileSync(
    path.join(fleetHome, "config.json"),
    JSON.stringify({
      useAgentView: false,
      extraRepos: [repo],
      worktree: { repos: { [repo]: { setup: "node --version", include: ["local.json"] } } },
    }),
  );
  const srv = await startServer({
    fleetHome,
    env: { CLAUDE_FLEET_PTY: "pipe", FLEET_TEST_CLAUDE: fake.file, FAKE_CLAUDE_LOG: fake.log },
  });
  try {
    const post = (p: string, body: unknown) =>
      srv.request(p, { method: "POST", headers: JSONH, body: JSON.stringify(body) });
    assert.strictEqual((await post("/api/worktrees", { root: "/etc" })).status, 404);
    const r = await post("/api/term/new", { root: repo, prompt: "Fix login", worktree: true });
    assert.strictEqual(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    const dir = j.worktree.dir as string;
    assert.strictEqual(path.dirname(dir), path.join(path.dirname(repo), `${path.basename(repo)}.wt`));
    assert.match(j.worktree.branch, /^fleet\/fix-login-[0-9a-f]{4}$/);
    assert.deepStrictEqual([j.worktree.copied, j.worktree.setup], [1, "node --version"]);
    assert.ok(fs.existsSync(path.join(dir, "local.json")), "seeded from the config");
    await waitFor(() => fake.calls().some((c) => c.args[0] === "--session-id"));
    const call = fake.calls().find((c) => c.args[0] === "--session-id");
    assert.strictEqual(fs.realpathSync.native(call?.cwd || ""), fs.realpathSync.native(dir));
    // While Claude runs there it is no candidate, and nothing the request names goes.
    const busy = JSON.parse((await post("/api/worktrees", { root: repo, remove: [dir, repo, "/etc"] })).body);
    assert.deepStrictEqual([busy.candidates, busy.removed], [[], []]);
    assert.ok(fs.existsSync(dir));
    assert.strictEqual((await post("/api/term/kill", { id: j.id, signal: "term" })).status, 200);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse((await post("/api/worktrees", { root: repo })).body).candidates.length === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Only the recomputed candidates can go: a foreign path in `remove` does nothing.
    const none = JSON.parse((await post("/api/worktrees", { root: repo, remove: [repo, "/etc"] })).body);
    assert.deepStrictEqual(none.removed, []);
    const gone = JSON.parse((await post("/api/worktrees", { root: repo, remove: [dir] })).body);
    assert.deepStrictEqual(
      gone.removed.map((d: string) => fs.realpathSync.native(path.dirname(d))),
      [fs.realpathSync.native(path.dirname(dir))],
    );
    assert.ok(!fs.existsSync(dir));
    assert.strictEqual(g("branch", "--list", j.worktree.branch).trim(), "");
    assert.ok(fs.existsSync(path.join(repo, "local.json")), "the main folder is untouched");
  } finally {
    await srv.stop();
  }
});
