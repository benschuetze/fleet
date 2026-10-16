// The repo drawer shows a repo's architecture notes: only fixed names inside the repo, never a file outside it.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ARCH_MAX, readArchitecture } from "../server/core/architecture";

const repo = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-arch-")));
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test("The private Architekturmappe first, then ARCHITECTURE.md; none is an empty state, not an error", () => {
  const r = repo();
  assert.deepStrictEqual(readArchitecture(r), { file: null, text: null, truncated: false, mappe: false });
  write(r, "docs/ARCHITECTURE.md", "# docs");
  assert.strictEqual(readArchitecture(r).file, "docs/ARCHITECTURE.md");
  write(r, "ARCHITECTURE.md", "# top");
  assert.strictEqual(readArchitecture(r).text, "# top");
  write(r, ".architektur/README.md", "# Mappe");
  write(r, ".architektur/mappe.html", "<html></html>");
  assert.deepStrictEqual(readArchitecture(r), {
    file: ".architektur/README.md",
    text: "# Mappe",
    truncated: false,
    mappe: true,
  });
  assert.deepStrictEqual(readArchitecture(path.join(r, "missing")).text, null);
});

test("Big notes are cut at the limit, without a broken character at the end", () => {
  const r = repo();
  write(r, "ARCHITECTURE.md", `${"a".repeat(ARCH_MAX - 1)}äöü`);
  const d = readArchitecture(r);
  assert.strictEqual(d.truncated, true);
  assert.ok(Buffer.byteLength(String(d.text)) <= ARCH_MAX);
  assert.doesNotMatch(String(d.text), /�/);
});

test.skipIf(process.platform === "win32")("A link that leads out of the repo is not followed", () => {
  const r = repo();
  const outside = repo();
  write(outside, "secret.md", "secret");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(r, "ARCHITECTURE.md"));
  fs.symlinkSync(outside, path.join(r, ".architektur"));
  assert.strictEqual(readArchitecture(r).text, null);
  // A directory with the file's name is no file either
  const d = repo();
  fs.mkdirSync(path.join(d, "ARCHITECTURE.md"));
  assert.strictEqual(readArchitecture(d).file, null);
});
