import { GLYPH, inbox, type Place, places, type WaitKind } from "../../shared/inbox";
import { nowForStream } from "../../shared/stream";
import type { Decision, FleetEvent, Overview, Session } from "../../shared/types";
import type { Approval } from "./rows";

/** Small facts about a session the components share: status labels, what it is doing, commands to copy. */

type T = (de: string, en: string) => string;

export type Tone = "amber" | "red" | "blue" | "green" | "violet" | "hi" | "";

export function statusLabel(status: Session["status"], t: T): { label: string; tone: Tone } {
  switch (status) {
    case "needs_input":
      return { label: t("wartet auf dich", "waits for you"), tone: "amber" };
    case "error":
      return { label: t("Fehler", "error"), tone: "red" };
    case "working":
      return { label: t("arbeitet", "working"), tone: "blue" };
    case "stale":
      return { label: t("keine Rückmeldung", "no sign of life"), tone: "red" };
    case "waiting":
      return { label: t("fertig", "done"), tone: "green" };
    case "ended":
      return { label: t("beendet", "ended"), tone: "" };
    case "cloud":
      return { label: "Cloud", tone: "violet" };
    default:
      return { label: t("ruht", "resting"), tone: "" };
  }
}

/** The word for why a session waits (shared/inbox.ts `waitKind`): the alarm row's kind and the status everywhere. */
export function waitWord(kind: WaitKind, t: T): string {
  return kind === "approval"
    ? t("Freigabe", "Approval")
    : kind === "fleet"
      ? t("Fleet fragt", "Fleet asks")
      : t("Frage", "Question");
}

/**
 * The one status word of a session, from the place it stands on Now (`places(inbox)` in shared/inbox.ts): a
 * session Fleet holds a question for waits, wherever it is shown. Only the raw status' "no sign of life" stays as
 * the word for an error. Without a place (hidden) the raw status is all there is.
 */
export function placeLabel(
  place: Place | undefined,
  s: Pick<Session, "status">,
  t: T,
  kind?: WaitKind,
): { label: string; tone: Tone } {
  switch (place) {
    case "decision":
    case "needs":
      return {
        label: kind ? `${t("wartet", "waits")} · ${waitWord(kind, t)}` : t("wartet auf dich", "waits for you"),
        tone: "amber",
      };
    case "errors":
      return s.status === "stale"
        ? { label: t("keine Rückmeldung", "no sign of life"), tone: "red" }
        : { label: t("Fehler", "error"), tone: "red" };
    case "working":
      return { label: t("arbeitet", "working"), tone: "blue" };
    case "done":
      return { label: t("fertig", "done"), tone: "green" };
    case "replaced":
      return { label: t("abgelöst", "replaced"), tone: "" };
    case "archive":
      return { label: t("archiviert", "archived"), tone: "" };
    case "resting":
      return { label: t("ruht", "resting"), tone: "" };
    default:
      return statusLabel(s.status, t);
  }
}

/** How a group of sessions stands, from their places: "alle fertig", "1 arbeitet, 1 wartet". */
export function groupState(ids: string[], where: Map<string, Place>, t: T): string {
  const words: Record<string, [string, string, string, string]> = {
    waiting: ["wartet", "warten", "waiting", "waiting"],
    working: ["arbeitet", "arbeiten", "working", "working"],
    done: ["fertig", "fertig", "done", "done"],
    error: ["Fehler", "Fehler", "error", "error"],
    resting: ["ruht", "ruhen", "resting", "resting"],
  };
  const n = new Map<string, number>();
  for (const id of ids) {
    const place = where.get(id);
    const g = place ? GLYPH[place] : "resting";
    n.set(g, (n.get(g) || 0) + 1);
  }
  const order = ["waiting", "error", "working", "done", "resting"].filter((g) => n.has(g));
  if (order.length === 1) {
    const w = words[order[0] as string] as [string, string, string, string];
    return t(`alle ${w[1]}`, `all ${w[3]}`);
  }
  return order
    .map((g) => {
      const w = words[g] as [string, string, string, string];
      return t(`${n.get(g)} ${w[0]}`, `${n.get(g)} ${w[2]}`);
    })
    .join(", ");
}

export type ActivityKind = "edit" | "read" | "term" | "web" | "agent" | "plan" | "plug" | "think" | "ask";

