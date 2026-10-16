import fs from "node:fs";
import path from "node:path";
import { tr } from "../core/lang";
import { excludeFromGit, FILE, readRegistry, rootOf, sha, writeRegistry } from "./registry";
import { readConfig } from "./settings";
import { facts, H, stamp } from "./text";
import { oneLine, progressSince } from "./transcript";

/**
 * Emergency handoff: when a turn breaks off (limit reached, API error), Claude can no longer write a handoff.
 * Then Fleet builds one from the transcript itself, without asking a model: prompts, todo list, last answer,
 * changed files, last commands.
 *
 * An existing handoff (under 24 h) is extended, never replaced: the summary Claude wrote is worth more than
 * anything that can be pulled from the transcript. A foreign file stays untouched, otherwise its content would
 * become trusted through Fleet's fingerprint.
 */
export function onStopFailure(
  ev: { session_id: string; cwd?: unknown; transcript_path?: unknown; error?: unknown; message?: unknown },
  now: number,
): string | null {
  if (typeof ev.cwd !== "string" || !ev.cwd || typeof ev.transcript_path !== "string" || !readConfig().enabled)
    return null;
  const root = rootOf(ev.cwd);
  const file = path.join(root, FILE);
  let since = 0;
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs < 24 * 3600e3) {
      const e = readRegistry().byDir[root];
      if (!e?.sha || e.sha !== sha(fs.readFileSync(file))) return null;
      if (e.key.startsWith("failure:") && now - e.requestedAt < 30 * 60e3) return null; // extended just now
      // Reported: the addendum hung on the handoff of another, older session. A foreign handoff is replaced by
      // our own emergency handoff after two hours, not touched before that.
      if (e.sessionId !== ev.session_id) {
        if (now - st.mtimeMs < 2 * 3600e3) return null;
      } else since = st.mtimeMs;
    }
  } catch {
    // no handoff yet
  }
  const p = progressSince(ev.transcript_path, root, since);
  if (!p.prompts.length && !p.files.length && !p.answer && !since) return null;
  const h = H();
  const error = oneLine(String(ev.error || ev.message || tr("unbekannt", "unknown")), 200);
  const doing = p.open;
  const md = since
    ? [
        fs.readFileSync(file, "utf8").trimEnd(),
        "",
        `## ${tr("Nachtrag (Notfall)", "Addendum (emergency)")} – ${stamp(now)}`,
        "",
        tr(
          `Von Claude Fleet automatisch ergänzt: Danach lief die Session weiter, dann brach der Turn ab (${error}).`,
          `Added automatically by Claude Fleet: the session continued, then the turn broke off (${error}).`,
        ),
        ...(p.prompts.length
          ? ["", `- ${tr("Aufträge danach", "Prompts afterwards")}:`, ...p.prompts.slice(-3).map((x) => `  - ${x}`)]
          : []),
        ...(doing.length
          ? [`- ${tr("Offen laut Todo-Liste", "Open per todo list")}: ${doing.slice(0, 5).join("; ")}`]
          : []),
        ...facts(p),
        "",
      ].join("\n")
    : [
        `# ${h.title} (${tr("Notfall", "emergency")}) – ${stamp(now)}`,
        "",
        tr(
          `Von Claude Fleet automatisch erstellt: Der Turn brach ab (${error}), Claude konnte keine Übergabe mehr schreiben. Inhalt aus dem Transcript, nicht zusammengefasst.`,
          `Created automatically by Claude Fleet: the turn broke off (${error}) and Claude could not write a handoff anymore. Content from the transcript, not summarised.`,
        ),
        "",
        `## ${h.goal}`,
        ...(p.prompts.length
          ? p.prompts.slice(-3).map((x) => `- ${x}`)
          : [`- ${tr("(kein Auftrag im gelesenen Teil)", "(no prompt in the part read)")}`]),
        "",
        `## ${h.done}`,
        ...(p.done.length ? p.done.map((t) => `- ${t}`) : [`- ${tr("(keine Todo-Liste)", "(no todo list)")}`]),
        "",
        `## ${h.open}`,
        ...doing.map((t) => `- ${t}`),
        "",
        // Only real steps (from the todo list); a placeholder would look like a plan nobody made. The heading stays
        // so the sections keep their order for readHandoff.
        `## ${h.next}`,
        ...doing.slice(0, 5).map((t, i) => `${i + 1}. ${t}`),
        "",
        `## ${h.notes}`,
        ...facts(p),
        "",
      ].join("\n");
  try {
    fs.writeFileSync(file, md);
    const reg = readRegistry();
    const st = fs.statSync(file);
    reg.byDir[root] = {
      sessionId: ev.session_id,
      requestedAt: now,
      reason: tr(`Turn abgebrochen (${error})`, `Turn broke off (${error})`),
      key: `failure:${now}`,
      file,
      sha: sha(fs.readFileSync(file)),
      writtenAt: st.mtimeMs,
    };
    writeRegistry(reg);
    excludeFromGit(root);
    return file;
  } catch {
    return null;
  }
}
