import { fleetWorktree } from "../../shared/repo";
import type { ConflictPair } from "./conflict";
import { type ActionId, KEYMAP, type Mode, type StatusFilter } from "./keymap";
import type { MergeWay } from "./merge";

/**
 * The command palette (`⌘K`) as a pure function: typed text in, suggestions out. One implementation for both ways
 * in (`⌘K` and the Vim `:` line). Typable: session titles, repo names, PR numbers (`#11`),
 * branches, Bloomberg-style function codes (`NOW`, `REP`, `USE`, `ACT`) and commands with arguments. Each key
 * action of the keymap is a command too. Suggestions are sorted by how well they match, then by how often they
 * were used.
 */

export type Cmd =
  | { kind: "go"; to: string }
  /** `:12`: select row 12 (spec rule 14; the row number prefix of stage 4 is gone). */
  | { kind: "row"; nr: number }
  | { kind: "action"; action: ActionId; arg?: string }
  | { kind: "session"; id: string }
  | { kind: "repo"; name: string }
  | { kind: "pr"; number: number; url: string | null; sessionId: string | null }
  | { kind: "new"; root: string; prompt: string; worktree?: boolean }
  /** Release 6: a new project folder under the projects folder, and Claude in it. */
  | { kind: "newFolder"; name: string; prompt: string }
  /** `fleet` typed in a folder: Claude in exactly that folder (server/core/here.ts). */
  | { kind: "here"; dir: string; prompt: string }
  | { kind: "resume"; id: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "merge"; root: string; number: number; anyway: boolean }
  /** A PR that does not merge yet: the status line says why (round 3: it said "nothing found"). */
  | { kind: "mergeBlocked"; root: string; number: number; why: "draft" | "stacked" | "base" }
  | { kind: "run"; root: string; runId: number; action: "rerun" | "fix" }
  | { kind: "handoff" }
  /** Release 6: hide every session quiet for more than 8 h (y/n), and end all of Fleet's sessions (y/n). */
  | { kind: "cleanup"; roots?: string[]; name?: string }
  | { kind: "stop" }
  | { kind: "filter"; filter: StatusFilter | "" }
  | { kind: "clear" }
  | { kind: "theme"; theme: "dark" | "light" | "system" }
  | { kind: "lang"; lang: "de" | "en" }
  | { kind: "mode"; mode: string }
  | { kind: "help" }
  | { kind: "repoDrawer"; name: string; tab: "arch" | "tools" }
  | { kind: "report"; format: "md" | "json" }
  | ({ kind: "conflict" } & ConflictPair)
  | { kind: "later"; stage: number };

export interface Suggestion {
  /** Stable id, also the key for counting use. */
  id: string;
  de: string;
  en: string;
  /** The action's keys, shown on the right. */
  action?: ActionId;
  /** Selecting it fills the input with this text instead of running (a command that still needs arguments). */
  fill?: string;
  cmd: Cmd | null;
  score: number;
}

export interface PaletteData {
  sessions: { id: string; root: string; title: string; project: string; branch: string; pty: boolean }[];
  repos: { root: string; name: string }[];
  prs: {
    root: string;
    repo: string;
    number: number;
    title: string;
    url: string | null;
    /** Id of the red run, if CI is red: rerun and fix need it. */
    runId: number | null;
    /** How it merges: the same as the merge button (`mergeWay`). */
    merge: MergeWay;
    sessionId: string | null;
  }[];
  /** Known conflicts (shared files, failed probe merges), each pair once. */
  conflicts: ConflictPair[];
  /** Where `new <name>` creates a folder (release 6); empty when the server does not say. */
  projectsDir?: string;
  /** The folder `fleet` was typed in, if fresh. */
  here?: string;
}

/** The areas: listed once, under their code; `word` is the command that reaches the same place (`:usage`). */
const CODES: { code: string; to: string; de: string; en: string; word: string }[] = [
  { code: "NOW", to: "/", de: "Jetzt", en: "Now", word: "now" },
  { code: "REP", to: "/repos", de: "Repos & PRs", en: "Repos & PRs", word: "repos" },
  { code: "USE", to: "/usage", de: "Verbrauch", en: "Usage", word: "usage" },
  { code: "ACT", to: "/activity", de: "Aktivität", en: "Activity", word: "activity" },
];