/** Tool name -> what the session is doing, in words. */
export function activity(s: Session, t: T): [ActivityKind, string] {
  const tool = String(s.lastTool || "");
  if (s.status === "stale") return ["think", t("keine Rückmeldung", "no sign of life")];
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return ["edit", t("schreibt Code", "writing code")];
  if (/^(Read|Grep|Glob|LS)$/.test(tool)) return ["read", t("liest Code", "reading code")];
  if (/^(Bash|PowerShell|KillShell|BashOutput)$/.test(tool))
    return ["term", t("führt Befehle aus", "running commands")];
  if (/^(WebSearch|WebFetch)$/.test(tool)) return ["web", t("recherchiert im Web", "researching the web")];
  if (/^(Task|Agent)$/.test(tool)) return ["agent", t("Subagent arbeitet", "subagent working")];
  if (/^(TodoWrite|TaskCreate|TaskUpdate|EnterPlanMode|ExitPlanMode)$/.test(tool))
    return ["plan", t("plant die nächsten Schritte", "planning the next steps")];
  if (tool === "AskUserQuestion") return ["ask", t("fragt dich", "asking you")];
  if (/^mcp__/.test(tool)) {
    const srv = tool.split("__")[1] || "";
    const nice = /remote-devices/.test(srv)
      ? t("deinen Computer", "your computer")
      : /chrome/i.test(srv)
        ? t("den Browser", "the browser")
        : /atlassian|jira|confluence/i.test(srv)
          ? "Jira/Confluence"
          : srv.replace(/[_-]+/g, " ");
    return ["plug", `${t("nutzt", "using")} ${nice}`];
  }
  return ["think", tool || t("denkt nach", "thinking")];
}

export const looping = (s: Session) => !!(s.loop && (s.status === "working" || s.status === "stale"));
export const loopText = (s: Session, t: T) =>
  !s.loop
    ? ""
    : s.loop.kind === "repeat"
      ? t(`${s.loop.count}× derselbe ${s.loop.tool}-Aufruf`, `${s.loop.count}× the same ${s.loop.tool} call`)
      : t(`${s.loop.count} Fehler in Folge (${s.loop.tool})`, `${s.loop.count} errors in a row (${s.loop.tool})`);

export function conflictText(s: Session, t: T): string {
  const c = s.conflict;
  if (!c) return "";
  const names = c.with.map((w) => w.title).join(t("“, „", '", "'));
  return `${t(`Gleichzeitig mit „${names}“`, `At the same time as "${names}"`)}${c.sameBranch ? t(` auf demselben Branch${s.branch ? ` ${s.branch}` : ""}`, ` on the same branch${s.branch ? ` ${s.branch}` : ""}`) : ""}${c.files.length ? ` · ${t("gleiche Dateien", "same files")}: ${c.files.join(", ")}` : ""}`;
}

const idOk = (id: string) => /^[\w.-]+$/.test(id);
const shq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** A separate folder and branch for one of two sessions that collide. */
export function worktreeCmd(s: Session): string {
  const name = String(s.project || "repo").replace(/[^\w.-]/g, "-");
  const br = String(s.branch || "main").replace(/[^\w./-]/g, "-");
  return `cd ${shq(s.repoRoot || s.cwd || ".")} && git worktree add ${shq(`../${name}-parallel`)} -b ${shq(`${br}-parallel`)}`;
}

