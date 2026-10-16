// One source for all counters: header, tiles and sections show the same numbers.
import assert from "node:assert";
import { test } from "vitest";
import { loadConfig } from "../server/core/config";
import { demoSources } from "../server/core/demo";
import { buildOverview, onePrSignal } from "../server/core/overview";
import { alarmCount, alarmRows, GLYPH, type Glyph, inbox, type Place, places } from "../shared/inbox";
import type { Decision, Overview, Repo, Session, Usage } from "../shared/types";

const demo = () =>
  buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );

test("Counters: every visible session is in exactly one group and the numbers match", async () => {
  const o = await demo();
  const ib = inbox(o);
  const ids = [ib.needs, ib.errors, ib.working, ib.done, ib.resting, ib.archive, ib.replaced].flat().map((s) => s.id);
  const deciding = ib.decisions.map((d) => d.sessionId);
  assert.strictEqual(new Set(ids).size, ids.length, "no session twice");
  assert.deepStrictEqual(
    [...ids, ...deciding].sort(),
    o.sessions
      .filter((s) => !s.meta?.hidden)
      .map((s) => s.id)
      .sort(),
    "no session missing",
  );
  assert.deepStrictEqual(ib.counts, {
    needs: ib.needs.length + ib.decisions.length,
    errors: ib.errors.length,
    ciRed: ib.ciRed.length,
    working: ib.working.length,
    done: ib.done.length,
  });
});

test("Groups: errors include no sign of life; a replaced session is never an alarm", () => {
  const s = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session => ({
    id,
    source: "local",
    status,
    meta: {},
    ...extra,
  });
  const ib = inbox({
    sessions: [
      s("err", "error"),
      s("stale", "stale"),
      s("replaced", "error", { next: { id: "new", title: null } }),
      s("ask", "needs_input"),
      s("asked-before", "needs_input", { next: { id: "new", title: null } }),
      s("work", "working"),
      s("done", "waiting"),
    ],
    repos: [],
  });
  assert.deepStrictEqual(
    ib.errors.map((x) => x.id),
    ["err", "stale"],
  );
  assert.deepStrictEqual(
    ib.needs.map((x) => x.id),
    ["ask"],
  );
  assert.deepStrictEqual(
    ib.working.map((x) => x.id),
    ["work"],
  );
  // Their successor "new" is not in the list: then they are the only way back to the work and keep resting.
  assert.deepStrictEqual(
    ib.resting.map((x) => x.id),
    ["replaced", "asked-before"],
  );
  assert.deepStrictEqual(ib.counts, { needs: 1, errors: 2, ciRed: 0, working: 1, done: 1 });
});

test("Resting, archive, replaced: archive and replaced ones leave Now, a replaced one only once its successor exists", () => {
  const s = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session => ({
    id,
    source: "local",
    status,
    meta: {},
    ...extra,
  });
  const ib = inbox({
    sessions: [
      s("idle", "idle"),
      s("ended", "ended"),
      s("app-archived", "idle", { desktop: { id: "d", title: null, current: true, archived: true } }),
      s("archive-group", "idle", { group: { id: "g", name: "Archiv" } }),
      s("other-group", "idle", { group: { id: "g2", name: "Archivierung neu" } }),
      s("old", "ended", { next: { id: "succ", title: "Nachfolger" } }),
      s("succ", "working"),
      s("old-gone", "idle", { next: { id: "not-listed", title: null } }),
      // A hidden successor still exists: the old one is replaced, not resting.
      s("old-hidden-succ", "idle", { next: { id: "hidden", title: null } }),
      s("hidden", "waiting", { meta: { hidden: true } }),
    ],
    repos: [],
  });
  assert.deepStrictEqual(
    ib.resting.map((x) => x.id),
    ["idle", "other-group", "old-gone"],
  );
  assert.deepStrictEqual(
    ib.archive.map((x) => x.id),
    ["ended", "app-archived", "archive-group"],
  );
  assert.deepStrictEqual(
    ib.replaced.map((x) => x.id),
    ["old", "old-hidden-succ"],
  );
  assert.deepStrictEqual(
    ib.working.map((x) => x.id),
    ["succ"],
  );
});

