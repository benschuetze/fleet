import fs from "node:fs";
import path from "node:path";
import { tr } from "../core/lang";
import { groupOf, prevOf } from "./desktop";
import { excludeFromGit, FILE, readRegistry, SID, sha, writeRegistry } from "./registry";
import { facts, H, stamp } from "./text";
import { progressSince } from "./transcript";

/**
 * Merging several sessions of one repo into one: a joint handoff from all histories (without a model; a fresh
 * handoff one of them wrote itself is included word for word), registered for the new session. The old
 * sessions point to the new one afterwards.
 */
export function mergeNow({
  root,
  sessions,
  now,
}: {
  root: string;
  sessions: { sid: string; title: string; transcript: string | null }[];
  now: number;
}): { root: string; prompt: string } | { error: string } {
  const first = sessions[0];
  if (!first || sessions.length < 2 || !path.isAbsolute(root) || sessions.some((x) => !SID.test(x.sid))) {
    return {
      error: tr("Zum Zusammenfassen braucht es mindestens zwei Sessions", "Merging needs at least two sessions"),
    };
  }
  const h = H();
  const file = path.join(root, FILE);
  const reg = readRegistry();
  const e = reg.byDir[root];
  let existing = "";
  try {
    const buf = fs.readFileSync(file);
    if (e?.sha === sha(buf) && sessions.some((x) => x.sid === e.sessionId) && now - (e.writtenAt || 0) < 6 * 3600e3) {
      existing = buf.toString("utf8").replace(/^# .*\n/, "");
    }
  } catch {
    // no handoff yet
  }
  const next: string[] = [];
  const blocks = sessions.map((x) => {
    const p = x.transcript
      ? progressSince(x.transcript, root, 0)
      : { prompts: [], done: [], open: [], files: [], cmds: [], answer: "" };
    for (const o of p.open) if (!next.includes(o)) next.push(o);
    return [
      `### ${x.title.replace(/\n/g, " ").slice(0, 120) || x.sid.slice(0, 8)}`,
      ...(p.prompts.length ? [`- ${tr("Aufträge", "Prompts")}:`, ...p.prompts.slice(-3).map((q) => `  - ${q}`)] : []),
      ...(p.done.length ? [`- ${h.done}: ${p.done.slice(-6).join("; ")}`] : []),
      ...(p.open.length ? [`- ${h.open}: ${p.open.slice(0, 6).join("; ")}`] : []),
      ...facts(p),
      "",
    ].join("\n");
  });
  const md = [
    `# ${h.title} – ${stamp(now)} (${tr(`zusammengefasst aus ${sessions.length} Sessions`, `merged from ${sessions.length} sessions`)})`,
    "",
    tr(
      `Von Claude Fleet zusammengestellt: ${sessions.length} Sessions arbeiteten im selben Repo und gehen hier in einer auf. Ohne Modell, aus den Verläufen.`,
      `Put together by Claude Fleet: ${sessions.length} sessions worked in the same repo and continue here as one. Without a model, from their histories.`,
    ),
    "",
    `## ${h.goal}`,
    `${tr("Beide Stränge in einer Session weiterführen", "Continue both strands in one session")}: ${sessions
      .map((x) => x.title)
      .join(" + ")
      .slice(0, 300)}`,
    "",
    `## ${h.next}`,
    ...(next.length
      ? next.slice(0, 8).map((t, i) => `${i + 1}. ${t}`)
      : [
          `1. ${tr("Stand beider Stränge prüfen (git status, Tests), dann mit dem jüngsten Auftrag weitermachen", "Check both strands (git status, tests), then continue with the newest task")}`,
        ]),
    "",
    ...(existing
      ? [
          `## ${tr("Übergabe, die eine der Sessions geschrieben hat", "Handoff one of the sessions wrote")}`,
          existing.trim(),
          "",
        ]
      : []),
    `## ${tr("Je Session", "Per session")}`,
    ...blocks,
  ].join("\n");
  try {
    fs.writeFileSync(file, md);
  } catch {
    return { error: tr("Übergabe ließ sich nicht schreiben", "Could not write the handoff") };
  }
  let writtenAt = now;
  try {
    writtenAt = fs.statSync(file).mtimeMs;
  } catch {
    // keep now
  }
  const prevs = sessions.map((x) => prevOf(x.sid)).filter((p): p is { id: string; title: string } => !!p);
  const g = groupOf(first.sid);
  reg.byDir[root] = {
    sessionId: first.sid,
    merged: sessions.map((x) => x.sid),
    requestedAt: now,
    reason: tr(`${sessions.length} Sessions zusammengefasst`, `${sessions.length} sessions merged`),
    key: `merge:${now}`,
    file,
    sha: sha(md),
    writtenAt,
    openedAt: now,
    ...(g ? { group: g } : {}),
    ...(prevs.length ? { prevs } : {}),
  };
  writeRegistry(reg);
  excludeFromGit(root);
  return {
    root,
    prompt: tr(
      `Zusammenfassung in ${path.basename(root)}: ${sessions.length} Sessions arbeiteten hier parallel, ich habe sie in Fleet zu einer zusammengefasst. Mach mit der Übergabe weiter und fass mir zuerst kurz den Stand beider Stränge zusammen.`,
      `Merged in ${path.basename(root)}: ${sessions.length} sessions worked here in parallel and I merged them into one in Fleet. Continue from the handoff and first give me a short summary of both strands.`,
    ),
  };
}