/** Resume command for the shell; the folder safely quoted. */
export function resumeCmds(
  s: Session,
  platform: string,
): { main?: string; mainLabel?: string; alt?: string | null; altLabel?: string } {
  if (!idOk(s.id)) return {};
  const r = `claude --resume ${s.id}`;
  if (!s.cwd) return { main: r };
  if (platform === "win32") {
    return {
      main: `Set-Location -LiteralPath '${s.cwd.replace(/'/g, "''")}'; ${r}`,
      mainLabel: "PowerShell",
      alt: /["%^&|<>]/.test(s.cwd) ? null : `cd /d "${s.cwd}" && ${r}`,
      altLabel: "cmd",
    };
  }
  return { main: `cd ${shq(s.cwd)} && ${r}` };
}

export const continueCmd = (root: string, platform: string, prompt: string) =>
  platform === "win32"
    ? `Set-Location -LiteralPath '${root.replace(/'/g, "''")}'; claude "${prompt}"`
    : `cd ${shq(root)} && claude ${shq(prompt)}`;

export const openable = (s: Session, demo: boolean) =>
  idOk(s.id) && (s.source === "local" || (demo && s.source === "demo") || (demo && s.id.startsWith("demo-")));

export function matches(s: Session, q: string): boolean {
  if (!q) return true;
  const hay = [
    s.project,
    s.group?.name,
    s.title,
    s.branch,
    s.cwd,
    s.lastAssistant,
    s.lastPrompt,
    s.meta?.note,
    s.ci?.pr?.title,
  ]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

/**
 * The history's lines that name a session's current state (rounds 3 and 4): the newest event of a session that waits
 * for you or failed now, unless that event already says so. Its line reads like Now ("waits for you", "error"), as
 * the stream ends with the current status; older lines keep what happened then.
 */
export function nowLines(events: FleetEvent[], place: (id: string) => Place | undefined): Map<FleetEvent, Place> {
  const newest = new Map<string, FleetEvent>();
  for (const e of events) {
    const n = newest.get(e.sessionId);
    if (!n || e.at > n.at) newest.set(e.sessionId, e);
  }
  const out = new Map<FleetEvent, Place>();
  for (const [id, e] of newest) {
    const p = place(id);
    const waits = p === "needs" || p === "decision";
    if (waits && e.event !== "Notification" && e.event !== "PermissionRequest") out.set(e, p);
    if (p === "errors" && e.status !== "error" && e.status !== "stale") out.set(e, p);
  }
  return out;
}

/**
 * When a session was last active, one answer for every view (round 8: the session drawer said "2 h" for a wait of
 * 2 h 55 min, the repo drawer "just now"). A session that waits for you, for one of Fleet's questions or for your
 * next prompt did nothing since the wait began, whatever the transcript's file time says: bookkeeping lines and
 * Fleet's own question make the file newer without any progress. So its last sign of life is the wait's start,
 * the same moment the stream and the alarm rows use (`nowForStream`).
 */
export function lastActiveOf(data: Pick<Overview, "sessions" | "repos"> & { decisions?: Overview["decisions"] }) {
  const where = places(inbox(data as Overview));
  const since = new Map(nowForStream(data).map((n) => [n.id, Number(n.statusSince) || 0]));
  return (s: Pick<Session, "id" | "lastActivity">): number => {
    const p = where.get(s.id);
    const waits = since.get(s.id) || 0;
    return (p === "needs" || p === "decision" || p === "done") && waits > 0 ? waits : s.lastActivity || 0;
  };
}

/**
 * Who holds a session's open approval (live 16.10.2026: Enter forked the session, the fork showed the call as
 * "Interrupted"). Fleet's own terminal shows the prompt itself; otherwise the app or terminal the session runs in
 * holds it, and Fleet cannot answer it there. While Fleet's hook holds it ("fleet"), its countdown row answers it.
 */
export function approvalHolder(
  s: Session,
  decisions?: Pick<Decision, "sessionId" | "kind" | "status">[] | null,
): Approval | null {
  if (decisions?.some((d) => d.sessionId === s.id && d.kind === "permission" && d.status === "open")) return "fleet";
  // A question or a plan the app holds (AskUserQuestion, ExitPlanMode) is no approval, but a branch cannot answer it
  // either (live 16.10.2026): every prompt the hook saw open counts.
  const prompt = s.status === "needs_input" && s.hook?.status === "needs_input" && !!s.hook.waitFor?.length;
  if (s.waits !== "approval" && !prompt) return null;
  if (s.proc?.mode === "pty" && (s.proc.status === "running" || s.proc.status === "starting")) return "terminal";
  return s.desktop ? "app" : "elsewhere";
}

/**
 * Where an approval waits that Fleet's terminal must not touch, in one sentence for the row's title and the status
 * line; `opens` adds that Enter opens it there (only the desktop app can be opened, review 16.10.2026).
 */
export function approvalWhere(
  holder: "app" | "elsewhere" | "fleet",
  t: (de: string, en: string) => string,
  opens = false,
  question = false,
): string {
  if (holder === "fleet")
    return t(
      "Die Freigabe wartet in Fleet – y, a oder n auf ihrer Zeile mit Countdown",
      "The approval waits in Fleet: y, a or n on its row with the countdown",
    );
  const what = question ? t("Die Frage", "The question") : t("Die Freigabe", "The approval");
  const where =
    holder === "app"
      ? `${what} ${t("wartet in der Claude-App", "waits in the Claude app")}`
      : `${what} ${t("wartet im Fenster, in dem die Session läuft", "waits in the window the session runs in")}`;
  return opens
    ? `${where} – ${t("Fleet kann sie dort nicht beantworten; Enter öffnet sie dort", "Fleet cannot answer it there; Enter opens it there")}`
    : `${where} – ${t("Fleet kann sie dort nicht beantworten", "Fleet cannot answer it there")}`;
}

/** Can Fleet open this session in the desktop app (its approval waits there)? */
export const appOpens = (s: Session, data: Pick<Overview, "openTargets"> | null | undefined) =>
  !!s.desktop && !!data?.openTargets?.some((x) => x.id === "desktop" && x.ok);