test("Demo: on Now three resting in two repos, the archive and the replaced session stay away", async () => {
  const o = await demo();
  const ib = inbox(o);
  const by = (l: Session[]) => l.map((x) => `${x.project}: ${x.title}`).sort();
  assert.deepStrictEqual(by(ib.resting), [
    "infra: Kostenbericht für die Staging-Umgebung",
    "infra: Terraform-Module aufteilen",
    "shop-frontend: Lighthouse-Werte der Produktseite prüfen",
  ]);
  assert.deepStrictEqual(by(ib.archive), [
    "data-pipeline: Alte Exportskripte entfernen",
    "support-bot: Prompt-Bibliothek sortieren",
  ]);
  assert.deepStrictEqual(by(ib.replaced), ["mobile-app: Abhängigkeiten aktualisieren"]);
});

test("Red CI with a working session on its branch is being fixed: no alarm, said once at that session", () => {
  const remote = { provider: "github", trusted: true, host: "github.com", repo: "y", path: "x/y", webUrl: "" } as const;
  const pr = {
    number: 7,
    title: "x",
    url: "https://github.com/x/y/pull/7",
    state: "open" as const,
    review: null,
    ci: "failure" as const,
  };
  const s = (id: string, status: Session["status"], root: string, branch: string, ci?: Session["ci"]): Session => ({
    id,
    source: "local",
    status,
    repoRoot: root,
    branch,
    remote,
    ci: ci || null,
    meta: {},
  });
  // The PR is known at a finished session; the fix runs in another worktree of the same remote.
  const fixing = inbox({
    sessions: [s("done", "waiting", "/w/y", "fix/x", { pr }), s("fixer", "working", "/w/y-wt", "fix/x")],
    repos: [],
  });
  assert.deepStrictEqual(fixing.ciRed, [], "no alarm while it is being fixed");
  assert.deepStrictEqual(
    fixing.ciFixing.map((c) => [c.pr?.number, c.fixedBy]),
    [[7, "fixer"]],
  );
  assert.strictEqual(fixing.counts.ciRed, 0, "the header counts alarms only");
  // Waiting or resting on that branch is no fix, nor is a working session on another branch.
  for (const other of [s("asks", "needs_input", "/w/y", "fix/x"), s("elsewhere", "working", "/w/y", "main")]) {
    const ib = inbox({ sessions: [s("done", "waiting", "/w/y", "fix/x", { pr }), other], repos: [] });
    assert.strictEqual(ib.ciRed.length, 1, other.id);
    assert.strictEqual(ib.ciFixing.length, 0, other.id);
  }
  // Another repo with the same branch name does not fix this one.
  const foreign = { ...s("foreign", "working", "/w/z", "fix/x"), remote: { ...remote, path: "x/z", repo: "z" } };
  assert.strictEqual(
    inbox({ sessions: [s("done", "waiting", "/w/y", "fix/x", { pr }), foreign], repos: [] }).ciRed.length,
    1,
  );
});

test("Limit alarm only from certain numbers: 90 % from the status line or a reported hit before its reset", () => {
  const now = 1_800_000_000_000;
  const usage = (limits: Usage["limits"], limitHit: Usage["limitHit"] = null) => ({ limits, limitHit }) as Usage;
  const at = (u: Usage | null) => inbox({ sessions: [], repos: [], usage: u }, now).limit;
  const later = now / 1000 + 3600;
  assert.strictEqual(at(null), null, "no data, no alarm");
  assert.strictEqual(at(usage({ five_hour: { used_percentage: 89.9, resets_at: later } })), null);
  assert.deepStrictEqual(at(usage({ five_hour: { used_percentage: 90, resets_at: later } })), {
    kind: "five_hour",
    pct: 90,
    resetsAt: later * 1000,
    hit: false,
  });
  assert.strictEqual(
    at(usage({ five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 96, resets_at: later } }))?.kind,
    "seven_day",
    "the fuller window wins",
  );
  assert.strictEqual(
    at(usage({ five_hour: { used_percentage: 97, resets_at: now / 1000 - 60 } })),
    null,
    "a window that has reset says nothing about now",
  );
  assert.deepStrictEqual(at(usage(null, { kind: "seven_day", at: now - 60e3, resetsAt: now + 3600e3 })), {
    kind: "seven_day",
    pct: null,
    resetsAt: now + 3600e3,
    hit: true,
  });
  assert.strictEqual(at(usage(null, { kind: "five_hour", at: now - 7200e3, resetsAt: now - 1 })), null);
});

