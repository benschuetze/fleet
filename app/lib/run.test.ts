import { expect, test } from "vitest";
import { parseRun } from "./run";

test("Run details with missing fields still give a complete, safe shape", () => {
  // Reported by the e2e test: a reply without `tests` took the whole dashboard down
  const r = parseRun({ id: 7, jobs: [{ name: "test", state: "failure", notes: ["was not started", 3] }] });
  expect(r).toMatchObject({ id: 7, tests: [], log: null, state: "none" });
  if ("error" in r) throw new Error("unexpected error");
  expect(r.jobs[0]).toEqual({
    id: 0,
    name: "test",
    state: "failure",
    current: null,
    steps: [],
    notes: ["was not started"],
  });
});

test("Errors and garbage stay errors or empty, never throw", () => {
  expect(parseRun({ error: "nicht gefunden" })).toEqual({ error: "nicht gefunden" });
  for (const v of [null, 42, "x", [], { jobs: "nope", tests: {} }]) expect(() => parseRun(v)).not.toThrow();
});
