import path from "node:path";
import type {
  ArchDoc,
  Balance,
  CiResult,
  Decision,
  FleetEvent,
  GitInfo,
  HookState,
  LoopSignal,
  OpenPr,
  Remote,
  RunDetails,
  Session,
  Status,
  TranscriptData,
} from "../../shared/types";
import { classifyLine } from "./apierror";
import { detectAsk } from "./ask";
import { demoPrConflicts } from "./demo-conflict";
import { demoDiff } from "./demo-diff";
import { APPROVAL, demoNowTool, demoTaskStart } from "./demo-log";
import type { DesktopSession } from "./desktop";
import { tr } from "./lang";
import type { Sources } from "./overview";
import type { SessionSum, UsageData } from "./usage";
import { priceFor } from "./usage";

/**
 * Demo mode (`fleet serve --demo`): invented sessions, repos, PRs, events and usage. Provides the same data
 * sources as the real ones (see realSources in overview.ts), so the dashboard, the API and the E2E tests run
 * the real server path without touching ~/.claude. All names are made up. The data moves slowly (todos, tools)
 * so live updates are visible; at the same moment it is deterministic.
 */

const ROOT = process.platform === "win32" ? "C:\\demo" : "/demo";
/** The files a demo session without its own list edits: the log, the conversation and the diff use the same. */
export const DEMO_FILES = ["src/index.ts", "src/lib/core.ts", "tests/core.test.ts"];

/**
 * A demo session that waits for you: asked for it, or its turn ended with a question (the server sees that one as
 * waiting too). It gets the one-hour cache; on the slower CI runner a five-minute one ran out mid-test.
 */
const waitsInDemo = (s: { status: string; detail?: string | null; answer?: string | null }) =>
  s.status === "needs_input" || /\?\s*$|dein Ja|your yes/i.test(s.detail || s.answer || "");

/** The demo's clock starts with the server: every time hangs on it, so it runs on like a real one. */
const T0 = Date.now();
const MIN = 60e3;
const TOOLS = ["Edit", "Read", "Bash", "Grep", "Task", "WebFetch", "Write", "TodoWrite"];

interface DemoSession {
  project: string;
  branch: string | null;
  title: string;
  status: Status;
  /** minutes in the current status */
  mins: number;
  tool: string;
  todos?: string[];
  /** current todo step */
  cur?: number;
  detail?: string;
  answer?: string;
  source?: "cowork";
  model?: string;
  /** context in thousand tokens */
  ctx?: number;
  /** cost of the session in USD */
  cost?: number;
  /** cache hit rate 0..1 */
  cache?: number;
  loop?: LoopSignal;
  /** work profile for the efficiency advisor (default heavy) */
  work?: "heavy" | "light" | "explore";
  /** cache rebuilds after breaks */
  rebuilds?: number;
  /** in the project's main folder instead of a worktree (for the conflict warning) */
  sameDir?: boolean;
  /** edited files relative to the project */
  edits?: string[];
  /** API error line at the end of the transcript (as Claude Code writes it); no hook unless the session ended */
  failure?: { text: string; quota?: boolean };
}

