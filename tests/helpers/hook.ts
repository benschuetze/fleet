import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./server";

/**
 * Runs the real, built hook (dist/hook.cjs) like Claude Code does: the event as JSON on stdin, the answer on
 * stdout. Each setup gets its own Fleet folder and a repo; opening programs is only recorded (launch log).
 */
export function hookEnv(o: { limit?: number; context?: number; config?: object } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ho-"));
  const home = path.join(tmp, "fleet");
  const repo = path.join(tmp, "projekt");
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(home, "statusline"), { recursive: true });
  if (o.config) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(o.config));
  const usage = (sid: string, limit?: number, context?: number) =>
    fs.writeFileSync(
      path.join(home, "statusline", `${sid}.json`),
      JSON.stringify({
        sessionId: sid,
        at: Date.now(),
        model: "Opus 5.5",
        context: context === undefined ? null : { size: 1000000, pct: context, tokens: context * 10000 },
        rateLimits:
          limit === undefined
            ? null
            : { five_hour: { used_percentage: limit, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      }),
    );
  usage("s1", o.limit, o.context);
  const env = {
    ...process.env,
    FLEET_LANG: "de",
    CLAUDE_FLEET_HOME: home,
    CLAUDE_FLEET_LAUNCH_LOG: path.join(tmp, "launch.log"),
    CLAUDE_DESKTOP_SESSIONS_DIR: "",
    CLAUDE_DESKTOP_CONFIG: "",
  };
  const hook = (ev: object) =>
    execFileSync(process.execPath, [path.join(ROOT, "dist", "hook.cjs")], {
      input: JSON.stringify(ev),
      env,
      encoding: "utf8",
    });
  const state = (sid: string) => JSON.parse(fs.readFileSync(path.join(home, "state", `${sid}.json`), "utf8"));
  const launched = (): unknown[][] => {
    try {
      return fs
        .readFileSync(path.join(tmp, "launch.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { tmp, home, repo, file: path.join(repo, "HANDOFF.md"), env, hook, state, usage, launched };
}

const line = (o: object) => `${JSON.stringify(o)}\n`;

/** An invented transcript: a prompt, a todo list, an edit, a test run and Claude's answer; ctxTokens sets the context. */
export function transcript(home: string, repo: string, ctxTokens = 1000): string {
  const f = path.join(home, "t.jsonl");
  const now = new Date().toISOString();
  fs.writeFileSync(
    f,
    line({
      type: "user",
      timestamp: now,
      cwd: repo,
      message: { role: "user", content: "Baue den PDF-Export für Rechnungen" },
    }) +
      line({
        type: "assistant",
        timestamp: now,
        message: {
          model: "claude-opus-5-5",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Vorlage bauen", status: "completed" },
                  { content: "Metadaten einbetten", status: "in_progress" },
                  { content: "Tests schreiben", status: "pending" },
                ],
              },
            },
          ],
        },
      }) +
      line({
        type: "assistant",
        timestamp: now,
        message: {
          model: "claude-opus-5-5",
          content: [
            { type: "tool_use", id: "t2", name: "Edit", input: { file_path: path.join(repo, "src", "pdf.js") } },
          ],
        },
      }) +
      line({
        type: "assistant",
        timestamp: now,
        message: {
          model: "claude-opus-5-5",
          content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "pnpm test pdf" } }],
        },
      }) +
      line({
        type: "assistant",
        timestamp: now,
        message: {
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, cache_read_input_tokens: ctxTokens },
          content: [{ type: "text", text: "Die Vorlage steht. Als Nächstes bette ich die Metadaten ein." }],
        },
      }),
  );
  return f;
}
