// Windows refuses a rename while another process reads the target (CI, 16 Oct: EPERM in brake.test, an approval's
// decision was lost). The write tries again and, at the end, writes in place: a decision is never dropped.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { writeAtomic } from "../server/core/decisions";

afterEach(() => vi.restoreAllMocks());

const busy = (code: string) => Object.assign(new Error(code), { code });

test("a rename refused for a moment (EPERM) is tried again and the file holds the data", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-atomic-")), "d.json");
  const real = fs.renameSync;
  let n = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    if (n++ < 2) throw busy("EPERM");
    return real(a, b);
  });
  writeAtomic(file, { ok: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: 1 });
  assert.ok(n >= 3, "tried again");
});

test("a rename that never works writes in place and leaves no temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-atomic-"));
  const file = path.join(dir, "d.json");
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw busy("EBUSY");
  });
  writeAtomic(file, { ok: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir), ["d.json"]);
});

test("any other error still throws", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-atomic-")), "d.json");
  vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw busy("ENOSPC");
  });
  assert.throws(() => writeAtomic(file, { ok: 3 }), /ENOSPC/);
});
