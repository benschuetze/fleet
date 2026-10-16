import assert from "node:assert";
import { test } from "vitest";
import { inline, parseArch, parseMarkdown } from "./markdown";

test("Architecture notes: headings, lists, code and paragraphs become blocks", () => {
  const md = [
    "# Title #",
    "",
    "One line",
    "goes on.",
    "- a",
    "* **b**",
    "1. first",
    "2) second",
    "```ts",
    "const x = `y`;",
    "```",
    "#### deep",
  ].join("\r\n");
  assert.deepStrictEqual(parseMarkdown(md), [
    { t: "h", level: 1, v: [{ t: "text", v: "Title" }] },
    { t: "p", v: [{ t: "text", v: "One line goes on." }] },
    { t: "ul", items: [[{ t: "text", v: "a" }], [{ t: "bold", v: "b" }]] },
    { t: "ol", items: [[{ t: "text", v: "first" }], [{ t: "text", v: "second" }]] },
    { t: "pre", v: "const x = `y`;" },
    { t: "h", level: 3, v: [{ t: "text", v: "deep" }] },
  ]);
});

test("Links only to http(s); HTML stays text", () => {
  assert.deepStrictEqual(inline("see [docs](https://example.com/a) and [x](javascript:alert(1)) <b>"), [
    { t: "text", v: "see " },
    { t: "link", v: "docs", href: "https://example.com/a" },
    { t: "text", v: " and " },
    { t: "text", v: "x" },
    { t: "text", v: ") <b>" },
  ]);
  assert.deepStrictEqual(parseMarkdown("<script>alert(1)</script>"), [
    { t: "p", v: [{ t: "text", v: "<script>alert(1)</script>" }] },
  ]);
  assert.deepStrictEqual(parseMarkdown(""), []);
});

test("The server's answer is checked like any input: an odd field costs that field", () => {
  assert.deepStrictEqual(parseArch({ file: 3, text: "# x", truncated: "yes", mappe: true }), {
    file: null,
    text: "# x",
    truncated: false,
    mappe: true,
  });
  assert.deepStrictEqual(parseArch(null), { file: null, text: null, truncated: false, mappe: false });
  assert.deepStrictEqual(parseArch({ error: "repo not found" }), { error: "repo not found" });
});
