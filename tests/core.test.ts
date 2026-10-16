// Core building blocks: remotes and branches, config, meta, transcripts, providers, usage, self-healing.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalize } from "../server/core/config";
import { parseRemote, parseStatusV2, validBranch } from "../server/core/git";
import { get as ciFor, ghReview, rollup, toOpenPrs, ttlFor } from "../server/core/providers";
import { checkHooks, isLiveFleet, parseCommand } from "../server/core/selfheal";
import { parseFull, parseIncrement } from "../server/core/sessions";
import { normalizeAgent, readMeta, shownMeta, updateMeta } from "../server/core/state";
import { collectUsage, costOf, familyOf, priceFor } from "../server/core/usage";
import type { OpenPr, Remote } from "../shared/types";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-home-"));
const remote = (u: string, map?: Record<string, "gitlab">) => parseRemote(u, map) as Remote;

test("parseRemote: known hosts are trusted", () => {
  const r = remote("git@github.com:org/repo.git");
  assert.deepStrictEqual([r.provider, r.trusted, r.path], ["github", true, "org/repo"]);
  assert.strictEqual(remote("https://gitlab.com/a/b/c.git").owner, "a/b");
  assert.strictEqual(remote("ssh://git@ssh.github.com:443/o/r.git").host, "github.com");
});

test("parseRemote: foreign hosts never get tokens automatically", () => {
  const r = remote("https://github.evil.example/org/repo");
  assert.deepStrictEqual([r.provider, r.trusted, r.guess], ["unknown", false, "github"]);
  const m = remote("https://git.firma.de/x/y", { "git.firma.de": "gitlab" });
  assert.deepStrictEqual([m.provider, m.trusted], ["gitlab", true]);
  const g = ciFor(r, "main", { prRefreshSeconds: 90, tokens: {} });
  assert.ok(g?.skipped && /hostMap/.test(String(g.hint)));
});

test("parseRemote: credentials and path tricks", () => {
  assert.ok(!JSON.stringify(parseRemote("https://user:secret@github.com/o/r.git")).includes("secret"));
  assert.strictEqual(parseRemote("https://github.com/o/../../x"), null);
  assert.strictEqual(parseRemote("https://github.com/o/r?x=1"), null);
});

test("parseRemote: Azure DevOps", () => {
  const a = remote("https://org@dev.azure.com/org/My%20Proj/_git/repo");
  assert.deepStrictEqual([a.provider, a.org, a.project, a.repo], ["azure", "org", "My Proj", "repo"]);
  const b = remote("git@ssh.dev.azure.com:v3/org/proj/repo");
  assert.deepStrictEqual([b.org, b.project, b.repo], ["org", "proj", "repo"]);
  const c = remote("https://org.visualstudio.com/DefaultCollection/proj/_git/repo");
  assert.deepStrictEqual([c.org, c.project, c.repo], ["org", "proj", "repo"]);
});

test("validBranch blocks option injection", () => {
  assert.ok(validBranch("feature/x-1"));
  for (const b of ["--upload-pack=evil", "HEAD", "a..b", "a b", "x\n", "", null]) assert.ok(!validBranch(b), String(b));
});

test("parseStatusV2", () => {
  const r = parseStatusV2(
    "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f.txt\n? neu.txt",
  );
  assert.deepStrictEqual(r, { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, dirty: 2 });
  assert.strictEqual(parseStatusV2("# branch.head (detached)").branch, "HEAD");
});

test("Config is bounded and cleaned", () => {
  const w: string[] = [];
  const c = normalize(
    { refreshSeconds: 0, port: "x", host: "0.0.0.0", hostMap: { "Git.Firma.DE": "GitLab", a: "evil" } },
    w,
  );
  assert.deepStrictEqual(
    [c.refreshSeconds, c.port, c.host, c.hostMap],
    [2, 4777, "127.0.0.1", { "git.firma.de": "gitlab" }],
  );
  assert.ok(w.length >= 3);
});

test("Billing: a plan by default, api allowed, anything else warns and stays on the plan", () => {
  assert.strictEqual(normalize({}, []).billing, "subscription");
  assert.strictEqual(normalize({ billing: "api" }, []).billing, "api");
  const w: string[] = [];
  assert.strictEqual(normalize({ billing: "dollars" }, w).billing, "subscription");
  assert.match(w.join(" "), /config\.billing/);
});

test("normalizeAgent", () => {
  assert.strictEqual(normalizeAgent({ id: "a1", state: "inactive" }).status, "waiting");
  assert.strictEqual(normalizeAgent({ id: "a1", state: "running" }).status, "working");
  assert.strictEqual(normalizeAgent({ id: "../x", state: "running" }).sessionId, null);
});

test("Meta: prototype pollution and invalid ids", async () => {
  const cfg = { _fleetHome: home };
  assert.throws(() => updateMeta(cfg, "__proto__/x", { note: "x" }));
  await updateMeta(cfg, "__proto__", { pinned: true });
  assert.strictEqual(({} as { pinned?: boolean }).pinned, undefined);
  const r = await updateMeta(cfg, "abc", { note: "n".repeat(5000), pinned: "yes" as unknown as boolean });
  assert.strictEqual(r.note?.length, 2000);
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(readMeta(cfg).sessions.abc?.pinned, true);
});