const sessions = (): DemoSession[] => [
  {
    project: "shop-frontend",
    branch: "feat/checkout-redesign",
    title: tr("Checkout auf die neuen Komponenten umstellen", "Move checkout to the new components"),
    status: "working",
    mins: 18,
    tool: "Edit",
    todos: [
      tr("Bestehende Formulare analysieren", "Analyse existing forms"),
      tr("Adressformular migrieren", "Migrate address form"),
      tr("Zahlungsschritt migrieren", "Migrate payment step"),
      tr("Unit-Tests anpassen", "Update unit tests"),
      tr("E2E-Tests laufen lassen", "Run E2E tests"),
    ],
    cur: 2,
    ctx: 874,
    cost: 14.6,
    cache: 0.93,
  },
  {
    project: "billing-service",
    branch: "feat/pdf-export",
    title: tr("Rechnungen als PDF/A-3 exportieren", "Export invoices as PDF/A-3"),
    status: "working",
    mins: 42,
    tool: "Bash",
    todos: [
      tr("Bibliothek auswählen", "Pick a library"),
      tr("Vorlage bauen", "Build the template"),
      tr("Metadaten einbetten", "Embed metadata"),
      tr("Validierung anbinden", "Hook up validation"),
      tr("Testrechnungen erzeugen", "Generate test invoices"),
    ],
    cur: 3,
    ctx: 655,
    cost: 11.2,
    cache: 0.95,
  },
  {
    project: "data-pipeline",
    branch: "perf/batch-import",
    title: tr("Nächtlichen Import parallelisieren", "Parallelise the nightly import"),
    status: "working",
    mins: 7,
    tool: "Read",
    todos: [
      tr("Laufzeiten messen", "Measure run times"),
      tr("Engpass finden", "Find the bottleneck"),
      tr("Batches parallel verarbeiten", "Process batches in parallel"),
      "Benchmark",
    ],
    cur: 0,
    model: "claude-sonnet-5-5",
    ctx: 96,
    cost: 1.3,
    cache: 0.88,
  },
  {
    project: "design-system",
    branch: "fix/focus-ring",
    edits: ["src/tokens/colors.ts", "src/components/Button.tsx"],
    title: tr("Sichtbarer Fokusrahmen für Tastaturbedienung", "Visible focus ring for keyboard users"),
    status: "working",
    mins: 25,
    tool: "Task",
    todos: [
      tr("Komponenten mit Fokus sammeln", "Collect focusable components"),
      tr("Token für Fokusfarbe", "Token for the focus colour"),
      tr("axe-Tests ergänzen", "Add axe tests"),
    ],
    cur: 1,
    ctx: 188,
    cost: 3.9,
    cache: 0.91,
  },
  {
    project: "support-bot",
    branch: "main",
    title: tr("Antwortvorschläge mit Quellenangaben", "Reply suggestions with sources"),
    status: "working",
    mins: 11,
    tool: "WebFetch",
    todos: [
      tr("Quellen indexieren", "Index sources"),
      tr("Prompt mit Zitaten", "Prompt with citations"),
      tr("Eval-Set erweitern", "Extend the eval set"),
      "Tests",
    ],
    cur: 2,
    ctx: 241,
    cost: 4.7,
    cache: 0.9,
    work: "explore",
  },
  {
    project: "Cowork",
    branch: null,
    title: tr("Wochenbericht aus den Tickets zusammenstellen", "Compile the weekly report from tickets"),
    status: "working",
    mins: 9,
    tool: "mcp__tickets__search_issues",
    source: "cowork",
    ctx: 74,
    cost: 0.9,
    cache: 0.84,
  },
  {
    project: "mobile-app",
    branch: "fix/flaky-login-test",
    title: tr("Flaky Login-Test stabilisieren", "Stabilise the flaky login test"),
    status: "stale",
    mins: 34,
    tool: "Bash",
    todos: [
      tr("Fehlschläge sammeln", "Collect failures"),
      tr("Ursache finden", "Find the cause"),
      tr("Test reparieren", "Fix the test"),
    ],
    cur: 1,
    ctx: 402,
    cost: 7.8,
    cache: 0.62,
    loop: { kind: "repeat", tool: "Bash", count: 6 },
    rebuilds: 4,
  },
  {
    project: "shop-frontend",
    branch: "fix/cart-rounding",
    title: tr("Rundung im Warenkorb korrigieren", "Fix rounding in the cart"),
    // Its conversation edits what its diff shows, the cart fix (round 6: it edited core.ts, the diff showed cart.ts).
    edits: ["src/cart.ts", "src/cart.test.ts"],
    status: "needs_input",
    mins: 4,
    tool: "Bash",
    detail: tr("Freigabe für Bash: pnpm e2e --project=chromium", "Approval for Bash: pnpm e2e --project=chromium"),
    ctx: 133,
    cost: 2.1,
    cache: 0.92,
  },
  {
    project: "Cowork",
    branch: null,
    title: tr("Projektangebot: Aufwand schätzen", "Project offer: estimate the effort"),
    status: "needs_input",
    mins: 12,
    tool: "AskUserQuestion",
    source: "cowork",
    detail: tr(
      "Soll die Schätzung in Personentagen oder Story Points erfolgen?",
      "Should the estimate be in person-days or story points?",
    ),
    ctx: 58,
    cost: 0.6,
    cache: 0.8,
  },
  {
    project: "infra",
    branch: "chore/node-24",
    title: tr("Laufzeit auf Node 24 anheben", "Move the runtime to Node 24"),
    status: "error",
    mins: 6,
    tool: "Bash",
    // As the StopFailure hook writes it: the error enum, then Claude Code's details.
    detail: "overloaded: 529 Overloaded",
    ctx: 71,
    cost: 0.8,
    cache: 0.87,
  },
  {
    project: "billing-service",
    branch: "fix/tax-rounding",
    title: tr("Steuerbeträge je Position runden", "Round tax per line item"),
    status: "waiting",
    mins: 21,
    tool: "Bash",
    answer: tr(
      "Rundung jetzt kaufmännisch je Position, PR #48 ist offen. Die CI meldet einen roten Integrationstest – soll ich ihn mir ansehen?",
      "Rounding is now commercial per line item and PR #48 is open. CI reports a red integration test; shall I look into it?",
    ),
    ctx: 210,
    cost: 3.3,
    cache: 0.94,
  },
  {
    project: "design-system",
    branch: "fix/focus-ring",
    sameDir: true,
    edits: ["src/tokens/colors.ts", "docs/tokens.md"],
    title: tr("Doku für Farb-Tokens", "Docs for colour tokens"),
    status: "waiting",
    mins: 3,
    tool: "Write",
    answer: tr(
      "Doku ist fertig, alle Beispiele gegen beide Themes geprüft. Soll ich den PR aufmachen?",
      "The docs are done and every example is checked against both themes. Shall I open the PR?",
    ),
    model: "claude-sonnet-5-5",
    ctx: 64,
    cost: 0.7,
    cache: 0.9,
  },
  {
    project: "data-pipeline",
    branch: "feat/schema-check",
    title: tr("Schema-Prüfung vor dem Import", "Schema check before the import"),
    status: "waiting",
    mins: 47,
    tool: "Edit",
    answer: tr(
      "Prüfung eingebaut, 23 Tests grün, PR #112 ist approved und kann gemergt werden.",
      "Check is in, 23 tests green, PR #112 is approved and can be merged.",
    ),
    ctx: 175,
    cost: 2.6,
    cache: 0.93,
  },
  {
    project: "docs-site",
    branch: "feat/deploy-preview",
    title: tr("Kurze Fragen zur Deploy-Konfiguration", "Quick questions about the deploy config"),
    status: "waiting",
    mins: 15,
    tool: "Read",
    answer: tr(
      "Die Vorschau-Deploys laufen über den Workflow preview.yml, Secrets kommen aus der Umgebung „preview“.",
      'Preview deploys run through the workflow preview.yml, secrets come from the "preview" environment.',
    ),
    ctx: 38,
    cost: 1.4,
    cache: 0.81,
    work: "light",
  },
  {
    project: "docs-site",
    branch: "main",
    sameDir: true,
    title: tr("Suchindex neu aufbauen", "Rebuild the search index"),
    status: "waiting",
    mins: 40,
    tool: "Bash",
    model: "claude-haiku-5-5",
    ctx: 22,
    cost: 0.1,
    cache: 0.79,
  },
  {
    project: "infra",
    branch: "main",
    title: tr("Kostenbericht für die Staging-Umgebung", "Cost report for staging"),
    status: "idle",
    mins: 600,
    tool: "Read",
    ctx: 48,
    cost: 0.5,
    cache: 0.85,
  },
  {
    project: "mobile-app",
    branch: "main",
    title: tr("Abhängigkeiten aktualisieren", "Update dependencies"),
    status: "ended",
    mins: 1500,
    tool: "Bash",
    ctx: 90,
    cost: 1.1,
    cache: 0.9,
  },
  // Ends without a question mark, still waits for a yes.
  {
    project: "support-bot",
    branch: "chore/guardrails",
    title: tr("Eitplanken-Aufträge Guardrails", "Eitplanken tasks guardrails"),
    status: "waiting",
    mins: 8,
    tool: "TodoWrite",
    answer: tr(
      "Plan steht: vier Leitplanken, zwei davon ändern das Verhalten der API. Ich stoppe hier, an der ersten Stelle, an der ich dein Ja brauche.",
      "The plan is ready: four guardrails, two of them change the API's behaviour. I stop here, at the first point where I need your yes.",
    ),
    ctx: 120,
    cost: 1.9,
    cache: 0.9,
  },
  // The login expired in the desktop app: no StopFailure hook, only the transcript knows, and the session ended.
  {
    project: "analytics",
    branch: "feat/funnel",
    title: tr("Funnel-Auswertung je Kanal", "Funnel report per channel"),
    status: "ended",
    mins: 35,
    tool: "Read",
    failure: { text: "Failed to authenticate: OAuth session expired and could not be refreshed" },
    ctx: 60,
    cost: 0.9,
    cache: 0.88,
  },
  // The five-hour limit broke the turn off; Fleet wrote an emergency handoff.
  {
    project: "crm-sync",
    branch: "feat/webhooks",
    title: tr("Webhooks für Kontaktänderungen", "Webhooks for contact changes"),
    status: "error",
    mins: 14,
    tool: "Edit",
    failure: { text: "You've hit your session limit · resets 6pm", quota: true },
    ctx: 230,
    cost: 3.4,
    cache: 0.92,
  },
  // Resting and archived ones: folded per repo on "Now", the archive only through the search.
  {
    project: "shop-frontend",
    branch: "main",
    title: tr("Lighthouse-Werte der Produktseite prüfen", "Check the product page's Lighthouse scores"),
    status: "idle",
    mins: 320,
    tool: "Read",
    ctx: 30,
    cost: 0.3,
    cache: 0.86,
  },
  {
    project: "infra",
    branch: "chore/terraform-modules",
    title: tr("Terraform-Module aufteilen", "Split the Terraform modules"),
    status: "idle",
    mins: 900,
    tool: "Edit",
    ctx: 41,
    cost: 0.4,
    cache: 0.84,
  },
  {
    project: "data-pipeline",
    branch: "chore/old-exports",
    title: tr("Alte Exportskripte entfernen", "Remove old export scripts"),
    status: "ended",
    mins: 4000,
    tool: "Bash",
    ctx: 25,
    cost: 0.2,
    cache: 0.8,
  },
  // Archived in the desktop app's sidebar, though the session itself never ended.
  {
    project: "support-bot",
    branch: "chore/prompt-library",
    title: tr("Prompt-Bibliothek sortieren", "Sort the prompt library"),
    status: "idle",
    mins: 2600,
    tool: "Read",
    ctx: 19,
    cost: 0.2,
    cache: 0.82,
  },
];

