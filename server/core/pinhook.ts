import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tr } from "./lang";
import { APP_DIR, fleetHome } from "./paths";

/**
 * The hook runs in every Claude Code session of this machine, so one bad build would hit all of them at once.
 * Sessions therefore never run dist/ directly. They run a small guard in ~/.claude-fleet/hook/ that:
 * - loads the last build that passed a self-test (a copy under hook/<id>/, so `pnpm build` on a broken branch
 *   never reaches a running session; the previous copies stay as fallback),
 * - does nothing while ~/.claude-fleet/hook-off exists (the kill switch, `fleet hook off`),
 * - turns every crash into exit code 0 and a line in hook/errors.jsonl,
 * - switches itself off after ten crashes within ten minutes (hook-off with "auto"), which Fleet shows as a warning.
 */

export const KINDS = ["hook", "statusline"] as const;
export type Kind = (typeof KINDS)[number];
const BREAKER_COUNT = 10;
const BREAKER_MS = 10 * 60_000;
const KEEP = 3;

export const hookDir = () => path.join(fleetHome(), "hook");
export const offFile = () => path.join(fleetHome(), "hook-off");
export const errorsFile = () => path.join(hookDir(), "errors.jsonl");
/** What settings.json runs: the guard, never the build itself. */
export const guardPath = (kind: Kind) => path.join(hookDir(), `${kind}.cjs`).replace(/\\/g, "/");

/** The guard: plain CommonJS with Node built-ins only, so it cannot break with a build. */
export function guardSource(appDir: string): string {
  return `// Claude Fleet hook guard, written by Fleet (server/core/pinhook.ts). Do not edit: \`fleet hook\` rewrites it.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CLAUDE_FLEET_HOME || path.join(require("node:os").homedir(), ".claude-fleet");
const dir = path.join(home, "hook");
const kind = path.basename(__filename, ".cjs");
const quit = () => process.exit(0);
function failed(e) {
  try {
    const f = path.join(dir, "errors.jsonl");
    try {
      if (fs.statSync(f).size > 256 * 1024) fs.renameSync(f, f + ".old");
    } catch {}
    const line = JSON.stringify({ at: Date.now(), kind, error: String((e && e.stack) || e).slice(0, 2000) });
    fs.appendFileSync(f, line + "\\n", { mode: 0o600 });
    const at = fs.readFileSync(f, "utf8").trim().split("\\n").slice(-${BREAKER_COUNT}).map((l) => {
      try { return JSON.parse(l).at || 0; } catch { return 0; }
    });
    if (at.length >= ${BREAKER_COUNT} && Date.now() - at[0] < ${BREAKER_MS}) fs.writeFileSync(path.join(home, "hook-off"), "auto\\n", { mode: 0o600 });
  } catch {}
  quit();
}
try {
  if (fs.existsSync(path.join(home, "hook-off"))) quit();
  else {
    process.on("uncaughtException", failed);
    process.on("unhandledRejection", failed);
    const id = fs.readFileSync(path.join(dir, "current"), "utf8").trim();
    if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("no tested build in " + dir);
    if (!process.env.CLAUDE_FLEET_APP) process.env.CLAUDE_FLEET_APP = ${JSON.stringify(appDir)};
    require(path.join(dir, id, kind + ".cjs"));
  }
} catch (e) {
  failed(e);
}
`;
}

const BUILD = (appDir: string, kind: Kind) => path.join(appDir, "dist", `${kind}.cjs`);