test("Hidden (release 6): stays hidden while quiet, shows again once the session works after it was hidden", async () => {
  const cfg = { _fleetHome: home };
  const before = Date.now();
  const m = await updateMeta(cfg, "quiet", { hidden: true });
  assert.ok(m.hidden && (m.hiddenAt || 0) >= before, "the time it was hidden is kept");
  assert.strictEqual(shownMeta(m, before - 60e3).hidden, true, "quiet since: hidden");
  assert.strictEqual(shownMeta(m, (m.hiddenAt || 0) + 5000).hidden, undefined, "active again: shown");
  // Shown again keeps the rest (a note); unhidden drops the time; an entry from before release 6 stays hidden.
  assert.strictEqual(shownMeta({ ...m, note: "n" }, Date.now() + 1).note, "n");
  assert.strictEqual((await updateMeta(cfg, "quiet", { hidden: false })).hiddenAt, undefined);
  assert.strictEqual(shownMeta({ hidden: true }, Date.now()).hidden, true);
});

test("Transcripts: incremental reading never swallows half a line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tr-"));
  const f = path.join(dir, "s1.jsonl");
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    f,
    line({ type: "user", cwd: "/x", timestamp: "2026-01-01T00:00:00Z", message: { content: "Erster Auftrag" } }),
  );
  const a = await parseFull(f, fs.statSync(f));
  assert.strictEqual(a.data.firstPrompt, "Erster Auftrag");
  fs.appendFileSync(
    f,
    `${line({ type: "assistant", message: { model: "m1", content: [{ type: "text", text: "Fertig" }] } })}{"type":"user","mess`,
  );
  const b = await parseIncrement(f, fs.statSync(f), { ...a, mtime: 0, size: 0 });
  assert.strictEqual(b.data.lastAssistant, "Fertig");
  fs.appendFileSync(f, 'age":{"content":"Zweiter"}}\n');
  const c = await parseIncrement(f, fs.statSync(f), { ...b, mtime: 0, size: 0 });
  assert.deepStrictEqual([c.data.lastPrompt, c.data.firstPrompt], ["Zweiter", "Erster Auftrag"]);
});

test("Provider helpers", () => {
  assert.strictEqual(rollup([{ conclusion: "SUCCESS", status: "COMPLETED" }, { status: "IN_PROGRESS" }]), "running");
  assert.strictEqual(
    ghReview(
      [
        { user: { id: 1 }, state: "CHANGES_REQUESTED" },
        { user: { id: 1 }, state: "APPROVED" },
      ],
      false,
    ),
    "approved",
  );
  assert.strictEqual(ttlFor({ ci: { state: "running" } }, 90e3), 30e3);
  assert.strictEqual(
    ttlFor(
      { pr: { number: 1, title: "", url: null, state: "merged", review: null, ci: "none" }, ci: { state: "success" } },
      90e3,
    ),
    450e3,
  );
});

test("Launcher: a demo instance does not count as the running Fleet", () => {
  assert.strictEqual(isLiveFleet({ ok: true, app: "claude-fleet", version: "2.0.0", pid: 1, demo: false }), true);
  assert.strictEqual(isLiveFleet({ ok: true, app: "claude-fleet", version: "2.0.0", pid: 1, demo: true }), false);
  assert.strictEqual(isLiveFleet({ app: "something-else" }), false);
  assert.strictEqual(isLiveFleet(null), false);
});

test("Self-healing: detects missing, moved and valid hooks", () => {
  const hook = "C:/Fleet/dist/hook.cjs";
  const cmd = (h: string, extra = {}) => ({
    hooks: [{ type: "command", command: `"C:/node/node.exe" "${h}" --claude-fleet`, ...extra }],
  });
  const mk = (h: string, tools = true, pre: object = { timeout: 150 }) => ({
    hooks: Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "Stop", "Notification", ...(tools ? ["PreToolUse"] : [])].map((e) => [
        e,
        [cmd(h, e === "PreToolUse" ? pre : {})],
      ]),
    ),
  });
  const yes = () => true;
  assert.strictEqual(checkHooks({}, hook, yes).ok, false);
  assert.strictEqual(checkHooks(mk(hook), hook, yes).ok, true);
  assert.strictEqual(
    checkHooks(mk("c:\\fleet\\dist\\hook.cjs"), hook, yes).ok,
    true,
    "case and backslashes do not matter",
  );
  assert.match(
    checkHooks(mk("D:/old/hook.js"), hook, yes).reason,
    /geändert/,
    "an older version (hook.js) or a moved folder is repaired",
  );
  assert.match(checkHooks(mk(hook), hook, () => false).reason, /Node/);
  assert.strictEqual(checkHooks(mk(hook, false), hook, () => false).light, true);
  // A setup from before the brake (PreToolUse in the background, 5 s) is repaired.
  assert.match(checkHooks(mk(hook, true, { timeout: 5, async: true }), hook, yes).reason, /Bremse/);
  assert.deepStrictEqual(parseCommand('"a b/node" "c/hook.cjs" --claude-fleet'), {
    node: "a b/node",
    hook: "c/hook.cjs",
  });
});

