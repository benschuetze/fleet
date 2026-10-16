import { inbox } from "../../shared/inbox";
import { repoKey, repoName } from "../../shared/repo";
import type { FleetEvent, Overview, Session, WeekReport } from "../../shared/types";
import { lang, tr } from "./lang";

/**
 * The week report (spec: "Analyse-Export"): what happened in the last seven days, as JSON with a schema version
 * and as Markdown, each small enough to drop into a Claude session. The size limit is the point: a report that
 * eats what it should save is worthless. Only names, never paths; numbers only where Fleet measured them.
 */

export const MAX_TOKENS = 5000;
/** Conservative on purpose: German text, names and numbers take more tokens per character than English prose. */
const CHARS_PER_TOKEN = 3;
export const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

const DAY = 24 * 3600e3;
const WEEK = 7 * DAY;
/** An open PR nobody worked on for this long is stale. */
const STALE_MS = 3 * DAY;
const TOP = 5;

/** One line, short: titles come from prompts and may hold newlines, Markdown or whole pasted texts. */
const clip = (v: unknown, n = 80) => {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const titleOf = (s: Session) => clip(s.title || s.id.slice(0, 8));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const usd = (v: number) => Math.round(v * 100) / 100;

export function weekReport(data: Overview, events: FleetEvent[], now = Date.now()): WeekReport {
  const from = now - WEEK;
  const active = data.sessions.filter((s) => !s.meta?.hidden && (s.lastActivity || 0) >= from);
  const byId = new Map(data.sessions.map((s) => [s.id, s]));

  // Sessions per repo in the groups of "Now".
  const box = inbox({ ...data, sessions: active }, now);
  const groups = { needs: box.needs, errors: box.errors, working: box.working, done: box.done } as const;
  const repos = new Map<string, WeekReport["repos"][number]>();
  const row = (s: Session) => {
    const k = repoKey(s);
    const r = repos.get(k) || {
      repo: clip(repoName(s), 60),
      sessions: 0,
      needs: 0,
      errors: 0,
      working: 0,
      done: 0,
      resting: 0,
      archive: 0,
    };
    repos.set(k, r);
    return r;
  };
  for (const s of active) row(s).sessions++;
  for (const [g, list] of Object.entries(groups)) for (const s of list) row(s)[g as keyof typeof groups]++;
  for (const s of box.resting) row(s).resting++;
  for (const s of [...box.archive, ...box.replaced]) row(s).archive++;

  // Bad actors: who raised the most alarms. Events of unknown sessions name nobody and are left out.
  const alarmCount = new Map<string, { waiting: number; errors: number }>();
  let oldest: number | null = null;
  for (const e of events) {
    if (!e || !Number.isFinite(e.at) || e.at < from || e.at > now) continue;
    oldest = Math.min(oldest ?? e.at, e.at);
    if (e.status !== "needs_input" && e.status !== "error") continue;
    if (!byId.has(e.sessionId)) continue;
    const c = alarmCount.get(e.sessionId) || { waiting: 0, errors: 0 };
    if (e.status === "error") c.errors++;
    else c.waiting++;
    alarmCount.set(e.sessionId, c);
  }
  const alarms = [...alarmCount]
    .sort(([, a], [, b]) => b.waiting + b.errors - (a.waiting + a.errors))
    .slice(0, TOP)
    .map(([id, c]) => {
      const s = byId.get(id) as Session;
      return { repo: clip(repoName(s), 60), session: titleOf(s), ...c };
    });

  // Stale PRs: open, and no session touched them for three days. One PR once, however many worktrees know it.
  const stalePrs: WeekReport["stalePrs"] = [];
  const seen = new Set<string>();
  for (const r of data.repos) {
    const k = repoKey({ remote: r.remote, repoRoot: r.root, project: r.name });
    for (const pr of r.prs?.prs || []) {
      if (seen.has(`${k}#${pr.number}`)) continue;
      seen.add(`${k}#${pr.number}`);
      const last = Math.max(
        0,
        ...data.sessions
          .filter(
            (s) => repoKey(s) === k && (String(s.ci?.pr?.number ?? "") === String(pr.number) || s.branch === pr.head),
          )
          .map((s) => s.lastActivity || 0),
      );
      if (last && now - last < STALE_MS) continue;
      stalePrs.push({
        repo: clip(r.remote?.repo || r.name, 60),
        number: pr.number,
        title: clip(pr.title),
        draft: pr.draft,
        ci: pr.ci,
        lastSession: last ? day(last) : null,
      });
    }
  }
  stalePrs.sort((a, b) => (a.lastSession || "").localeCompare(b.lastSession || "") || a.number - b.number);

  const cacheRebuilds = active
    .filter((s) => (s.usage?.rebuilds || 0) > 0)
    .sort((a, b) => (b.usage?.rebuilds || 0) - (a.usage?.rebuilds || 0))
    .slice(0, TOP)
    .map((s) => ({
      repo: clip(repoName(s), 60),
      session: titleOf(s),
      rebuilds: s.usage?.rebuilds || 0,
      apiValueUsd: typeof s.usage?.rebuildCost === "number" ? usd(s.usage.rebuildCost) : null,
    }));

  const light = active.filter((s) => (s.advice || []).some((a) => a.kind === "model" && /haiku/i.test(a.model || "")));
  const saving = light.reduce(
    (sum, s) =>
      sum +
      (s.advice || [])
        .filter((a) => a.kind === "model" && /haiku/i.test(a.model || ""))
        .reduce((x, a) => x + Math.max(0, a.saving || 0), 0),
    0,
  );

  const u = data.usage;
  const report: WeekReport = {
    schema: "claude-fleet/week-report",
    version: 1,
    generatedAt: new Date(now).toISOString(),
    language: lang(),
    period: { from: day(from), to: day(now), eventsFrom: oldest === null ? null : day(oldest) },
    repos: [...repos.values()].sort((a, b) => b.sessions - a.sessions || a.repo.localeCompare(b.repo)),
    usage: {
      tokens7d: u?.hasData ? u.totals.d7.tok : null,
      apiValueUsd7d: u?.hasData ? usd(u.totals.d7.cost) : null,
      weekLimitPct: u?.limits?.seven_day ? Math.round(u.limits.seven_day.used_percentage) : null,
    },
    fleetBalance: null,
    alarms,
    stalePrs,
    cacheRebuilds,
    haiku: {
      sessions: light.length,
      estimatedSavingUsd: usd(saving),
      examples: light.slice(0, 3).map((s) => ({ repo: clip(repoName(s), 60), session: titleOf(s) })),
    },
    // Only real duplicates (shared files); parallel sessions without overlap are no finding.
    duplicates: data.duplicates
      .filter((d) => d.overlap)
      .map((d) => ({
        repo: clip(d.repo, 60),
        reason: d.reason,
        sessions: d.sessions.slice(0, 4).map((s) => clip(s.title, 60)),
        files: d.files.slice(0, 5).map((f) => clip(f, 100)),
      })),
    truncated: false,
  };
  return shrink(report);
}

/** Cuts the longest list until both forms fit; says so in the report. */
export function shrink(r: WeekReport): WeekReport {
  const lists = (): unknown[][] => [
    r.repos,
    r.alarms,
    r.stalePrs,
    r.cacheRebuilds,
    r.duplicates,
    r.haiku.examples,
    ...r.duplicates.map((d) => d.files),
  ];
  while (JSON.stringify(r).length > MAX_CHARS || reportMarkdown(r).length > MAX_CHARS) {
    const longest = lists().sort((a, b) => b.length - a.length)[0];
    if (!longest?.length) break;
    longest.pop();
    r.truncated = true;
  }
  return r;
}

export function reportMarkdown(r: WeekReport): string {
  const L: string[] = [];
  const n = (v: number) => v.toLocaleString(r.language === "de" ? "de-DE" : "en-US");
  const money = (v: number) =>
    `${v.toLocaleString(r.language === "de" ? "de-DE" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  L.push(`# ${tr("Claude Fleet – Wochenbericht", "Claude Fleet – week report")} ${r.period.from} – ${r.period.to}`);
  L.push("");
  L.push(
    tr(
      `Schema ${r.schema} v${r.version}. Erstellt ${r.generatedAt}.${r.period.eventsFrom ? ` Ereignisse ab ${r.period.eventsFrom}.` : " Keine Ereignisse im Zeitraum."}`,
      `Schema ${r.schema} v${r.version}. Generated ${r.generatedAt}.${r.period.eventsFrom ? ` Events from ${r.period.eventsFrom}.` : " No events in the period."}`,
    ),
  );
  if (r.truncated)
    L.push(tr("Listen gekürzt, damit der Bericht klein bleibt.", "Lists were cut to keep the report small."));
  L.push("");
  L.push(`## ${tr("Sessions nach Repo und Status", "Sessions by repo and status")}`);
  if (!r.repos.length) L.push(tr("- keine aktiven Sessions", "- no active sessions"));
  for (const x of r.repos) {
    const parts = [
      [x.needs, tr("wartet", "waiting")],
      [x.errors, tr("Fehler", "error")],
      [x.working, tr("arbeitet", "working")],
      [x.done, tr("fertig", "done")],
      [x.resting, tr("ruht", "resting")],
      [x.archive, tr("Archiv", "archive")],
    ]
      .filter(([c]) => c)
      .map(([c, l]) => `${c} ${l}`);
    L.push(`- ${x.repo}: ${x.sessions} (${parts.join(", ")})`);
  }
  L.push("");
  L.push(`## ${tr("Verbrauch", "Usage")}`);
  L.push(
    `- ${tr("Tokens 7 Tage", "Tokens 7 days")}: ${r.usage.tokens7d === null ? tr("unbekannt", "unknown") : n(r.usage.tokens7d)}`,
  );
  if (r.usage.apiValueUsd7d !== null)
    L.push(`- ${tr("API-Gegenwert 7 Tage", "API value 7 days")}: ${money(r.usage.apiValueUsd7d)}`);
  L.push(
    `- ${tr("Wochenlimit", "Weekly limit")}: ${r.usage.weekLimitPct === null ? tr("unbekannt (keine Statuszeile)", "unknown (no status line)") : `${r.usage.weekLimitPct} %`}`,
  );
  L.push(`- ${tr("Fleet-Bilanz", "Fleet balance")}: ${tr("noch nicht gemessen", "not measured yet")}`);
  L.push("");
  L.push(`## ${tr("Häufigste Alarme", "Most frequent alarms")}`);
  if (!r.alarms.length) L.push(tr("- keine", "- none"));
  for (const a of r.alarms)
    L.push(
      `- ${a.repo} · ${a.session}: ${a.waiting}× ${tr("wartet auf dich", "waiting for you")}, ${a.errors}× ${tr("Fehler", "error")}`,
    );
  L.push("");
  L.push(`## ${tr("Liegengebliebene PRs (3+ Tage ohne Session)", "Stale PRs (3+ days without a session)")}`);
  if (!r.stalePrs.length) L.push(tr("- keine", "- none"));
  for (const p of r.stalePrs)
    L.push(
      `- ${p.repo} #${p.number} ${p.title}${p.draft ? tr(" (Entwurf)", " (draft)") : ""} · CI ${p.ci} · ${
        p.lastSession
          ? tr(`letzte Session ${p.lastSession}`, `last session ${p.lastSession}`)
          : tr("nie eine Session", "never a session")
      }`,
    );
  L.push("");
  L.push(`## ${tr("Cache-Neuschreibungen", "Cache rebuilds")}`);
  if (!r.cacheRebuilds.length) L.push(tr("- keine", "- none"));
  for (const c of r.cacheRebuilds)
    L.push(
      `- ${c.repo} · ${c.session}: ${c.rebuilds}×${c.apiValueUsd !== null ? ` (${tr("API-Gegenwert", "API value")} ${money(c.apiValueUsd)})` : ""}`,
    );
  L.push("");
  L.push(`## ${tr("Haiku-Kandidaten", "Haiku candidates")}`);
  L.push(
    tr(
      `- ${r.haiku.sessions} Sessions, geschätzt ${money(r.haiku.estimatedSavingUsd)} weniger zu API-Preisen (Schätzung des Beraters)`,
      `- ${r.haiku.sessions} sessions, estimated ${money(r.haiku.estimatedSavingUsd)} less at API prices (the advisor's estimate)`,
    ),
  );
  for (const h of r.haiku.examples) L.push(`  - ${h.repo} · ${h.session}`);
  L.push("");
  L.push(`## ${tr("Doppelt", "Duplicates")}`);
  if (!r.duplicates.length) L.push(tr("- keine", "- none"));
  const why = {
    files: tr("dieselben Dateien", "same files"),
    branch: tr("derselbe Branch", "same branch"),
    title: tr("derselbe Auftrag", "same task"),
  };
  for (const d of r.duplicates)
    L.push(
      `- ${d.repo} (${why[d.reason]}): ${d.sessions.join(" / ")}${d.files.length ? ` · ${d.files.join(", ")}` : ""}`,
    );
  L.push("");
  L.push(
    tr(
      "Frage an Claude: Was soll ich diese Woche an meinem Arbeitsfluss ändern?",
      "Question for Claude: what should I change in my workflow this week?",
    ),
  );
  return `${L.join("\n")}\n`;
}
