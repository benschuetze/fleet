import { dateTimeFull } from "../../shared/dates";
import { locale, tr } from "../core/lang";
import { oneLine, type Progress } from "./transcript";

/** Texts of the handoff: the instruction for Claude, prompts for new sessions, the Markdown Fleet writes itself. */

const toks = (v: number) =>
  v >= 1e6
    ? `${(v / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 })} ${tr("Mio.", "M")}`
    : `${Math.round(v / 1e3).toLocaleString(locale())} ${tr("Tsd.", "k")}`;
const usd = (v: number) => `${v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
export const stamp = (now: number) => dateTimeFull(now, locale());
export const tokensText = toks;

/** Headings of the handoff, in the session's language. Parsing accepts both languages. */
export const H = () => ({
  title: tr("Übergabe", "Handoff"),
  goal: tr("Ziel", "Goal"),
  done: tr("Erledigt", "Done"),
  open: tr("Offen", "Open"),
  next: tr("Nächste Schritte", "Next steps"),
  notes: tr("Wichtig zu wissen", "Good to know"),
});

/**
 * The text with which Claude writes the handoff.
 * fresh: continue fresh afterwards (worth it); opens: Fleet opens the new session itself (otherwise it
 * recommends one); goOn: tight limit, the handoff is a safety copy and work continues.
 */
export function instruction(
  reason: string,
  file: string,
  fresh: { tokens: number; perCall: number } | null = null,
  opens = false,
  goOn = false,
): string {
  const h = H();
  const cost = fresh
    ? tr(
        `Der Kontext umfasst ${toks(fresh.tokens)} Tokens, jeder weitere Aufruf liest ihn erneut (≈ ${usd(fresh.perCall)} pro Aufruf).`,
        `The context holds ${toks(fresh.tokens)} tokens and every further call reads it again (≈ ${usd(fresh.perCall)} per call).`,
      )
    : "";
  // A new session instead of clear_session: a cleared chat stands there without any visible history and the
  // user cannot see where work continues. The new session shows its prompt, the old one stays readable.
  const then = !fresh
    ? ""
    : opens
      ? tr(
          `\n\nDanach frisch weitermachen: ${cost} Sobald du den Turn beendest, öffnet Fleet eine neue Session in diesem Ordner mit dem Auftrag, an der Übergabe weiterzumachen; dieser Chat bleibt erhalten. Sag dem Nutzer in einem Satz, warum (${reason}) und dass es in der neuen Session weitergeht; erscheint keine, startet er sie in Fleet bei der Übergabe mit „Nochmal öffnen“. Rufe clear_session nicht auf.`,
          `\n\nThen continue fresh: ${cost} As soon as you end the turn, Fleet opens a new session in this folder with the task to continue from the handoff; this chat stays. Tell the user in one sentence why (${reason}) and that work continues in the new session; if none appears, they start it in Fleet with "Open again" at the handoff. Do not call clear_session.`,
        )
      : tr(
          `\n\nDanach frisch weitermachen: ${cost} Empfiehl dem Nutzer in einem Satz, eine neue Session in diesem Ordner zu starten; sie bekommt die Übergabe automatisch.`,
          `\n\nThen continue fresh: ${cost} Recommend in one sentence that the user starts a new session in this folder; it receives the handoff automatically.`,
        );
  const end = goOn
    ? tr(
        "Danach arbeite normal weiter. Schreib die Datei nicht bei jedem Schritt neu: Fleet hängt nach jedem Turn selbst den aktuellen Stand an (ohne Tokens), damit bei einem Abbruch der genaue Punkt dokumentiert ist.",
        "Then carry on working. Do not rewrite the file at every step: after each turn Fleet appends the current state itself (no tokens), so the exact point is documented if the session breaks off.",
      )
    : tr("Danach nichts weiter tun und den Turn beenden.", "Then do nothing else and end the turn.");
  return `Claude Fleet: ${reason}. ${tr(
    `Bevor du aufhörst, schreib bitte jetzt eine Übergabe nach ${file}, damit eine neue Session ohne dieses Gespräch weitermachen kann. Überschreibe eine vorhandene Datei. Aufbau:`,
    `Before you stop, please write a handoff to ${file} now, so a new session can continue without this conversation. Overwrite an existing file. Structure:`,
  )}

# ${h.title} – <${tr("Datum, Uhrzeit", "date, time")}>
## ${h.goal}
<${tr("Auftrag in zwei Sätzen", "task in two sentences")}>
## ${h.done}
- <${tr("mit Dateien, Commits, PRs", "with files, commits, PRs")}>
## ${h.open}
- <${tr("was noch nicht fertig ist", "what is not finished yet")}>
## ${h.next}
1. <${tr("in Reihenfolge, konkret", "in order, concrete")}>
## ${h.notes}
- <${tr("Entscheidungen, Stolperfallen, Befehle zum Prüfen", "decisions, pitfalls, commands to check")}>

${tr("Nur was eine neue Session braucht, höchstens etwa 60 Zeilen.", "Only what a new session needs, at most about 60 lines.")}${then}
${end}`;
}

/** First line under "## Ziel" / "## Goal", shortened. */
export function goalOf(md: string): string {
  const m = /^##\s*(?:Ziel|Goal)\s*\r?\n+([^\n#][^\n]*)/m.exec(md);
  return m?.[1]
    ? m[1]
        .replace(/^[-*]\s+/, "")
        .trim()
        .slice(0, 200)
    : "";
}

/**
 * Name without additions: "Claude Fleet · abgelöst 13.10." → "Claude Fleet"; generic task titles
 * ("… Übergabe fortsetzen", "Fortsetzung in …") are replaced by the folder name.
 */
export function baseTitle(title: string, repo: string): string {
  const t = String(title || "")
    .replace(/\s*·\s*(abgelöst|replaced|zusammengefasst|merged).*$/i, "")
    .trim();
  if (!t || /^(Fortsetzung|Continuing)\b/i.test(t)) return repo;
  return t.replace(/\s+(Übergabe fortsetzen|continue handoff)$/i, "").trim() || repo;
}

/** The prompt shown in a new session that continues from a handoff. */
export function continuePrompt(name: string, why: string, goal: string): string {
  const g = goal ? goal.replace(/[.\s]+$/, "").slice(0, 160) : "";
  return tr(
    `Fortsetzung in ${name}${why ? `, frisch gestartet, weil ${why}` : ""}. Mach mit der Übergabe weiter${g ? ` (Ziel: ${g})` : ""}. Fass mir zuerst kurz den letzten Stand zusammen.`,
    `Continuing in ${name}${why ? `, started fresh because ${why}` : ""}. Continue from the handoff${g ? ` (goal: ${g})` : ""}. First give me a short summary of where things stand.`,
  );
}

/** Facts gathered from the transcript: changed files, last commands, Claude's last answer. */
export function facts(p: Progress): string[] {
  return [
    ...(p.files.length
      ? [`- ${tr("Zuletzt geänderte Dateien", "Recently changed files")}: ${p.files.slice(-15).join(", ")}`]
      : []),
    ...(p.cmds.length
      ? [
          `- ${tr("Letzte Befehle", "Last commands")}: ${p.cmds
            .slice(-5)
            .map((c) => `\`${c.replace(/`/g, "'")}\``)
            .join(", ")}`,
        ]
      : []),
    ...(p.answer
      ? [
          `- ${tr("Letzte Antwort von Claude", "Claude's last answer")}:`,
          "",
          ...oneLine(p.answer, 1200)
            .split(/(?<=[.!?]) /)
            .map((x) => `  > ${x}`),
        ]
      : []),
  ];
}
