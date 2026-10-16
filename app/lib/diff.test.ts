// The diff view's browser side (release 6): answers checked like inputs, change runs found for `n`.
import assert from "node:assert";
import { test } from "vitest";
import { changeStarts, parseDiffView } from "./diff";

test("A broken file or line costs only itself, never the view", () => {
  const v = parseDiffView({
    base: "main",
    files: [
      {
        path: "ok.ts",
        status: "M",
        hunks: [{ header: "@@", lines: [{ t: "+", a: null, b: 1, text: "x" }, { t: "?" }] }],
      },
      { path: "", status: "M" },
      { path: "bad.ts", status: "Z" },
      "nonsense",
    ],
  });
  assert.deepStrictEqual(
    v?.files.map((f) => [f.path, f.hunks[0]?.lines.length]),
    [["ok.ts", 1]],
  );
  assert.strictEqual(parseDiffView({ files: "no" }), null);
});

test("Change runs: n jumps to the first line of each run of + and - lines", () => {
  const l = (t: "+" | "-" | " ") => ({ t, a: null, b: null, text: "" });
  assert.deepStrictEqual(changeStarts([l(" "), l("-"), l("+"), l(" "), l("+"), l(" ")]), [1, 4]);
  assert.deepStrictEqual(changeStarts([l("+"), l("+")]), [0]);
});
