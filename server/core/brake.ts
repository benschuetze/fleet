import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrakeAnswer, Decision } from "../../shared/types";
import { requestNow } from "../handoff/request";
import { readUsage } from "../handoff/usage";
import { answer, decisionDir, latestFor, list, read, readJson, save, writeAtomic } from "./decisions";
import { tr } from "./lang";
import { sig } from "./loop";
import { APP_DIR, fleetHome, ID_RE } from "./paths";

export { answer, decisionDir, latestFor, list, read, save };

/**
 * The brake: when a session gets stuck (loop, run of errors) or the limit threatens to run out mid-work, Fleet
 * pauses it before the next tool call and asks in the dashboard how to continue. The answer goes straight back
 * to Claude (as the reason for denying the tool call, or as a stop). Without an answer the session continues
 * after `waitSeconds`; a later answer applies at the next tool call.
 *
 * A full context is no reason: the automatic handoff at the end of the turn covers that. Why before the tool
 * call: only there can a hook wait mid-turn and give Claude an instruction. At the end of a turn the session
 * waits for you anyway.
 *
 * Runs in the hook on every tool call: only fs/path, small files, never throw.
 */

export interface BrakeConfig {
  enabled: boolean;
  waitSeconds: number;
  loop: boolean;
  limitPercent: number;
  openFleet: boolean;
  approvals: boolean;
  approvalSeconds: number;
}
type Ring = {
  ring: { id: string; sig: string; tool: string; err?: boolean }[];
  fired: Record<string, number | string>;
  checkedAt: number;
};
// biome-ignore lint/suspicious/noExplicitAny: hook input from Claude Code, checked field by field
type HookEvent = Record<string, any>;

// Loops no longer pause: across 5,077 real tool calls the rule would have fired twice, both times while
// waiting in the browser, never in a real loop. The dashboard still shows "Loop?".
export const DEFAULTS: BrakeConfig = {
  enabled: true,
  waitSeconds: 90,
  loop: false,
  limitPercent: 95,
  openFleet: true,
  approvals: true,
  approvalSeconds: 45,
};
/** Longest wait: the hook timeout in settings.json is above this (install-hooks). */
export const MAX_WAIT = 120;
// Pausing before these tools is pointless: they ask the user anyway.
const SKIP = /^(AskUserQuestion|ExitPlanMode|EnterPlanMode|TodoWrite)$/;

const ringFile = (sid: string) => path.join(fleetHome(), "brake", `${sid}.json`);
const errFile = (sid: string) => path.join(fleetHome(), "brake", `${sid}.err`);

export function readConfig(): BrakeConfig {
  const cfg = { ...DEFAULTS };
  for (const p of [path.join(APP_DIR, "config.json"), path.join(fleetHome(), "config.json")]) {
    const j = readJson<{ brake?: Record<string, unknown> }>(p);
    if (!j) continue;
    const b = j.brake;
    if (b && typeof b === "object") {
      for (const k of ["enabled", "loop", "openFleet", "approvals"] as const)
        if (typeof b[k] === "boolean") cfg[k] = b[k];
      if (Number.isFinite(b.approvalSeconds))
        cfg.approvalSeconds = Math.min(MAX_WAIT, Math.max(5, Number(b.approvalSeconds)));
      if (Number.isFinite(b.waitSeconds)) cfg.waitSeconds = Math.min(MAX_WAIT, Math.max(2, Number(b.waitSeconds)));
      if (Number.isFinite(b.limitPercent)) cfg.limitPercent = Math.min(100, Math.max(50, Number(b.limitPercent)));
    }
    break;
  }
  return cfg;
}

/**
 * Stricter than the loop hint in the dashboard: test, change, test is progress. Fleet only pauses when the
 * same call comes three times in a row, five times among the last ten, or five calls in a row failed.
 */
export function stuck(ring: Ring["ring"]): { what: "repeat" | "errors"; tool: string; count: number } | null {
  const last = ring[ring.length - 1];
  if (!last) return null;
  let run = 0;
  for (let i = ring.length - 1; i >= 0 && ring[i]?.sig === last.sig; i--) run++;
  if (run >= 3) return { what: "repeat", tool: last.tool, count: run };
  const counts = new Map<string, number>();
  for (const r of ring.slice(-10)) counts.set(r.sig, (counts.get(r.sig) || 0) + 1);
  for (const [k, n] of counts) if (n >= 5) return { what: "repeat", tool: k.slice(0, k.lastIndexOf(":")), count: n };
  let errs = 0;
  // the call that is about to run has no result yet
  for (let i = ring.length - 2; i >= 0 && ring[i]?.err; i--) errs++;
  if (errs >= 5) return { what: "errors", tool: ring[ring.length - 2]?.tool || last.tool, count: errs };
  return null;
}

