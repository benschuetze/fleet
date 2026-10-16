// Integration: the real, built server on a free port. Checks the promises from the README (readable locally only,
// no CSRF, strict CSP) and the way from transcript and hook to the overview.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { Overview } from "../shared/types";
import { startServer } from "./helpers/server";

describe("Server in demo mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer({ args: ["--demo"] });
  });
  afterAll(() => srv.stop());

  test("Seite mit strikter CSP und Schutz-Headern", async () => {
    const r = await srv.request("/");
    assert.strictEqual(r.status, 200);
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self' 'sha256-[^']+'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.strictEqual(r.headers["x-frame-options"], "DENY");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
  });

  test("DNS-Rebinding: fremder Host-Header wird abgelehnt", async () => {
    assert.strictEqual(
      (await srv.request("/api/overview", { headers: { Host: `evil.example:${srv.port}` } })).status,
      421,
    );
    assert.strictEqual(
      (await srv.request("/api/overview", { headers: { Host: "localhost:1" } })).status,
      421,
      "falscher Port",
    );
  });

  test("Fremde Webseiten können nichts lesen", async () => {
    assert.strictEqual(
      (await srv.request("/api/overview", { headers: { Origin: "https://evil.example" } })).status,
      403,
    );
    assert.strictEqual(
      (await srv.request("/api/overview", { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
      403,
    );
  });

  test("CSRF: Schreiben nur mit eigenem Header und JSON", async () => {
    const body = JSON.stringify({ id: "demo-00", note: "x" });
    assert.strictEqual(
      (await srv.request("/api/meta", { method: "POST", body, headers: { "Content-Type": "application/json" } }))
        .status,
      403,
    );
    assert.strictEqual(
      (
        await srv.request("/api/meta", {
          method: "POST",
          body,
          headers: { "Content-Type": "text/plain", "X-Fleet": "1" },
        })
      ).status,
      415,
    );
    assert.strictEqual(
      (
        await srv.request("/api/meta", {
          method: "POST",
          body: JSON.stringify({ id: "../x" }),
          headers: { "Content-Type": "application/json", "X-Fleet": "1" },
        })
      ).status,
      400,
    );
    assert.strictEqual(
      (
        await srv.request("/api/meta", {
          method: "POST",
          body: "a".repeat(50000),
          headers: { "Content-Type": "application/json", "X-Fleet": "1" },
        })
      ).status,
      413,
    );
  });

  test("Öffnen: nur mit eigenem Header, bekanntem Ziel und bekannter Session", async () => {
    const post = (b: object, h: Record<string, string> = { "Content-Type": "application/json", "X-Fleet": "1" }) =>
      srv.request("/api/open", { method: "POST", body: JSON.stringify(b), headers: h });
    assert.strictEqual(
      (await post({ id: "demo-00", target: "desktop" }, { "Content-Type": "application/json" })).status,
      403,
    );
    assert.strictEqual((await post({ id: "demo-00", target: "calc.exe" })).status, 400);
    assert.strictEqual((await post({ id: "gibt-es-nicht", target: "desktop" })).status, 404);
    const r = await post({ id: "demo-00", target: "terminal" });
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, demo: true, target: "terminal" }, "Demo startet nichts");
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.deepStrictEqual(
      o.openTargets.filter((x) => x.ok).map((x) => x.id),
      ["fleet", "desktop", "vscode", "terminal"],
      "Fleet's own terminal first",
    );
    assert.deepStrictEqual(o.sessions.find((x) => x.id === "demo-16")?.next, {
      id: "demo-06",
      title: "Flaky Login-Test stabilisieren",
    });
  });

  test("Entscheidung beantworten: nur mit eigenem Header und mit einer angebotenen Antwort", async () => {
    const post = (b: object, h: Record<string, string> = { "Content-Type": "application/json", "X-Fleet": "1" }) =>
      srv.request("/api/decision", { method: "POST", body: JSON.stringify(b), headers: h });
    assert.strictEqual(
      (await post({ id: "demo-entscheidung", answer: "rethink" }, { "Content-Type": "application/json" })).status,
      403,
    );
    assert.strictEqual((await post({ id: "demo-entscheidung", answer: "rm -rf" })).status, 400);
    assert.strictEqual((await post({ id: "../../etc/passwd", answer: "stop" })).status, 400);
    assert.strictEqual((await post({ id: "gibt-es-nicht", answer: "stop" })).status, 404);
    assert.strictEqual((await post({ id: "demo-entscheidung", answer: "rethink" })).status, 200);
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.deepStrictEqual(
      o.decisions.map((d) => [d.project, d.cwd]),
      [
        ["mobile-app", ""],
        ["data-pipeline", ""],
      ],
      "Projekt ja, Ordner nie an die Oberfläche",
    );
  });

  test("Frisch starten: nur mit eigenem Header und für bekannte Sessions; großer Kontext zeigt die Ersparnis", async () => {
    const post = (b: object, h: Record<string, string> = { "Content-Type": "application/json", "X-Fleet": "1" }) =>
      srv.request("/api/fresh", { method: "POST", body: JSON.stringify(b), headers: h });
    assert.strictEqual((await post({ id: "demo-00" }, { "Content-Type": "application/json" })).status, 403);
    assert.strictEqual((await post({ id: "../x" })).status, 400);
    assert.strictEqual((await post({ id: "gibt-es-nicht" })).status, 404);
    assert.strictEqual((await post({ id: "demo-00" })).status, 200);
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const s = o.sessions.find((x) => x.id === "demo-00");
    assert.ok((s?.fresh?.perCall || 0) > 0.1, `874 Tsd. Tokens Kontext kosten je Aufruf ${s?.fresh?.perCall} $`);
    assert.strictEqual(o.sessions.find((x) => x.id === "demo-14")?.fresh, undefined, "kleiner Kontext: kein Knopf");
  });

  test("Weitermachen: nur Repos mit Übergabe, nur bekannte Ziele", async () => {
    const post = (b: object) =>
      srv.request("/api/continue", {
        method: "POST",
        body: JSON.stringify(b),
        headers: { "Content-Type": "application/json", "X-Fleet": "1" },
      });
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const root = o.repos.find((r) => r.handoff)?.root;
    assert.strictEqual((await post({ root, target: "sh" })).status, 400);
    assert.strictEqual((await post({ root: "/etc", target: "desktop" })).status, 404);
    assert.strictEqual((await post({ root, target: "desktop" })).status, 200);
    assert.strictEqual(
      (
        await srv.request("/api/continue", {
          method: "POST",
          body: JSON.stringify({ root, target: "desktop" }),
          headers: { "Content-Type": "application/json" },
        })
      ).status,
      403,
    );
  });

  test("Projekt-Briefing: nur bekannte Projekte und Ziele, nur mit Fleet-Kopfzeile", async () => {
    const post = (b: object, h: Record<string, string> = { "X-Fleet": "1" }) =>
      srv.request("/api/project-brief", {
        method: "POST",
        body: JSON.stringify(b),
        headers: { "Content-Type": "application/json", ...h },
      });
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.deepStrictEqual(
      o.projects.map((p) => p.name),
      ["Checkout-Relaunch"],
    );
    const id = o.projects[0]?.id;
    assert.strictEqual((await post({ id, target: "sh" })).status, 400);
    assert.strictEqual((await post({ id: "gibt-es-nicht", target: "desktop" })).status, 404);
    assert.strictEqual((await post({ id, target: "desktop" })).status, 200);
    assert.strictEqual((await post({ id, target: "desktop" }, {})).status, 403);
  });

  test("Notiz wird gespeichert und erscheint in der Übersicht", async () => {
    const r = await srv.request("/api/meta", {
      method: "POST",
      body: JSON.stringify({ id: "demo-00", note: "PR erst nach Review", pinned: true }),
      headers: { "Content-Type": "application/json", "X-Fleet": "1" },
    });
    assert.strictEqual(r.status, 200);
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const s = o.sessions.find((x) => x.id === "demo-00");
    assert.deepStrictEqual(s?.meta, { pinned: true, note: "PR erst nach Review" });
    assert.ok(
      fs.existsSync(path.join(srv.fleetHome, "meta.json")) === false,
      "Demo schreibt nie in das übergebene Fleet-Verzeichnis",
    );
  });

  test("Übersicht: erfundene Daten, alle Zustände, ETag", async () => {
    const r = await srv.request("/api/overview");
    const o = JSON.parse(r.body) as Overview;
    assert.strictEqual(o.demo, true);
    const statuses = new Set(o.sessions.map((s) => s.status));
    for (const st of ["working", "stale", "needs_input", "error", "waiting", "idle", "ended"])
      assert.ok(statuses.has(st as Overview["sessions"][number]["status"]), st);
    assert.ok(o.sessions.every((s) => s.id.startsWith("demo-") || s.source === "cowork"));
    assert.ok(
      o.sessions.some((s) => !!s.loop),
      "Schleife in der Demo",
    );
    assert.ok(
      o.sessions.some((s) => (s.advice || []).some((a) => a.kind === "model" && !!a.model)),
      "Modell-Tipp in der Demo",
    );
    const again = await srv.request("/api/overview", { headers: { "If-None-Match": String(r.headers.etag) } });
    assert.ok([200, 304].includes(again.status));
  });

  test("Week report: Markdown and JSON as a download, small, foreign pages cannot read it", async () => {
    const md = await srv.request("/api/report/week?format=md");
    assert.strictEqual(md.status, 200);
    assert.match(String(md.headers["content-type"]), /^text\/markdown/);
    assert.match(
      String(md.headers["content-disposition"]),
      /^attachment; filename="fleet-week-\d{4}-\d{2}-\d{2}\.md"$/,
    );
    assert.match(md.body, /^# Claude Fleet/);
    const js = await srv.request("/api/report/week?format=json");
    assert.strictEqual(js.status, 200);
    assert.match(String(js.headers["content-disposition"]), /\.json"$/);
    const r = JSON.parse(js.body);
    assert.deepStrictEqual([r.schema, r.version], ["claude-fleet/week-report", 1]);
    assert.ok(r.repos.length > 0 && r.alarms.length > 0, "the demo week has sessions and alarms");
    for (const b of [md.body, js.body]) assert.ok(b.length < 15000, "under 5,000 tokens");
    assert.strictEqual((await srv.request("/api/report/week?format=pdf")).status, 400);
    assert.strictEqual(
      (await srv.request("/api/report/week", { headers: { Origin: "https://evil.example" } })).status,
      403,
    );
    assert.strictEqual((await srv.request("/api/report/week", { method: "POST", body: "{}" })).status, 403);
  });

  test("Dashboard: client routes get the page, assets are cached for good, nothing outside build/client", async () => {
    for (const p of ["/repos", "/usage", "/activity"]) assert.strictEqual((await srv.request(p)).status, 200, p);
    const html = (await srv.request("/")).body;
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] || /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    assert.ok(asset, "the page references its bundle");
    const a = await srv.request(String(asset));
    assert.strictEqual(a.status, 200);
    assert.match(String(a.headers["cache-control"]), /immutable/);
    for (const p of [
      "/../package.json",
      "/assets/../../package.json",
      "/%2e%2e/%2e%2e/package.json",
      "/dist/fleet.cjs",
      "/nope",
    ])
      assert.strictEqual((await srv.request(p)).status, 404, p);
    assert.strictEqual((await srv.request("/", { method: "POST", headers: { "X-Fleet": "1" } })).status, 405);
  });

  test("Architecture for the repo drawer: only repos of the overview, plain Markdown, an empty state", async () => {
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const shop = o.repos.find((r) => r.name === "shop-frontend");
    const infra = o.repos.find((r) => r.name === "infra");
    assert.ok(shop && infra);
    const get = (root: string) => srv.request(`/api/architecture?root=${encodeURIComponent(root)}`);
    const a = await get(shop.root);
    assert.strictEqual(a.status, 200);
    const doc = JSON.parse(a.body);
    assert.strictEqual(doc.file, ".architektur/README.md");
    assert.match(doc.text, /^# shop-frontend/);
    assert.strictEqual(doc.mappe, true);
    assert.strictEqual(JSON.parse((await get(infra.root)).body).text, null);
    for (const root of ["/etc", `${shop.root}/..`, ""]) assert.strictEqual((await get(root)).status, 404, root);
    assert.strictEqual(
      (await srv.request("/api/architecture", { method: "POST", headers: { "X-Fleet": "1" } })).status,
      405,
    );
    const foreign = await srv.request(`/api/architecture?root=${encodeURIComponent(shop.root)}`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.strictEqual(foreign.status, 403);
  });

  test("Merge anyway is refused unless CI could not start", async () => {
    const post = (b: object) =>
      srv.request("/api/merge", {
        method: "POST",
        body: JSON.stringify(b),
        headers: { "Content-Type": "application/json", "X-Fleet": "1" },
      });
    assert.strictEqual(
      (await post({ id: "demo-12" })).status,
      200,
      "the approved PR #112 merges (demo: nothing happens)",
    );
    assert.strictEqual((await post({ id: "demo-13" })).status, 404, "no PR, nothing to merge");
  });

  test("Offene PRs mergen: Repo und PR aus der eigenen Übersicht, rote CI nur bestätigt, gestapelt erst nach dem unteren", async () => {
    const post = (
      b: object,
      headers: Record<string, string> = { "Content-Type": "application/json", "X-Fleet": "1" },
    ) => srv.request("/api/merge-pr", { method: "POST", body: JSON.stringify(b), headers });
    const ov = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const root = (name: string) => ov.repos.find((r) => r.name === name)?.root || "";
    assert.ok(root("docs-site"), "Demo-Repo mit PR ohne Session");
    assert.strictEqual(ov.repos.find((r) => r.name === "docs-site")?.prs?.prs?.[0]?.number, 14);

    assert.strictEqual((await post({ root: root("docs-site"), number: 14 })).status, 200, "grün: mergt");
    assert.strictEqual((await post({ root: root("billing-service"), number: 48 })).status, 409, "rot ohne Bestätigung");
    assert.strictEqual(
      (await post({ root: root("billing-service"), number: 48, force: true })).status,
      200,
      "rot mit Bestätigung",
    );
    const stacked = await post({ root: root("billing-service"), number: 52, force: true });
    assert.strictEqual(stacked.status, 409, "gestapelt: auch mit Bestätigung nicht");
    assert.match(stacked.body, /#51/);
    // The dashboard shows both buttons disabled; the server refuses them anyway (second safety).
    const draft = await post({ root: root("shop-frontend"), number: 231, force: true });
    assert.strictEqual(draft.status, 409, "Entwurf: auch mit Bestätigung nicht");
    assert.match(draft.body, /Entwurf/);
    assert.strictEqual(
      ov.repos.find((r) => r.name === "docs-site")?.prs?.prs?.[0]?.commits,
      3,
      "the commit count reaches the merge question",
    );
    assert.strictEqual((await post({ root: root("billing-service"), number: 999 })).status, 404);
    assert.strictEqual(
      (await post({ root: "/etc", number: 14 })).status,
      404,
      "fremder Ordner ist kein Repo der Übersicht",
    );
    assert.strictEqual((await post({ root: root("docs-site"), number: "14" })).status, 400);
    assert.strictEqual(
      (await post({ root: root("docs-site"), number: 14 }, { "Content-Type": "application/json" })).status,
      403,
      "ohne X-Fleet",
    );
    assert.strictEqual(
      (await post({ root: root("docs-site"), number: 14 }, { "Content-Type": "text/plain", "X-Fleet": "1" })).status,
      415,
    );
  });

  test("Live-Push: Server-Sent Events", async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: srv.port, path: "/api/stream", headers: { Host: `localhost:${srv.port}` } },
        (res) => {
          assert.strictEqual(res.headers["content-type"], "text/event-stream; charset=utf-8");
          res.once("data", (d) => {
            resolve(String(d));
            req.destroy();
          });
        },
      );
      req.on("error", reject);
    });
    assert.match(String(first), /retry: \d+/);
  });
});