/** PR/CI per branch (project|branch). */
const ci = (): Record<string, CiResult> => ({
  "shop-frontend|feat/checkout-redesign": {
    pr: {
      number: 231,
      title: tr("Checkout auf neue Komponenten", "Checkout on new components"),
      url: "https://github.com/example/shop-frontend/pull/231",
      state: "draft",
      review: null,
      ci: "running",
    },
    ci: { state: "running", url: "https://github.com/example/shop-frontend/actions", name: "CI", id: 9001 },
  },
  "billing-service|feat/pdf-export": {
    pr: {
      number: 51,
      title: tr("PDF/A-3-Export", "PDF/A-3 export"),
      url: "https://github.com/example/billing-service/pull/51",
      state: "open",
      review: "pending",
      ci: "running",
    },
    ci: { state: "running", url: "https://github.com/example/billing-service/actions", name: "CI", id: 9002 },
  },
  "billing-service|fix/tax-rounding": {
    pr: {
      number: 48,
      title: tr("Steuerbeträge je Position runden", "Round tax per line item"),
      url: "https://github.com/example/billing-service/pull/48",
      state: "open",
      review: "changes",
      ci: "failure",
    },
    ci: { state: "failure", url: "https://github.com/example/billing-service/actions", name: "CI", id: 9003 },
  },
  "data-pipeline|feat/schema-check": {
    pr: {
      number: 112,
      title: tr("Schema-Prüfung vor dem Import", "Schema check before the import"),
      url: "https://github.com/example/data-pipeline/pull/112",
      state: "open",
      review: "approved",
      ci: "success",
    },
    ci: { state: "success", url: "https://github.com/example/data-pipeline/actions" },
  },
  "design-system|fix/focus-ring": { ci: { state: "success", url: "https://github.com/example/design-system/actions" } },
  "mobile-app|fix/flaky-login-test": {
    pr: {
      number: 87,
      title: tr("Login-Test stabilisieren", "Stabilise the login test"),
      url: "https://github.com/example/mobile-app/pull/87",
      state: "open",
      review: null,
      ci: "failure",
    },
    ci: { state: "failure", url: "https://github.com/example/mobile-app/actions", name: "CI", id: 9004 },
  },
  "docs-site|main": { ci: { state: "success", url: "https://github.com/example/docs-site/actions" } },
  "infra|main": { ci: { state: "failure", url: "https://github.com/example/infra/actions", name: "CI", id: 9005 } },
});

/** Open PRs per repo for "Repos & PRs": green, red, running, stacked, and one without a session. */
const openPrs = (): Record<string, OpenPr[]> => {
  const pr = (number: number, repo: string, title: string, head: string, o: Partial<OpenPr> = {}): OpenPr => ({
    number,
    title,
    url: `https://github.com/example/${repo}/pull/${number}`,
    draft: false,
    base: "main",
    head,
    ci: "success",
    failed: [],
    review: null,
    onDefault: true,
    stackedOn: null,
    commits: 1 + (number % 4),
    ...o,
  });
  return {
    "shop-frontend": [
      pr(
        231,
        "shop-frontend",
        tr("Checkout auf neue Komponenten", "Checkout on new components"),
        "feat/checkout-redesign",
        {
          draft: true,
          ci: "running",
        },
      ),
    ],
    "billing-service": [
      pr(51, "billing-service", tr("PDF/A-3-Export", "PDF/A-3 export"), "feat/pdf-export", {
        ci: "running",
        review: "pending",
      }),
      pr(52, "billing-service", tr("ZUGFeRD-Anhang im PDF", "ZUGFeRD attachment in the PDF"), "feat/zugferd", {
        base: "feat/pdf-export",
        onDefault: false,
        stackedOn: 51,
      }),
      pr(48, "billing-service", tr("Steuerbeträge je Position runden", "Round tax per line item"), "fix/tax-rounding", {
        ci: "failure",
        failed: ["test (ubuntu-latest)", "lint"],
        review: "changes",
      }),
    ],
    "data-pipeline": [
      pr(
        112,
        "data-pipeline",
        tr("Schema-Prüfung vor dem Import", "Schema check before the import"),
        "feat/schema-check",
        {
          review: "approved",
          // The session's three commits, as its result line says (round 6).
          commits: 3,
        },
      ),
    ],
    "docs-site": [
      pr(14, "docs-site", tr("Suchindex nachts neu bauen", "Rebuild the search index nightly"), "chore/search-index"),
    ],
    "mobile-app": [
      pr(87, "mobile-app", tr("Login-Test stabilisieren", "Stabilise the login test"), "fix/flaky-login-test", {
        ci: "failure",
        failed: ["e2e (ios)"],
      }),
    ],
  };
};

/** Small deterministic random generator (same seed, same sequence). */
function rand(seed: number) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

/** Last tool calls; the session in the loop repeats the same failing test run. */
function trailOf(s: DemoSession, i: number) {
  if (s.loop)
    return Array.from({ length: 8 }, (_, k) => ({
      id: `l${k}`,
      sig: "Bash:x",
      tool: k < 2 ? "Read" : "Bash",
      err: k >= 2,
    }));
  const pick =
    s.work === "light"
      ? ["Read", "Grep"]
      : s.work === "explore"
        ? ["Read", "Grep", "Read", "WebFetch", "Glob", "Read"]
        : ["Read", "Edit", "Bash", "Edit", "Grep", "Bash", "Write", "Task"];
  const r = rand(100 + i);
  return Array.from({ length: s.work === "light" ? 3 : 10 }, (_, k) => ({
    id: `t${k}`,
    sig: `t${k}`,
    tool: pick[Math.floor(r() * pick.length)] ?? "Read",
    err: r() < 0.06,
  }));
}

/** Work profile as counted from a transcript. */
function statsOf(s: DemoSession) {
  if (s.work === "light")
    return { prompts: 5, promptChars: 420, tools: 3, edits: 0, reads: 3, shells: 0, errors: 0, subagents: 0 };
  if (s.work === "explore")
    return { prompts: 3, promptChars: 900, tools: 46, edits: 1, reads: 41, shells: 4, errors: 0, subagents: 1 };
  return {
    prompts: 3,
    promptChars: 1400,
    tools: 64,
    edits: 14,
    reads: 20,
    shells: 28,
    errors: s.loop ? 9 : 2,
    subagents: 2,
  };
}

