/**
 * Fleet's scope after 6.0.0 (docs/SCOPE.md): the core the review found worth it, what replaces the desktop app, and
 * the rest. Each feature names the use keys that show it in action (featureuse.ts); `fleet scope` lists the ones
 * nobody used in the test weeks, the first candidates to cut. Keep this list and docs/SCOPE.md in step.
 */

export type Area = "core" | "desktop" | "extra";

export interface Feature {
  id: string;
  area: Area;
  de: string;
  en: string;
  /** Use keys; a key ending in `*` matches every key that starts with it. */
  keys: string[];
}

export const FEATURES: Feature[] = [
  // Core: waiting states, conflicts, fresh start.
  { id: "watch", area: "core", de: "Wer wartet: Jetzt-Ansicht", en: "Who waits: Now view", keys: ["view:/"] },
  {
    id: "answer",
    area: "core",
    de: "Fragen und Freigaben in Fleet beantworten",
    en: "Answer questions and approvals in Fleet",
    keys: ["api:/api/decision", "api:/api/reply", "cmd:reply"],
  },
  {
    id: "conflicts",
    area: "core",
    de: "Konflikte zwischen Sessions und PRs",
    en: "Conflicts between sessions and PRs",
    keys: ["api:/api/conflict*", "api:/api/merge-sessions"],
  },
  {
    id: "fresh",
    area: "core",
    de: "Frisch starten mit Übergabe",
    en: "Start fresh with a handoff",
    keys: ["api:/api/fresh", "api:/api/continue", "api:/api/job", "api:/api/merge", "key:fresh*", "cmd:handoff"],
  },
  // Replacing the desktop app for the two test weeks.
  {
    id: "terminal",
    area: "desktop",
    de: "Claude im Fleet-Terminal",
    en: "Claude in Fleet's terminal",
    keys: [
      "api:/api/term/new*",
      "api:/api/term/resume",
      "api:/api/term/here",
      "api:/api/term/kill",
      "key:terminal*",
      "cmd:new*",
      "cmd:resume",
      "cmd:here",
    ],
  },
  {
    id: "worktrees",
    area: "desktop",
    de: "Sessions in eigenen Worktrees",
    en: "Sessions in worktrees of their own",
    keys: ["api:/api/worktrees", "cmd:wt", "use:worktree*"],
  },
  {
    id: "diff",
    area: "desktop",
    de: "Diff und Dateien",
    en: "Diff and files",
    keys: ["api:/api/diff", "api:/api/file", "key:diff*"],
  },
  {
    id: "open",
    area: "desktop",
    de: "In App oder Editor öffnen",
    en: "Open in app or editor",
    keys: ["api:/api/open"],
  },
  { id: "log", area: "desktop", de: "Log-Sicht", en: "Log view", keys: ["api:/api/log", "key:log*"] },
  { id: "chat", area: "desktop", de: "Verlauf einer Session", en: "A session's conversation", keys: ["api:/api/chat"] },
  {
    id: "clear",
    area: "desktop",
    de: "Wegräumen und :cleanup",
    en: "Clear and :cleanup",
    keys: ["key:hide*", "cmd:cleanup", "cmd:stop"],
  },
  // Everything else.
  {
    id: "usage",
    area: "extra",
    de: "Verbrauch und Fleet-Bilanz",
    en: "Usage and Fleet balance",
    keys: ["view:/usage"],
  },
  { id: "activity", area: "extra", de: "Aktivität", en: "Activity", keys: ["view:/activity"] },
  { id: "repos", area: "extra", de: "Repos & PRs", en: "Repos & PRs", keys: ["view:/repos"] },
  { id: "merge-pr", area: "extra", de: "PR mergen", en: "Merge a PR", keys: ["api:/api/merge-pr", "cmd:merge"] },
  {
    id: "ci",
    area: "extra",
    de: "CI: neu starten, Fix-Session",
    en: "CI: rerun, fix session",
    keys: ["api:/api/run", "cmd:run"],
  },
  { id: "week", area: "extra", de: "Wochenbericht", en: "Week report", keys: ["api:/api/report/week"] },
  {
    id: "architecture",
    area: "extra",
    de: "Architekturmappe",
    en: "Architecture folder",
    keys: ["api:/api/architecture"],
  },
  { id: "brief", area: "extra", de: "Projekt-Briefing", en: "Project briefing", keys: ["api:/api/project-brief"] },
  {
    id: "meta",
    area: "extra",
    de: "Session anheften und benennen",
    en: "Pin and name sessions",
    keys: ["api:/api/meta"],
  },
];

const matches = (pattern: string, key: string) =>
  pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;

/** Uses per feature, plus the keys no feature claims (new or unmapped: they belong in FEATURES). */
export function byFeature(uses: Record<string, number>): {
  features: (Feature & { uses: number })[];
  unmapped: Record<string, number>;
} {
  const claimed = new Set<string>();
  const features = FEATURES.map((f) => {
    let n = 0;
    for (const [k, v] of Object.entries(uses))
      if (f.keys.some((p) => matches(p, k))) {
        n += v;
        claimed.add(k);
      }
    return { ...f, uses: n };
  });
  const unmapped = Object.fromEntries(Object.entries(uses).filter(([k]) => !claimed.has(k)));
  return { features, unmapped };
}
