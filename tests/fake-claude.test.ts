// The invented claude is the ground the process tests stand on: once its prompt is visible, an interrupt must
// print ^C and leave it running. CI once saw the interrupt arrive before the handler was in place.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { test } from "vitest";
import { fakeClaude } from "./helpers/fake-claude";

test.skipIf(process.platform === "win32")(
  "Fake claude: an interrupt right after its first output prints ^C and does not end it",
  async () => {
    const fake = fakeClaude();
    const one = () =>
      new Promise<{ out: string; code: number | null; signal: string | null }>((resolve) => {
        const child = spawn(process.execPath, [fake.file], {
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, FAKE_CLAUDE_LOG: fake.log },
        });
        let out = "";
        let sent = false;
        child.stdout.on("data", (d) => {
          out += d;
          // Exactly what the manager may do: interrupt as soon as the prompt shows.
          if (!sent) {
            sent = true;
            child.kill("SIGINT");
          }
          if (out.includes("^C")) child.kill("SIGTERM");
        });
        child.on("exit", (code, signal) => resolve({ out, code, signal }));
      });
    const runs = await Promise.all(Array.from({ length: 20 }, one));
    for (const r of runs) {
      assert.match(r.out, /\^C/, `interrupt handled (exit ${r.code}, signal ${r.signal})`);
      assert.strictEqual(r.code, 143, "ended by the later SIGTERM, not by the interrupt");
    }
  },
);