interface Command {
  word: string;
  args: string;
  de: string;
  en: string;
  aliases?: string[];
  stage?: number;
}

/** The spec's command list ("Befehlspalette und :-Zeile"), plus `lang`, since the language switch moves here too. */
export const COMMANDS: Command[] = [
  // Stage 12: the areas are commands, like resource names in k9s (`:repos`); their Alt keys went to the filters.
  { word: "now", args: "", de: "Jetzt (NOW)", en: "Now (NOW)", aliases: ["jetzt"] },
  { word: "repos", args: "", de: "Repos & PRs (REP)", en: "Repos & PRs (REP)" },
  { word: "usage", args: "", de: "Verbrauch (USE)", en: "Usage (USE)", aliases: ["verbrauch"] },
  { word: "activity", args: "", de: "Aktivität (ACT)", en: "Activity (ACT)", aliases: ["aktivitaet"] },
  {
    word: "new",
    args: "<repo|neuer Ordner> [Auftrag]",
    de: "Neue Session (im Repo oder in einem neuen Ordner)",
    en: "New session (in a repo or a new folder)",
    aliases: ["neu"],
  },
  {
    word: "wt",
    args: "<repo> [Auftrag]",
    de: "Neue Session in einem eigenen Worktree neben dem Repo",
    en: "New session in a worktree of its own next to the repo",
    aliases: ["worktree"],
  },
  {
    word: "here",
    args: "[Auftrag]",
    de: "Claude im Ordner starten, in dem du fleet getippt hast",
    en: "Start Claude in the folder you typed fleet in",
    aliases: ["hier"],
  },
  { word: "resume", args: "<session>", de: "Session fortsetzen", en: "Resume a session", aliases: ["res"] },
  { word: "reply", args: "<session> <text>", de: "Antworten", en: "Reply" },
  { word: "merge", args: "<pr>", de: "PR mergen", en: "Merge a PR" },
  { word: "rerun", args: "<pr>", de: "Fehlgeschlagene Jobs neu starten", en: "Re-run failed jobs" },
  { word: "fix", args: "<pr>", de: "Fix-Session starten", en: "Start a fix session" },
  { word: "filter", args: "<status|repo>", de: "Filtern", en: "Filter" },
  { word: "clear", args: "", de: "Filter und Suche leeren", en: "Clear filter and search" },
  { word: "pin", args: "", de: "Gewählte Session anheften", en: "Pin the selected session" },
  { word: "hide", args: "", de: "Gewählte Session ausblenden", en: "Hide the selected session" },
  // Vim's `:archive` after `V`: Fleet's way off "Now" is hiding (the search still finds them, `u` undoes it).
  {
    word: "archive",
    args: "",
    de: "Markierte Sessions ausblenden (V)",
    en: "Hide the marked sessions (V)",
    aliases: ["archiv"],
  },
  {
    word: "cleanup",
    args: "",
    de: "Aufräumen: Sessions ohne Lebenszeichen seit 8 h ausblenden, erledigte Worktrees entfernen",
    en: "Clean up: hide sessions quiet for 8 h, remove finished worktrees",
    aliases: ["aufraeumen", "aufräumen", "clean"],
  },
  {
    word: "stop",
    args: "",
    de: "Alle Sessions im Fleet-Fenster beenden",
    en: "End all sessions in Fleet's window",
    aliases: ["stopp", "stopall"],
  },
  {
    word: "diff",
    args: "",
    de: "Änderungen der gewählten Session (Diff)",
    en: "Changes of the selected session (diff)",
  },
  { word: "note", args: "", de: "Notiz der gewählten Session", en: "Note of the selected session" },
  { word: "handoff", args: "", de: "Übergabe schreiben lassen", en: "Have the handoff written" },
  { word: "fresh", args: "", de: "Frisch starten", en: "Start fresh" },
  { word: "tidy", args: "<repo>", de: "Aufräumen nur in einem Repo", en: "Tidy up one repo only" },
  { word: "arch", args: "<repo>", de: "Architektur des Repos", en: "The repo's architecture" },
  { word: "conflict", args: "<a> <b>", de: "Konflikt zeigen", en: "Show the conflict", aliases: ["conf"] },
  { word: "report", args: "week [md|json]", de: "Wochenbericht exportieren", en: "Export the week report" },
  { word: "mode", args: "<standard|vim>", de: "Tastaturmodus", en: "Keyboard mode" },
  { word: "theme", args: "<dark|light|system>", de: "Farbschema", en: "Colour scheme" },
  { word: "lang", args: "<de|en>", de: "Sprache", en: "Language" },
  { word: "help", args: "", de: "Tastenhilfe", en: "Key help" },
];

