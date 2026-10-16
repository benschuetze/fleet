// The diff and files view (release 6, plan R9, R10) against real git in a temporary repo: what a session changed
// since its branch left main, uncommitted and untracked included; files only from git's lists and the edit list.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { changedNames, diffView, parseDiff, readFileView, unquote } from "../server/core/diff";
import { startServer } from "./helpers/server";

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

describe("diff of a session's checkout", () => {
  let root = "";
  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-diff-")));
    g(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "a.ts"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(root, "gone.ts"), "bye\n");
    fs.writeFileSync(path.join(root, "old-name.ts"), "same content here\nand more\nand more\n");
    g(root, "add", ".");
    g(root, "commit", "-q", "-m", "base");
    g(root, "checkout", "-q", "-b", "feat");
    // Committed on the branch, uncommitted, deleted, renamed, untracked.
    fs.writeFileSync(path.join(root, "a.ts"), "one\nTWO\nthree\n");
    g(root, "commit", "-q", "-am", "change");
    fs.appendFileSync(path.join(root, "a.ts"), "four\n");
    fs.rmSync(path.join(root, "gone.ts"));
    g(root, "mv", "old-name.ts", "new-name.ts");
    fs.writeFileSync(path.join(root, "new.ts"), "fresh\nfile\n");
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  test("against the merge base: committed and uncommitted changes, deletions, renames and new files", async () => {
    const v = await diffView(root, "feat", ["a.ts"], []);
    assert.strictEqual(v.error, null);
    const by = Object.fromEntries(v.files.map((f) => [f.path, f]));
    assert.deepStrictEqual(Object.keys(by), ["a.ts", "gone.ts", "new-name.ts", "new.ts"]);
    assert.strictEqual(by["a.ts"]?.mine, true, "the session's own file, first");
    assert.strictEqual(by["a.ts"]?.status, "M");
    assert.deepStrictEqual([by["a.ts"]?.add, by["a.ts"]?.del], [2, 1]);
    const lines = by["a.ts"]?.hunks[0]?.lines || [];
    assert.ok(lines.some((l) => l.t === "-" && l.a === 2 && l.text === "two"));
    assert.ok(lines.some((l) => l.t === "+" && l.b === 2 && l.text === "TWO"));
    assert.ok(lines.some((l) => l.t === "+" && l.b === 4 && l.text === "four"));
    assert.strictEqual(by["gone.ts"]?.status, "D");
    assert.strictEqual(by["new-name.ts"]?.status, "R");
    assert.strictEqual(by["new-name.ts"]?.old, "old-name.ts");
    assert.strictEqual(by["new.ts"]?.status, "U");
    assert.deepStrictEqual(
      by["new.ts"]?.hunks[0]?.lines.map((l) => l.text),
      ["fresh", "file"],
    );
    assert.strictEqual(v.base, "main", "compared to where the branch left main");
  });

  test("files view: only listed paths, never outside the root, never through a link", async () => {
    const allowed = new Set([...(await changedNames(root)), "a.ts"]);
    assert.strictEqual(readFileView(root, "a.ts", allowed)?.text, "one\nTWO\nthree\nfour\n");
    assert.strictEqual(readFileView(root, "new.ts", allowed)?.text, "fresh\nfile\n");
    assert.strictEqual(readFileView(root, "../etc/passwd", new Set(["../etc/passwd"])), null);
    assert.strictEqual(readFileView(root, "not-listed.ts", allowed), null);
    try {
      fs.symlinkSync(path.join(root, "a.ts"), path.join(root, "link.ts"));
      assert.strictEqual(readFileView(root, "link.ts", new Set(["link.ts"]))?.missing, true);
    } catch {
      // no links without rights on Windows
    }
    // A linked folder on the way out of the repo (audit L3): the file behind it is never read.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "geheim");
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, "linked-dir"), "junction");
      linked = true;
    } catch {
      // no links without rights on Windows
    }
    if (linked)
      assert.strictEqual(readFileView(root, "linked-dir/secret.txt", new Set(["linked-dir/secret.txt"])), null);
  });
});

test("parseDiff: quoted names, binaries, and line numbers per hunk", () => {
  assert.strictEqual(unquote('"a\\tb\\303\\244.ts"'), "a\tbä.ts");
  const files = parseDiff(
    [
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,2 +10,3 @@ fn",
      " keep",
      "+add",
      " keep2",
    ].join("\n"),
  );
  assert.strictEqual(files[0]?.binary, true);
  assert.deepStrictEqual(
    files[1]?.hunks[0]?.lines.map((l) => [l.t, l.a, l.b]),
    [
      [" ", 10, 10],
      ["+", null, 11],
      [" ", 11, 12],
    ],
  );
});

test("Diff API in demo mode: invented changes; bad ids 400, unknown 404, a file only from the list", async () => {
  const srv = await startServer({ args: ["--demo"] });
  try {
    const ov = JSON.parse((await srv.request("/api/overview")).body);
    const id = ov.sessions[0].id;
    const d = JSON.parse((await srv.request(`/api/diff?id=${id}`)).body);
    assert.ok(d.files.length >= 2 && d.files.some((f: { mine: boolean }) => f.mine));
    assert.strictEqual((await srv.request("/api/diff?id=../x")).status, 400);
    assert.strictEqual((await srv.request("/api/diff?id=unbekannt")).status, 404);
    const f = JSON.parse((await srv.request(`/api/file?id=${id}&path=src%2Fcart.ts`)).body);
    assert.match(f.text, /export function total/);
    assert.strictEqual((await srv.request(`/api/file?id=${id}&path=%2Fetc%2Fpasswd`)).status, 404);
    assert.strictEqual((await srv.request(`/api/file?id=${id}`)).status, 400);
  } finally {
    await srv.stop();
  }
});
