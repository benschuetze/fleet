// Sessions in worktrees of their own (release 6.1.0, plan T1): where a new session starts, how a worktree is made,
// filled and removed – only the safe way.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { normalize } from "../server/core/config";
import {
  baseRef,
  createWorktree,
  fleetWorktrees,
  includeList,
  mainRoot,
  planWorktree,
  removable,
  removeWorktree,
  seedWorktree,
  slug,
  wantsWorktree,
} from "../server/core/worktree";
import { fleetWorktree } from "../shared/repo";

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A repo `app` with one commit on main and origin/main at it, inside its own temp parent. */
function repo(): string {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wt-")));
  const root = path.join(parent, "app");
  fs.mkdirSync(root);
  g(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "local.json\n");
  g(root, "add", "-A");
  g(root, "commit", "-q", "-m", "base");
  g(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  // A configured origin: without it git would not set an upstream anyway, and the --no-track check proves nothing.
  g(root, "remote", "add", "origin", root);
  return root;
}

test("Worktree names: the task's words, a short tag, next to the repo, branch fleet/…", () => {
  assert.strictEqual(slug("Login-Fix für die Übersicht!"), "login-fix-fur-die-ubersicht");
  assert.strictEqual(slug("x".repeat(50)).length, 32);
  assert.strictEqual(slug("   "), "");
  const root = path.join(path.sep, "code", "app");
  const p = planWorktree(root, "Fix login", "3a2c");
  assert.deepStrictEqual(p, {
    name: "fix-login-3a2c",
    dir: path.join(path.sep, "code", "app.wt", "fix-login-3a2c"),
    branch: "fleet/fix-login-3a2c",
  });
  assert.strictEqual(planWorktree(root, "", "0000").name, "session-0000");
  assert.deepStrictEqual(fleetWorktree(p.dir), { repo: "app", name: "fix-login-3a2c" });
  assert.strictEqual(fleetWorktree(root), null);
  assert.strictEqual(fleetWorktree(null), null);
});

test("Where a new session starts: :wt always, else the second one once the first works or waits", () => {
  const root = path.join(path.sep, "code", "app");
  const second = { auto: "second" as const };
  assert.strictEqual(wantsWorktree(root, [], [], second, false), false);
  assert.strictEqual(wantsWorktree(root, [], [], second, true), true);
  for (const status of ["working", "waiting", "needs_input", "stale"] as const)
    assert.strictEqual(wantsWorktree(root, [{ cwd: root, status }], [], second, false), true, status);
  // Done, or busy in another folder: the main folder is free.
  assert.strictEqual(wantsWorktree(root, [{ cwd: root, status: "idle" }], [], second, false), false);
  assert.strictEqual(wantsWorktree(root, [{ cwd: `${root}-other`, status: "working" }], [], second, false), false);
  // A process in Fleet's window counts even before its transcript says anything.
  assert.strictEqual(wantsWorktree(root, [], [root], second, false), true);
  assert.strictEqual(wantsWorktree(root, [{ cwd: root, status: "working" }], [root], { auto: "off" }, false), false);
  assert.strictEqual(wantsWorktree(root, [], [], { auto: "always" }, false), true);
});

test("Config: worktree defaults, a known mode, per repo setup and files; unknown modes warn", () => {
  const w: string[] = [];
  assert.deepStrictEqual(normalize({}, w).worktree, { auto: "second", fetch: false, repos: {} });
  const cfg = normalize(
    {
      worktree: { auto: "always", fetch: true, repos: { "/code/app": { setup: " pnpm i ", include: ["a.json", 3] } } },
    },
    w,
  );
  assert.deepStrictEqual(cfg.worktree, {
    auto: "always",
    fetch: true,
    repos: { "/code/app": { setup: "pnpm i", include: ["a.json"] } },
  });
  assert.strictEqual(normalize({ worktree: { auto: "sometimes" } }, w).worktree.auto, "second");
  assert.ok(w.some((x) => x.includes("worktree.auto")));
});

test("Files copied into a worktree: relative paths inside the repo only, comments skipped, at most 50", () => {
  const list = includeList(
    ["local.json", "/etc/passwd", "../up.txt"],
    "# comment\nconf/dev.json  # mine\n\nlocal.json\n",
  );
  assert.deepStrictEqual(list, ["local.json", "conf/dev.json"]);
  assert.strictEqual(
    includeList(
      Array.from({ length: 80 }, (_, i) => `f${i}`),
      "",
    ).length,
    50,
  );
});

test("Worktree lifecycle: made from origin/main, seeded, offered only when merged and clean, removed safely", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "local.json"), "{}\n");
  // Windows needs extra rights for links; there the link case is simply missing.
  const links = process.platform !== "win32";
  if (links) fs.symlinkSync(path.join(root, "README.md"), path.join(root, "link.json"));
  assert.strictEqual(await baseRef(root), "origin/main");

  const plan = planWorktree(root, "first task", "aaaa");
  const made = await createWorktree(root, plan, "origin/main");
  assert.ok(made.ok, made.ok ? "" : made.error);
  assert.strictEqual(g(plan.dir, "rev-parse", "--abbrev-ref", "HEAD"), "fleet/first-task-aaaa");
  assert.ok(!(await createWorktree(root, plan, "origin/main")).ok, "the same folder twice");
  // --no-track: a plain `git push` in the worktree must not go to main.
  assert.throws(() => g(plan.dir, "rev-parse", "--abbrev-ref", "@{upstream}"));
  assert.strictEqual(await mainRoot(plan.dir), root);
  assert.strictEqual(await mainRoot(root), root);

  const copied = await seedWorktree(root, plan.dir, ["local.json", "link.json", "missing.json"]);
  assert.deepStrictEqual(copied, ["local.json"], "regular files only, no link");
  assert.ok(fs.existsSync(path.join(plan.dir, "local.json")));

  const [wt] = await fleetWorktrees(root);
  assert.deepStrictEqual(wt, { dir: plan.dir, branch: plan.branch });
  // No commit of its own yet: part of the base, so it may go – unless a session lives there.
  assert.deepStrictEqual(await removable(root, wt, "origin/main", [plan.dir]), {
    ok: false,
    why: "a session runs there",
  });
  // Ignored: the seeded copy as it came, and a folder the main folder has too (dependencies), may go along ...
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(plan.dir, "node_modules"));
  fs.writeFileSync(path.join(plan.dir, "node_modules", "dep.js"), "1\n");
  fs.appendFileSync(path.join(plan.dir, ".gitignore"), "node_modules/\n*.local\n");
  g(plan.dir, "add", ".gitignore");
  g(plan.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "ignore");
  // ... but an ignored file of its own, or the copy edited there, would be lost silently: it stays.
  fs.writeFileSync(path.join(plan.dir, "notes.local"), "mine\n");
  assert.deepStrictEqual(await removable(root, wt, "origin/main", []), { ok: false, why: "ignored file notes.local" });
  fs.rmSync(path.join(plan.dir, "notes.local"));
  fs.writeFileSync(path.join(plan.dir, "local.json"), '{"edited":true}\n');
  assert.deepStrictEqual(await removable(root, wt, "origin/main", []), { ok: false, why: "ignored file local.json" });
  fs.copyFileSync(path.join(root, "local.json"), path.join(plan.dir, "local.json"));
  // An uncommitted file keeps it.
  fs.writeFileSync(path.join(plan.dir, "note.txt"), "wip\n");
  assert.deepStrictEqual(await removable(root, wt, "origin/main", []), { ok: false, why: "uncommitted changes" });
  g(plan.dir, "add", "note.txt");
  g(plan.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "work");
  assert.deepStrictEqual(await removable(root, wt, "origin/main", []), { ok: false, why: "branch not merged" });
  // Merged into main: now it may go, and goes with its branch.
  g(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "merge", "-q", "--no-edit", plan.branch);
  g(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepStrictEqual(await removable(root, wt, "origin/main", []), { ok: true });
  assert.deepStrictEqual(await removeWorktree(root, wt), { ok: true });
  assert.ok(!fs.existsSync(plan.dir));
  assert.strictEqual(g(root, "branch", "--list", plan.branch), "");
  assert.deepStrictEqual(await fleetWorktrees(root), []);
});