test("Fleet balance negative over three days: exactly one alarm, never from an incomplete or broken balance", () => {
  const alarm = { net: -80_000, cost: 80_000, since: "2026-10-12" };
  const at = (b: unknown) => inbox({ sessions: [], repos: [], usage: { balance: b } as Usage }).balance;
  assert.deepStrictEqual(at({ alarm, incomplete: false }), alarm);
  assert.strictEqual(at({ alarm: null, incomplete: false }), null, "positive: no row");
  assert.strictEqual(at({ alarm, incomplete: true }), null, "hooks missing: the number is not certain");
  assert.strictEqual(at({ alarm: { ...alarm, net: "x" }, incomplete: false }), null, "a broken field raises nothing");
  assert.strictEqual(at(undefined), null);
});

test("Demo: Eitplanken waits for you, the login and the limit error stand under errors", async () => {
  const o = await demo();
  const ib = inbox(o);
  const titles = (l: Session[]) => l.map((x) => x.title);
  assert.ok(titles(ib.needs).includes("Eitplanken-Aufträge Guardrails"));
  assert.ok(titles(ib.needs).includes("Doku für Farb-Tokens"), "„Soll ich den PR aufmachen?“ waits");
  assert.ok(titles(ib.done).includes("Schema-Prüfung vor dem Import"));
  assert.ok(!titles(ib.done).includes("Doku für Farb-Tokens"));
  const auth = ib.errors.find((x) => x.title === "Funnel-Auswertung je Kanal");
  assert.deepStrictEqual([auth?.failure?.kind, auth?.detail], ["auth", "Anmeldung abgelaufen"]);
  const limit = ib.errors.find((x) => x.title === "Webhooks für Kontaktänderungen");
  assert.strictEqual(limit?.failure?.kind, "limit");
  assert.match(String(limit?.detail), /^Limit erreicht, frei ab/);
});

test("Signals once: a PR stays only at its youngest visible session, one red card per PR across worktrees", () => {
  const pr = {
    number: 11,
    title: "x",
    url: "https://github.com/x/y/pull/11",
    state: "open" as const,
    review: null,
    ci: "failure" as const,
  };
  const remote = { provider: "github", trusted: true, host: "github.com", repo: "y", path: "x/y", webUrl: "" } as const;
  const s = (id: string, root: string, last: number, hidden = false): Session => ({
    id,
    source: "local",
    status: "idle",
    repoRoot: root,
    branch: "fix/x",
    remote,
    lastActivity: last,
    ci: { pr, ci: { state: "failure", id: 1 } },
    meta: { hidden },
  });
  const list = [s("old", "/w/y", 1), s("young", "/w/y-wt", 3), s("mid", "/w/y", 2)];
  onePrSignal(list);
  assert.deepStrictEqual(
    list.filter((x) => x.ci?.pr).map((x) => x.id),
    ["young"],
  );
  const hidden = [s("old", "/w/y", 1), s("young", "/w/y-wt", 3, true), s("mid", "/w/y", 2)];
  onePrSignal(hidden);
  assert.deepStrictEqual(
    hidden.filter((x) => x.ci?.pr).map((x) => x.id),
    ["mid"],
    "a hidden youngest hands the badge to the next one",
  );
  // Without the cleanup two worktrees of the same repo would still make one card, not two
  const both = [s("a", "/w/y", 1), s("b", "/w/y-wt", 2)];
  assert.strictEqual(inbox({ sessions: both, repos: [] }).ciRed.length, 1);
});

