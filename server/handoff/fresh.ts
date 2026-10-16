import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tr } from "../core/lang";
import * as launch from "../core/launch";
import { cliLoggedIn } from "../process/cli";
import { setFresh } from "./marks";

/**
 * "Start fresh" from the dashboard. The summary always comes from the session itself, the model that knows the
 * whole conversation; Fleet never hands over the raw history. How it gets the session to write:
 *
 *  - working: the mark is consumed at the end of the current turn (Stop hook asks for the handoff).
 *  - waiting, Claude CLI logged in: Fleet resumes the session in the background (`claude --resume <id> -p`, as a
 *    job of the process manager when the server passes one, so its cost is counted exactly)
 *    with a one-word nudge; the UserPromptSubmit hook turns it into the handoff request, the Stop hook opens
 *    the new session afterwards.
 *  - waiting, no usable CLI: the mark waits for the user's next message in that session (any text, e.g.
 *    "handoff"); Fleet opens the old session so the user can send it.
 */

export type FreshMode = "turn-end" | "background" | "ask";
export type FreshResult = { ok: true; mode: FreshMode; target: launch.Target | null } | { ok: false; error: string };
/** Fleet's job runner (server/process): the background turn with exactly counted costs. */
export type JobRunner = (o: { id: string; cwd: string; prompt: string }) => Promise<boolean>;

const BUSY = ["working", "stale", "needs_input"];

function backgroundTurn(cli: string, sid: string, cwd: string): boolean {
  const args = ["--resume", sid, "-p", tr("Übergabe", "Handoff")];
  const log = process.env.CLAUDE_FLEET_LAUNCH_LOG;
  if (log) {
    try {
      fs.appendFileSync(log, `${JSON.stringify([{ cmd: cli, args, cwd }])}\n`);
    } catch {
      // test log only
    }
    return true;
  }
  try {
    const c = spawn(cli, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
    c.on("error", () => {});
    c.unref();
    return true;
  } catch {
    return false;
  }
}

export async function freshStart(
  s: { id: string; cwd: string | null | undefined; status: string | undefined; desktopId?: string | null },
  chosen: string | null,
  o: { job?: JobRunner; fleet?: boolean } = {},
): Promise<FreshResult> {
  const env = launch.env();
  const ok = launch
    .targets(env, o.fleet ? { available: true } : undefined)
    .filter((t) => t.ok)
    .map((t) => t.id);
  const target =
    chosen && launch.isTarget(chosen) && ok.includes(chosen)
      ? chosen
      : ok.includes("desktop")
        ? "desktop"
        : (ok[0] ?? null);
  if (!s.cwd || !path.isAbsolute(s.cwd))
    return { ok: false, error: tr("Session ohne Ordner", "Session without a folder") };
  if (!setFresh(s.id, true, target))
    return { ok: false, error: tr("Konnte nicht gespeichert werden", "Could not be saved") };
  if (BUSY.includes(String(s.status))) return { ok: true, mode: "turn-end", target };
  if (
    env.claude &&
    (await cliLoggedIn(env.claude)) &&
    (o.job
      ? await o.job({ id: s.id, cwd: s.cwd, prompt: tr("Übergabe", "Handoff") })
      : backgroundTurn(env.claude, s.id, s.cwd))
  )
    return { ok: true, mode: "background", target };
  // Open the old session so the user can nudge it; the new one follows once the handoff is written.
  const steps = launch.plan("desktop", { id: s.id, cwd: s.cwd, desktopId: s.desktopId }, env);
  if (steps.length) launch.run(steps);
  return { ok: true, mode: "ask", target };
}
