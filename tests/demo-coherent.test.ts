// The demo tells one story per session (practical test 15 Oct): the board's activity is the conversation's running
// step, a session that changes no code has no edit and no diff, the diff has the files the log edits, the last
// answer stands once.
import assert from "node:assert";
import { test } from "vitest";
import { loadConfig } from "../server/core/config";
import { DEMO_FILES, demoLogSessions, demoSources } from "../server/core/demo";
import { demoDiff } from "../server/core/demo-diff";
import { demoChat, demoLog, demoNowTool } from "../server/core/demo-log";
import { buildOverview } from "../server/core/overview";
import type { Session } from "../shared/types";

const now = Date.now() + 5 * 60e3;
const sessions = demoLogSessions();

test("a working session's activity is its conversation's running step", () => {
  for (const s of sessions.filter((x) => x.status === "working")) {
    const chat = demoChat(s.id, { status: "working" }, now);
    const last = chat.entries.at(-1);
    if (last?.kind !== "tool") continue;
    assert.strictEqual(demoNowTool(s.id, now), last.tool, s.id);
  }
});

test("a session that changes no code has no edit in its conversation and an empty diff", () => {
  const light = sessions.filter((x) => x.readOnly);
  assert.ok(light.length > 0);
  for (const s of light) {
    assert.ok(!demoChat(s.id, { status: s.status }, now).entries.some((e) => e.tool === "Edit"), s.id);
    assert.deepStrictEqual(demoDiff({ id: s.id, title: "x" } as Session).files, [], s.id);
  }
});

test("the diff shows the files the log edits", () => {
  for (const s of sessions.filter((x) => !x.readOnly).slice(0, 4)) {
    const edited = new Set(
      demoLog(now)
        .lines.filter((l) => l.session === s.id && l.tool === "Edit")
        .map((l) => l.text),
    );
    const files = demoDiff({ id: s.id, title: "x" } as Session).files.map((f) => f.path);
    for (const f of edited) assert.ok(files.includes(f), `${s.id}: ${f} in ${files.join(", ")}`);
    if (!s.edits.length) assert.deepStrictEqual(files, DEMO_FILES);
  }
});

test("the last answer of a finished session stands once", () => {
  for (const s of sessions.filter((x) => x.answer && x.status !== "working")) {
    const said = demoChat(s.id, { status: s.status, lastAssistant: s.answer }, now).entries.filter(
      (e) => e.kind === "claude" && (s.answer || "").startsWith(e.text.replace(/…$/, "")),
    );
    assert.strictEqual(said.length, 1, s.id);
  }
});

test("a checkout's changed files are its session's diff, and a checkout without one is clean (round 3: ±12 vs 3 files)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  for (const r of o.repos) {
    const own = o.sessions.filter((s) => s.repoRoot === r.root);
    const counts = own.map((s) => demoDiff(s).files.length);
    if (!own.length) assert.strictEqual(r.dirty, 0, `${r.root} has no session and is clean`);
    else assert.ok(counts.includes(Number(r.dirty)), `${r.root}: ${r.dirty} changed, diffs ${counts.join(", ")}`);
  }
});

test("a checkout's diff has the files of every session in it, each marked as its own only by its session (round 4)", () => {
  const byDir = new Map<string, typeof sessions>();
  for (const s of sessions.filter((x) => !x.readOnly)) byDir.set(s.cwd, [...(byDir.get(s.cwd) || []), s]);
  const shared = [...byDir.values()].filter((l) => l.length > 1);
  assert.ok(shared.length > 0, "the demo has a checkout with two sessions");
  for (const list of shared) {
    const files = list.map((s) =>
      demoDiff({ id: s.id, title: "x" } as Session)
        .files.map((f) => f.path)
        .sort(),
    );
    for (const f of files) assert.deepStrictEqual(f, files[0], `${list[0]?.cwd}: one diff per checkout`);
    for (const s of list) {
      const own = new Set(s.edits.length ? s.edits : DEMO_FILES);
      for (const f of demoDiff({ id: s.id, title: "x" } as Session).files)
        assert.strictEqual(f.mine, own.has(f.path), `${s.id}: ${f.path}`);
    }
  }
});

test("the result line counts what the checkout's diff shows (round 4: 6 files +214 beside a diff of 2)", async () => {
  const src = demoSources();
  for (const s of sessions.filter((x) => !x.readOnly)) {
    const r = await src.result?.(s.cwd, []);
    if (!r) continue;
    const d = demoDiff({ id: s.id, title: "x" } as Session).files;
    assert.strictEqual(r.files, d.length, s.cwd);
    assert.strictEqual(
      r.add,
      d.reduce((n, f) => n + f.add, 0),
      s.cwd,
    );
    assert.strictEqual(
      r.del,
      d.reduce((n, f) => n + f.del, 0),
      s.cwd,
    );
  }
});