/** Handoffs as the automatic handoff writes them (repo name -> content). */
const handoffs = (): Record<
  string,
  { minsAgo: number; reason: string; done: string[]; open: string[]; next: string[]; emergencyOf?: number }
> => ({
  // Written by Fleet when the limit broke the turn off; the session stands under "Errors", so not here.
  "crm-sync": {
    minsAgo: 14,
    reason: tr("Turn abgebrochen (rate_limit)", "Turn broke off (rate_limit)"),
    done: [],
    open: [],
    next: [],
    emergencyOf: 19,
  },
  "mobile-app": {
    minsAgo: 50,
    reason: tr("Das Kontextfenster ist zu 87 % voll", "The context window is 87 % full"),
    done: [
      tr("Fehlschläge der letzten 20 Läufe gesammelt", "Collected failures of the last 20 runs"),
      tr(
        "Ursache eingegrenzt: Testkonto wird parallel benutzt",
        "Narrowed the cause: the test account is used in parallel",
      ),
    ],
    open: [
      tr(
        "Login-Test teilt sich das Testkonto mit dem Profil-Test",
        "The login test shares its account with the profile test",
      ),
      tr("Retry im CI ist noch aktiv und verdeckt den Fehler", "Retry in CI is still on and hides the error"),
    ],
    next: [
      tr(
        "Eigenes Testkonto je Testdatei anlegen (fixtures/accounts.ts)",
        "Create one test account per test file (fixtures/accounts.ts)",
      ),
      tr("Retry in playwright.config.ts auf 0 setzen", "Set retries in playwright.config.ts to 0"),
      tr("Test 20× lokal laufen lassen, dann PR #87 aktualisieren", "Run the test 20× locally, then update PR #87"),
    ],
  },
  "billing-service": {
    minsAgo: 180,
    reason: tr("Das Kontextfenster ist zu 86 % voll", "The context window is 86 % full"),
    done: [
      tr("PDF/A-3-Vorlage mit eingebettetem XML", "PDF/A-3 template with embedded XML"),
      tr("Metadaten nach ZUGFeRD-Profil", "Metadata per ZUGFeRD profile"),
    ],
    open: [
      tr("Validierung gegen das offizielle Prüfwerkzeug fehlt", "Validation against the official checker is missing"),
    ],
    next: [
      tr("Prüfwerkzeug im CI-Job einbinden", "Add the checker to the CI job"),
      tr("Drei Testrechnungen mit Sonderfällen erzeugen", "Generate three test invoices with edge cases"),
    ],
  },
});

const idOf = (i: number) => `demo-${String(i).padStart(2, "0")}`;

/** The first session of a project in the main folder, further ones in their own worktrees (that is how one works in parallel). */
function dirOf(list: DemoSession[], s: DemoSession) {
  const first = list.find((x) => x.project === s.project);
  return first === s || s.sameDir
    ? path.join(ROOT, s.project)
    : path.join(ROOT, ".worktrees", String(s.branch).split("/").pop() || "wt", s.project);
}

/** Where does a running session stand right now? One step every 20 s, so live updates are visible. */
function progress(s: DemoSession, i: number, now: number) {
  const tick = Math.floor(now / 20e3) + i;
  const moving = s.status === "working";
  const n = s.todos ? s.todos.length : 0;
  // Tasks only move forward, one a minute while it works (practical test 15 Oct: done tasks jumped back to open).
  const cur = n ? (moving ? Math.min(n - 1, (s.cur || 0) + Math.floor(Math.max(0, now - T0) / MIN)) : s.cur || 0) : 0;
  const tool = moving && !s.source ? (TOOLS[tick % TOOLS.length] ?? s.tool) : s.tool;
  return { cur, tool };
}

/** The end of the demo's 5-hour window, fixed from the server start: the header's reset and crm-sync's "free from". */
const fiveHourEnd = () => Math.floor(T0 / 3600e3) * 3600e3 + 3 * 3600e3;

/**
 * The next reset of a demo limit window after `now`: the first end from the server start, then one period on
 * whenever it has passed, so the demo never shows a reset in the past (round 8).
 */
const nextReset = (first: number, period: number, now: number) =>
  now < first ? first : first + Math.ceil((now - first + 1) / period) * period;

function sessionsAt(now: number) {
  const list = sessions();
  return list.map((s, i) => {
    const { cur, tool: guess } = progress(s, i, now);
    // A working session does what its newest log step does (demo-log.ts): board, drawer and log agree.
    const tool = (s.status === "working" && !s.source && demoNowTool(idOf(i), now)) || guess;
    // Anchored at the server's start, not at each request: countdowns run down and times stay put (practical test
    // 15 Oct: the cache countdown stood still, stream times moved with every refresh).
    const statusSince = T0 - s.mins * MIN;
    const last = s.status === "working" ? now - 20e3 : statusSince;
    const t: TranscriptData = {
      id: idOf(i),
      file: "",
      cwd: s.source ? null : dirOf(list, s),
      gitBranch: s.branch,
      title: s.title,
      summary: null,
      firstPrompt: s.title,
      lastPrompt: s.title,
      lastAssistant: s.answer || null,
      lastTool: tool,
      model: s.model || "claude-opus-5-5",
      todos: s.todos
        ? s.todos.map((c, k) => ({
            content: c,
            activeForm: c,
            status: k < cur ? "completed" : k === cur ? "in_progress" : "pending",
          }))
        : null,
      startedAt: statusSince - 30 * MIN,
      lastTimestamp: last,
      ctx: { tokens: (s.ctx || 50) * 1000, at: last },
      compactions: 0,
      // Waiting sessions on a one-hour cache (Max plans): the countdown runs down visibly, not out in two minutes;
      // finished ones keep five minutes, so the demo also shows an expired cache.
      ...(waitsInDemo(s) ? { cacheTtl: "1h" as const } : {}),
      stats: statsOf(s),
      recent: trailOf(s, i),
      edited: (s.edits || []).map((f) => path.join(dirOf(list, s), f)),
      // Last test run of the finished sessions: billing-service red (integration test), the others green.
      testRun:
        s.status === "waiting" && s.project !== "docs-site"
          ? {
              id: `t${i}`,
              cmd: s.project === "data-pipeline" ? "pnpm test" : "pnpm check",
              ok: s.project !== "billing-service",
              at: null,
            }
          : null,
      turn: s.status === "waiting" ? "done" : s.status === "idle" ? null : s.failure ? "running" : "tool_pending",
      loop: s.loop || null,
      ask: s.status === "waiting" ? detectAsk(s.answer) : null,
      failure: s.failure
        ? classifyLine({
            type: "assistant",
            timestamp: new Date(statusSince).toISOString(),
            isApiErrorMessage: true,
            ...(s.failure.quota
              ? {
                  apiErrorStatus: 429,
                  quotaLimits: { status: "rejected", resetsAt: Math.floor(fiveHourEnd() / 1000) },
                }
              : {}),
            message: { model: "<synthetic>", content: [{ type: "text", text: s.failure.text }] },
          })
        : null,
      mtime: last,
    };
    return { s, t, statusSince, last };
  });
}