const STATUS_WORDS: Record<string, StatusFilter | ""> = {
  wartet: "needs",
  waiting: "needs",
  needs: "needs",
  fehler: "errors",
  error: "errors",
  errors: "errors",
  arbeitet: "working",
  working: "working",
  fertig: "done",
  done: "done",
  ruht: "resting",
  resting: "resting",
  alle: "",
  all: "",
};
const STATUS_NAME: Record<StatusFilter, [string, string]> = {
  needs: ["wartet", "waiting"],
  errors: ["Fehler", "error"],
  working: ["arbeitet", "working"],
  done: ["fertig", "done"],
  resting: ["ruht", "resting"],
};
export const statusName = (f: StatusFilter, t: (de: string, en: string) => string) => t(...STATUS_NAME[f]);

/** Keys that only move around a list are no commands. */
const NOT_COMMANDS = new Set<ActionId>([
  "palette",
  "close",
  "up",
  "down",
  "pageUp",
  "pageDown",
  "first",
  "last",
  "zoneNext",
  "zonePrev",
  "filter",
  "tile",
  "command",
  "zoneAlarm",
  "zoneStream",
  "halfUp",
  "halfDown",
  "nextAlarm",
  "prevAlarm",
  "nextRepo",
  "prevRepo",
  "searchNext",
  "searchPrev",
  "expand",
  "collapse",
  "visual",
  "repeat",
  // Listed once, under its code LOG.
  "log",
]);

const lc = (s: string) => s.toLowerCase();
/** A folder name the server accepts (server/core/newfolder.ts FOLDER_RE). */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 3 starts with, 2 a word starts with, 1 contains, 0 no match; an empty needle matches everything a little. */
function rank(hay: string, needle: string): number {
  const h = lc(hay);
  const n = lc(needle.trim());
  if (!n) return 0.5;
  if (h.startsWith(n)) return 3;
  if (h.split(/[\s/·\-_:]+/).some((w) => w.startsWith(n))) return 2;
  return h.includes(n) ? 1 : 0;
}
const prNumber = (s: string) => {
  const m = /^#?(\d{1,6})$/.exec(s.trim());
  return m ? Number(m[1]) : null;
};

function findCommand(word: string): Command | undefined {
  const w = lc(word);
  return COMMANDS.find((c) => c.word === w || c.aliases?.includes(w));
}

/** Suggestions for typed text, best first. `used` counts how often each suggestion id was run. */
export function suggest(text: string, data: PaletteData, used: Record<string, number> = {}, limit = 12): Suggestion[] {
  const out = collect(text, data);
  const n = (id: string) => (Number.isFinite(used[id]) ? Number(used[id]) : 0);
  return out
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.score > 0)
    .sort((a, b) => b.s.score - a.s.score || n(b.s.id) - n(a.s.id) || a.i - b.i)
    .slice(0, limit)
    .map(({ s }) => s);
}

