// Opening sessions in the desktop app, VS Code or a terminal: commands without a shell, inputs checked.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { type Env, plan, planNew, targets } from "../server/core/launch";
import { ROOT } from "./helpers/server";

const ID = "22222222-2222-4222-8222-222222222222";
const DESK = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mac = (o: Partial<Env> = {}): Env => ({
  platform: "darwin",
  desktopApp: true,
  vscode: "/Applications/Visual Studio Code.app",
  cursor: null,
  claude: "/Users/x/.local/bin/claude",
  wt: null,
  linuxTerminal: null,
  ...o,
});

test("Desktop-App: App-Session direkt, Terminal-Session wird übernommen", () => {
  assert.deepStrictEqual(plan("desktop", { id: ID, cwd: "/w", desktopId: DESK }, mac()), [
    { cmd: "open", args: [`claude://claude.ai/epitaxy/${DESK}`] },
  ]);
  assert.deepStrictEqual(plan("desktop", { id: ID, cwd: "/w" }, mac()), [
    { cmd: "open", args: [`claude://resume?session=${ID}`] },
  ]);
  assert.deepStrictEqual(plan("desktop", { id: ID, cwd: "/w" }, mac({ platform: "win32" }))[0]?.cmd, "rundll32");
  assert.deepStrictEqual(plan("desktop", { id: ID, cwd: "/w" }, mac({ desktopApp: false })), []);
});

test("VS Code: erst den Projektordner, dann die Session über die Erweiterung", () => {
  const steps = plan("vscode", { id: ID, cwd: "/w/mein projekt" }, mac());
  assert.deepStrictEqual(steps[0], {
    cmd: "open",
    args: ["-a", "/Applications/Visual Studio Code.app", "/w/mein projekt"],
  });
  assert.deepStrictEqual(steps[1]?.args, [`vscode://anthropic.claude-code/open?session=${ID}`]);
  assert.ok((steps[1]?.delayMs || 0) > 0, "wartet, bis das Fenster vorne ist");
  assert.deepStrictEqual(plan("vscode", { id: ID, cwd: null }, mac()), [], "ohne Ordner nicht");
});

test("Terminal: Ordner und Pfade sind für Shell und AppleScript maskiert", () => {
  const [s] = plan("terminal", { id: ID, cwd: `/w/it's "quoted"` }, mac());
  assert.strictEqual(s?.cmd, "osascript");
  assert.strictEqual(
    s?.args[1],
    `tell application "Terminal" to do script "cd '/w/it'\\\\''s \\"quoted\\"' && '/Users/x/.local/bin/claude' --resume ${ID}"`,
  );
  assert.deepStrictEqual(plan("terminal", { id: ID, cwd: "relativ" }, mac()), [], "nur absolute Ordner");
  assert.deepStrictEqual(plan("terminal", { id: ID, cwd: "/w" }, mac({ claude: null })), [], "ohne CLI nicht");
  assert.deepStrictEqual(
    plan("terminal", { id: ID, cwd: "C:\\w&calc" }, mac({ platform: "win32", claude: "C:\\c\\claude.exe" })),
    [],
    "cmd-Steuerzeichen abgelehnt",
  );
  assert.deepStrictEqual(
    plan(
      "terminal",
      { id: ID, cwd: "C:\\w&x" },
      mac({ platform: "win32", claude: "C:\\c\\claude.exe", wt: "C:\\wt.exe" }),
    )[0]?.args,
    ["-d", "C:\\w&x", "C:\\c\\claude.exe", "--resume", ID],
    "Windows Terminal bekommt Argumente einzeln",
  );
});

test("Nur echte Session-IDs, nie Optionen oder Pfade", () => {
  for (const id of ["--help", "../x", `${ID}; rm -rf /`, "demo-01"]) {
    for (const t of ["desktop", "vscode", "terminal"] as const)
      assert.deepStrictEqual(plan(t, { id, cwd: "/w" }, mac()), [], `${t} ${id}`);
  }
});

test("Ziele mit Grund, warum eines fehlt", () => {
  const t = targets(mac({ claude: null, vscode: null }));
  assert.deepStrictEqual(
    t.map((x) => [x.id, x.ok]),
    [
      ["desktop", true],
      ["vscode", false],
      ["terminal", false],
    ],
  );
  assert.match(String(t[2]?.why), /claude/);
});

test("Mit der Übergabe weitermachen: neue Session im Ordner, Auftrag vorausgefüllt", () => {
  assert.deepStrictEqual(planNew("desktop", "/w/mein projekt", "Mach mit der Übergabe weiter", mac()), [
    {
      cmd: "open",
      args: ["claude://code/new?q=Mach%20mit%20der%20%C3%9Cbergabe%20weiter&folder=%2Fw%2Fmein%20projekt"],
    },
  ]);
  assert.match(
    String(planNew("vscode", "/w", "x y", mac())[1]?.args[0]),
    /^vscode:\/\/anthropic\.claude-code\/open\?prompt=x%20y$/,
  );
  assert.match(String(planNew("terminal", "/w", `it's`, mac())[0]?.args[1]), /'it'\\\\''s'"$/);
  assert.deepStrictEqual(planNew("desktop", "relativ", "x", mac()), []);
});

test("Opening from the hook keeps running although the hook exits at once", async () => {
  // Reported: "new session opened" stood in the log, nothing opened. The hook ends with process.exit before a
  // timer fires; opening must run independently of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-open-"));
  const mark = path.join(dir, "geoeffnet");
  const steps = [{ cmd: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(mark)}, 'ja')`] }];
  const runner = path.join(ROOT, "dist", "launch-run.cjs");
  // The same call as launch.runDetached, from a parent process that exits right away.
  const parent = `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(JSON.stringify(steps))}], { detached: true, stdio: 'ignore' }); c.unref(); process.exit(0);`;
  execFileSync(process.execPath, ["-e", parent], { env: { ...process.env, CLAUDE_FLEET_HOME: dir } });
  for (let i = 0; i < 50 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(fs.existsSync(mark), true, "the step ran although the calling process was gone");
  for (let i = 0; i < 20 && !fs.existsSync(path.join(dir, "launch.log")); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.match(fs.readFileSync(path.join(dir, "launch.log"), "utf8"), /^\S+ ok /, "the outcome is in the log");
});
