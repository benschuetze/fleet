// Ben, 15 Oct (BUGANALYSE B2): no claude on PATH, only the CLI inside the desktop app, so Fleet offered no terminal.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bundledClaude, bundledRoot } from "../server/core/toolpath";

// The first bytes of a real binary per system; the check reads only these.
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const PE = Buffer.from("MZ\x90\0\x03\0\0\0", "latin1");

const tmpHome = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cli-")));

/** The layout the desktop app keeps: <root>/<version>/<build hash>/<binary>. */
function put(root: string, ver: string, rel: string[], bytes: Buffer, build = "9d6405864fdc"): string {
  const file = path.join(root, ver, build, ...rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o755 });
  return file;
}
const MAC_BIN = ["claude.app", "Contents", "MacOS", "claude"];

test("macOS: the newest version folder wins by number, not by text (2.1.295 over 2.1.9)", () => {
  const home = tmpHome();
  assert.strictEqual(bundledClaude("darwin", home, {}), null, "no app, no CLI");
  const root = bundledRoot("darwin", home, {});
  assert.strictEqual(root, path.join(home, "Library", "Application Support", "Claude", "claude-code"));
  put(root, "2.1.9", MAC_BIN, MACHO);
  const newest = put(root, "2.1.295", MAC_BIN, MACHO, "8433d0d9cd0d");
  put(root, "2.1.30", MAC_BIN, MACHO);
  fs.mkdirSync(path.join(root, "latest"));
  assert.strictEqual(bundledClaude("darwin", home, {}), newest);
});

test("A half-written or foreign file in the newest folder is skipped: the next older version counts", () => {
  const home = tmpHome();
  const root = bundledRoot("darwin", home, {});
  const older = put(root, "2.1.293", MAC_BIN, MACHO);
  put(root, "2.1.295", MAC_BIN, Buffer.alloc(0));
  assert.strictEqual(bundledClaude("darwin", home, {}), older, "empty file: update still downloading");
  put(root, "2.1.296", MAC_BIN, Buffer.from("#!/bin/sh\nrm -rf ~\n"));
  assert.strictEqual(bundledClaude("darwin", home, {}), older, "a script is not the app's binary");
  put(root, "2.1.297", MAC_BIN, ELF);
  assert.strictEqual(bundledClaude("darwin", home, {}), older, "a Linux binary does not run on a Mac");
});

test.skipIf(process.platform === "win32")("Without the execute bit the binary does not count", () => {
  const home = tmpHome();
  const root = bundledRoot("darwin", home, {});
  const file = put(root, "2.1.295", MAC_BIN, MACHO);
  fs.chmodSync(file, 0o644);
  assert.strictEqual(bundledClaude("darwin", home, {}), null);
});

test("A symlink out of the app folder is not followed", () => {
  const home = tmpHome();
  const root = bundledRoot("darwin", home, {});
  const elsewhere = path.join(home, "elsewhere");
  fs.writeFileSync(elsewhere, MACHO, { mode: 0o755 });
  const link = path.join(root, "2.1.295", "abc", ...MAC_BIN);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(elsewhere, link);
  } catch {
    return; // Windows without the right to create symlinks
  }
  assert.strictEqual(bundledClaude("darwin", home, {}), null);
});

test("Windows: %APPDATA%\\Claude\\claude-code\\<version>\\<build>\\claude.exe, a PE binary", () => {
  const home = tmpHome();
  const appData = path.join(home, "AppData", "Roaming");
  const root = bundledRoot("win32", home, { APPDATA: appData });
  assert.strictEqual(root, path.join(appData, "Claude", "claude-code"));
  assert.strictEqual(
    bundledRoot("win32", home, {}),
    path.join(home, "AppData", "Roaming", "Claude", "claude-code"),
    "without APPDATA the default place",
  );
  put(root, "2.1.9", ["claude.exe"], PE);
  const newest = put(root, "2.1.295", ["claude.exe"], PE);
  assert.strictEqual(bundledClaude("win32", home, { APPDATA: appData }), newest);
});

test("Linux: $XDG_CONFIG_HOME/Claude/claude-code, else ~/.config, an ELF binary", () => {
  const home = tmpHome();
  assert.strictEqual(bundledRoot("linux", home, {}), path.join(home, ".config", "Claude", "claude-code"));
  const xdg = path.join(home, "xdg");
  const root = bundledRoot("linux", home, { XDG_CONFIG_HOME: xdg });
  assert.strictEqual(root, path.join(xdg, "Claude", "claude-code"));
  put(root, "2.1.295", ["claude"], MACHO);
  assert.strictEqual(bundledClaude("linux", home, { XDG_CONFIG_HOME: xdg }), null, "a Mac binary does not count");
  const elf = put(root, "2.1.294", ["claude"], ELF);
  assert.strictEqual(bundledClaude("linux", home, { XDG_CONFIG_HOME: xdg }), elf);
  assert.strictEqual(
    bundledRoot("linux", home, { XDG_CONFIG_HOME: "relative/dir" }),
    path.join(home, ".config", "Claude", "claude-code"),
    "a relative XDG_CONFIG_HOME is invalid by the spec",
  );
});
