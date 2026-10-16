import fs from "node:fs";
import path from "node:path";
import { beginTurn } from "../core/fleetturns";
import { tr } from "../core/lang";
import * as launch from "../core/launch";
import { priceFor } from "../core/usage";
import { groupOf, prevOf } from "./desktop";
import { takeFresh } from "./marks";
import {
  excludeFromGit,
  FILE,
  fleetTerminal,
  MAX_BYTES,
  readRegistry,
  readSmall,
  rootOf,
  sha,
  writeRegistry,
} from "./registry";
import { readConfig } from "./settings";
import { continuePrompt, facts, goalOf, instruction, stamp, tokensText } from "./text";
import { openTargetOf, progressSince } from "./transcript";
import { readUsage } from "./usage";

/**
 * Requesting the handoff: before the five-hour limit or the context window runs out, Fleet lets the session
 * write HANDOFF.md at the end of a turn. A new session in the same folder receives it at start instead of
 * paying for the whole old context again after a break.
 *
 * Why the same session (and model) writes it: its history is already in the cache. Another model would have
 * to read it completely and write it into its own cache.
 */

const OPEN_WINDOW = 30 * 60e3;
/** A new session from the app's link usually takes its handoff within seconds. */
const NOT_STARTED_AFTER = 60e3;

interface HookEvent {
  session_id: string;
  cwd?: unknown;
  stop_hook_active?: unknown;
  transcript_path?: unknown;
}

/** Can Fleet open a new session here? Returns the target or null. The one chosen in the dashboard wins. */
function opener(root: string, transcript: unknown, chosen: string | null = null): launch.Target | null {
  const env = launch.env();
  // A session in Fleet's own window (terminal first): its successor opens there too, not in Terminal.app.
  const own = /^[\w.-]{1,128}$/.test(process.env.CLAUDE_FLEET_PROC || "") ? "fleet" : null;
  const tries = [chosen, own, openTargetOf(transcript)].filter((t): t is launch.Target => launch.isTarget(t));
  return tries.find((t) => (t === "fleet" ? fleetTerminal() : launch.planNew(t, root, "x", env).length)) || null;
}

/** Registers the request and returns the text for Claude, or null if there is nothing (new) to ask for. */
function request(
  ev: HookEvent & { cwd: string },
  now: number,
  why: { reason: string; key: string },
  manual: { target: string | null } | null,
) {
  const cfg = readConfig();
  const u = readUsage(ev.session_id, now, ev.transcript_path);
  // Starting fresh only where it clearly pays off: a big context that every call re-reads.
  const perCall = u.tokens ? (u.tokens * priceFor(u.model).cr) / 1e6 : 0;
  // A new session only helps against a big context. If only the limit runs low, it runs into the same limit:
  // then a handoff yes, a new session no (continue after the reset, with one click in Fleet).
  const fresh =
    manual || (cfg.clearAfter && why.key === "context" && u.tokens !== null && u.tokens >= cfg.clearMinTokens)
      ? { tokens: u.tokens || 0, perCall }
      : null;
  const openWhy = manual
    ? tr("ich in Fleet „Frisch starten“ gewählt habe", 'I chose "Start fresh" in Fleet')
    : tr(
        `der Kontext ${tokensText(u.tokens || 0)} Tokens groß war`,
        `the context had grown to ${tokensText(u.tokens || 0)} tokens`,
      );
  const root = rootOf(ev.cwd);
  const reg = readRegistry();
  const prev = reg.byDir[root];
  if (prev && prev.key === why.key && (why.key !== "context" || now - prev.requestedAt < 2 * 3600e3)) return null;
  // Just asked this session for a fresh-start handoff: no second request at the end of the same turn.
  if (
    prev &&
    prev.sessionId === ev.session_id &&
    prev.key.startsWith("manual") &&
    !why.key.startsWith("manual") &&
    now - prev.requestedAt < OPEN_WINDOW
  )
    return null;
  const file = path.join(root, FILE);
  const openIn = fresh ? opener(root, ev.transcript_path, manual?.target || null) : null;
  reg.byDir[root] = {
    sessionId: ev.session_id,
    requestedAt: now,
    reason: why.reason,
    key: why.key,
    file,
    ...(openIn ? { openIn, openWhy } : {}),
  };
  writeRegistry(reg);
  excludeFromGit(root);
  // Writing the handoff is a turn Fleet caused: it counts as Fleet's cost in the balance.
  beginTurn(ev.session_id, "handoff", now);
  return {
    text: instruction(why.reason, file, fresh, !!openIn, !fresh && why.key.startsWith("limit:")),
    fresh: !!fresh,
  };
}

/**
 * At the end of a turn (Stop hook): request a handoff when the limit or the context runs low. Per repo at
 * most once per five-hour block, or every two hours for the context.
 */