/** Remembers failed tool calls (PostToolUseFailure, runs in the background). */
export function noteFailure(sid: string, toolUseId: unknown): void {
  if (!ID_RE.test(sid) || typeof toolUseId !== "string" || !/^[\w-]{1,128}$/.test(toolUseId)) return;
  try {
    fs.mkdirSync(path.dirname(errFile(sid)), { recursive: true, mode: 0o700 });
    fs.appendFileSync(errFile(sid), `${toolUseId}\n`, { mode: 0o600 });
  } catch {
    // never block the hook
  }
}

const strong = (model: unknown) => /opus|fable|mythos/i.test(String(model || ""));

function make(
  sid: string,
  cwd: string,
  now: number,
  waitSeconds: number,
  kind: Decision["kind"],
  title: string,
  text: string,
  options: Decision["options"],
  recommended: BrakeAnswer,
): Decision {
  return {
    id: `${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    sessionId: sid,
    cwd,
    kind,
    title,
    text,
    options,
    recommended,
    createdAt: now,
    expiresAt: now + waitSeconds * 1000,
    status: "open",
  };
}

/** Before a tool call: a (late) answer is applied now. Otherwise check whether to pause. */
export function onPreToolUse(ev: HookEvent, now: number): { output: string } | { decision: Decision } | null {
  const sid = String(ev.session_id || "");
  const cwd = typeof ev.cwd === "string" ? ev.cwd.slice(0, 1000) : "";
  if (!ID_RE.test(sid) || !cwd) return null;
  const cfg = readConfig();
  if (!cfg.enabled) return null;

  const late = latestFor(sid, "answered");
  if (late) return { output: apply(late, ev, now) };

  const tool = String(ev.tool_name || "").slice(0, 80);
  const st = readJson<Ring>(ringFile(sid)) || { ring: [], fired: {}, checkedAt: 0 };
  if (!Array.isArray(st.ring) || typeof st.fired !== "object" || !st.fired) {
    st.ring = [];
    st.fired = {};
  }
  st.ring.push({ id: String(ev.tool_use_id || "").slice(0, 128), sig: sig(tool, ev.tool_input), tool });
  st.ring = st.ring.slice(-12);
  try {
    const failed = new Set(fs.readFileSync(errFile(sid), "utf8").split("\n").slice(-50));
    for (const r of st.ring) if (r.id && failed.has(r.id)) r.err = true;
  } catch {
    // no failures recorded
  }

  let d: Decision | null = null;
  if (!SKIP.test(tool)) {
    const loop = cfg.loop ? stuck(st.ring) : null;
    if (loop && !(now - Number(st.fired.loop || 0) < 15 * 60e3)) {
      st.fired.loop = now;
      st.ring = [];
      const u = readUsage(sid, now, ev.transcript_path);
      d = make(
        sid,
        cwd,
        now,
        cfg.waitSeconds,
        "loop",
        loop.what === "repeat"
          ? tr(`${loop.count}× derselbe ${loop.tool}-Aufruf`, `${loop.count}× the same ${loop.tool} call`)
          : tr(`${loop.count} fehlgeschlagene Aufrufe in Folge`, `${loop.count} failed calls in a row`),
        loop.what === "repeat"
          ? tr(
              `Die Session wiederholt denselben ${loop.tool}-Aufruf, ohne dass sich etwas ändert. Jeder weitere Versuch kostet Tokens.`,
              `The session repeats the same ${loop.tool} call without anything changing. Every further attempt costs tokens.`,
            )
          : tr(
              `Die letzten ${loop.count} Werkzeugaufrufe sind fehlgeschlagen (zuletzt ${loop.tool}).`,
              `The last ${loop.count} tool calls failed (last ${loop.tool}).`,
            ),
        [
          {
            id: "rethink",
            label: tr("Innehalten und neu ansetzen", "Pause and rethink"),
            hint: tr(
              "Claude fasst zusammen, was nicht klappt, und fragt dich",
              "Claude sums up what does not work and asks you",
            ),
          },
          ...(strong(u.model)
            ? []
            : [
                {
                  id: "escalate" as const,
                  label: tr("An Opus-Subagent geben", "Hand to an Opus subagent"),
                  hint: tr(
                    "Ein stärkeres Modell übernimmt den festgefahrenen Schritt",
                    "A stronger model takes over the stuck step",
                  ),
                },
              ]),
          { id: "continue", label: tr("Weiter so", "Carry on") },
          { id: "stop", label: tr("Anhalten", "Stop") },
        ],
        "rethink",
      );
    } else if (now - (st.checkedAt || 0) > 20e3) {
      // Check the limit at most every 20 s: it reads files and the hook must stay fast.
      st.checkedAt = now;
      const u = readUsage(sid, now, ev.transcript_path);
      const block = String(u.resetsAt || Math.floor(now / (5 * 3600e3)));
      if (u.limit !== null && u.limit >= cfg.limitPercent && st.fired.limit !== block) {
        st.fired.limit = block;
        d = make(
          sid,
          cwd,
          now,
          cfg.waitSeconds,
          "limit",
          tr(`5-Stunden-Limit zu ${Math.round(u.limit)} % verbraucht`, `Five-hour limit ${Math.round(u.limit)} % used`),
          tr(
            "Läuft das Limit mitten in der Arbeit aus, bricht der Turn ab und der Stand steckt nur im Verlauf. Eine Übergabe jetzt sichert ihn.",
            "If the limit runs out mid-work, the turn breaks off and the state only lives in the history. A handoff now saves it.",
          ),
          [
            {
              id: "handoff",
              label: tr("Übergabe schreiben", "Write a handoff"),
              hint: tr(
                "Claude hält den Stand in HANDOFF.md fest und hört auf",
                "Claude records the state in HANDOFF.md and stops",
              ),
            },
            { id: "continue", label: tr("Weiter", "Continue") },
            { id: "stop", label: tr("Anhalten", "Stop") },
          ],
          "handoff",
        );
      }
    }
  }
  try {
    writeAtomic(ringFile(sid), st);
  } catch {
    // never block the hook
  }
  if (!d) return null;
  try {
    writeAtomic(path.join(decisionDir(), `${d.id}.json`), d);
  } catch {
    return null;
  }
  return { decision: d };
}

/**
 * How long a report from a focused Fleet tab counts. The tab reports every 15 s while it is in front
 * (app/lib/presence.ts) and at once when it leaves; this only covers a tab that vanished without a word.
 */
export const UI_FRESH_MS = 40e3;
/** A gap this long without the mark ends a wait: switching between two Fleet tabs is no leaving. */
const LEFT_MS = 1000;

/**
 * Is a Fleet tab visible and focused right now? The server writes the mark only for such a tab (bug B3: an
 * open background tab held every approval 45 s while the app showed nothing).
 */
export function uiActive(now = Date.now()): boolean {
  try {
    return now - fs.statSync(path.join(fleetHome(), "ui-active")).mtimeMs < UI_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Approval in the dashboard: Claude Code asks for a permission. If a Fleet tab is in front, the hook waits
 * briefly for the answer there; otherwise (or without an answer, or once the user leaves Fleet) the request
 * appears in the app as always. Only then because while the hook waits, the app does not show its own request.
 */
export function onPermissionRequest(ev: HookEvent, now: number): { decision: Decision } | null {
  const sid = String(ev.session_id || "");
  const cwd = typeof ev.cwd === "string" ? ev.cwd.slice(0, 1000) : "";
  if (!ID_RE.test(sid) || !cwd) return null;
  const cfg = readConfig();
  if (!cfg.enabled || !cfg.approvals || !uiActive(now)) return null;
  const tool = String(ev.tool_name || "").slice(0, 80);
  // Questions and plan approvals are no permission: they are answered in the app.
  if (SKIP.test(tool)) return null;
  const inp = ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {};
  const what =
    typeof inp.command === "string"
      ? inp.command
      : typeof inp.file_path === "string"
        ? inp.file_path
        : typeof inp.url === "string"
          ? inp.url
          : JSON.stringify(inp);
  const suggestions = Array.isArray(ev.permission_suggestions) ? ev.permission_suggestions.slice(0, 10) : [];
  const options: Decision["options"] = [{ id: "allow", label: tr("Erlauben", "Allow") }];
  if (suggestions.length) {
    options.push({
      id: "allow-session",
      label: tr("Immer für diese Session", "Always for this session"),
      hint: tr("Gleiche Aufrufe fragen in dieser Session nicht mehr", "Same calls no longer ask in this session"),
    });
  }
  options.push({ id: "deny", label: tr("Ablehnen", "Deny") });
  const d = make(
    sid,
    cwd,
    now,
    cfg.approvalSeconds,
    "permission",
    `${tr("Freigabe", "Approval")}: ${tool}`,
    String(what).slice(0, 600),
    options,
    "allow",
  );
  d.suggestions = suggestions;
  try {
    writeAtomic(path.join(decisionDir(), `${d.id}.json`), d);
  } catch {
    return null;
  }
  return { decision: d };
}

/** Turns the answer into hook output and marks it as applied. */
export function apply(d: Decision, ev: HookEvent, now: number): string {
  d.status = "applied";
  d.appliedAt = now;
  try {
    save(d);
  } catch {
    // the answer still applies
  }
  const deny = (reason: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
  if (d.kind === "permission") {
    const decision =
      d.answer === "deny"
        ? {
            behavior: "deny",
            message: tr("Vom Nutzer in Claude Fleet abgelehnt.", "Denied by the user in Claude Fleet."),
          }
        : d.answer === "allow-session"
          ? {
              behavior: "allow",
              updatedPermissions: (d.suggestions || []).map((x) =>
                x && typeof x === "object" ? { ...x, destination: "session" } : x,
              ),
            }
          : d.answer === "allow"
            ? { behavior: "allow" }
            : null;
    return decision ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }) : "";
  }
  switch (d.answer) {
    case "stop":
      return JSON.stringify({
        continue: false,
        stopReason: tr(`Claude Fleet: angehalten – ${d.title}`, `Claude Fleet: stopped – ${d.title}`),
      });
    case "rethink":
      return deny(
        tr(
          `Claude Fleet hat angehalten (${d.title}), der Nutzer hat entschieden: innehalten und neu ansetzen. Führe diesen Aufruf nicht aus. Fasse in wenigen Sätzen zusammen, was du versucht hast, warum es nicht klappt und welche zwei, drei Wege du siehst. Frag dann den Nutzer, wie es weitergehen soll, und beende den Turn.`,
          `Claude Fleet paused (${d.title}) and the user decided: pause and rethink. Do not run this call. Sum up in a few sentences what you tried, why it does not work and which two or three ways you see. Then ask the user how to continue and end the turn.`,
        ),
      );
    case "escalate":
      return deny(
        tr(
          `Claude Fleet hat angehalten (${d.title}), der Nutzer hat entschieden: Ein stärkeres Modell übernimmt den festgefahrenen Schritt. Führe diesen Aufruf nicht selbst aus. Gib den Schritt mit dem Agent-Werkzeug (model: "opus") an einen Subagenten: Ziel, was schon versucht wurde, Fehlermeldungen, relevante Dateien. Arbeite danach mit seinem Ergebnis weiter.`,
          `Claude Fleet paused (${d.title}) and the user decided: a stronger model takes over the stuck step. Do not run this call yourself. Hand the step to a subagent with the Agent tool (model: "opus"): goal, what was tried, error messages, relevant files. Then continue with its result.`,
        ),
      );
    case "handoff":
      try {
        return deny(
          requestNow(
            { session_id: String(ev.session_id), cwd: String(ev.cwd), transcript_path: ev.transcript_path },
            tr(
              `Der Nutzer hat in Fleet entschieden: ${d.title}, jetzt übergeben`,
              `The user decided in Fleet: ${d.title}, hand over now`,
            ),
            now,
          ),
        );
      } catch {
        return deny(
          tr(
            "Claude Fleet: Der Nutzer möchte jetzt eine Übergabe. Schreib eine kurze HANDOFF.md im Projekt (Ziel, Erledigt, Offen, Nächste Schritte) und beende den Turn.",
            "Claude Fleet: the user wants a handoff now. Write a short HANDOFF.md in the project (goal, done, open, next steps) and end the turn.",
          ),
        );
      }
    default:
      return "";
  }
}

/**
 * Waits for the answer from Fleet (the server writes the file). Without an answer until `expiresAt`: let the
 * session continue and mark the decision as missed.
 */
export function waitFor(d: Decision, ev: HookEvent, done: (out: string) => void): void {
  let goneSince = 0;
  const tick = () => {
    const cur = read(d.id);
    const now = Date.now();
    if (cur && cur.status === "answered") return done(apply(cur, ev, now));
    // An approval waits only while the user looks at Fleet: once they leave, the app shows its own prompt.
    if (d.kind === "permission" && !uiActive(now)) goneSince ||= now;
    else goneSince = 0;
    const left = goneSince > 0 && now - goneSince >= LEFT_MS;
    // Unreadable for a moment (being written, locked on Windows) is no answer: keep waiting until the deadline.
    // Only a readable decision that is no longer open (dismissed, expired) ends the wait early.
    if ((cur && cur.status !== "open") || now >= d.expiresAt || left) {
      if (cur && cur.status === "open") {
        cur.status = "expired";
        try {
          save(cur);
        } catch {
          // nothing to do
        }
      }
      return done("");
    }
    setTimeout(tick, 300);
  };
  tick();
}