test("Real mode: transcript and hook state make up the overview", async () => {
  // Daten vor dem Start anlegen: der Server rechnet die Übersicht beim Start schon einmal vor
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-real-"));
  const srv = { claudeHome: path.join(tmp, "claude"), fleetHome: path.join(tmp, "fleet") };
  // Erfundenes Transcript einer fertigen Session und eine Session, die auf Erlaubnis wartet
  const dir = path.join(srv.claudeHome, "projects", "-tmp-projekt");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    path.join(dir, "aaaa-fertig.jsonl"),
    line({ type: "user", cwd: "/tmp/projekt", timestamp: now, message: { role: "user", content: "Baue den Export" } }) +
      line({
        type: "assistant",
        timestamp: now,
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 40000 },
          content: [{ type: "text", text: "Export ist fertig." }],
        },
      }),
  );
  fs.writeFileSync(
    path.join(dir, "bbbb-frage.jsonl"),
    line({ type: "user", cwd: "/tmp/projekt", timestamp: now, message: { role: "user", content: "Deploy bitte" } }),
  );
  fs.mkdirSync(path.join(srv.fleetHome, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(srv.fleetHome, "state", "bbbb-frage.json"),
    JSON.stringify({
      sessionId: "bbbb-frage",
      status: "needs_input",
      event: "PermissionRequest",
      detail: "Freigabe für Bash",
      at: Date.now() + 1000,
      startedAt: Date.now(),
      statusSince: Date.now(),
    }),
  );
  const server = await startServer(srv);
  try {
    const o = JSON.parse((await server.request("/api/overview")).body) as Overview;
    assert.strictEqual(o.demo, false);
    const byId = Object.fromEntries(o.sessions.map((s) => [s.id, s]));
    assert.deepStrictEqual([byId["aaaa-fertig"]?.status, byId["aaaa-fertig"]?.statusSource], ["waiting", "transcript"]);
    assert.strictEqual(byId["aaaa-fertig"]?.lastAssistant, "Export ist fertig.");
    assert.ok((byId["aaaa-fertig"]?.usage?.cost || 0) > 0);
    assert.deepStrictEqual(
      [byId["bbbb-frage"]?.status, byId["bbbb-frage"]?.detail],
      ["needs_input", "Freigabe für Bash"],
    );
    for (const s of o.sessions)
      for (const k of ["file", "hook", "recent", "pending", "edited", "dirs"])
        assert.ok(!(k in s), `internes Feld ${k} geht nicht an die Oberfläche`);
  } finally {
    await server.stop();
  }
});

