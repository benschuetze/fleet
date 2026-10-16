// Installing the hooks against a real but temporary settings.json: this changes the user's files, so the promise
// that nothing foreign breaks is checked here.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ROOT } from "./helpers/server";

// biome-ignore lint/suspicious/noExplicitAny: settings.json content, read like Claude Code does
type Settings = any;

function setup(settings: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-inst-"));
  const claude = path.join(dir, "claude");
  const env = {
    ...process.env,
    FLEET_LANG: "de",
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_FLEET_HOME: path.join(dir, "fleet"),
  };
  fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, "settings.json");
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [path.join(ROOT, "dist", "fleet.cjs"), "install-hooks", ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const read = (): Settings => JSON.parse(fs.readFileSync(file, "utf8"));
  return { run, read, dir: claude };
}
const fleetHooks = (s: Settings, ev: string) =>
  (s.hooks[ev] || []).flatMap((g: Settings) => g.hooks).filter((h: Settings) => h.command.includes("--claude-fleet"));

test("Install: tool hooks run in the background, status hooks and the brake do not", () => {
  const t = setup({ model: "opus" });
  t.run();
  const s = t.read();
  for (const ev of ["PostToolUse", "PostToolUseFailure"]) assert.strictEqual(fleetHooks(s, ev)[0].async, true, ev);
  // The brake must be able to wait before the tool call.
  assert.deepStrictEqual(
    [fleetHooks(s, "PreToolUse")[0].async, fleetHooks(s, "PreToolUse")[0].timeout],
    [undefined, 150],
  );
  assert.match(
    fleetHooks(s, "Stop")[0].command,
    /\/hook\/hook\.cjs" --claude-fleet$/,
    "the guard in Fleet's home, which runs the tested copy of the bundle",
  );
  t.run("--no-brake");
  assert.deepStrictEqual(
    [fleetHooks(t.read(), "PreToolUse")[0].async, fleetHooks(t.read(), "PreToolUse")[0].timeout],
    [true, 5],
    "can be deselected",
  );
  // Stop and the like stay synchronous, otherwise "done" might arrive before the last tool.
  for (const ev of ["Stop", "UserPromptSubmit", "PermissionRequest", "SessionEnd"])
    assert.strictEqual(fleetHooks(s, ev)[0].async, undefined, ev);
  assert.strictEqual(s.model, "opus", "foreign settings stay");
});

test("Install: --sync turns off background hooks, --light leaves out tool hooks", () => {
  const t = setup({});
  t.run("--sync");
  assert.strictEqual(fleetHooks(t.read(), "PreToolUse")[0].async, undefined);
  t.run("--light");
  assert.strictEqual(fleetHooks(t.read(), "PreToolUse").length, 0);
  assert.strictEqual(fleetHooks(t.read(), "Stop").length, 1, "never installed twice");
});

test("Install: foreign hooks and an own status line stay, uninstalling restores them", () => {
  const own = { type: "command", command: "echo meine" };
  const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] };
  const t = setup({ statusLine: own, hooks: { PreToolUse: [foreign] } });
  t.run();
  const s = t.read();
  assert.deepStrictEqual(s.hooks.PreToolUse[0], foreign);
  assert.match(s.statusLine.command, /statusline\.cjs/);
  assert.ok(
    fs.readdirSync(t.dir).some((f) => f.startsWith("settings.json.bak-fleet-")),
    "a backup was made",
  );
  t.run("--uninstall");
  const u = t.read();
  assert.deepStrictEqual(u.hooks, { PreToolUse: [foreign] });
  assert.deepStrictEqual(u.statusLine, own);
});

test("Install: a broken settings.json is not overwritten", () => {
  const t = setup({});
  fs.writeFileSync(path.join(t.dir, "settings.json"), "{ kaputt");
  assert.throws(
    () => t.run(),
    (e: { stdout?: string }) => /kein gültiges JSON/.test(String(e.stdout)),
  );
  assert.strictEqual(fs.readFileSync(path.join(t.dir, "settings.json"), "utf8"), "{ kaputt");
});
