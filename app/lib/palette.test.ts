// The palette's promise (spec, "Befehlspalette"): what is typed finds sessions, repos, PRs and commands, the best
// match first, often used ones before rarely used ones, and nothing that is not built yet pretends to work.
import assert from "node:assert";
import { test } from "vitest";
import { type PaletteData, suggest } from "./palette";

const data: PaletteData = {
  sessions: [
    {
      id: "a1",
      root: "/r/shop-web",
      title: "Checkout umstellen",
      project: "shop-web",
      branch: "feat/checkout",
      pty: true,
    },
    {
      id: "b2",
      root: "/r/belegpruefer",
      title: "Belege prüfen",
      project: "belegpruefer",
      branch: "fix/ocr",
      pty: false,
    },
    { id: "c3", root: "/r/shop-web", title: "Warenkorb-Doku", project: "shop-web", branch: "docs/cart", pty: false },
  ],
  repos: [
    { root: "/r/shop-web", name: "shop-web" },
    { root: "/r/belegpruefer", name: "belegpruefer" },
  ],
  prs: [
    {
      root: "/r/belegpruefer",
      repo: "belegpruefer",
      number: 11,
      title: "OCR-Fix",
      url: "https://github.com/x/y/pull/11",
      runId: 99,
      merge: "anyway",
      sessionId: "b2",
    },
    {
      root: "/r/shop-web",
      repo: "shop-web",
      number: 8,
      title: "Checkout",
      url: null,
      runId: null,
      merge: "ok",
      sessionId: "a1",
    },
    {
      root: "/r/belegpruefer",
      repo: "belegpruefer",
      number: 12,
      title: "OCR-Sprache",
      url: null,
      runId: null,
      merge: "ok",
      sessionId: null,
    },
    {
      root: "/r/belegpruefer",
      repo: "belegpruefer",
      number: 13,
      title: "OCR-Entwurf",
      url: null,
      runId: null,
      merge: "draft",
      sessionId: null,
    },
  ],
  conflicts: [
    { root: "/r/shop-web", a: "s:a1", b: "s:c3", title: "Checkout umstellen ↔ Warenkorb-Doku" },
    { root: "/r/belegpruefer", a: "pr:11", b: "pr:12", title: "#11 ↔ #12" },
  ],
};
const top = (text: string, used = {}) => suggest(text, data, used)[0];

test("Function codes go to the areas", () => {
  assert.deepStrictEqual(top("REP")?.cmd, { kind: "go", to: "/repos" });
  assert.deepStrictEqual(top("now")?.cmd, { kind: "go", to: "/" });
  assert.deepStrictEqual(top("USE")?.cmd, { kind: "go", to: "/usage" });
});

test("Stage 12: the areas are commands (`:repos`, `:activity`), a bare number selects that row, #11 stays the PR", () => {
  assert.deepStrictEqual(top("repos")?.cmd, { kind: "go", to: "/repos" });
  assert.deepStrictEqual(top(":usage")?.cmd, { kind: "go", to: "/usage" });
  assert.deepStrictEqual(top("activity")?.cmd, { kind: "go", to: "/activity" });
  assert.deepStrictEqual(top("12")?.cmd, { kind: "row", nr: 12 });
  assert.deepStrictEqual(top(":3")?.cmd, { kind: "row", nr: 3 });
  // The PR with that number still comes up, right after the row
  assert.deepStrictEqual(suggest("11", data)[1]?.cmd, {
    kind: "pr",
    number: 11,
    url: "https://github.com/x/y/pull/11",
    sessionId: "b2",
  });
  assert.strictEqual(top("#11")?.cmd?.kind, "pr");
});

test("#11 finds the PR, a repo name the repo, a title the session", () => {
  assert.deepStrictEqual(top("#11")?.cmd, {
    kind: "pr",
    number: 11,
    url: "https://github.com/x/y/pull/11",
    sessionId: "b2",
  });
  assert.deepStrictEqual(top("beleg")?.cmd, { kind: "repo", name: "belegpruefer" });
  assert.deepStrictEqual(top("Checkout")?.cmd, { kind: "session", id: "a1" });
});

