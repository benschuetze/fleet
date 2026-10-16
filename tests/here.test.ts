// `fleet` typed in any folder opens Fleet for it (server/core/here.ts, server/cli/shim.ts).
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { repoForDir } from "../shared/repobar";
import { ROOT, startServer } from "./helpers/server";

const JSON_HDR = { "Content-Type": "application/json", "X-Fleet": "1" };

test("repoForDir: the deepest checkout that is or contains the folder", () => {
  const e = [
    { name: "outer", roots: ["/w/app"] },
    { name: "inner", roots: ["/w/app/packages/lib", "/w/app-wt"] },
  ];
  assert.strictEqual(repoForDir(e, "/w/app")?.name, "outer");
  assert.strictEqual(repoForDir(e, "/w/app/src")?.name, "outer");
  assert.strictEqual(repoForDir(e, "/w/app/packages/lib/x/")?.name, "inner");
  assert.strictEqual(repoForDir(e, "/w/app-wt")?.name, "inner", "a worktree");
  assert.strictEqual(repoForDir(e, "/w/apple"), null, "a prefix is no parent");
  assert.strictEqual(repoForDir(e, "C:\\w\\app\\src".replace(/^C:/, "")), repoForDir(e, "/w/app/src"));
});

describe("fleet in a folder (real server)", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-here-")));
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(() => srv.stop());
  const writeHere = (h: object) => fs.writeFileSync(path.join(srv.fleetHome, "here.json"), JSON.stringify(h));
  const overview = async () => JSON.parse((await srv.request("/api/overview")).body);
  // The server sees here.json through its folder watcher: give it a moment, as the browser does.
  const hereSoon = async (want: unknown) => {
    let got: unknown;
    for (let i = 0; i < 40; i++) {
      got = (await overview()).here?.dir ?? null;
      if (got === want) return got;
      await new Promise((r) => setTimeout(r, 50));
    }
    return got;
  };

  test("the overview names the folder for 12 h, then forgets it", async () => {
    writeHere({ dir, at: Date.now() });
    assert.strictEqual(await hereSoon(dir), dir);
    writeHere({ dir, at: Date.now() - 13 * 3600e3 });
    assert.strictEqual(await hereSoon(null), null);
    writeHere({ dir, at: Date.now() });
    assert.strictEqual(await hereSoon(dir), dir);
    writeHere({ dir: "relative/path", at: Date.now() });
    assert.strictEqual(await hereSoon(null), null);
  });

  test("Claude starts only in exactly the folder fleet was typed in", async () => {
    writeHere({ dir, at: Date.now() });
    const post = (body: object) =>
      srv.request("/api/term/here", { method: "POST", headers: JSON_HDR, body: JSON.stringify(body) });
    assert.strictEqual((await post({ dir: os.homedir() })).status, 409, "another folder");
    assert.strictEqual((await post({ dir: `${dir}/..` })).status, 409);
    assert.notStrictEqual((await post({ dir })).status, 409, "the folder itself");
  });
});

test("setup puts a fleet command on PATH that runs this Fleet, and never replaces a foreign one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-shim-"));
  const win = process.platform === "win32";
  const bin = win ? path.join(home, "Microsoft", "WindowsApps") : path.join(home, ".local", "bin");
  const env = { ...process.env };
  process.env.HOME = home;
  process.env.LOCALAPPDATA = home; // Windows: never the runner's real WindowsApps
  process.env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  try {
    const { installShim, shimDir } = await import("../server/cli/shim");
    assert.deepStrictEqual(shimDir(), { dir: bin, onPath: true });
    assert.match(installShim(), /Befehl fleet eingerichtet|fleet command set up/);
    const file = path.join(bin, win ? "fleet.cmd" : "fleet");
    assert.ok(fs.readFileSync(file, "utf8").includes(path.join(ROOT, "dist", "fleet.cjs")));
    if (!win) {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o755);
      const out = execFileSync(file, ["version"], { encoding: "utf8" });
      assert.match(out, /^\d+\.\d+\.\d+/);
    }
    assert.match(installShim(true), /entfernt|removed/);
    assert.ok(!fs.existsSync(file));
    fs.writeFileSync(file, "#!/bin/sh\necho other\n");
    assert.match(installShim(), /anderen Programm|another program/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "#!/bin/sh\necho other\n");
    installShim(true);
    assert.ok(fs.existsSync(file), "a foreign command stays");
  } finally {
    for (const k of ["HOME", "LOCALAPPDATA", "PATH"] as const)
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
  }
});

test("help, version and unknown options never start or open Fleet", () => {
  // `fleet --help` once opened the live Fleet: only `fleet`, a folder or --no-open may.
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cli-"));
  const env = { ...process.env, CLAUDE_FLEET_HOME: fleetHome, CLAUDE_CONFIG_DIR: fleetHome };
  const run = (...args: string[]) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [path.join(ROOT, "dist", "fleet.cjs"), ...args], {
          env,
          encoding: "utf8",
          timeout: 10_000,
        }),
      };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };
  for (const a of ["--help", "-h", "help"]) {
    const r = run(a);
    assert.strictEqual(r.code, 0, a);
    assert.match(r.out, /Befehle|Commands/, a);
  }
  for (const a of ["--version", "-v", "version"]) assert.match(run(a).out, /^\d+\.\d+\.\d+/, a);
  const bogus = run("--bogus");
  assert.strictEqual(bogus.code, 2);
  assert.match(bogus.out, /Befehle|Commands/);
  assert.ok(!fs.existsSync(path.join(fleetHome, "here.json")), "no folder was handed to Fleet");
});

test("help names every command with what it does; scope without counts names no candidates", () => {
  const fleetHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cli-"));
  const env = { ...process.env, CLAUDE_FLEET_HOME: fleetHome, CLAUDE_CONFIG_DIR: fleetHome, FLEET_LANG: "de" };
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [path.join(ROOT, "dist", "fleet.cjs"), ...args], { env, encoding: "utf8" });
  const help = cli("--help");
  for (const cmd of ["setup", "status", "restart", "audit", "compat", "balance", "scope", "hook"])
    assert.match(help, new RegExp(`^  fleet [^\\n]*\\b${cmd}\\b[^\\n]*\\s{2}\\S`, "m"), cmd);
  const scope = cli("scope");
  assert.match(scope, /Noch keine Nutzung gezählt/);
  assert.doesNotMatch(scope, /Kandidaten zum Streichen/);
  assert.doesNotMatch(scope, /← ungenutzt/, "nothing counted: no line is unused either");
  assert.match(cli("status", "--help"), /Befehle:/, "--help after a command shows help, never runs it");
  // Round 7: `fleet hook --help` prints the hook's own help, not the general one.
  const hook = cli("hook", "--help");
  assert.match(hook, /Aufruf: fleet hook \[status\|on\|off\]/);
  assert.doesNotMatch(hook, /Befehle:/);
});

test("status says when an older Fleet answers a newer CLI", async () => {
  const { versionNote } = await import("../server/cli/launcher");
  assert.strictEqual(versionNote("6.0.0", "6.0.0"), "");
  assert.match(versionNote("5.0.0", "6.0.0"), /6\.0\.0.*5\.0\.0.*fleet restart/);
});