test("a session's newest 'new task' in the history is where its conversation starts (round 4: 19:34 vs 20:09)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  const at = Date.now();
  let checked = 0;
  for (const s of o.sessions.filter((x) => x.lastPrompt && x.source !== "cowork")) {
    const task = o.events
      .filter((e) => e.sessionId === s.id && e.event === "UserPromptSubmit")
      .sort((a, b) => b.at - a.at)[0];
    const first = demoChat(s.id, s, at).entries[0];
    if (!task || !first) continue;
    assert.strictEqual(first.kind, "you", s.id);
    assert.ok(
      Math.abs(task.at - first.at) < 60e3,
      `${s.project}: task ${new Date(task.at).toISOString()} chat ${new Date(first.at).toISOString()}`,
    );
    checked++;
  }
  assert.ok(checked > 3, `checked ${checked}`);
});

test("no session's history starts before its conversation (round 5: analytics waited 58 min, living 50)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  const at = Date.now();
  let checked = 0;
  for (const s of o.sessions.filter((x) => x.source !== "cowork")) {
    const first = demoChat(s.id, s, at).entries[0];
    if (!first) continue;
    const early = o.events.filter((e) => e.sessionId === s.id && e.at < first.at - 60e3);
    assert.strictEqual(
      early.length,
      0,
      `${s.project}: ${early.length} events before ${new Date(first.at).toISOString()}`,
    );
    checked++;
  }
  assert.ok(checked > 3, `checked ${checked}`);
});

test("the terminal of a session in Fleet's window shows the files its log works on (round 5: AddressForm.tsx vs core.ts)", async () => {
  const { createDemoTerminals } = await import("../server/process/demo-term");
  const { demoTerminalSessions } = await import("../server/core/demo");
  const terms = createDemoTerminals();
  let checked = 0;
  for (const s of demoTerminalSessions().filter((x) => !x.asks)) {
    let out = "";
    terms.attach(s.id, (e) => {
      if (e.type === "out") out += e.data.toString();
    });
    const files = demoLog(now)
      .lines.filter((l) => l.session === s.id && l.kind === "tool")
      .map((l) => l.text);
    const shown = [...out.matchAll(/● \w+\(([^)]+)\)/g)].map((m) => String(m[1]));
    assert.ok(shown.length > 0, `${s.title}: the terminal shows a step`);
    for (const f of shown) assert.ok(files.includes(f), `${s.title}: ${f} is not in its log`);
    checked++;
  }
  assert.ok(checked > 0);
  terms.close();
});

test("a session's commits read the same in its result, its PR and the repo's arrow (round 6: 3 vs 1 vs ↑1)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  let checked = 0;
  for (const s of o.sessions) {
    if (!s.result?.commits) continue;
    const repo = o.repos.find((r) => r.root === s.repoRoot);
    const pr = repo?.prs?.prs?.find((p) => p.head === repo.branch);
    if (!repo || !pr) continue;
    assert.strictEqual(s.result.commits, pr.commits, `${s.project}: result vs PR #${pr.number}`);
    assert.strictEqual(repo.ahead, 0, `${s.project}: a branch with an open PR is pushed`);
    checked++;
  }
  assert.ok(checked > 0, "at least one finished session with a PR");
});

test("every file a conversation edits is the session's own in its diff, and its own files come first (round 6)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  for (const s of o.sessions) {
    const files = demoDiff(s).files;
    const mine = files.filter((f) => f.mine).map((f) => f.path);
    const edited = demoChat(s.id, s, Date.now()).entries.flatMap((e) =>
      e.kind === "tool" && (e.tool === "Edit" || e.tool === "Write") ? [String(e.text)] : [],
    );
    for (const f of edited) assert.ok(mine.includes(f), `${s.title}: ${f} edited, own files ${mine.join(", ")}`);
    const firstOther = files.findIndex((f) => !f.mine);
    if (firstOther >= 0)
      assert.ok(
        files.slice(firstOther).every((f) => !f.mine),
        `${s.title}: own files first (${files.map((f) => f.path)})`,
      );
  }
});

test("every file the diff marks as the session's own is one its conversation edits (round 7: colors.ts by this session, never edited)", async () => {
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  for (const s of o.sessions) {
    const mine = demoDiff(s)
      .files.filter((f) => f.mine)
      .map((f) => f.path);
    const edited = new Set(
      demoChat(s.id, s, Date.now()).entries.flatMap((e) =>
        e.kind === "tool" && (e.tool === "Edit" || e.tool === "Write") ? [String(e.text)] : [],
      ),
    );
    for (const f of mine) assert.ok(edited.has(f), `${s.title}: ${f} is its own in the diff, edited ${[...edited]}`);
  }
});
