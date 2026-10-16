// Demo times hang on the server start (round 7): the conversation's first line, the history's "new task" and the
// Cowork prompt stay where they are, whatever the clock says and however far the log's window has slid.
import assert from "node:assert";
import { test } from "vitest";
import { demoChat, demoLog, demoTaskStart } from "../server/core/demo-log";

const H = 3600e3;

test("a working session's conversation starts at the same time now and hours later (round 7)", () => {
  const ids = [...new Set(demoLog(Date.now()).lines.map((l) => l.session))];
  assert.ok(ids.length > 3);
  for (const id of ids) {
    const task = demoTaskStart(id);
    assert.ok(task !== null, id);
    for (const dt of [0, 40 * 60e3, 3 * H, 9 * H]) {
      const page = demoChat(
        id,
        { lastPrompt: "task", status: "working", statusSince: Date.now() + 99 * H },
        Date.now() + dt,
      );
      assert.strictEqual(page.entries[0]?.at, task, `${id} +${dt}`);
    }
  }
});

test("the task start is no later than any step of the session, even when the log window slid on (round 7)", () => {
  const later = Date.now() + 6 * H;
  for (const l of demoLog(later).lines) {
    const task = demoTaskStart(l.session);
    assert.ok(task !== null && task <= l.at, `${l.session}: ${task} > ${l.at}`);
  }
});

test("a session without steps (Cowork) asks when its state began, at any time (round 7)", () => {
  const since = Date.now() - 37 * 60e3;
  for (const dt of [0, 5 * 60e3, 2 * H]) {
    const page = demoChat(
      "cowork-without-steps",
      { lastPrompt: "Plan", status: "waiting", statusSince: since },
      Date.now() + dt,
    );
    assert.strictEqual(page.entries[0]?.at, since, `+${dt}`);
  }
});