test("Usage: prices, model families, streaming duplicates, subagents", async () => {
  assert.strictEqual(familyOf("claude-opus-5-5"), "Opus 5.5");
  assert.strictEqual(familyOf("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.strictEqual(priceFor("claude-opus-5-5").i, 4);
  assert.strictEqual(priceFor("claude-opus-4-1-2025").i, 15);
  assert.strictEqual(priceFor("claude-sonnet-4-6").o, 15);
  assert.strictEqual(priceFor("claude-opus-5-5", { "opus-5-5": { input: 1, output: 2 } }).o, 2);
  assert.ok(
    Math.abs(costOf({ i: 0, o: 1e6, cw: 0, cr: 0 }, "claude-opus-5-5") - 20) < 1e-9,
    "1M output tokens of Opus 5.5 = $20",
  );
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-usage-"));
  const dir = path.join(dir0, "projects", "p");
  fs.mkdirSync(path.join(dir, "sess1", "subagents"), { recursive: true });
  const ts = new Date().toISOString();
  const line = (id: string, out: number) =>
    JSON.stringify({
      type: "assistant",
      cwd: "/x/meinprojekt",
      timestamp: ts,
      message: {
        id,
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  fs.writeFileSync(path.join(dir, "sess1.jsonl"), `${[line("m1", 1), line("m1", 100), line("m2", 50)].join("\n")}\n`);
  fs.writeFileSync(
    path.join(dir, "sess1", "subagents", "agent-a.jsonl"),
    `${JSON.stringify({ type: "assistant", isSidechain: true, timestamp: ts, message: { id: "s1", model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 50000 } } })}\n`,
  );
  const r = await collectUsage({ claudeHome: dir0, _fleetHome: path.join(dir0, "fleet"), statsDays: 30, prices: {} });
  const s = r.perSession.sess1;
  assert.ok(s);
  assert.strictEqual(s.n, 3, "m1 only once (its last state), m2, the subagent");
  assert.strictEqual(s.o, 50150);
  assert.ok(s.sub > 0);
  assert.ok(r.usage?.days.at(-1)?.byProject.meinprojekt);
  assert.ok((r.usage?.block?.tok || 0) > 0);
});

test("Offene PRs: gestapelter PR wartet auf den unteren, rote Checks mit Namen, kaputte Einträge fallen weg", () => {
  const prs = toOpenPrs(
    [
      {
        number: 79,
        title: "Eval-Zeile",
        url: "https://github.com/o/r/pull/79",
        baseRefName: "main",
        headRefName: "feat/eval",
        commits: [{ oid: "a" }, { oid: "b" }, { oid: "c" }],
        statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      {
        number: 80,
        title: "baut auf 79",
        baseRefName: "feat/eval",
        headRefName: "feat/eval-oben",
        statusCheckRollup: [],
      },
      {
        number: 81,
        title: "rot",
        baseRefName: "main",
        headRefName: "fix/x",
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [
          { name: "lint (windows-latest)", status: "COMPLETED", conclusion: "FAILURE" },
          { context: "e2e", state: "ERROR" },
          { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
      { number: 82, title: "Ziel ist ein alter Branch", baseRefName: "release/1", headRefName: "fix/y", isDraft: true },
      { number: "kaputt" },
      null,
    ] as unknown as Parameters<typeof toOpenPrs>[0],
    "main",
  );
  assert.deepStrictEqual(
    prs.map((p) => p.number),
    [79, 80, 81, 82],
  );
  const [ok, stacked, red, other] = prs as [OpenPr, OpenPr, OpenPr, OpenPr];
  assert.strictEqual(ok.ci, "success");
  assert.strictEqual(ok.onDefault, true);
  assert.strictEqual(stacked.onDefault, false);
  assert.strictEqual(stacked.stackedOn, 79, "#80 zeigt, dass erst #79 rein muss");
  assert.strictEqual(red.ci, "failure");
  assert.deepStrictEqual(red.failed, ["lint (windows-latest)", "e2e"]);
  assert.strictEqual(red.review, "changes");
  assert.strictEqual(other.stackedOn, null, "Basis ohne offenen PR: kein Verweis, aber nicht mergebar");
  assert.strictEqual(other.draft, true);
  assert.strictEqual(ok.commits, 3, "commit count for the merge question");
  assert.strictEqual(stacked.commits, null, "gh without commits: unknown, not zero");
  assert.deepStrictEqual(toOpenPrs(undefined, "main"), []);
  assert.strictEqual(toOpenPrs([{ number: 1, baseRefName: "main" }], "")[0]?.onDefault, false, "Hauptbranch unbekannt");
});
