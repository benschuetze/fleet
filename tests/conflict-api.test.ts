// The conflict drawer's API against the real, built server: in demo mode (invented PRs and sessions) and in real
// mode (a git repo and two invented transcripts that edited the same file).
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { ConflictHunks, ConflictView, Overview } from "../shared/types";
import { startServer } from "./helpers/server";

const q = (root: string, a: string, b: string) =>
  `root=${encodeURIComponent(root)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;

describe("Conflict API in demo mode", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let o: Overview;
  const rootOf = (name: string) => o.repos.find((r) => r.name === name)?.root as string;
  beforeAll(async () => {
    srv = await startServer({ args: ["--demo"] });
    o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
  });
  afterAll(() => srv.stop());

  test("Konflikt-Punkt in der PR-Liste: an beiden PRs des Paars, saubere PRs mit leerer Liste", () => {
    const prs = o.repos.find((r) => r.name === "billing-service")?.prs?.prs || [];
    assert.deepStrictEqual(
      prs.map((p) => [p.number, p.conflicts]),
      [
        [51, [{ with: 48, files: ["src/invoice/totals.ts"] }]],
        [52, []],
        [48, [{ with: 51, files: ["src/invoice/totals.ts"] }]],
      ],
    );
  });

  test("Doppelt nur mit Dateischnitt: design-system doppelt, docs-site parallel ohne Überschneidung", () => {
    const d = Object.fromEntries(o.duplicates.map((x) => [x.repo, x]));
    assert.deepStrictEqual([d["design-system"]?.overlap, d["design-system"]?.pairs.length], [true, 1]);
    assert.deepStrictEqual([d["docs-site"]?.overlap, d["docs-site"]?.pairs], [false, []]);
  });

  test("Zwei PRs: Dateischnitt und echter Konflikt; Hunks nur für Dateien der beiden Seiten", async () => {
    const root = rootOf("billing-service");
    const r = await srv.request(`/api/conflict?${q(root, "pr:48", "pr:51")}`);
    assert.strictEqual(r.status, 200);
    const v = JSON.parse(r.body) as ConflictView;
    assert.deepStrictEqual([v.a.label, v.b.label], ["#48 Steuerbeträge je Position runden", "#51 PDF/A-3-Export"]);
    assert.deepStrictEqual([v.shared, v.conflicts], [["src/invoice/totals.ts"], ["src/invoice/totals.ts"]]);
    const h = JSON.parse(
      (await srv.request(`/api/conflict/hunks?${q(root, "pr:48", "pr:51")}&file=src%2Finvoice%2Ftotals.ts`)).body,
    ) as ConflictHunks;
    assert.match(h.a || "", /roundTax/);
    assert.match(h.b || "", /taxFor/);
    assert.strictEqual(
      (await srv.request(`/api/conflict/hunks?${q(root, "pr:48", "pr:51")}&file=README.md`)).status,
      404,
    );
    assert.strictEqual((await srv.request(`/api/conflict/hunks?${q(root, "pr:48", "pr:51")}`)).status, 400);
  });

  test("Zwei Sessions: der Dateischnitt aus ihren Transcripts", async () => {
    const d = o.duplicates.find((x) => x.repo === "design-system");
    const [a, b] = d?.pairs[0] || [];
    const v = JSON.parse(
      (await srv.request(`/api/conflict?${q(d?.root as string, `s:${a}`, `s:${b}`)}`)).body,
    ) as ConflictView;
    assert.deepStrictEqual(v.shared, ["src/tokens/colors.ts"]);
    assert.strictEqual(v.conflicts, null, "same branch: nothing to merge");
    assert.match(v.why || "", /demselben Branch/);
  });

  test("Eingaben: nur Seiten aus der eigenen Übersicht", async () => {
    const root = rootOf("billing-service");
    const other = o.sessions.find((s) => s.project === "shop-frontend")?.id as string;
    const status = async (p: string) => (await srv.request(p)).status;
    assert.strictEqual(await status(`/api/conflict?${q(root, "pr:48", "pr:48")}`), 400, "the same side twice");
    assert.strictEqual(await status(`/api/conflict?root=${encodeURIComponent(root)}&a=pr:48`), 400);
    assert.strictEqual(await status(`/api/conflict?${q(root, "x:1", "pr:48")}`), 400);
    assert.strictEqual(await status(`/api/conflict?${q(root, "s:../etc", "pr:48")}`), 400);
    assert.strictEqual(await status(`/api/conflict?${q("/nicht/da", "pr:48", "pr:51")}`), 404);
    assert.strictEqual(await status(`/api/conflict?${q(root, "pr:999", "pr:51")}`), 404);
    assert.strictEqual(
      await status(`/api/conflict?${q(root, `s:${other}`, "pr:51")}`),
      404,
      "a session of another repo",
    );
    const post = { method: "POST", body: "{}", headers: { "X-Fleet": "1", "Content-Type": "application/json" } };
    assert.strictEqual((await srv.request("/api/conflict", post)).status, 405, "read only");
  });
});

test("Real mode: two transcripts edited the same file – duplicate, conflict mark and drawer, paths stay inside", async () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conflict-real-")));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=fleet@example.com", "-c", "user.name=Fleet Test", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "src", "x.ts"), "a\nb\n");
  git("add", ".");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(repo, "src", "x.ts"), "a\nB\n");

  const claudeHome = path.join(tmp, "claude");
  const dir = path.join(claudeHome, "projects", "-tmp-repo");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const session = (id: string, task: string, files: string[]) =>
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      line({ type: "user", cwd: repo, timestamp: now, message: { role: "user", content: task } }) +
        files
          .map((f, i) =>
            line({
              type: "assistant",
              timestamp: now,
              message: {
                id: `${id}-e${i}`,
                model: "claude-opus-5-5",
                content: [
                  { type: "tool_use", id: `${id}-t${i}`, name: "Edit", input: { file_path: path.join(repo, f) } },
                ],
              },
            }),
          )
          .join("") +
        line({
          type: "assistant",
          timestamp: now,
          message: {
            id: `${id}-end`,
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: "text", text: "Fertig." }],
          },
        }),
    );
  session("aaaa-haertung", "Härte die Eingaben", ["src/x.ts", "src/a.ts"]);
  session("bbbb-doku", "Schreibe die Doku", ["src/x.ts", "docs/b.md"]);

  const srv = await startServer({ claudeHome, fleetHome: path.join(tmp, "fleet") });
  try {
    const body = (await srv.request("/api/overview")).body;
    const o = JSON.parse(body) as Overview;
    const d = o.duplicates.find((x) => x.root === repo);
    assert.deepStrictEqual([d?.overlap, d?.files, d?.pairs.length], [true, ["src/x.ts"], 1]);
    assert.deepStrictEqual(o.sessions.find((s) => s.id === "aaaa-haertung")?.conflict?.files, ["src/x.ts"]);
    assert.ok(!body.includes(path.join(repo, "src", "x.ts")), "edited paths stay on the server");
    const v = JSON.parse(
      (await srv.request(`/api/conflict?${q(repo, "s:aaaa-haertung", "s:bbbb-doku")}`)).body,
    ) as ConflictView;
    assert.deepStrictEqual(
      [v.a.files, v.b.files, v.shared],
      [["src/x.ts", "src/a.ts"], ["src/x.ts", "docs/b.md"], ["src/x.ts"]],
    );
    const h = JSON.parse(
      (await srv.request(`/api/conflict/hunks?${q(repo, "s:aaaa-haertung", "s:bbbb-doku")}&file=src%2Fx.ts`)).body,
    ) as ConflictHunks;
    assert.match(h.a || "", /^\+B$/m, "the working tree against main");
  } finally {
    await srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