/** A demo session that waits for a tool approval ("Approval for Bash: …"), not for an answer in words. */
const perm = (s: { status: string; detail?: string | null }) =>
  s.status === "needs_input" && /^(Freigabe|Erlaubnis|Approval|Permission) (für|for) /.test(s.detail || "");

function hooksAt(now: number): Record<string, HookState> {
  const out: Record<string, HookState> = {};
  for (const { s, t, statusSince, last } of sessionsAt(now)) {
    // "no sign of life" and "resting" come from missing signs of life, not from a hook; an API error only the
    // transcript knows has no hook either (except the session ended afterwards).
    if (s.status === "stale" || s.status === "idle" || (s.failure && s.status !== "ended")) continue;
    out[t.id] = {
      sessionId: t.id,
      status: s.status,
      event: s.status === "ended" ? "SessionEnd" : perm(s) ? "PermissionRequest" : "Stop",
      // A tool approval waits like in real life: the hook holds the open permission request.
      ...(perm(s) ? { waitFor: [{ key: `${s.tool || "Bash"}:${s.detail}`, since: statusSince }] } : {}),
      ...(s.answer ? { lastAnswer: s.answer } : {}),
      detail: s.detail || "",
      at: last,
      cwd: t.cwd || undefined,
      startedAt: statusSince - 30 * MIN,
      statusSince,
      lastPrompt: s.title,
      lastTool: t.lastTool || undefined,
      ...(s.source
        ? {
            source: "cowork" as const,
            url: `https://claude.ai/code/session_demo${t.id.slice(-2)}`,
            title: s.title,
            model: t.model || undefined,
          }
        : {}),
    };
  }
  return out;
}

function eventsAt(now: number): FleetEvent[] {
  const ev: FleetEvent[] = [];
  const r = rand(7);
  sessionsAt(now).forEach(({ s, t, statusSince }, i) => {
    const cwd = t.cwd || "Cowork";
    const push = (at: number, event: string, status: Status, detail = "") =>
      ev.push({ at, sessionId: t.id, event, status, detail, cwd });
    // Current state
    if (s.status === "needs_input") push(statusSince, "PermissionRequest", "needs_input", s.detail);
    else if (s.status === "waiting" || s.status === "idle") push(statusSince, "Stop", "waiting");
    else if (s.status === "error") push(statusSince, "StopFailure", "error", s.detail || s.failure?.text || "");
    else if (s.status === "ended") push(statusSince, "SessionEnd", "ended", "logout");
    else push(Math.min(statusSince, demoTaskStart(t.id) ?? statusSince), "UserPromptSubmit", "working", s.title);
    // History before that: work phases alternating with waiting for the human. The newest task starts where the
    // session's conversation starts (round 4: the history said 19:34, the drawer's conversation began at 20:09).
    let at = statusSince;
    let working = s.status !== "working" && s.status !== "stale";
    const task = demoTaskStart(t.id);
    if (working && task !== null && task < statusSince) {
      push(task, "UserPromptSubmit", "working", s.title);
      at = task;
      working = false;
    }
    // Nothing before the session's conversation starts (round 5: analytics had waited 58 min while living 50).
    const start = Math.max(T0 - (3.2 + (i % 3) * 0.3) * 3600e3, task ?? Number.NEGATIVE_INFINITY);
    while (at > start) {
      at -= (working ? 8 + 30 * r() : 2 + 14 * r()) * MIN;
      if (at <= start) break;
      if (working) push(at, "UserPromptSubmit", "working", s.title);
      else if (r() < 0.35) push(at, "PermissionRequest", "needs_input", tr("Freigabe für Bash", "Approval for Bash"));
      else push(at, "Stop", "waiting");
      working = !working;
    }
  });
  return ev.sort((a, b) => b.at - a.at);
}

/**
 * Tokens per minute of the last hour: running sessions in bursts (answers come in bursts), waiting ones only up
 * to their status change. Shifts every minute so the charts live.
 */
function liveAt(now: number) {
  const minute = Math.floor(now / MIN);
  const bySession: Record<string, { tok: number[]; cost: number[] }> = {};
  sessions().forEach((s, i) => {
    if (s.status === "ended" || s.status === "idle") return;
    const base = (s.cost || 1) * 900; // roughly: more expensive sessions work more
    const p = priceFor(s.model || "claude-opus-5-5");
    const tok: number[] = [];
    for (let k = 59; k >= 0; k--) {
      const r = rand((minute - k) * 31 + i * 7919)();
      const active =
        s.status === "working" || s.status === "stale" ? !(s.status === "stale" && k < s.mins) : k > s.mins;
      tok.push(active && r > 0.25 ? Math.round(base * (0.3 + 1.6 * r * r)) : 0);
    }
    bySession[idOf(i)] = {
      tok,
      cost: tok.map((t) => Math.round(((t * 0.85 * p.i * 1.25 + t * 0.15 * p.o) / 1e6) * 1e4) / 1e4),
    };
  });
  return { minutes: 60, end: now, bySession };
}