test("Demo: PR #48 has one badge, and the emergency handoff of a failing session waits behind its error card", async () => {
  const o = await demo();
  const with48 = o.sessions.filter((x) => x.ci?.pr?.number === 48);
  assert.strictEqual(with48.length, 1);
  const crm = o.repos.find((r) => r.name === "crm-sync");
  assert.strictEqual(crm?.handoff?.origin, "emergency");
  assert.ok(inbox(o).errors.some((x) => x.id === crm?.handoff?.session));
});

test("Red CI belongs to the repo, not to the session", () => {
  // Reported: sessions like "continue handoff" stood under "Needs you" because of red CI.
  const ci = {
    pr: {
      number: 8,
      title: "Bremse",
      url: "https://github.com/x/y/pull/8",
      state: "open" as const,
      review: null,
      ci: "failure" as const,
    },
  };
  const s = (id: string, status: Session["status"]): Session => ({
    id,
    source: "local",
    status,
    repoRoot: "/w/app",
    branch: "feat/x",
    ci,
    meta: {},
  });
  const repo = (c: Repo["ci"]) => ({ root: "/w/app", name: "app", branch: "feat/x", ci: c }) as Repo;
  const data = (sessions: Session[], repos: Repo[]) => ({ sessions, repos }) as Pick<Overview, "sessions" | "repos">;
  const ib = inbox(data([s("a", "waiting"), s("b", "idle")], [repo(ci)]));
  assert.deepStrictEqual(ib.needs, [], "nobody needs you because of CI");
  assert.strictEqual(ib.ciRed.length, 1, "one card per repo and PR, not per session");
  assert.deepStrictEqual(
    [ib.ciRed[0]?.repo, ib.ciRed[0]?.pr?.number, ib.ciRed[0]?.branch],
    ["app", 8, null],
    "a PR card does not name a session's branch",
  );
  assert.strictEqual(ib.counts.ciRed, 1);
  assert.strictEqual(
    inbox(data([s("a", "waiting")], [repo({ pr: { ...ci.pr, state: "merged" } })])).ciRed.length,
    1,
    "the session's view counts while its PR is open",
  );
  // Reported: a merged PR stood with its last red run next to the run on main.
  const merged = { pr: { ...ci.pr, state: "merged" as const }, ci: { state: "failure" as const, id: 1 } };
  const m = inbox(
    data(
      [{ id: "m", source: "local", status: "waiting", repoRoot: "/w/app", branch: "main", ci: merged, meta: {} }],
      [],
    ),
  ).ciRed;
  assert.deepStrictEqual(
    m.map((c) => [c.branch, c.pr]),
    [["main", null]],
    "a merged PR is done, the red run on main stays",
  );
});

test("Conflict: same files in the same repo warn; worktrees and sessions only waiting on main do not", async () => {
  const o = await demo();
  const hit = o.sessions
    .filter((s) => s.conflict)
    .map((s) => s.title)
    .sort();
  assert.deepStrictEqual(hit, ["Doku für Farb-Tokens", "Sichtbarer Fokusrahmen für Tastaturbedienung"]);
  const s = o.sessions.find((x) => x.title === "Sichtbarer Fokusrahmen für Tastaturbedienung");
  assert.deepStrictEqual(s?.conflict?.files, ["src/tokens/colors.ts"], "only the shared file, relative to the repo");
  assert.ok(
    o.sessions.every((x) => !("edited" in x)),
    "edited paths never reach the dashboard",
  );
});