function collect(text: string, data: PaletteData): Suggestion[] {
  // The Vim `:` line is the palette: a typed or pasted `:merge 8` means `merge 8`.
  const raw = text.replace(/^\s*:?\s*/, "");
  const [first = "", ...rest] = raw.split(/\s+/);
  const cmd = findCommand(first);
  // A command word followed by a space: its arguments.
  if (cmd && /\s/.test(raw)) return args(cmd, rest.filter(Boolean), rest.join(" ").trim(), data);
  const q = raw.trim();
  const out: Suggestion[] = [];
  // A bare number is a row on "Now" first (`:12`, as in Vim and k9s); `#12` stays the PR.
  const row = /^\d{1,3}$/.test(q) ? Number(q) : 0;
  if (row > 0)
    out.push({
      id: `row:${row}`,
      de: `Zeile ${row} wählen`,
      en: `Select row ${row}`,
      cmd: { kind: "row", nr: row },
      score: 6,
    });
  for (const c of CODES)
    out.push({
      id: `go:${c.to}`,
      de: `${c.code} · ${c.de}`,
      en: `${c.code} · ${c.en}`,
      cmd: { kind: "go", to: c.to },
      score:
        q && lc(c.code) === lc(q)
          ? 5
          : rank(`${c.code} ${c.de} ${c.en} ${c.word} ${(findCommand(c.word)?.aliases || []).join(" ")}`, q),
    });
  // The log view is no area of its own but a layer over every one (spec: "⌘K-Palette (LOG)"); its key is Shift+L.
  out.push({
    id: "go:log",
    de: "LOG · Log-Sicht: alle Schritte aller Sessions",
    en: "LOG · Log view: every step of every session",
    action: "log",
    cmd: { kind: "action", action: "log" },
    score: q && lc(q) === "log" ? 5 : rank("LOG Log-Sicht log view Schritte steps", q),
  });
  for (const c of COMMANDS) {
    // The areas stand above under their codes (round 7: usage was listed twice).
    if (CODES.some((x) => x.word === c.word)) continue;
    // The description counts too (round 7: "Sprache" and "language" found nothing, only `lang`), a little less.
    const r = Math.max(
      rank(c.word, q),
      ...(c.aliases || []).map((a) => rank(a, q)),
      rank(c.de, q) - 0.5,
      rank(c.en, q) - 0.5,
    );
    out.push({
      id: `cmd:${c.word}`,
      de: `${c.word} ${c.args} – ${c.de}`.replace(/\s+–/, " –"),
      en: `${c.word} ${c.args} – ${c.en}`.replace(/\s+–/, " –"),
      fill: c.args && !c.stage ? `${c.word} ` : undefined,
      cmd: c.stage ? { kind: "later", stage: c.stage } : c.args ? null : noArg(c.word),
      score: q ? (r >= 3 ? 4 : r) : 0.5,
    });
  }
  const seen = new Set<string>();
  for (const x of KEYMAP) {
    if (x.own || NOT_COMMANDS.has(x.action) || seen.has(x.action)) continue;
    seen.add(x.action);
    out.push({
      id: `key:${x.action}`,
      de: x.de,
      en: x.en,
      action: x.action,
      cmd: x.stage ? { kind: "later", stage: x.stage } : { kind: "action", action: x.action },
      score: q ? Math.max(rank(x.de, q), rank(x.en, q)) : 0.5,
    });
  }
  if (!q) return out;
  const nr = prNumber(q);
  if (nr !== null)
    for (const p of data.prs.filter((x) => x.number === nr))
      out.push({
        id: `pr:${p.root}#${p.number}`,
        de: `#${p.number} · ${p.repo} · ${p.title}`,
        en: `#${p.number} · ${p.repo} · ${p.title}`,
        cmd: { kind: "pr", number: p.number, url: p.url, sessionId: p.sessionId },
        score: 5,
      });
  for (const s of data.sessions) {
    const r = Math.max(rank(s.title, q), rank(s.project, q) - 0.5, rank(s.branch, q) - 0.5);
    if (r > 0)
      out.push({
        id: `s:${s.id}`,
        de: `${s.title} · ${s.project}${s.branch ? ` · ${s.branch}` : ""}`,
        en: `${s.title} · ${s.project}${s.branch ? ` · ${s.branch}` : ""}`,
        cmd: { kind: "session", id: s.id },
        score: r,
      });
  }
  for (const r of data.repos) {
    const m = rank(r.name, q);
    if (m > 0)
      out.push({
        id: `repo:${r.root}`,
        de: `Repo ${r.name} – Sessions filtern`,
        en: `Repo ${r.name}: filter sessions`,
        cmd: { kind: "repo", name: r.name },
        score: m + 0.5,
      });
  }
  return out;
}