export function onStop(ev: HookEvent, now: number): { output: string; detail: string } | null {
  if (ev.stop_hook_active || typeof ev.cwd !== "string" || !ev.cwd) return null;
  // "Start fresh" from the dashboard applies even when the automatic handoff is off.
  const manual = takeFresh(ev.session_id);
  const cfg = readConfig();
  if (!cfg.enabled && !manual) return null;
  const u = readUsage(ev.session_id, now, ev.transcript_path);
  let why: { reason: string; key: string } | null = null;
  if (manual)
    why = {
      reason: tr("Du hast in Fleet „Frisch starten“ gewählt", 'You chose "Start fresh" in Fleet'),
      key: `manual:${now}`,
    };
  else if (u.limit !== null && u.limit >= cfg.limitPercent) {
    why = {
      reason: tr(
        `Das 5-Stunden-Limit ist zu ${Math.round(u.limit)} % verbraucht`,
        `The five-hour limit is ${Math.round(u.limit)} % used`,
      ),
      key: `limit:${u.resetsAt || Math.floor(now / (5 * 3600e3))}`,
    };
  } else if (u.context !== null && u.context >= cfg.contextPercent) {
    why = {
      reason: tr(
        `Das Kontextfenster ist zu ${Math.round(u.context)} % voll`,
        `The context window is ${Math.round(u.context)} % full`,
      ),
      key: "context",
    };
  } else if (u.tokens !== null && u.tokens >= cfg.largeContextTokens) {
    why = {
      reason: tr(
        `Der Kontext ist mit ${tokensText(u.tokens)} Tokens groß`,
        `The context is large at ${tokensText(u.tokens)} tokens`,
      ),
      key: "context",
    };
  }
  if (!why) return null;
  const r = request({ ...ev, cwd: ev.cwd }, now, why, manual);
  if (!r) return null;
  return {
    detail: `${tr(`schreibt Übergabe${r.fresh ? " und startet frisch" : ""}`, `writing handoff${r.fresh ? " and starting fresh" : ""}`)} (${why.reason.replace(/^(Das|Der|The) /, "")})`,
    output: JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: r.text } }),
  };
}

/**
 * The user chose "Start fresh" while the session was waiting, then sent it a message: write the handoff now,
 * before anything else, so the summary comes from the model that knows the whole conversation.
 */