test("Real mode: Fleet's own turns and what they saved arrive as usage.balance; billing defaults to the plan", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-bal-"));
  const srv = { claudeHome: path.join(tmp, "claude"), fleetHome: path.join(tmp, "fleet") };
  const dir = path.join(srv.claudeHome, "projects", "-tmp-projekt");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(srv.fleetHome, { recursive: true });
  const t0 = Date.now() - 3600e3;
  const iso = (t: number) => new Date(t).toISOString();
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const answer = (id: string, t: number, cr: number, o = 100) =>
    line({
      type: "assistant",
      timestamp: iso(t),
      cwd: "/tmp/projekt",
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 0, output_tokens: o, cache_read_input_tokens: cr },
      },
    });
  // The old session writes its handoff on Fleet's request (one call), the new one continues with a small context.
  fs.writeFileSync(path.join(dir, "alt.jsonl"), answer("a1", t0, 500_000) + answer("a2", t0 + 60e3, 500_000, 2000));
  fs.writeFileSync(
    path.join(dir, "neu.jsonl"),
    answer("n1", t0 + 5 * 60e3, 30_000) + answer("n2", t0 + 6 * 60e3, 40_000),
  );
  const marks = [
    { phase: "begin", sessionId: "alt", kind: "handoff", at: t0 + 30e3 },
    { phase: "end", sessionId: "alt", kind: "handoff", at: t0 + 90e3 },
    { phase: "begin", sessionId: "neu", kind: "continue", at: t0 + 4 * 60e3, prev: ["alt"] },
    { phase: "end", sessionId: "neu", kind: "continue", at: t0 + 5 * 60e3 + 30e3 },
  ];
  fs.writeFileSync(path.join(srv.fleetHome, "fleet-turns.jsonl"), marks.map(line).join(""));
  fs.writeFileSync(path.join(srv.fleetHome, "config.json"), JSON.stringify({ useAgentView: false }));
  const server = await startServer(srv);
  try {
    const o = JSON.parse((await server.request("/api/overview")).body) as Overview;
    assert.strictEqual(o.billing, "subscription");
    const b = o.usage?.balance;
    assert.ok(b, "a balance with Fleet activity");
    assert.strictEqual(b.cost.byKind.handoff?.tok, 502_000, "the handoff call");
    assert.strictEqual(b.cost.byKind.continue?.tok, 30_100, "the successor's first turn");
    assert.strictEqual(b.saved.fresh.tok, 470_000 + 460_000, "each realised call of the successor against the old one");
    assert.strictEqual(b.saved.fresh.calls, 2);
    assert.strictEqual(b.incomplete, false);
  } finally {
    await server.stop();
  }
  fs.writeFileSync(path.join(srv.fleetHome, "config.json"), JSON.stringify({ useAgentView: false, billing: "api" }));
  const api = await startServer(srv);
  try {
    assert.strictEqual((JSON.parse((await api.request("/api/overview")).body) as Overview).billing, "api");
  } finally {
    await api.stop();
  }
});
