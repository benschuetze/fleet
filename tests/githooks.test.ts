// The local gate (.githooks/pre-push, release 6.1.0): a push with code runs the check and stops on red,
// a push of docs and Markdown only skips it.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

const HOOK = path.resolve(__dirname, "..", ".githooks", "pre-push");
const ZERO = "0".repeat(40);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A repo with one commit on main and origin/main pointing at it, plus a branch with one more commit. */
function repo(files: Record<string, string>): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gate-"));
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

function push(dir: string, head: string, cmd: string, remoteSha = ZERO) {
  return spawnSync("sh", [HOOK, "origin", "x"], {
    cwd: dir,
    encoding: "utf8",
    input: `refs/heads/feature ${head} refs/heads/feature ${remoteSha}\n`,
    // Git sets GIT_DIR for its hooks; the hook must not pass it on to the check (whose tests make temp repos).
    env: { ...process.env, FLEET_PREPUSH_CMD: cmd, GIT_DIR: path.join(os.tmpdir(), "not-this-repo") },
  });
}

// Git for Windows brings sh, but the runners do not put it on PATH for Node; the hook logic is the same everywhere.
const posix = process.platform !== "win32";

test.runIf(posix)("Pre-push: code runs the check, red stops the push with the end of its output", () => {
  const { dir, head } = repo({ "server/x.ts": "export const x = 1;\n" });
  const green = push(dir, head, '[ -z "$GIT_DIR" ]');
  assert.strictEqual(green.status, 0, green.stderr);
  assert.match(green.stdout, /green in \d+ s/);
  const red = push(dir, head, "echo 'type error in x.ts'; exit 3");
  assert.strictEqual(red.status, 1);
  assert.match(red.stdout, /type error in x\.ts/);
  assert.match(red.stdout, /--no-verify/);
});

test.runIf(posix)("Pre-push: docs and Markdown only skip the check", () => {
  const { dir, head } = repo({ "docs/guide.md": "y\n", "docs/shot.png": "png", "CHANGELOG.md": "z\n" });
  const r = push(dir, head, "exit 1");
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /docs only/);
});

test.runIf(posix)("Pre-push: an update of a pushed branch looks only at the new commits", () => {
  const { dir, head } = repo({ "server/x.ts": "export const x = 1;\n" });
  fs.writeFileSync(path.join(dir, "docs-note.md"), "n\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "note");
  const next = git(dir, "rev-parse", "HEAD");
  const r = push(dir, next, "exit 1", head);
  assert.strictEqual(r.status, 0, r.stdout);
});

test.runIf(posix)("Pre-push: deleting a remote branch checks nothing", () => {
  const { dir } = repo({ "server/x.ts": "1\n" });
  const r = spawnSync("sh", [HOOK, "origin", "x"], {
    cwd: dir,
    encoding: "utf8",
    input: `(delete) ${ZERO} refs/heads/old ${"a".repeat(40)}\n`,
    env: { ...process.env, FLEET_PREPUSH_CMD: "exit 1" },
  });
  assert.strictEqual(r.status, 0);
});

test.runIf(posix)("Pre-push: without origin/main to compare with, the check runs (fail closed)", () => {
  const { dir, head } = repo({ "docs/only.md": "y\n" });
  git(dir, "update-ref", "-d", "refs/remotes/origin/main");
  assert.strictEqual(push(dir, head, "exit 1").status, 1);
});

test.runIf(posix)("Pre-push: a file moved from code into docs/ still counts as code", () => {
  const { dir } = repo({ "server/x.ts": "export const x = 1;\n" });
  const before = git(dir, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(dir, "docs"));
  git(dir, "mv", "server/x.ts", "docs/x.ts");
  git(dir, "commit", "-q", "-m", "move");
  assert.strictEqual(push(dir, git(dir, "rev-parse", "HEAD"), "exit 1", before).status, 1);
});

test("Pre-push is executable and enabled by pnpm install", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts.prepare, "node scripts/hooks-path.mjs");
  if (posix) assert.ok(fs.statSync(HOOK).mode & 0o100, "pre-push must be executable");
});