test("Status pictures: waiting and error follow the place on Now, one picture per session", async () => {
  const s = (id: string, status: Session["status"], extra: Partial<Session> = {}): Session => ({
    id,
    source: "local",
    status,
    meta: {},
    ...extra,
  });
  const decision: Decision = {
    id: "d1",
    sessionId: "braked",
    cwd: "/tmp/x",
    kind: "loop",
    title: "Schleife",
    text: "",
    options: [],
    recommended: "stop",
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    status: "open",
  };
  const ib = inbox({
    sessions: [
      s("err", "error"),
      s("stale", "stale"),
      s("ask", "needs_input"),
      s("work", "working"),
      s("done", "waiting"),
      s("idle", "idle"),
      s("ended", "ended"),
      s("braked", "working"),
      // Replaced: no alarm, so neither the red nor the waiting ship.
      s("old-err", "error", { next: { id: "work", title: null } }),
      s("old-ask", "needs_input", { next: { id: "work", title: null } }),
    ],
    repos: [],
    decisions: [decision],
  });
  const where = places(ib);
  const glyph = (id: string) => GLYPH[where.get(id) as Place];
  const ids = ["err", "stale", "ask", "work", "done", "idle", "ended", "braked", "old-err", "old-ask"];
  assert.deepStrictEqual(Object.fromEntries(ids.map((id) => [id, glyph(id)])), {
    err: "error",
    stale: "error",
    ask: "waiting",
    work: "working",
    done: "done",
    idle: "resting",
    ended: "resting",
    braked: "waiting",
    "old-err": "resting",
    "old-ask": "resting",
  });
  // The error and waiting pictures stand exactly where the alarm counters count.
  const with_ = (g: Glyph) => [...where].filter(([, p]) => GLYPH[p] === g);
  assert.strictEqual(with_("error").length, ib.counts.errors);
  assert.strictEqual(with_("waiting").length, ib.counts.needs);

  // In the demo too: every visible session has exactly one place, so one picture.
  const o = await demo();
  assert.deepStrictEqual(
    [...places(inbox(o)).keys()].sort(),
    o.sessions
      .filter((x) => !x.meta?.hidden)
      .map((x) => x.id)
      .sort(),
  );
});

test("Alarm order: everything waiting for you stands above errors, CI and the limit (B14)", () => {
  const s = (id: string, status: Session["status"], since: number): Session => ({
    id,
    source: "local",
    status,
    statusSince: since,
    meta: {},
  });
  const d = (id: string, sessionId: string, expiresAt: number): Decision => ({
    id,
    sessionId,
    cwd: "/x",
    kind: "permission",
    title: id,
    text: "",
    options: [],
    recommended: "allow",
    createdAt: expiresAt - 45_000,
    expiresAt,
    status: "open",
  });
  const now = Date.UTC(2026, 9, 15, 12);
  const ib = inbox(
    {
      sessions: [
        // Old errors from yesterday came first before: they pushed the waiting rows out of the three-row zone.
        s("err-old", "error", now - 86_400_000),
        s("err-new", "stale", now - 60_000),
        s("ask-old", "needs_input", now - 3_600_000),
        s("ask-new", "needs_input", now - 5_000),
        s("ask-mid", "needs_input", now - 600_000),
        s("deciding", "working", now - 1000),
        s("deciding-2", "working", now - 1000),
      ],
      repos: [],
      decisions: [d("late", "deciding", now + 40_000), d("soon", "deciding-2", now + 10_000)],
      usage: { limitHit: { kind: "five_hour", resetsAt: now + 3_600_000 } } as unknown as Usage,
    },
    now,
  );
  const rows = alarmRows(ib, ib.decisions);
  assert.deepStrictEqual(
    rows.map((r) => (r.kind === "decision" ? r.d.id : r.kind === "needs" || r.kind === "errors" ? r.s.id : r.kind)),
    // Fleet's questions by expiry (the one about to expire first), then waiting newest first, then errors newest first.
    ["soon", "late", "ask-new", "ask-mid", "ask-old", "err-new", "err-old", "limit"],
  );
  assert.strictEqual(alarmCount(ib, ib.decisions), rows.length);
  // The header's ?N counts exactly the waiting rows.
  assert.strictEqual(ib.counts.needs, rows.filter((r) => r.kind === "decision" || r.kind === "needs").length);
});