test.runIf(process.platform !== "win32")(
  "Seeding: a linked folder on the way out of the repo or the worktree copies nothing",
  async () => {
    const root = repo();
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-outside-")));
    fs.writeFileSync(path.join(outside, "secret.json"), "{}\n");
    fs.symlinkSync(outside, path.join(root, "cfg"));
    const plan = planWorktree(root, "seed", "bbbb");
    assert.ok((await createWorktree(root, plan, "origin/main")).ok);
    assert.deepStrictEqual(await seedWorktree(root, plan.dir, ["cfg/secret.json"]), []);
    // A linked folder inside the worktree that leads out of it: nothing is written there.
    fs.writeFileSync(path.join(root, "local.json"), "{}\n");
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "x.json"), "{}\n");
    fs.symlinkSync(outside, path.join(plan.dir, "sub"));
    assert.deepStrictEqual(await seedWorktree(root, plan.dir, ["sub/x.json", "local.json"]), ["local.json"]);
    assert.ok(!fs.existsSync(path.join(outside, "x.json")));
  },
);

test("Worktrees made by hand are never offered", async () => {
  const root = repo();
  g(root, "worktree", "add", "-q", "-b", "mine", path.join(path.dirname(root), "by-hand"), "main");
  assert.deepStrictEqual(await fleetWorktrees(root), []);
});