test("Commands with arguments: new, merge, rerun, fix, filter, reply", () => {
  assert.deepStrictEqual(top("new shop Tests grün machen")?.cmd, {
    kind: "new",
    root: "/r/shop-web",
    prompt: "Tests grün machen",
  });
  assert.deepStrictEqual(top("neu beleg")?.cmd, { kind: "new", root: "/r/belegpruefer", prompt: "" });
  // Merge takes the same way as the buttons (round 3): red CI merges anyway after y/n, a draft says why it waits;
  // only red ones re-run or get a fix session
  assert.deepStrictEqual(top("merge 8")?.cmd, { kind: "merge", root: "/r/shop-web", number: 8, anyway: false });
  assert.deepStrictEqual(top("merge 11")?.cmd, { kind: "merge", root: "/r/belegpruefer", number: 11, anyway: true });
  assert.deepStrictEqual(top("merge 13")?.cmd, {
    kind: "mergeBlocked",
    root: "/r/belegpruefer",
    number: 13,
    why: "draft",
  });
  assert.deepStrictEqual(top("rerun #11")?.cmd, { kind: "run", root: "/r/belegpruefer", runId: 99, action: "rerun" });
  assert.deepStrictEqual(top("fix 11")?.cmd, { kind: "run", root: "/r/belegpruefer", runId: 99, action: "fix" });
  assert.deepStrictEqual(top("filter wartet")?.cmd, { kind: "filter", filter: "needs" });
  assert.deepStrictEqual(top("filter fehler")?.cmd, { kind: "filter", filter: "errors" });
  assert.deepStrictEqual(top("filter shop")?.cmd, { kind: "repo", name: "shop-web" });
  // Reply only to sessions in Fleet's terminal; without text the input is filled, nothing is sent
  assert.deepStrictEqual(top("reply shop ja, mach weiter")?.cmd, { kind: "reply", id: "a1", text: "ja, mach weiter" });
  const noText = top("reply shop");
  assert.strictEqual(noText?.cmd, null);
  assert.strictEqual(noText?.fill, "reply shop-web ");
  assert.strictEqual(suggest("reply beleg hallo", data).length, 0);
});

test("A command that still needs arguments fills the input; theme, lang and mode switch", () => {
  const m = top("mer");
  assert.strictEqual(m?.id, "cmd:merge");
  assert.strictEqual(m?.fill, "merge ");
  assert.deepStrictEqual(top("theme hell")?.cmd, { kind: "theme", theme: "light" });
  assert.deepStrictEqual(top("lang en")?.cmd, { kind: "lang", lang: "en" });
  assert.deepStrictEqual(top("mode standard")?.cmd, { kind: "mode", mode: "standard" });
});

test("conflict lists the known conflicts, one word narrows them, two words compare any two sides of one repo", () => {
  const known = suggest("conflict ", data, {}).map((s) => s.cmd);
  assert.deepStrictEqual(known, [
    { kind: "conflict", root: "/r/shop-web", a: "s:a1", b: "s:c3", title: "Checkout umstellen ↔ Warenkorb-Doku" },
    { kind: "conflict", root: "/r/belegpruefer", a: "pr:11", b: "pr:12", title: "#11 ↔ #12" },
  ]);
  // The side named first is A
  assert.deepStrictEqual(top("conf checkout")?.cmd, known[0]);
  assert.deepStrictEqual(top("conf warenkorb")?.cmd, {
    kind: "conflict",
    root: "/r/shop-web",
    a: "s:c3",
    b: "s:a1",
    title: "Warenkorb-Doku ↔ Checkout umstellen",
  });
  // Either order finds the known pair; the typed order is A and B
  assert.deepStrictEqual(top("conflict #12 #11")?.cmd, {
    kind: "conflict",
    root: "/r/belegpruefer",
    a: "pr:12",
    b: "pr:11",
    title: "#12 ↔ #11",
  });
  // Any two sides of one repo, even without a known conflict: the drawer probes them
  assert.deepStrictEqual(top("conflict #11 belege")?.cmd, {
    kind: "conflict",
    root: "/r/belegpruefer",
    a: "pr:11",
    b: "s:b2",
    title: "#11 ↔ Belege prüfen",
  });
  // Two repos never make a pair
  assert.strictEqual(suggest("conflict #8 #11", data, {}).filter((s) => s.cmd?.kind === "conflict").length, 0);
});

test("The Vim `:` line is the palette: `mode vim` switches, a leading colon is Vim's, `:archive` hides the marks", () => {
  assert.deepStrictEqual(top("mode vim")?.cmd, { kind: "mode", mode: "vim" });
  assert.deepStrictEqual(top(":mode standard")?.cmd, { kind: "mode", mode: "standard" });
  assert.deepStrictEqual(top(":merge 8")?.cmd, { kind: "merge", root: "/r/shop-web", number: 8, anyway: false });
  assert.deepStrictEqual(top(":filter wartet")?.cmd, { kind: "filter", filter: "needs" });
  assert.deepStrictEqual(top(":new beleg")?.cmd, { kind: "new", root: "/r/belegpruefer", prompt: "" });
  assert.deepStrictEqual(top("archive")?.cmd, { kind: "action", action: "hide" });
  // Moving around is no command, undoing a hide is
  assert.ok(!suggest("halbe Seite", data).some((s) => s.action === "halfDown"));
  assert.ok(suggest("rückgängig", data).some((s) => s.cmd?.kind === "action" && s.cmd.action === "undo"));
});