/** Id of a build: the first twelve hex digits of the hash over both bundles. */
export function buildId(appDir = APP_DIR): string | null {
  try {
    const h = crypto.createHash("sha256");
    for (const k of KINDS) h.update(fs.readFileSync(BUILD(appDir, k)));
    return h.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

export function currentId(): string {
  try {
    const id = fs.readFileSync(path.join(hookDir(), "current"), "utf8").trim();
    return /^[0-9a-f]{12}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

/**
 * Whether a build from this folder may reach the sessions without being asked: a release folder (no git), or a clean
 * `main` that equals `origin/main` (reviewed and pushed). A Claude session working on Fleet in this folder (another
 * branch, unpushed or uncommitted edits) can then never put its code into every session's hook by itself
 * (security audit M2); `fleet install-hooks` still pins on purpose. Returns the reason it may not, or "".
 */
export function releaseProblem(appDir = APP_DIR): string {
  if (!fs.existsSync(path.join(appDir, ".git"))) return "";
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", "-C", appDir, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") return tr(`Branch ${branch} statt main`, `branch ${branch} instead of main`);
    if (git("status", "--porcelain", "--untracked-files=no"))
      return tr("ungespeicherte Änderungen", "uncommitted changes");
    if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
      return tr("main weicht von origin/main ab", "main differs from origin/main");
    return "";
  } catch {
    return tr("Git-Stand nicht lesbar", "git state not readable");
  }
}

/** Runs a copied build like Claude Code would, against a throwaway Fleet home. Returns the problem or "". */
export function selfTest(dir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-selftest-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_FLEET_HOME: tmp, FLEET_LANG: "en" };
  delete env.CLAUDE_FLEET_PROC;
  delete env.CLAUDE_FLEET_TURN;
  const run = (kind: Kind, ev: object) =>
    execFileSync(process.execPath, [path.join(dir, `${kind}.cjs`)], {
      input: JSON.stringify(ev),
      env,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  try {
    const sid = "fleet-selftest";
    const base = { session_id: sid, cwd: tmp, transcript_path: path.join(tmp, "none.jsonl") };
    for (const ev of [
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "self-test" },
      { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: tmp }, tool_use_id: "t1" },
      { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: tmp }, tool_use_id: "t1" },
      { ...base, hook_event_name: "Stop", last_assistant_message: "Done." },
    ]) {
      const out = run("hook", ev).trim();
      if (out) JSON.parse(out);
    }
    const state = JSON.parse(fs.readFileSync(path.join(tmp, "state", `${sid}.json`), "utf8"));
    if (!state || typeof state.status !== "string") return "hook wrote no status";
    run("statusline", { ...base, model: { display_name: "Test" }, workspace: { current_dir: tmp } });
    return "";
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).split("\n")[0] || "failed";
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Makes the newest build the one sessions run, if it passes the self-test; otherwise the last good one stays.
 * Writes the guards every time (cheap, and repairs a deleted or older guard). Never throws.
 */
export function pinHook(
  appDir = APP_DIR,
  o: { onlyRelease?: boolean } = {},
): { ok: boolean; changed: boolean; message: string } {
  try {
    const id = buildId(appDir);
    const dir = hookDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const guard = guardSource(appDir.replace(/\\/g, "/"));
    for (const k of KINDS) {
      const f = guardPath(k);
      let same = false;
      try {
        same = fs.readFileSync(f, "utf8") === guard;
      } catch {
        // not there yet
      }
      if (!same) writeAtomic(f, guard);
    }
    const cur = currentId();
    if (!id) {
      return cur
        ? { ok: true, changed: false, message: "" }
        : { ok: false, changed: false, message: tr("dist/ fehlt – erst bauen", "dist/ is missing; build first") };
    }
    if (id === cur && fs.existsSync(path.join(dir, id, "hook.cjs"))) return { ok: true, changed: false, message: "" };
    const notRelease = o.onlyRelease && cur ? releaseProblem(appDir) : "";
    if (notRelease)
      return {
        ok: true,
        changed: false,
        message: tr(
          `Neuer Hook-Build nicht übernommen (${notRelease}) – Sessions behalten den geprüften; bewusst übernehmen: node dist/fleet.cjs install-hooks`,
          `New hook build not taken (${notRelease}); sessions keep the tested one. To take it on purpose: node dist/fleet.cjs install-hooks`,
        ),
      };
    const target = path.join(dir, id);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const k of KINDS) fs.copyFileSync(BUILD(appDir, k), path.join(target, `${k}.cjs`));
    const problem = selfTest(target);
    if (problem) {
      fs.rmSync(target, { recursive: true, force: true });
      return {
        ok: !!cur,
        changed: false,
        message: tr(
          `Neuer Hook-Build fiel durch den Selbsttest (${problem}) – ${cur ? "der letzte gute bleibt aktiv" : "Hook nicht eingerichtet"}.`,
          `The new hook build failed its self-test (${problem}); ${cur ? "the last good one stays active" : "hook not set up"}.`,
        ),
      };
    }
    writeAtomic(path.join(dir, "current"), `${id}\n`);
    prune(dir, id, cur);
    return { ok: true, changed: true, message: "" };
  } catch (e) {
    return {
      ok: !!currentId(),
      changed: false,
      message: (e instanceof Error ? e.message : String(e)).split("\n")[0] || "",
    };
  }
}

/** Keeps the active build and the newest others as fallback. */
function prune(dir: string, id: string, prev: string) {
  try {
    const builds = fs
      .readdirSync(dir)
      .filter((d) => /^[0-9a-f]{12}$/.test(d) && d !== id && d !== prev)
      .map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const b of builds.slice(Math.max(0, KEEP - 2)))
      fs.rmSync(path.join(dir, b.d), { recursive: true, force: true });
  } catch {
    // old copies stay
  }
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function hookOff(): "" | "manual" | "auto" {
  try {
    return fs.readFileSync(offFile(), "utf8").trim() === "auto" ? "auto" : "manual";
  } catch {
    return "";
  }
}

export function setHookOff(off: boolean): void {
  if (off) {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(offFile(), "manual\n", { mode: 0o600 });
  } else fs.rmSync(offFile(), { force: true });
}

/** Crashes the guard caught since `since`. */
export function recentErrors(since: number): { at: number; kind: string; error: string }[] {
  try {
    return fs
      .readFileSync(errorsFile(), "utf8")
      .trim()
      .split("\n")
      .flatMap((l) => {
        try {
          const e = JSON.parse(l);
          return e && typeof e.at === "number" && e.at >= since ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** The line for the message row: the hook is off, or it crashed in the last hour. */
export function hookWarning(now: number): string {
  const off = hookOff();
  if (off)
    return off === "auto"
      ? tr(
          "Hook nach 10 Abstürzen in 10 min abgeschaltet – Fleet erkennt keine Wartezustände. Ursache in ~/.claude-fleet/hook/errors.jsonl, dann „node dist/fleet.cjs hook on“.",
          'Hook switched off after 10 crashes in 10 min; Fleet sees no waiting states. Cause in ~/.claude-fleet/hook/errors.jsonl, then "node dist/fleet.cjs hook on".',
        )
      : tr(
          "Hook ist aus (fleet hook off) – Fleet erkennt keine Wartezustände. Einschalten: „node dist/fleet.cjs hook on“.",
          'Hook is off (fleet hook off); Fleet sees no waiting states. Switch on: "node dist/fleet.cjs hook on".',
        );
  const n = recentErrors(now - 3_600_000).length;
  return n
    ? tr(
        `Hook ist in der letzten Stunde ${n}× abgestürzt (Sessions liefen weiter) – ~/.claude-fleet/hook/errors.jsonl`,
        `The hook crashed ${n}× in the last hour (sessions went on); see ~/.claude-fleet/hook/errors.jsonl`,
      )
    : "";
}