function noArg(word: string): Cmd {
  if (word === "clear") return { kind: "clear" };
  if (word === "help") return { kind: "help" };
  if (word === "handoff") return { kind: "handoff" };
  if (word === "cleanup") return { kind: "cleanup" };
  if (word === "stop") return { kind: "stop" };
  const area = ({ now: "/", repos: "/repos", usage: "/usage", activity: "/activity" } as const)[word as "now"];
  if (area) return { kind: "go", to: area };
  const action = ({ pin: "pin", hide: "hide", archive: "hide", note: "note", fresh: "fresh", diff: "diff" } as const)[
    word as "pin"
  ];
  return { kind: "action", action };
}

/** A worktree Fleet made stands in the list as its repo's checkout; new sessions start from the main folder. */
const mainRepos = <R extends { root: string }>(repos: R[]) => repos.filter((r) => !fleetWorktree(r.root));

function args(c: Command, words: string[], all: string, data: PaletteData): Suggestion[] {
  const id = `cmd:${c.word}`;
  const one = (de: string, en: string, cmd: Cmd | null, score = 3, sid = id, fill?: string): Suggestion => ({
    id: sid,
    de,
    en,
    cmd,
    score,
    fill,
  });
  if (c.stage) return [one(`${c.word} – ${c.de}`, `${c.word} – ${c.en}`, { kind: "later", stage: c.stage })];
  const [a = "", ...more] = words;
  const tail = more.join(" ");
  switch (c.word) {
    case "new": {
      const inRepos = mainRepos(data.repos)
        .map((r) =>
          one(
            `Neue Session in ${r.name}${tail ? `: ${tail}` : ""}`,
            `New session in ${r.name}${tail ? `: ${tail}` : ""}`,
            { kind: "new", root: r.root, prompt: tail },
            rank(r.name, a),
            `new:${r.root}`,
          ),
        )
        .filter((s) => s.score > 0);
      // A name no repo has exactly: a new folder of that name (release 6, plan R7), first when nothing else fits.
      const exact = data.repos.some((r) => lc(r.name) === lc(a));
      if (data.projectsDir && FOLDER.test(a) && !exact) {
        const where = `${data.projectsDir.replace(/[\\/]+$/, "")}/${a}`;
        inRepos.push(
          one(
            `Neuer Ordner ${where}${tail ? `: ${tail}` : ""}`,
            `New folder ${where}${tail ? `: ${tail}` : ""}`,
            { kind: "newFolder", name: a, prompt: tail },
            inRepos.length ? 1.5 : 3.5,
            "new:folder",
          ),
        );
      }
      return inRepos;
    }
    case "wt":
      return mainRepos(data.repos)
        .map((r) =>
          one(
            `Neue Session in ${r.name}, eigener Worktree${tail ? `: ${tail}` : ""}`,
            `New session in ${r.name}, own worktree${tail ? `: ${tail}` : ""}`,
            { kind: "new", root: r.root, prompt: tail, worktree: true },
            rank(r.name, a),
            `wt:${r.root}`,
          ),
        )
        .filter((s) => s.score > 0);
    case "here":
      return data.here
        ? [
            one(
              `Claude in ${data.here} starten${words.length ? `: ${words.join(" ")}` : ""}`,
              `Start Claude in ${data.here}${words.length ? `: ${words.join(" ")}` : ""}`,
              { kind: "here", dir: data.here, prompt: words.join(" ") },
            ),
          ]
        : [
            one(
              "here – erst im Terminal im gewünschten Ordner fleet tippen",
              "here: first type fleet in a terminal in the folder you want",
              null,
            ),
          ];
    case "resume":
      return data.sessions
        .map((s) =>
          one(
            `Fortsetzen: ${s.title} · ${s.project}`,
            `Resume: ${s.title} · ${s.project}`,
            { kind: "resume", id: s.id },
            Math.max(rank(s.title, all), rank(s.project, all) - 0.5),
            `resume:${s.id}`,
          ),
        )
        .filter((s) => s.score > 0);
    case "reply":
      return data.sessions
        .filter((s) => s.pty)
        .map((s) =>
          one(
            tail ? `Antwort an ${s.title}: ${tail}` : `Antwort an ${s.title} …`,
            tail ? `Reply to ${s.title}: ${tail}` : `Reply to ${s.title} …`,
            tail ? { kind: "reply", id: s.id, text: tail } : null,
            Math.max(rank(s.project, a), rank(s.branch, a), rank(s.title, a)),
            `reply:${s.id}`,
            tail ? undefined : `reply ${s.project} `,
          ),
        )
        .filter((s) => s.score > 0);
    case "merge":
    case "rerun":
    case "fix": {
      const nr = prNumber(a);
      return data.prs
        .filter((p) => (nr === null || p.number === nr) && (c.word === "merge" || p.runId !== null))
        .map((p) => {
          const what = `#${p.number} · ${p.repo} · ${p.title}`;
          const cmd: Cmd =
            c.word === "merge"
              ? p.merge === "ok" || p.merge === "anyway"
                ? { kind: "merge", root: p.root, number: p.number, anyway: p.merge === "anyway" }
                : { kind: "mergeBlocked", root: p.root, number: p.number, why: p.merge }
              : { kind: "run", root: p.root, runId: p.runId || 0, action: c.word === "fix" ? "fix" : "rerun" };
          return one(
            `${c.de}: ${what}`,
            `${c.en}: ${what}`,
            cmd,
            nr === null ? 2 : 4,
            `${c.word}:${p.root}#${p.number}`,
          );
        });
    }
    case "filter": {
      const out: Suggestion[] = [];
      for (const [w, f] of Object.entries(STATUS_WORDS)) {
        const r = rank(w, a);
        if (r <= 0 || out.some((x) => x.id === `filter:${f}`)) continue;
        out.push(
          one(
            f ? `Filter: ${STATUS_NAME[f][0]}` : "Filter aufheben",
            f ? `Filter: ${STATUS_NAME[f][1]}` : "Clear the filter",
            { kind: "filter", filter: f },
            r + 1,
            `filter:${f}`,
          ),
        );
      }
      for (const r of data.repos) {
        const m = rank(r.name, a);
        if (m > 0) out.push(one(`Filter: Repo ${r.name}`, `Filter: repo ${r.name}`, { kind: "repo", name: r.name }, m));
      }
      return out;
    }
    case "theme":
      return (
        [
          ["dark", "dunkel", "Dunkel", "Dark"],
          ["light", "hell", "Hell", "Light"],
          ["system", "system", "System", "System"],
        ] as const
      )
        .map(([v, de, deL, enL]) =>
          one(
            `Farbschema: ${deL}`,
            `Colour scheme: ${enL}`,
            { kind: "theme", theme: v },
            Math.max(rank(v, a), rank(de, a)),
            `theme:${v}`,
          ),
        )
        .filter((s) => s.score > 0);
    case "lang":
      return (["de", "en"] as const)
        .map((l) =>
          one(
            `Sprache: ${l === "de" ? "Deutsch" : "Englisch"}`,
            `Language: ${l === "de" ? "German" : "English"}`,
            { kind: "lang", lang: l },
            rank(l, a),
            `lang:${l}`,
          ),
        )
        .filter((s) => s.score > 0);
    case "mode":
      return (["standard", "vim"] as const)
        .map((m) =>
          one(`Tastaturmodus: ${m}`, `Keyboard mode: ${m}`, { kind: "mode", mode: m }, rank(m, a), `mode:${m}`),
        )
        .filter((s) => s.score > 0);
    case "arch":
    case "tidy": {
      // One entry per repo name: worktrees of a repo share its name and are tidied together.
      const byName = new Map<string, string[]>();
      for (const r of data.repos) byName.set(r.name, [...(byName.get(r.name) || []), r.root]);
      return [...byName]
        .map(([name, roots]) =>
          one(
            `${c.de}: ${name}`,
            `${c.en}: ${name}`,
            c.word === "arch" ? { kind: "repoDrawer", name, tab: "arch" } : { kind: "cleanup", roots, name },
            rank(name, a),
            `${c.word}:${name}`,
          ),
        )
        .filter((s) => s.score > 0);
    }
    case "conflict":
      return conflictArgs(c, words, data);
    case "report":
      return [
        one(
          "Wochenbericht exportieren (Markdown)",
          "Export the week report (Markdown)",
          { kind: "report", format: "md" },
          words.includes("json") ? 1 : 3,
          "report:md",
        ),
        one(
          "Wochenbericht exportieren (JSON)",
          "Export the week report (JSON)",
          { kind: "report", format: "json" },
          words.includes("json") ? 4 : 2,
          "report:json",
        ),
      ].filter((s) => s.score > 0);
    default:
      return [one(`${c.word} – ${c.de}`, `${c.word} – ${c.en}`, noArg(c.word))];
  }
}