/** Usage: 30 days, stacked by model and project, plus limits as from the status line. */
function usageAt(now: number, days: number): UsageData {
  const DAY = 86400e3;
  const r = rand(42);
  const list = sessions();
  const projects = [...new Set(list.map((s) => s.project))];
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const series: NonNullable<UsageData["usage"]>["days"] = [];
  for (let k = days - 1; k >= 0; k--) {
    const t = now - k * DAY;
    const wd = new Date(t).getDay();
    const base = wd === 0 || wd === 6 ? 0.15 : 1; // quiet weekend
    const byModel: Record<string, { cost: number; tok: number }> = {};
    const byProject: Record<string, { cost: number; tok: number }> = {};
    let cost = 0;
    let tok = 0;
    for (const [m, share, perM] of [
      ["Opus 5.5", 0.78, 7.5],
      ["Sonnet 5.5", 0.19, 3.6],
      ["Haiku 5.5", 0.03, 0.4],
    ] as const) {
      const c = Math.round(base * share * (28 + 30 * r()) * 100) / 100;
      const tk = Math.round((c / perM) * 1e6);
      if (c > 0) byModel[m] = { cost: c, tok: tk };
      cost += c;
      tok += tk;
    }
    let left = cost;
    projects.forEach((p, j) => {
      const c = j === projects.length - 1 ? left : Math.round(cost * (0.05 + 0.2 * r()) * 100) / 100;
      const part = Math.min(left, c);
      left -= part;
      if (part > 0) byProject[p] = { cost: Math.round(part * 100) / 100, tok: Math.round((part / 6) * 1e6) };
    });
    series.push({ day: dayKey(t), cost: Math.round(cost * 100) / 100, tok, byModel, byProject });
  }
  const sum = (l: typeof series) => ({
    cost: Math.round(l.reduce((a, d) => a + d.cost, 0) * 100) / 100,
    tok: l.reduce((a, d) => a + d.tok, 0),
    cr: 0,
    n: l.length * 140,
    prompt: 0,
    i: 0,
    o: 0,
    cw: 0,
    cacheRate: 0.92,
  });
  const hour = 3600e3;
  // Fixed from the server start (round 3: the resets moved with the clock).
  const start = fiveHourEnd() - 5 * hour;
  const perSession: Record<string, SessionSum> = {};
  list.forEach((s, idx) => {
    const cost = s.cost || 0;
    // Token counts chosen to match cost and model (for the saving estimate).
    const p = priceFor(s.model || "claude-opus-5-5");
    const n = s.work === "light" ? 6 : Math.max(10, Math.round(cost * 9));
    const i0 = n * 40;
    const o = n * (s.work === "light" ? 450 : 900);
    const cw = n * 6000;
    const cr = Math.max(0, Math.round((cost * 1e6 - i0 * p.i - o * p.o - cw * p.i * 1.25) / p.cr));
    const rebuilds = s.rebuilds || 0;
    perSession[idOf(idx)] = {
      cost,
      tok: i0 + o + cw,
      cr,
      n,
      mn: n,
      mo: o,
      prompt: 0,
      i: i0,
      o,
      cw,
      sub: s.todos ? Math.round(cost * 15) / 100 : 0,
      cacheRate: s.cache ?? null,
      rebuilds,
      rebuildCost: rebuilds * 1.6,
    };
  });
  const today = series[series.length - 1];
  return {
    usage: {
      days: series,
      totals: { today: sum(today ? [today] : []), d7: sum(series.slice(-7)), d30: sum(series) },
      block: { start, end: start + 5 * hour, first: start + 4 * MIN, tok: 5_400_000, cost: 31.4, burnPerMin: 21000 },
      limitHit: null,
      limits: {
        five_hour: { used_percentage: 58, resets_at: Math.floor(nextReset(start + 5 * hour, 5 * hour, now) / 1000) },
        seven_day: { used_percentage: 41, resets_at: Math.floor(nextReset(T0 + 3 * 86400e3, 7 * 86400e3, now) / 1000) },
        at: now,
      },
      live: liveAt(now),
      statsDays: days,
      hasData: true,
      priced: "list",
      balance: demoBalance(series.slice(-7).map((d) => d.day)),
      overage: null,
    },
    perSession,
    statusline: {},
  };
}

/** An invented, positive Fleet balance: a few handoffs and jobs, three fresh starts and one merge that paid off. */
function demoBalance(days: string[]): Balance {
  const cost = [14_000, 22_000, 0, 31_000, 9_000, 26_000, 18_000];
  const saved = [0, 160_000, 240_000, 120_000, 310_000, 280_000, 290_000];
  const s = (tok: number, usd: number, n: number) => ({ tok, cost: usd, n });
  const costTok = cost.reduce((a, b) => a + b, 0);
  const savedTok = saved.reduce((a, b) => a + b, 0);
  return {
    days: 7,
    cost: {
      ...s(costTok, 1.92, 10),
      byKind: {
        handoff: s(48_000, 0.71, 4),
        job: s(21_000, 0.33, 2),
        continue: s(31_000, 0.52, 2),
        merge: s(12_000, 0.18, 1),
        fix: s(8_000, 0.18, 1),
      },
    },
    saved: {
      ...s(savedTok, 10.1, 4),
      fresh: { ...s(1_060_000, 5.3, 3), calls: 212 },
      merge: { ...s(340_000, 1.7, 1), calls: 64 },
      rebuild: s(0, 3.1, 2),
    },
    net: { tok: savedTok - costTok, cost: 8.18 },
    daily: days.map((day, i) => ({
      day,
      cost: cost[i] ?? 0,
      saved: saved[i] ?? 0,
      costUsd: ((cost[i] ?? 0) / costTok) * 1.92,
      savedUsd: ((saved[i] ?? 0) / savedTok) * 10.1,
      compactUsd: i % 2 ? 0.74 / 3 : 0,
      freshUsd: i % 2 ? 0.71 / 3 : 0,
    })),
    // As the server counts it: Fleet's side is the cost of writing the handoffs (the table's first row).
    vsCompact: { n: 4, compact: 0.74, fleet: 0.71, net: 0.03 },
    unmatched: 0,
    alarm: null,
    incomplete: false,
  };
}

/** How long the demo's brake question and approval stand: the approval as long as Fleet's default (README, 45 s). */
const LOOP_MS = 90e3;
const APPROVAL_MS = 45e3;

/**
 * Fleet's own questions in the demo: the stuck mobile-app session waits for a decision (brake), data-pipeline for an
 * approval. Each counts down from the server start to 0 and only then is asked again (round 3: they started over
 * every minute, mid-countdown). Asked again, it still waits since the first time (round 5: the activity's minutes
 * stood still while the row waited).
 */
export function decisionsAt(now: number): Decision[] {
  const cycle = (len: number) => T0 + Math.floor(Math.max(0, now - T0) / len) * len;
  const loopAt = cycle(LOOP_MS);
  const askAt = cycle(APPROVAL_MS);
  return [
    {
      id: "demo-entscheidung",
      sessionId: idOf(6),
      cwd: "",
      kind: "loop",
      title: tr("6× derselbe Bash-Aufruf", "6× the same Bash call"),
      text: tr(
        "Die Session wiederholt denselben Bash-Aufruf, ohne dass sich etwas ändert. Jeder weitere Versuch kostet Tokens.",
        "The session repeats the same Bash call without anything changing. Every further attempt costs tokens.",
      ),
      options: [
        {
          id: "rethink",
          label: tr("Innehalten und neu ansetzen", "Pause and rethink"),
          hint: tr(
            "Claude fasst zusammen, was nicht klappt, und fragt dich",
            "Claude sums up what does not work and asks you",
          ),
        },
        { id: "escalate", label: tr("An Opus-Subagent geben", "Hand to an Opus subagent") },
        { id: "continue", label: tr("Weiter so", "Carry on") },
        { id: "stop", label: tr("Anhalten", "Stop") },
      ],
      recommended: "rethink",
      createdAt: T0,
      expiresAt: loopAt + LOOP_MS,
      status: "open",
    },
    {
      // Approval straight from Fleet: the parallel import needs a package.
      id: "demo-freigabe",
      sessionId: APPROVAL.session,
      cwd: "",
      kind: "permission",
      title: `${tr("Freigabe", "Approval")}: Bash`,
      text: APPROVAL.text,
      options: [
        { id: "allow", label: tr("Erlauben", "Allow") },
        {
          id: "allow-session",
          label: tr("Immer für diese Session", "Always for this session"),
          hint: tr("Gleiche Aufrufe fragen in dieser Session nicht mehr", "Same calls no longer ask in this session"),
        },
        { id: "deny", label: tr("Ablehnen", "Deny") },
      ],
      recommended: "allow",
      createdAt: T0,
      expiresAt: askAt + APPROVAL_MS,
      status: "open",
    },
  ];
}