test("arch opens the repo's drawer; tidy cleans up that repo only (release 6: no more 'does not exist yet')", () => {
  assert.deepStrictEqual(top("arch beleg")?.cmd, { kind: "repoDrawer", name: "belegpruefer", tab: "arch" });
  assert.deepStrictEqual(top("tidy shop")?.cmd, { kind: "cleanup", roots: ["/r/shop-web"], name: "shop-web" });
});

test("The week report (stage 10) is a command that works; density went with its switch (stage 12, rule 15)", () => {
  assert.ok(!suggest("density", data, {}).some((s) => /Dichte|Density/.test(`${s.de} ${s.en}`)));
  assert.deepStrictEqual(top("report week")?.cmd, { kind: "report", format: "md" });
  assert.deepStrictEqual(top("report week json")?.cmd, { kind: "report", format: "json" });
});

test("Every key action is a command, found by its name", () => {
  const s = top("Resume-Befehl");
  assert.deepStrictEqual(s?.cmd, { kind: "action", action: "copy" });
  assert.strictEqual(s?.action, "copy");
  assert.deepStrictEqual(top("stummschalten")?.cmd, { kind: "action", action: "mute" });
});

test("LOG opens the log view (stage 11), listed once, with its key", () => {
  for (const q of ["LOG", "log", "Log-Sicht"]) assert.deepStrictEqual(top(q)?.cmd, { kind: "action", action: "log" });
  assert.strictEqual(top("LOG")?.action, "log");
  assert.strictEqual(
    suggest("log", data, {}, 50).filter((s) => s.cmd?.kind === "action" && s.cmd.action === "log").length,
    1,
  );
});

test("Often used suggestions come first among equally good ones", () => {
  const empty = suggest("", data, {}, 50);
  assert.ok(empty.length > 10);
  const used = { "go:/usage": 9, "cmd:merge": 3 };
  const ranked = suggest("", data, used, 50);
  assert.strictEqual(ranked[0]?.id, "go:/usage");
  assert.strictEqual(ranked[1]?.id, "cmd:merge");
  // Use never beats a better match
  assert.strictEqual(top("REP", { "go:/usage": 99 })?.id, "go:/repos");
  // Garbage counts are ignored
  assert.doesNotThrow(() => suggest("", data, { x: Number.NaN } as Record<string, number>));
});

test("new <name>: a name no repo has is a new folder under the projects folder (release 6, plan R7)", () => {
  const withDir = { ...data, projectsDir: "/home/ben/code" };
  const top = suggest("new rezepte Baue eine Rezept-App", withDir)[0];
  assert.deepStrictEqual(top?.cmd, { kind: "newFolder", name: "rezepte", prompt: "Baue eine Rezept-App" });
  assert.match(top?.de || "", /^Neuer Ordner \/home\/ben\/code\/rezepte: Baue/);
  // An exact repo name stays the repo; a name with a path or a leading dot is no folder.
  const repo = data.repos[0]?.name || "";
  assert.ok(!suggest(`new ${repo}`, withDir).some((s) => s.cmd?.kind === "newFolder"));
  for (const bad of ["new ../x", "new .hidden", "new a/b"])
    assert.ok(!suggest(bad, withDir).some((s) => s.cmd?.kind === "newFolder"), bad);
  // Without a projects folder from the server there is no such offer.
  assert.ok(!suggest("new rezepte", data).some((s) => s.cmd?.kind === "newFolder"));
});

test("Round 6: every open PR is suggested once, also when several checkouts of its repo know it", async () => {
  const { paletteData } = await import("../components/screen/cmdline");
  const { buildOverview } = await import("../../server/core/overview");
  const { loadConfig } = await import("../../server/core/config");
  const { demoSources } = await import("../../server/core/demo");
  const o = await buildOverview(
    { ...loadConfig(), cloudSessions: [], extraRepos: [], hiddenProjects: [], _warnings: [] },
    { version: "test", demo: true, sources: demoSources() },
  );
  const prs = paletteData(o).prs;
  const keys = prs.map((p) => `${p.repo}#${p.number}`);
  assert.strictEqual(new Set(keys).size, keys.length, keys.join(", "));
  assert.ok(keys.includes("docs-site#14"));
});

test("Round 7: the language command is found by its name in both languages, and each area is listed once", () => {
  for (const q of ["Sprache", "language", "lang"]) {
    const hit = suggest(q, data).find((x) => x.id === "cmd:lang");
    assert.ok(hit, q);
    assert.strictEqual(hit.fill, "lang ", q);
  }
  for (const q of ["", "u", "usage", "verbrauch", "re"]) {
    const ids = suggest(q, data, {}, 100).map((x) => x.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${q}: ids repeat`);
    const areas = suggest(q, data, {}, 100).filter((x) => x.cmd?.kind === "go" && x.cmd.to === "/usage");
    assert.ok(areas.length <= 1, `${q}: usage twice`);
  }
  assert.deepStrictEqual(top("aktivitaet")?.cmd, { kind: "go", to: "/activity" });
});