/** One side the `conflict` command can name: a session by title, branch or project, or an open PR by number. */
interface Side {
  ref: string;
  root: string;
  name: string;
  match: (w: string) => number;
}

function sides(data: PaletteData): Side[] {
  return [
    ...data.sessions
      .filter((s) => s.root)
      .map((s) => ({
        ref: `s:${s.id}`,
        root: s.root,
        name: s.title,
        match: (w: string) => Math.max(rank(s.title, w), rank(s.branch, w) - 0.5, rank(s.project, w) - 1),
      })),
    ...data.prs.map((p) => ({
      ref: `pr:${p.number}`,
      root: p.root,
      name: `#${p.number}`,
      match: (w: string) => (prNumber(w) === p.number ? 4 : rank(p.title, w) - 1),
    })),
  ];
}

/**
 * `conflict` lists the known conflicts, one word narrows them to a side; with two words any two sides of one repo
 * can be compared (the drawer probes them), known conflicts first.
 */
function conflictArgs(c: Command, words: string[], data: PaletteData): Suggestion[] {
  const [a = "", b = ""] = words;
  const all = sides(data);
  const byRef = (root: string, ref: string) => all.find((x) => x.root === root && x.ref === ref);
  const pairKey = (root: string, x: string, y: string) => [root, ...[x, y].sort()].join("|");
  const known = new Set(data.conflicts.map((p) => pairKey(p.root, p.a, p.b)));
  const out = new Map<string, Suggestion>();
  const add = (p: ConflictPair, score: number) => {
    const id = `conflict:${pairKey(p.root, p.a, p.b)}`;
    if ((out.get(id)?.score ?? 0) >= score) return;
    out.set(id, { id, de: `${c.de}: ${p.title}`, en: `${c.en}: ${p.title}`, cmd: { kind: "conflict", ...p }, score });
  };
  for (const p of data.conflicts) {
    const [x, y] = [byRef(p.root, p.a), byRef(p.root, p.b)];
    const one = (s?: Side, w = "") => (!w ? 0.5 : s ? s.match(w) : 0);
    // Either order finds the pair; the typed one is A and B (the drawer offers to merge A first).
    const ab = Math.min(one(x, a), one(y, b));
    const ba = Math.min(one(y, a), one(x, b));
    const turned = { root: p.root, a: p.b, b: p.a, title: p.title.split(" ↔ ").reverse().join(" ↔ ") };
    if (Math.max(ab, ba) > 0) add(ba > ab ? turned : p, Math.max(ab, ba) + 1);
  }
  if (a && b) {
    const top = (w: string) =>
      all
        .map((s) => ({ s, r: s.match(w) }))
        .filter((x) => x.r > 0)
        .sort((x, y) => y.r - x.r)
        .slice(0, 20);
    for (const x of top(a))
      for (const y of top(b))
        if (x.s.root === y.s.root && x.s.ref !== y.s.ref && !known.has(pairKey(x.s.root, x.s.ref, y.s.ref)))
          add({ root: x.s.root, a: x.s.ref, b: y.s.ref, title: `${x.s.name} ↔ ${y.s.name}` }, Math.min(x.r, y.r));
  }
  return [...out.values()];
}

export const isMode = (m: string): m is Mode => m === "standard" || m === "vim";