function gitAt(root: string): GitInfo {
  const name = path.basename(root);
  const list = sessions();
  const own = list.find((s) => !s.source && dirOf(list, s) === root);
  // The checkout's changed files are its session's diff (round 3: the repo bar summed 4 per worktree while `gd`
  // showed 3 files); a checkout no session works in is clean.
  const logged = new Set(demoLogSessions().map((x) => x.id));
  const here = list.map((s, i) => ({ s, id: idOf(i) })).filter((x) => !x.s.source && dirOf(list, x.s) === root);
  const working = here.find((x) => logged.has(x.id)) || here[0];
  const dirty = working ? demoDiff({ id: working.id, title: working.s.title } as Session).files.length : 0;
  const remote: Remote = {
    provider: "github",
    trusted: true,
    host: "github.com",
    owner: "example",
    repo: name,
    path: `example/${name}`,
    webUrl: `https://github.com/example/${name}`,
  };
  const subjects: Record<string, string> = {
    "shop-frontend": tr(
      "feat(checkout): Adressformular auf neue Komponenten",
      "feat(checkout): address form on new components",
    ),
    "billing-service": tr("test: Rundungsfälle je Steuersatz", "test: rounding cases per tax rate"),
    "data-pipeline": tr("perf: Batches parallel einlesen", "perf: read batches in parallel"),
    "design-system": tr("fix(focus): Fokusrahmen in allen Themes", "fix(focus): focus ring in all themes"),
    "support-bot": tr("feat: Quellen im Antwortvorschlag", "feat: sources in reply suggestions"),
    "mobile-app": tr("test: Login-Test mit festem Testkonto", "test: login test with a fixed account"),
    infra: tr("chore: Node 24 in allen Images", "chore: Node 24 in all images"),
    "docs-site": tr("docs: Suchindex nachts neu bauen", "docs: rebuild the search index nightly"),
  };
  return {
    root,
    name,
    branch: own?.branch || "main",
    dirty,
    remote,
    behind: name === "infra" ? 2 : 0,
    // A branch with an open PR is pushed: its commits are the PR's (round 6: "3 Commits", "1 commit", "↑1").
    ahead: dirty && !(openPrs()[name] || []).some((p) => p.head === (own?.branch || "main")) ? 1 : 0,
    hasUpstream: true,
    lastCommit: {
      hash: `a1b2c3d${name.length}`.slice(0, 7),
      at: T0 - (name.length * 7 + 3) * MIN,
      subject: subjects[name] || "chore: upkeep",
    },
  };
}

/** The demo sessions that run in Fleet's own window: one at work, one waiting for a yes (server/process/demo-term.ts). */
/** The demo sessions with a transcript, as the log view's invented steps need them (demo-log.ts). */
export function demoLogSessions() {
  const list = sessions();
  return list
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.source)
    .map(({ s, i }) => ({
      id: idOf(i),
      project: s.project,
      cwd: dirOf(list, s),
      status: s.status,
      mins: s.mins,
      tool: s.tool,
      todos: s.todos || [],
      edits: s.edits || [],
      // Light sessions change no code (statsOf): no edits in their conversation, no diff (practical test 15 Oct).
      readOnly: statsOf(s).edits === 0,
      cur: s.cur || 0,
      detail: s.detail || null,
      answer: s.answer || null,
      failure: s.failure?.text || null,
      loop: !!s.loop,
    }));
}

/** What a demo session shows when it is resumed in Fleet's terminal (server/process/demo-term.ts). */
export function demoSessionFacts(
  id: string,
): { title: string; status: string; detail: string; answer: string; tool: string } | null {
  const list = sessions();
  const i = list.findIndex((_, k) => idOf(k) === id);
  const s = list[i];
  if (!s) return null;
  return { title: s.title, status: s.status, detail: s.detail || "", answer: s.answer || "", tool: s.tool || "" };
}

export function demoTerminalSessions(): { id: string; cwd: string; title: string; detail: string; asks: boolean }[] {
  const list = sessions();
  return [
    { i: list.findIndex((s) => s.branch === "feat/checkout-redesign"), asks: false },
    { i: list.findIndex((s) => s.branch === "fix/cart-rounding"), asks: true },
  ]
    .filter((x) => x.i >= 0)
    .map(({ i, asks }) => {
      const s = list[i] as DemoSession;
      return { id: idOf(i), cwd: dirOf(list, s), title: s.title, detail: s.detail || "", asks };
    });
}

/** Data sources for buildOverview in demo mode. */
export function demoSources(): Partial<Sources> {
  const days = 30;
  return {
    readHookStates: async () => hooksAt(Date.now()),
    // Cowork sessions have no local transcript, they only come through the hook state.
    scanSessions: async () =>
      sessionsAt(Date.now())
        .filter((x) => !x.s.source)
        .map((x) => x.t),
    readEvents: async () => eventsAt(Date.now()),
    usageData: async () => usageAt(Date.now(), days),
    getAgents: () => ({ at: Date.now(), list: [], error: null, disabledUntil: 0 }),
    claudeProcs: () => new Map(),
    repoRoot: async (dir: string) => (dir.startsWith(ROOT) ? dir : null),
    gitInfo: async (root: string) => gitAt(root),
    handoffFor: (root: string) => {
      const h = handoffs()[path.basename(root)];
      if (!h || root !== path.join(ROOT, path.basename(root))) return null;
      // billing-service: Fleet already opened the new session, it waits for Enter.
      const opened = path.basename(root) === "billing-service" ? { at: T0 - 2 * MIN, target: "desktop" } : null;
      return {
        file: path.join(root, "HANDOFF.md"),
        at: T0 - h.minsAgo * MIN,
        trusted: true,
        reason: h.reason,
        title: tr("Übergabe", "Handoff"),
        open: h.open,
        next: h.next,
        done: h.done,
        opened,
        session: h.emergencyOf === undefined ? null : idOf(h.emergencyOf),
        origin: h.emergencyOf === undefined ? "claude" : "emergency",
      };
    },
    prsFor: (remote) => (remote ? { prs: openPrs()[remote.repo] || [], fetchedAt: Date.now() } : null),
    prConflicts: demoPrConflicts,
    ciFor: (remote, branch) =>
      remote && branch ? ci()[`${remote.repo}|${branch}`] || { ci: { state: "none" } } : null,
    decisions: (): Decision[] => decisionsAt(Date.now()),
    // Result line of finished sessions: the commits and what the checkout's diff shows (round 4: "6 files +214"
    // beside a diff of 2 files).
    result: async (root: string) => {
      const meta = (
        {
          "billing-service": {
            commits: 2,
            last: tr("fix: Steuerbeträge je Position kaufmännisch runden", "fix: round tax per line item"),
          },
          "design-system": {
            commits: 1,
            last: tr(
              "docs: Farb-Tokens mit Beispielen für beide Themes",
              "docs: colour tokens with examples for both themes",
            ),
          },
          "data-pipeline": {
            commits: 3,
            last: tr("feat: Schema vor dem Import prüfen", "feat: check the schema before the import"),
          },
        } as Record<string, { commits: number; last: string }>
      )[path.basename(root)];
      const here = demoLogSessions().find((x) => x.cwd === root && !x.readOnly);
      if (!meta || !here) return null;
      const pr = (openPrs()[path.basename(root)] || []).find((p) => p.head === gitAt(root).branch);
      const files = demoDiff({ id: here.id, title: "" } as Session).files;
      return {
        ...meta,
        ...(pr && typeof pr.commits === "number" ? { commits: pr.commits } : {}),
        files: files.length,
        add: files.reduce((n, f) => n + f.add, 0),
        del: files.reduce((n, f) => n + f.del, 0),
      };
    },
    // The ended mobile-app session was restarted fresh: the desktop app knows the successor.
    desktop: () => {
      const list = sessions();
      const s: DesktopSession = {
        desktopId: "local_00000000-0000-4000-8000-000000000006",
        cliSessionId: idOf(6),
        prior: [idOf(16)],
        title: list[6]?.title ?? null,
        model: null,
        archived: false,
        lastActivityAt: 0,
        prs: [],
        group: null,
      };
      const byCli = new Map<string, DesktopSession>([
        [idOf(6), s],
        [idOf(16), s],
      ]);
      // Group "Checkout relaunch" in the sidebar: frontend, billing and design system together.
      const group = { id: "cg-demo-checkout", name: tr("Checkout-Relaunch", "Checkout relaunch") };
      for (const i of [0, 1, 3, 7, 10]) {
        byCli.set(idOf(i), {
          desktopId: `local_00000000-0000-4000-8000-0000000000${String(10 + i).padStart(2, "0")}`,
          cliSessionId: idOf(i),
          prior: [],
          title: list[i]?.title ?? null,
          model: null,
          archived: false,
          lastActivityAt: 0,
          prs: [],
          group,
        });
      }
      byCli.set(idOf(23), {
        desktopId: "local_00000000-0000-4000-8000-000000000033",
        cliSessionId: idOf(23),
        prior: [],
        title: list[23]?.title ?? null,
        model: null,
        archived: true,
        lastActivityAt: 0,
        prs: [],
        group: null,
      });
      return { byCli, successor: new Map([[idOf(16), idOf(6)]]) };
    },
  };
}