export function onPrompt(ev: HookEvent, now: number): { output: string; detail: string } | null {
  if (typeof ev.cwd !== "string" || !ev.cwd) return null;
  const manual = takeFresh(ev.session_id);
  if (!manual) return null;
  const r = request(
    { ...ev, cwd: ev.cwd },
    now,
    {
      reason: tr("Du hast in Fleet „Frisch starten“ gewählt", 'You chose "Start fresh" in Fleet'),
      key: `manual:${now}`,
    },
    manual,
  );
  if (!r) return null;
  const first = tr(
    "Schreib zuerst die Übergabe, bevor du auf die Nachricht des Nutzers eingehst; ist sie nur ein Anstoß (etwa „Übergabe“), genügt die Übergabe.",
    'Write the handoff first, before you respond to the user\'s message; if it is only a nudge (like "handoff"), the handoff is enough.',
  );
  return {
    detail: tr("schreibt Übergabe und startet frisch", "writing handoff and starting fresh"),
    output: JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${first}\n\n${r.text}` },
    }),
  };
}

/**
 * Request a handoff right away because the user decided so in Fleet (brake). Returns the text for Claude and
 * registers the file so the next session trusts it. No new session opens: the user just paused, they decide
 * how to continue ("Ready to continue" card).
 */
export function requestNow(
  ev: { session_id: string; cwd: string; transcript_path?: unknown },
  reason: string,
  now: number,
): string {
  const root = rootOf(ev.cwd);
  const file = path.join(root, FILE);
  const reg = readRegistry();
  reg.byDir[root] = { sessionId: ev.session_id, requestedAt: now, reason, key: "brake", file };
  writeRegistry(reg);
  excludeFromGit(root);
  beginTurn(ev.session_id, "handoff", now);
  return instruction(reason, file);
}

/** After the handoff: remember its fingerprint. Runs on every event of the requesting session once the file was written. */
export function noteWritten(sid: string, cwd: unknown): void {
  if (typeof cwd !== "string" || !cwd) return;
  const root = rootOf(cwd);
  const reg = readRegistry();
  const e = reg.byDir[root];
  // Once delivered, the fingerprint is final: a later edit never makes the file trusted again (audit L1).
  if (!e || e.sessionId !== sid || e.deliveredTo) return;
  try {
    const st = fs.statSync(e.file);
    if (st.mtimeMs < e.requestedAt - 1000 || st.size > MAX_BYTES || (e.writtenAt && st.mtimeMs <= e.writtenAt)) return;
    e.sha = sha(fs.readFileSync(e.file));
    e.writtenAt = st.mtimeMs;
    writeRegistry(reg);
  } catch {
    // not written yet
  }
}

const AUTO = () => tr("## Stand nach dem letzten Turn (automatisch)", "## State after the last turn (automatic)");

/**
 * Running state: when the limit is tight and the handoff is written, Fleet appends after every turn what
 * happened since (prompts, todo list, files, last answer). No model, no tokens. If the session breaks off
 * later, the exact point is in the handoff. The section is replaced each time, Claude's own text stays.
 */
export function checkpoint(ev: HookEvent, now: number): boolean {
  if (typeof ev.cwd !== "string" || !ev.cwd || typeof ev.transcript_path !== "string") return false;
  const root = rootOf(ev.cwd);
  const reg = readRegistry();
  const e = reg.byDir[root];
  if (!e || e.sessionId !== ev.session_id || !e.key.startsWith("limit:") || !e.sha || !e.writtenAt) return false;
  let md: string;
  try {
    const buf = fs.readFileSync(e.file);
    if (sha(buf) !== e.sha) return false;
    md = buf.toString("utf8");
  } catch {
    return false;
  }
  const marker = AUTO();
  const base = md.includes(marker) ? md.slice(0, md.indexOf(marker)).trimEnd() : md.trimEnd();
  const since = e.baseAt || e.writtenAt;
  const p = progressSince(ev.transcript_path, root, since);
  if (!p.prompts.length && !p.files.length && !p.answer) return false;
  const out = [
    base,
    "",
    marker,
    "",
    tr(
      `Von Claude Fleet nach jedem Turn ergänzt, zuletzt ${stamp(now)}. Was nach der Übergabe oben passiert ist:`,
      `Added by Claude Fleet after every turn, last at ${stamp(now)}. What happened after the handoff above:`,
    ),
    ...(p.prompts.length
      ? ["", `- ${tr("Aufträge seitdem", "Prompts since")}:`, ...p.prompts.slice(-4).map((x) => `  - ${x}`)]
      : []),
    ...(p.open.length
      ? [`- ${tr("Offen laut Todo-Liste", "Open per todo list")}: ${p.open.slice(0, 6).join("; ")}`]
      : []),
    ...(p.done.length
      ? [`- ${tr("Erledigt laut Todo-Liste", "Done per todo list")}: ${p.done.slice(-6).join("; ")}`]
      : []),
    ...facts(p),
    "",
  ].join("\n");
  try {
    fs.writeFileSync(e.file, out);
    e.baseAt = since;
    e.sha = sha(out);
    e.writtenAt = fs.statSync(e.file).mtimeMs;
    writeRegistry(reg);
    return true;
  } catch {
    return false;
  }
}

/**
 * At the end of a turn after the handoff was written: open a new session once, whose first message says
 * visibly what it is about. The SessionStart handoff then delivers the whole content.
 */
export function takeOpen(sid: string, now: number): { target: launch.Target; root: string; prompt: string } | null {
  const reg = readRegistry();
  // Only right after the request: a handoff written hours later no longer belongs to this fresh start and
  // must not open a window out of the blue.
  const hit = Object.entries(reg.byDir).find(
    ([, e]) => e?.sessionId === sid && e.openIn && e.sha && !e.openedAt && now - e.requestedAt < OPEN_WINDOW,
  );
  if (!hit) return null;
  const [root, e] = hit;
  if (!launch.isTarget(e.openIn)) return null;
  e.openedAt = now;
  const g = groupOf(sid);
  if (g) e.group = g;
  const p = prevOf(sid);
  if (p) e.prev = p;
  let goal = "";
  try {
    goal = goalOf(fs.readFileSync(e.file, "utf8"));
  } catch {
    // no goal line
  }
  const prompt = continuePrompt(path.basename(root), e.openWhy || "", goal);
  // Fleet's own window: the server starts it when it sees the mark (server/process/pending.ts).
  if (e.openIn === "fleet") {
    e.pendingStart = true;
    e.pendingPrompt = prompt;
  }
  writeRegistry(reg);
  return { target: e.openIn, root, prompt };
}

/**
 * Fleet opened the new session, but none took the handoff a minute later (live 16.10.2026: the app took the link
 * and made no session). Fleet cannot tell a lost link from a draft not sent yet, so it never opens a second one by
 * itself (two sessions would continue the same handoff); it only says so. Read only.
 */
export function notStarted(sid: string, now: number): boolean {
  return Object.values(readRegistry().byDir).some((e) => {
    if (e?.sessionId !== sid || !e.openedAt || e.deliveredTo || !e.sha) return false;
    // Fleet's window: only once the server took the mark (its start can fail, e.g. at the session limit).
    if (e.openIn === "fleet" && e.pendingStart) return false;
    if (now - e.openedAt <= NOT_STARTED_AFTER || now - e.openedAt >= OPEN_WINDOW) return false;
    // The drawer offers "Open again" only for an unchanged handoff: the same rule as read.ts.
    const buf = readSmall(e.file, now, 12 * 3600e3);
    return !!buf && sha(buf) === e.sha;
  });
}
