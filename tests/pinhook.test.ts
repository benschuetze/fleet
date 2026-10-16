// The hook runs in every Claude Code session: sessions run a guard that loads only a self-tested copy of the build,
// has a kill switch and turns every crash into exit 0 (server/core/pinhook.ts).
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ROOT } from "./helpers/server";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pin-"));
  const home = path.join(dir, "fleet");
  const claude = path.join(dir, "claude");
  fs.mkdirSync(claude, { recursive: true });
  const env = { ...process.env, FLEET_LANG: "de", CLAUDE_CONFIG_DIR: claude, CLAUDE_FLEET_HOME: home };
  const fleet = (...args: string[]) =>
    execFileSync(process.execPath, [path.join(ROOT, "dist", "fleet.cjs"), ...args], { env, encoding: "utf8" });
  const guard = (ev: object, kind = "hook") =>
    spawnSync(process.execPath, [path.join(home, "hook", `${kind}.cjs`)], {
      input: JSON.stringify(ev),
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  return { dir, home, claude, env, fleet, guard };
}
const prompt = (sid: string) => ({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "Los", cwd: "/p" });

test("Pin: install runs the guard, the guard runs a tested copy of the build", () => {
  const t = setup();
  t.fleet("install-hooks");
  const id = fs.readFileSync(path.join(t.home, "hook", "current"), "utf8").trim();
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(path.join(t.home, "hook", id, "hook.cjs")), "a copy, not dist/");
  const s = JSON.parse(fs.readFileSync(path.join(t.claude, "settings.json"), "utf8"));
  // Fleet writes the paths with "/" on every system (install.ts).
  const home = t.home.replace(/\\/g, "/");
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes(`${home}/hook/hook.cjs`), s.hooks.Stop[0].hooks[0].command);
  assert.ok(s.statusLine.command.includes(`${home}/hook/statusline.cjs`), s.statusLine.command);
  const r = t.guard(prompt("pin-1"));
  assert.strictEqual(r.status, 0);
  const st = JSON.parse(fs.readFileSync(path.join(t.home, "state", "pin-1.json"), "utf8"));
  assert.strictEqual(st.status, "working");
  // The status line runs through the guard as well.
  const sl = t.guard(
    { session_id: "pin-1", model: { display_name: "Opus" }, workspace: { current_dir: "/p" } },
    "statusline",
  );
  assert.strictEqual(sl.status, 0);
  assert.ok(sl.stdout.length > 0, "prints a status line");
});

test("Pin: the kill switch makes the hook do nothing at once; status and on bring it back", () => {
  const t = setup();
  t.fleet("install-hooks");
  assert.match(t.fleet("hook", "off"), /Hook ist aus \(von Hand\)/);
  const r = t.guard(prompt("off-1"));
  assert.deepStrictEqual([r.status, r.stdout], [0, ""]);
  assert.ok(!fs.existsSync(path.join(t.home, "state", "off-1.json")), "nothing written while off");
  assert.match(t.fleet("hook", "on"), /Hook ist an/);
  t.guard(prompt("off-1"));
  assert.ok(fs.existsSync(path.join(t.home, "state", "off-1.json")));
});

test("Pin: a crashing build never fails a session; ten crashes in ten minutes switch the hook off", () => {
  const t = setup();
  t.fleet("install-hooks");
  const id = fs.readFileSync(path.join(t.home, "hook", "current"), "utf8").trim();
  // Simulate a build that throws while loading.
  fs.writeFileSync(path.join(t.home, "hook", id, "hook.cjs"), 'throw new Error("kaputt");\n');
  for (let i = 0; i < 9; i++) {
    const r = t.guard(prompt("crash-1"));
    assert.deepStrictEqual([r.status, r.stdout], [0, ""], "exit 0, nothing for Claude");
  }
  const errors = fs
    .readFileSync(path.join(t.home, "hook", "errors.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.strictEqual(errors.length, 9);
  assert.match(JSON.parse(errors[0] || "{}").error, /kaputt/);
  assert.ok(!fs.existsSync(path.join(t.home, "hook-off")), "nine crashes: still on");
  t.guard(prompt("crash-1"));
  assert.strictEqual(fs.readFileSync(path.join(t.home, "hook-off"), "utf8").trim(), "auto");
  assert.match(t.fleet("hook", "status"), /automatisch nach Abstürzen[\s\S]*Abstürze in der letzten Stunde: 10/);
});

test("Pin: a build that fails its self-test never replaces the last good one", async () => {
  const t = setup();
  t.fleet("install-hooks");
  const good = fs.readFileSync(path.join(t.home, "hook", "current"), "utf8").trim();
  // A Fleet folder whose new hook build is broken (it exits with an error on every event).
  const app = path.join(t.dir, "app");
  fs.mkdirSync(path.join(app, "dist"), { recursive: true });
  fs.writeFileSync(path.join(app, "dist", "hook.cjs"), "process.exit(1);\n");
  fs.copyFileSync(path.join(ROOT, "dist", "statusline.cjs"), path.join(app, "dist", "statusline.cjs"));
  process.env.CLAUDE_FLEET_HOME = t.home;
  try {
    const { pinHook } = await import("../server/core/pinhook");
    const r = pinHook(app);
    assert.strictEqual(r.ok, true, "a good build is still active");
    assert.match(r.message, /Selbsttest|self-test/);
    assert.strictEqual(fs.readFileSync(path.join(t.home, "hook", "current"), "utf8").trim(), good);
    assert.deepStrictEqual(
      fs.readdirSync(path.join(t.home, "hook")).filter((d) => /^[0-9a-f]{12}$/.test(d)),
      [good],
      "the failed copy is removed",
    );
  } finally {
    delete process.env.CLAUDE_FLEET_HOME;
  }
});

test("Pin: at start only a build from a clean main that equals origin/main reaches the sessions (audit M2)", async () => {
  const { releaseProblem } = await import("../server/core/pinhook");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-rel-"));
  const app = path.join(dir, "app");
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", app, ...a], { encoding: "utf8" });
  assert.strictEqual(releaseProblem(dir), "", "a release folder without git is fine");
  fs.mkdirSync(app);
  execFileSync("git", ["init", "-q", "-b", "main", "--bare", path.join(dir, "origin.git")]);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(app, "a.txt"), "1");
  git("add", ".");
  git("commit", "-qm", "one");
  git("remote", "add", "origin", path.join(dir, "origin.git"));
  git("push", "-q", "origin", "main");
  assert.strictEqual(releaseProblem(app), "");
  fs.writeFileSync(path.join(app, "a.txt"), "2");
  assert.match(releaseProblem(app), /uncommitted|ungespeichert/);
  git("commit", "-qam", "two");
  assert.match(releaseProblem(app), /origin\/main/, "not pushed");
  git("checkout", "-qb", "feat/x");
  assert.match(releaseProblem(app), /feat\/x/);
});