/** Invented architecture notes for the repo drawer; two repos have none, so the empty state shows too. */
export function demoArchitecture(repo: string): ArchDoc {
  if (repo === "infra" || repo === "docs-site") return { file: null, text: null, truncated: false, mappe: false };
  const text = tr(
    `# ${repo} – Architektur

Ein Dienst, drei Schichten. Erfundene Demo-Daten.

## Schichten

- **Oberfläche**: React Router, eine Route pro Datei
- **Logik**: reine Funktionen unter \`lib/\`, ohne Netz testbar
- **Daten**: Postgres über Drizzle, Migrationen generiert

## Entscheidungen

1. Geld immer in Cent als Ganzzahl
2. Kein globaler Zustand im Browser

Mehr dazu: [Beispiel-Doku](https://example.com/docs/${repo})
`,
    `# ${repo}: architecture

One service, three layers. Made-up demo data.

## Layers

- **UI**: React Router, one route per file
- **Logic**: pure functions under \`lib/\`, testable without a network
- **Data**: Postgres through Drizzle, generated migrations

## Decisions

1. Money always in cents as integers
2. No global state in the browser

More: [example docs](https://example.com/docs/${repo})
`,
  );
  return { file: ".architektur/README.md", text, truncated: false, mappe: repo === "shop-frontend" };
}

/** Details of the demo pipelines (like pipeline.runDetails): a running run with its current step, red runs with failed tests and a log excerpt. */
export function demoRun(repo: string, id: number): RunDetails {
  const st = (name: string, state: RunDetails["jobs"][number]["state"]) => ({ name, state });
  const base = {
    id,
    url: `https://github.com/example/${repo}/actions/runs/${id}`,
    workflow: "CI",
    sha: "a1b2c3d4e5f6",
    branch: null,
    tests: [] as string[],
    log: null as string | null,
  };
  if (id === 9001 || id === 9002) {
    return {
      ...base,
      title: "Push",
      state: "running",
      jobs: [
        {
          id: 1,
          name: "lint",
          state: "success",
          current: null,
          notes: [],
          steps: [st("Checkout", "success"), st("pnpm lint", "success")],
        },
        {
          id: 2,
          name: "unit",
          state: "running",
          current: "pnpm test",
          notes: [],
          steps: [
            st("Checkout", "success"),
            st("pnpm install", "success"),
            st("pnpm test", "running"),
            st(tr("Coverage hochladen", "Upload coverage"), "pending"),
          ],
        },
        { id: 3, name: "e2e", state: "pending", current: null, notes: [], steps: [] },
      ],
    };
  }
  if (id === 9003) {
    const t1 = tr(
      "Rechnung mit drei Positionen: Summe stimmt auf den Cent",
      "Invoice with three items: total is exact to the cent",
    );
    const t2 = tr("Gutschrift rundet negativ kaufmännisch", "Credit note rounds negative amounts commercially");
    return {
      ...base,
      title: tr("fix: Steuerbeträge je Position runden", "fix: round tax per line item"),
      state: "failure",
      tests: [t1, t2],
      log: `▶ Integration\n  ✔ ${tr("Rechnung mit einer Position", "Invoice with one item")} (12ms)\n  ✖ ${t1} (8ms)\n    AssertionError: expected 1190.01 to equal 1190.00\n  ✖ ${t2} (5ms)\n    AssertionError: expected -19.01 to equal -19.00\nℹ tests 24\nℹ pass 22\nℹ fail 2`,
      jobs: [
        { id: 1, name: "lint", state: "success", current: null, notes: [], steps: [st("pnpm lint", "success")] },
        {
          id: 2,
          name: "integration",
          state: "failure",
          current: null,
          notes: [],
          steps: [st("Checkout", "success"), st("pnpm install", "success"), st("pnpm test:integration", "failure")],
        },
      ],
    };
  }
  if (id === 9005) {
    return {
      ...base,
      title: tr("Nicht gestartet", "Not started"),
      state: "failure",
      jobs: ["lint", "test", "e2e"].map((name, k) => ({
        id: k,
        name,
        state: "failure" as const,
        current: null,
        notes: [
          "The job was not started because recent account payments have failed or your spending limit needs to be increased.",
        ],
        steps: [],
      })),
    };
  }
  const t = tr("login › zeigt Fehlermeldung bei falschem Passwort", "login › shows an error for a wrong password");
  return {
    ...base,
    title: tr("Login-Test stabilisieren", "Stabilise the login test"),
    state: "failure",
    tests: [t],
    log: `  ✘  3 [chromium] › login.spec.ts:18:1 › ${t} (5.2s)\n    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()\n  1 failed\n  41 passed (48.3s)`,
    jobs: [
      {
        id: 1,
        name: "e2e",
        state: "failure",
        current: null,
        notes: [],
        steps: [st("Checkout", "success"), st("pnpm e2e", "failure")],
      },
    ],
  };
}
