// The log view's API against the real, built server: in demo mode (invented steps) and in real mode (invented
// transcripts in a temporary Claude folder). Every session appears, new lines come without a restart, the waiting
// session's newest line and every error carry their signal once.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { LOG_MAX, signals } from "../shared/log";
import type { LogPage, Overview } from "../shared/types";
import { startServer } from "./helpers/server";

const page = (body: string) => JSON.parse(body) as LogPage;

describe("Log API in demo mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let o: Overview;
  let p: LogPage;
  beforeAll(async () => {
    srv = await startServer({ args: ["--demo"] });
    o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    const r = await srv.request("/api/log");
    assert.strictEqual(r.status, 200);
    p = page(r.body);
  });
  afterAll(() => srv.stop());

  test(`At most ${LOG_MAX} lines in time order, sessions the overview does not show among them`, () => {
    assert.ok(p.lines.length > 100 && p.lines.length <= LOG_MAX, String(p.lines.length));
    assert.ok(p.lines.every((l, i) => i === 0 || (p.lines[i - 1]?.at ?? 0) <= l.at));
    const known = new Set(o.sessions.map((s) => s.id));
    const only = [...new Set(p.lines.map((l) => l.session))].filter((id) => !known.has(id));
    assert.deepStrictEqual(only.sort(), [
      "a9d4e2f7-1b3c-4e5f-a6b7-c8d9e0f1a2b3",
      "c0ffee12-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    ]);
    // Without a title: no name, only the folder.
    assert.deepStrictEqual(p.sessions["c0ffee12-3a4b-4c5d-8e9f-0a1b2c3d4e5f"], {
      name: null,
      project: "billing-service",
    });
  });

  test("Status wartet: the waiting sessions of Now, each with exactly one orange line, its newest", () => {
    const needs = o.sessions.filter((s) => s.status === "needs_input" && !s.meta?.hidden).map((s) => s.id);
    assert.ok(needs.length > 0);
    for (const id of needs) assert.ok(p.waiting.includes(id), `${id} waits`);
    const sig = signals(p.lines, p.waiting);
    for (const id of p.waiting) {
      const mine = p.lines.filter((l) => l.session === id);
      if (!mine.length) continue;
      const warn = mine.filter((l) => sig.get(l.seq) === "warn");
      assert.strictEqual(warn.length, 1, `${id}: one orange line`);
      assert.strictEqual(warn[0], mine.at(-1));
    }
  });

  test("Status fehler: the API error of a session in error is a red line", () => {
    const err = o.sessions.find((s) => s.project === "crm-sync" && s.status === "error");
    assert.ok(err);
    const last = p.lines.filter((l) => l.session === err.id).at(-1);
    assert.strictEqual(last?.kind, "error");
    assert.match(last?.text || "", /limit/i);
  });

  test("session: only that session's last 12 steps, for its drawer; a bad id is 400", async () => {
    const busy = [...new Set(p.lines.map((l) => l.session))]
      .map((id) => ({ id, n: p.lines.filter((l) => l.session === id).length }))
      .sort((a, b) => b.n - a.n)[0];
    assert.ok(busy && busy.n > 12, "a session with more than 12 steps");
    const r = page((await srv.request(`/api/log?session=${busy.id}`)).body);
    assert.strictEqual(r.lines.length, 12);
    assert.ok(r.lines.every((l) => l.session === busy.id));
    assert.deepStrictEqual(
      r.lines.map((l) => l.seq),
      p.lines
        .filter((l) => l.session === busy.id)
        .slice(-12)
        .map((l) => l.seq),
    );
    assert.strictEqual((await srv.request("/api/log?session=..%2F..%2Fetc")).status, 400);
  });

  test("after: only newer lines; bad input 400, writing 405", async () => {
    const r = page((await srv.request(`/api/log?after=${p.seq}`)).body);
    assert.ok(r.lines.every((l) => l.seq > p.seq));
    assert.strictEqual(r.epoch, p.epoch);
    assert.strictEqual((await srv.request("/api/log?after=-1")).status, 400);
    assert.strictEqual((await srv.request("/api/log?after=abc")).status, 400);
    const post = { method: "POST", body: "{}", headers: { "X-Fleet": "1", "Content-Type": "application/json" } };
    assert.strictEqual((await srv.request("/api/log", post)).status, 405);
  });
});

test("Real mode: transcripts become lines, appended steps come without a restart, signals once", async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-log-real-")));
  const repo = path.join(tmp, "shop");
  fs.mkdirSync(repo, { recursive: true });
  const claudeHome = path.join(tmp, "claude");
  const dir = path.join(claudeHome, "projects", "-tmp-shop");
  fs.mkdirSync(dir, { recursive: true });
  const at = (s: number) => new Date(Date.now() - 60e3 + s * 1000).toISOString();
  const write = (id: string, objs: object[]) =>
    fs.appendFileSync(path.join(dir, `${id}.jsonl`), objs.map((x) => `${JSON.stringify(x)}\n`).join(""));
  const assistant = (s: number, content: object[], extra: object = {}) => ({
    type: "assistant",
    cwd: repo,
    timestamp: at(s),
    message: { model: "claude-opus-5-5", stop_reason: "end_turn", content },
    ...extra,
  });
  write("asks", [
    { type: "user", cwd: repo, timestamp: at(0), message: { role: "user", content: "Mach den Checkout fertig" } },
    assistant(1, [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: path.join(repo, "src", "a.ts") } }]),
    { type: "user", cwd: repo, timestamp: at(2), message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
    assistant(3, [{ type: "text", text: "Fertig umgebaut. Soll ich den PR mergen?" }]),
  ]);
  write("broke", [
    { type: "user", cwd: repo, timestamp: at(4), message: { role: "user", content: "Tests reparieren" } },
    assistant(5, [{ type: "text", text: "API Error: 529 Overloaded" }], {
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
    }),
  ]);
  const srv = await startServer({ claudeHome });
  try {
    const o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
    assert.strictEqual(o.sessions.find((s) => s.id === "asks")?.status, "needs_input");
    const p = page((await srv.request("/api/log")).body);
    const text = (id: string) => p.lines.filter((l) => l.session === id).map((l) => `${l.kind} ${l.text}`);
    assert.deepStrictEqual(text("asks"), [
      "prompt Mach den Checkout fertig",
      "tool src/a.ts",
      "text Fertig umgebaut. Soll ich den PR mergen?",
    ]);
    assert.deepStrictEqual(text("broke"), ["prompt Tests reparieren", "error API Error: 529 Overloaded"]);
    assert.deepStrictEqual(p.waiting, ["asks"]);
    const sig = signals(p.lines, p.waiting);
    assert.deepStrictEqual(
      p.lines.map((l) => sig.get(l.seq) ?? null),
      [null, null, "warn", null, "crit"],
    );
    assert.deepStrictEqual(p.sessions.asks, { name: "Mach den Checkout fertig", project: "shop" });

    write("asks", [
      { type: "user", cwd: repo, timestamp: at(10), message: { role: "user", content: "ja" } },
      assistant(11, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "gh pr merge 8" } }]),
    ]);
    const next = page((await srv.request(`/api/log?after=${p.seq}`)).body);
    assert.deepStrictEqual(
      next.lines.map((l) => `${l.kind} ${l.text}`),
      ["prompt ja", "tool gh pr merge 8"],
    );
    // The overview is cached for a second; the answer reaches "waiting" with its next build.
    let waiting = next.waiting;
    for (let i = 0; i < 30 && waiting.includes("asks"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      waiting = page((await srv.request(`/api/log?after=${next.seq}`)).body).waiting;
    }
    assert.ok(!waiting.includes("asks"), "answered: no longer waiting, no orange left");
  } finally {
    await srv.stop();
  }
});
