import assert from "node:assert";
import { test } from "vitest";
import { callKey, hookBase, noteCall, settledState } from "../server/core/hookstate";
import type { HookState } from "../shared/types";

const pre = (id: string, agent?: string) =>
  hookBase({
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_name: "Read",
    tool_input: { file_path: id },
    tool_use_id: id,
    ...(agent ? { agent_id: agent } : {}),
  });

test("Recent calls: a busy subagent does not push out the main thread's call", () => {
  let calls: unknown = [];
  calls = noteCall(calls, pre("main1") as NonNullable<ReturnType<typeof pre>>);
  for (let i = 0; i < 40; i++) calls = noteCall(calls, pre(`a${i}`, "a1") as NonNullable<ReturnType<typeof pre>>);
  const list = calls as { id: string; agent?: string }[];
  assert.ok(list.some((c) => c.id === "main1"));
  assert.strictEqual(list.filter((c) => c.agent === "a1").length, 8);
  assert.strictEqual(noteCall(list, hookBase({ hook_event_name: "Stop", session_id: "s" }) as never), null);
});

test("The key ties tool and input, not the call", () => {
  assert.strictEqual(callKey("Bash", { command: "ls" }), callKey("Bash", { command: "ls" }));
  assert.notStrictEqual(callKey("Bash", { command: "ls" }), callKey("Bash", { command: "ls -a" }));
  assert.notStrictEqual(callKey("Bash", { command: "ls" }), callKey("Read", { command: "ls" }));
});

test("Fleet's answer to one of two requests keeps the session waiting for the other", () => {
  const k1 = callKey("Bash", { command: "a" });
  const k2 = callKey("Bash", { command: "b" });
  const prev = {
    sessionId: "s",
    status: "needs_input",
    event: "PermissionRequest",
    detail: "Freigabe für Bash",
    at: 1,
    startedAt: 1,
    statusSince: 1,
    waitFor: [
      { id: "p1", key: k1, since: 1 },
      { id: "p2", key: k2, since: 1 },
    ],
  } as HookState;
  const one = settledState(prev, '{"behavior":"allow"}', 2, "permission", "Bash", k1);
  assert.strictEqual(one?.status, "needs_input");
  assert.deepStrictEqual(
    one?.waitFor?.map((w) => w.id),
    ["p2"],
  );
  const both = settledState(one as HookState, '{"behavior":"allow"}', 3, "permission", "Bash", k2);
  assert.strictEqual(both?.status, "working");
  assert.strictEqual(both?.waitFor, undefined);
});

test("UserPromptSubmit: an empty prompt is the user's turn, the app's note alone is none, the note is not shown", () => {
  assert.ok(hookBase({ hook_event_name: "UserPromptSubmit", session_id: "s" }), "an image alone");
  const note = "<system-reminder>Linked sessions now: a = local_1</system-reminder>";
  assert.strictEqual(hookBase({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: note }), null);
  const b = hookBase({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: `${note}\nNein, lass es lokal.` });
  assert.strictEqual(b?.detail, "Nein, lass es lokal.");
  assert.strictEqual(b?.injected, false);
});

test("maskSecrets: masks obvious secrets, keeps ordinary words, stays fast on long commands (review #145)", async () => {
  const { maskSecrets } = await import("../server/core/hookstate");
  // Made-up values, put together at run time so secret scanners do not flag the test itself.
  const fake = ["not", "real", "42"].join("-");
  for (const [input, out] of <[string, string][]>[
    [`curl -H "Authorization: Bearer ${fake}" x`, 'curl -H "Authorization: Bearer ***" x'],
    [`curl https://x.test/a?api_key=${fake}&q=1`, "curl https://x.test/a?api_key=***&q=1"],
    [`GITHUB_TOKEN=${fake} gh pr list`, "GITHUB_TOKEN=*** gh pr list"],
    [`psql --password ${fake} db`, "psql --password *** db"],
    [`git clone https://ben:${fake}@git.test/r`, "git clone https://ben:***@git.test/r"],
    ['git commit -m "fix tokenizer: handle x"', 'git commit -m "fix tokenizer: handle x"'],
    ["git log --author=ben", "git log --author=ben"],
    ["echo basic setup", "echo basic setup"],
  ])
    assert.strictEqual(maskSecrets(input), out);
  for (const long of ["a-".repeat(20000), "token-".repeat(5000), `cat <<EOF\n${"x".repeat(60000)}`]) {
    const t0 = performance.now();
    maskSecrets(long);
    assert.ok(performance.now() - t0 < 50, `took ${performance.now() - t0} ms`);
  }
});
