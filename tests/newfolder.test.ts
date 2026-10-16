// `:new <name>` (release 6, plan R7): a new project folder under the projects folder, never anywhere else.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { FOLDER_RE, makeFolder, projectsDir } from "../server/core/newfolder";

const msg = (de: string) => de;

test("Projects folder: the config wins, else where most repos live (worktrees inside a repo do not count)", () => {
  // Absolute on every system: on Windows a path from the root gets the drive letter.
  const home = path.resolve(path.sep, "home", "ben");
  const dl = path.join(home, "Downloads");
  const roots = [
    path.join(dl, "fleet"),
    path.join(dl, "shop"),
    path.join(home, "work", "api"),
    path.join(dl, "fleet", ".claude", "worktrees", "a"),
    path.join(dl, "fleet", ".claude", "worktrees", "b"),
    path.join(dl, "fleet", ".claude", "worktrees", "c"),
  ];
  assert.strictEqual(projectsDir("", roots, home), dl);
  assert.strictEqual(projectsDir(path.join(home, "code"), roots, home), path.join(home, "code"));
  assert.strictEqual(projectsDir("", [], home), path.join(home, "Projects"));
});

test("Folder names: no path, no leading dot, nothing but letters, digits and . _ -", () => {
  for (const ok of ["shop", "my-app_2", "a.b", "X"]) assert.ok(FOLDER_RE.test(ok), ok);
  for (const bad of ["", ".", "..", ".git", "a/b", "a\\b", "../x", "a b", "ä", "x".repeat(65)])
    assert.ok(!FOLDER_RE.test(bad), bad);
});

test("makeFolder creates the folder with git init, takes an existing folder, refuses a file and a link", async () => {
  const base = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-new-"))), "projects");
  const made = await makeFolder(base, "shop", msg);
  assert.deepStrictEqual(made, { ok: true, dir: path.join(base, "shop"), created: true });
  assert.ok(fs.existsSync(path.join(base, "shop", ".git")), "git init ran");
  assert.deepStrictEqual(await makeFolder(base, "shop", msg), {
    ok: true,
    dir: path.join(base, "shop"),
    created: false,
  });
  fs.writeFileSync(path.join(base, "file"), "x");
  assert.strictEqual((await makeFolder(base, "file", msg)).ok, false);
  // A link needs rights on Windows; where it cannot be made there is nothing to refuse.
  let linked = true;
  try {
    fs.symlinkSync(os.tmpdir(), path.join(base, "link"), "dir");
  } catch {
    linked = false;
  }
  if (linked) assert.strictEqual((await makeFolder(base, "link", msg)).ok, false);
  const bad = await makeFolder(base, "../escape", msg);
  assert.strictEqual(bad.ok, false);
  assert.ok(!fs.existsSync(path.join(base, "..", "escape")));
});
