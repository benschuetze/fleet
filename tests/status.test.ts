// Status without hooks, context window, prices, usage: bugs found while testing with real sessions.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { cacheState } from "../server/core/cache";
import { parseShortstat } from "../server/core/result";
import { parseFull } from "../server/core/sessions";
import { contextFor, deriveStatus, waitsFor } from "../server/core/status";
import { collectUsage, costOf, priceFor } from "../server/core/usage";
import type { Config, Session } from "../shared/types";

process.env.CLAUDE_FLEET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-home-"));

const cfg = { staleMinutes: 20, contextWindow: 0 } as Pick<Config, "staleMinutes" | "contextWindow">;
const line = (o: object) => `${JSON.stringify(o)}\n`;
const T = "2026-10-12T10:00:00Z";

/** Schreibt ein Transcript und liest es wie der Server. */
async function parse(lines: object[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-st-"));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, lines.map(line).join(""));
  return (await parseFull(f, fs.statSync(f))).data;
}
const prompt = (text: string) => ({ type: "user", cwd: "/p", timestamp: T, message: { role: "user", content: text } });
const say = (text: string, stop = "end_turn") => ({
  type: "assistant",
  timestamp: T,
  message: { model: "claude-opus-5-5", stop_reason: stop, content: [{ type: "text", text }] },
});
const call = (id: string, name = "Bash", input: object = { command: "pnpm test" }) => ({
  type: "assistant",
  timestamp: T,
  message: { model: "claude-opus-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, isError = false) => ({
  type: "user",
  timestamp: T,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "Exit code 1" : "ok" }],
  },
});

test("Transcript: abgeschlossener Turn wird erkannt", async () => {
  const d = await parse([prompt("Baue X"), call("t1"), result("t1"), say("Fertig, bitte prüfen.")]);
  assert.strictEqual(d.turn, "done");
});

test("Transcript: offener Werkzeugaufruf und Abbruch", async () => {
  assert.strictEqual((await parse([prompt("Baue X"), call("t1")])).turn, "tool_pending");
  assert.strictEqual((await parse([prompt("Baue X"), call("t1"), result("t1")])).turn, "running");
  const interrupted = await parse([
    prompt("Baue X"),
    call("t1"),
    {
      type: "user",
      timestamp: T,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
  ]);
  assert.strictEqual(interrupted.turn, "interrupted");
  assert.strictEqual(interrupted.lastPrompt, "Baue X", "der Abbruch ist kein neuer Auftrag");
});

test("Ohne Hooks: fertige Session wartet auf dich, statt still zu „ruhen“", async () => {
  const now = Date.parse(T) + 12 * 60e3; // 12 Minuten nach dem letzten Eintrag
  const s = { id: "s", source: "local", mtime: Date.parse(T), lastTimestamp: Date.parse(T), turn: "done" } as Session;
  deriveStatus(s, cfg, now);
  assert.strictEqual(s.status, "waiting");
  assert.strictEqual(s.statusSource, "transcript");
});

test("Ohne Hooks: lang laufendes Werkzeug arbeitet noch, nach staleMinutes „hängt?“", () => {
  const at = Date.parse(T);
  const s = {
    id: "s",
    source: "local",
    mtime: at,
    lastTimestamp: at,
    turn: "tool_pending",
    lastTool: "Bash",
  } as Session;
  deriveStatus(s, cfg, at + 5 * 60e3);
  assert.strictEqual(s.status, "working");
  assert.match(String(s.detail), /Bash/);
  deriveStatus(s, cfg, at + 25 * 60e3);
  assert.strictEqual(s.status, "stale");
});

test("Ohne Hooks: Turn ohne Ende arbeitet, nach staleMinutes ist er ein Fehler, nach 24 h ruht er", () => {
  // Before: after 2 minutes "resting", so a long thinking step or a crashed process looked like a quiet session
  const at = Date.parse(T);
  const s = { id: "s", source: "local", mtime: at, lastTimestamp: at, turn: "running", lastTool: "Bash" } as Session;
  deriveStatus(s, cfg, at + 5 * 60e3);
  assert.strictEqual(s.status, "working");
  deriveStatus(s, cfg, at + 25 * 60e3);
  assert.strictEqual(s.status, "stale");
  assert.strictEqual(s.failure?.kind, "stuck");
  assert.match(String(s.detail), /seit 25 Min keine Rückmeldung \(zuletzt Bash\)/);
  deriveStatus(s, cfg, at + 25 * 3600e3);
  assert.deepStrictEqual([s.status, s.failure], ["idle", null], "no alarm older than a day");
});

test("Mit Hook: „arbeitet“ ohne Lebenszeichen wird „stale“ und ruht nach 24 h (lief bisher nie ab)", () => {
  const at = Date.parse(T);
  const s = () =>
    ({
      id: "s",
      source: "local",
      mtime: at,
      lastTimestamp: at,
      hook: { status: "working", event: "PostToolUse", detail: "Bash", at, statusSince: at },
    }) as Session;
  const a = s();
  deriveStatus(a, cfg, at + 30 * 60e3);
  assert.strictEqual(a.status, "stale");
  const b = s();
  deriveStatus(b, cfg, at + 30 * 3600e3);
  assert.strictEqual(b.status, "idle");
});

test("Hook-Status hat Vorrang vor der Schätzung aus dem Transcript", () => {
  const at = Date.parse(T);
  const s = {
    id: "s",
    source: "local",
    mtime: at,
    lastTimestamp: at,
    turn: "done",
    hook: { status: "needs_input", at: at + 1000, detail: "Freigabe für Bash", statusSince: at + 1000 },
  } as Session;
  deriveStatus(s, cfg, at + 60e3);
  assert.deepStrictEqual([s.status, s.statusSource], ["needs_input", "hook"]);
});

test("Kontextfenster: aktuelle Modelle haben 1 Mio. Tokens, nicht 200 Tsd.", () => {
  // 176 Tsd. Tokens in Opus 5.5 sind 17,6 %, keine Warnung über 80 %
  assert.strictEqual(contextFor(176000, "claude-opus-5-5", cfg).size, 1000000);
  assert.strictEqual(contextFor(176000, "claude-opus-5-5", cfg).pct, 17.6);
  for (const m of ["claude-fable-5-1", "claude-sonnet-5-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-5-5"])
    assert.strictEqual(contextFor(1000, m, cfg).size, 1000000, m);
  for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"])
    assert.strictEqual(contextFor(1000, m, cfg).size, 200000, m);
  assert.strictEqual(contextFor(1000, "claude-opus-5-5", { contextWindow: 500000 }).size, 500000, "Config gewinnt");
  assert.strictEqual(contextFor(300000, "unbekannt", cfg).size, 1000000, "mehr als 200 Tsd. geht nur mit 1 Mio.");
});

test("Preise: Haiku 5.5 und Fable 5.1 nach aktueller Preisliste", () => {
  assert.deepStrictEqual(priceFor("claude-haiku-5-5"), { i: 0.1, o: 0.5, cr: 0.01 });
  assert.deepStrictEqual(priceFor("claude-haiku-4-5"), { i: 1, o: 5, cr: 0.1 });
  assert.deepStrictEqual(priceFor("claude-fable-5-1"), { i: 10, o: 50, cr: 0.25 });
  assert.deepStrictEqual(priceFor("claude-sonnet-5-5"), { i: 2, o: 10, cr: 0.2 });
  assert.deepStrictEqual(priceFor("Opus 5.5"), priceFor("claude-opus-5-5"), "Anzeigename aus der Statuszeile");
  // Haiku 5.5 kostet über 100 Tsd. Tokens Prompt das Fünffache
  const big = { i: 10, o: 1000, cw: 0, cr: 150000, cw1h: 0 };
  assert.ok(Math.abs(costOf(big, "claude-haiku-5-5") - (10 * 0.5 + 1000 * 2.5 + 150000 * 0.05) / 1e6) < 1e-12);
});

test("Schleife: derselbe Werkzeugaufruf immer wieder wird erkannt", async () => {
  const lines: object[] = [prompt("Fix den Test")];
  for (let i = 0; i < 5; i++) lines.push(call(`r${i}`, "Bash", { command: "pnpm test login" }), result(`r${i}`, true));
  const d = await parse(lines);
  assert.deepStrictEqual(d.loop, { kind: "repeat", tool: "Bash", count: 5 });
});

test("Schleife: Fehlerserie mit wechselnden Eingaben wird erkannt", async () => {
  const lines: object[] = [prompt("Fix den Build")];
  for (let i = 0; i < 4; i++)
    lines.push(call(`e${i}`, "Bash", { command: `pnpm build --try ${i}` }), result(`e${i}`, true));
  assert.deepStrictEqual((await parse(lines)).loop, { kind: "errors", tool: "Bash", count: 4 });
});

test("Schleife: normale Arbeit und ein neuer Auftrag lösen keinen Alarm aus", async () => {
  const lines: object[] = [prompt("Baue X")];
  for (let i = 0; i < 6; i++) lines.push(call(`n${i}`, "Read", { file_path: `/p/f${i}.js` }), result(`n${i}`));
  lines.push(
    call("x1", "Bash", { command: "pnpm test" }),
    result("x1", true),
    call("x2", "Bash", { command: "pnpm test" }),
    result("x2"),
  );
  assert.strictEqual((await parse(lines)).loop, null);
  const again: object[] = [prompt("Fix")];
  for (let i = 0; i < 5; i++) again.push(call(`r${i}`, "Bash", { command: "pnpm test" }), result(`r${i}`, true));
  again.push(prompt("Lass das, mach etwas anderes"));
  assert.strictEqual((await parse(again)).loop, null);
});

test("Verbrauch: Cache-Trefferquote je Session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cache-"));
  const dir = path.join(home, "projects", "-p");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const msg = (id: string, usage: object) =>
    line({ type: "assistant", timestamp: now, message: { id, model: "claude-opus-5-5", usage } });
  // 1. Aufruf schreibt 10 Tsd. in den Cache, 2. und 3. lesen je 10 Tsd. → 20 von 30 Tsd. Prompt-Tokens aus dem Cache
  fs.writeFileSync(
    path.join(dir, "c1.jsonl"),
    msg("a", { input_tokens: 0, cache_creation_input_tokens: 10000, output_tokens: 5 }) +
      msg("b", { input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 5 }) +
      msg("c", { input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 5 }),
  );
  const u = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 7, prices: {} });
  assert.strictEqual(u.perSession.c1?.cacheRate, 0.6667);
  assert.strictEqual(u.usage?.totals.today.cacheRate, 0.6667);
});

test("Verbrauch: Neuschreiben nach Komprimierung ist kein verfallener Cache", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-rebuild-"));
  const dir = path.join(home, "projects", "-p");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const msg = (id: string, cw: number, cr: number) =>
    line({
      type: "assistant",
      timestamp: now,
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 5, output_tokens: 50, cache_creation_input_tokens: cw, cache_read_input_tokens: cr },
      },
    });
  fs.writeFileSync(
    path.join(dir, "r1.jsonl"),
    msg("a", 300000, 40000) +
      msg("b", 2000, 340000) +
      msg("c", 380000, 40000) + // Pause: Cache weg, alles neu geschrieben
      line({ type: "system", subtype: "compact_boundary", timestamp: now }) +
      msg("d", 90000, 40000) + // nach der Komprimierung: neuer, kurzer Kontext
      msg("e", 1500, 130000),
  );
  const u = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 7, prices: {} });
  assert.strictEqual(u.perSession.r1?.rebuilds, 1);
});

test("Live: Tokens und Kosten pro Minute der letzten Stunde je Session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-live-"));
  const dir = path.join(home, "projects", "-p");
  fs.mkdirSync(dir, { recursive: true });
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60e3).toISOString();
  const msg = (id: string, minsAgo: number, out: number) =>
    line({
      type: "assistant",
      timestamp: at(minsAgo),
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 1000 },
      },
    });
  fs.writeFileSync(
    path.join(dir, "l1.jsonl"),
    msg("a", 90, 500) + msg("b", 30.5, 1000) + msg("c", 0.2, 2000) + msg("d", 0.1, 3000),
  );
  const u = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 7, prices: {} });
  const live = u.usage?.live;
  assert.ok(live);
  assert.strictEqual(live.minutes, 60);
  const s = live.bySession.l1;
  assert.ok(s);
  assert.strictEqual(s.tok.length, 60);
  assert.strictEqual(s.tok[59], 5000, "letzte Minute: beide Antworten");
  assert.strictEqual(s.tok[29], 1000, "vor einer halben Stunde");
  assert.strictEqual(
    s.tok.reduce((a, b) => a + b, 0),
    6000,
    "älter als eine Stunde fällt heraus",
  );
  assert.ok((s.cost[59] ?? 0) > 0);
});

test("Limit ohne Statuszeile: nur der echte Treffer aus dem Transcript, keine geschätzten Prozent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-lim-"));
  const dir = path.join(home, "projects", "-p");
  fs.mkdirSync(dir, { recursive: true });
  const H = 3600e3;
  const now = Date.now();
  const at = (t: number) => new Date(t).toISOString();
  const spend = (id: string, t: number, usd: number) =>
    line({
      type: "assistant",
      timestamp: at(t),
      message: { id, model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: usd * 50000 } },
    });
  const hit = (t: number, resetsAt: number) =>
    line({
      type: "assistant",
      timestamp: at(t),
      isApiErrorMessage: true,
      quotaLimits: { status: "rejected", resetsAt: Math.floor(resetsAt / 1000), rateLimitType: "five_hour" },
      message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] },
    });
  // frühere Treffer: Grundlage der alten Schätzung, heute ohne Wirkung
  const s0 = [30, 40, 40, 60]
    .map((usd, k) => {
      const start = now - (3 + k) * 24 * H;
      return spend(`h${k}`, start + H, usd) + hit(start + 2 * H, start + 5 * H);
    })
    .join("");
  fs.writeFileSync(path.join(dir, "l.jsonl"), s0 + spend("cur", now - H, 18));
  fs.writeFileSync(path.join(home, "limit-estimate.json"), '{"used_percentage":80}');
  const u = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 30, prices: {} });
  assert.strictEqual(u.usage?.limits, null, "ohne Statuszeile keine Prozentwerte");
  assert.strictEqual(u.usage?.limitHit, null, "alte Treffer sind vorbei");
  assert.ok(!fs.existsSync(path.join(home, "limit-estimate.json")), "alte Schätzung für den Hook ist weg");
  assert.strictEqual(u.usage?.block?.tok, 18 * 50000, "Tokens im Fenster stimmen genau");

  // Jetzt erreicht: Zeitpunkt und Reset genau so, wie Claude Code sie meldet
  const reset = Math.floor((now + 2 * H) / 1000) * 1000;
  fs.appendFileSync(path.join(dir, "l.jsonl"), hit(now - 10 * 60e3, reset) + spend("extra", now - 5 * 60e3, 1));
  const v = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 30, prices: {} });
  assert.deepStrictEqual(v.usage?.limitHit, { kind: "five_hour", at: now - 10 * 60e3, resetsAt: reset });
  assert.strictEqual(v.usage?.limits, null, "auch nach dem Treffer keine erfundenen Prozent");

  // Gemeldet: das Wochenlimit war erreicht, Fleet zeigte nichts (nur 5-Stunden-Treffer ausgewertet)
  const week = Math.floor((now + 4 * 24 * H) / 1000) * 1000;
  fs.appendFileSync(
    path.join(dir, "l.jsonl"),
    line({
      type: "assistant",
      timestamp: at(now - 5 * 60e3),
      isApiErrorMessage: true,
      quotaLimits: { status: "rejected", resetsAt: week / 1000, rateLimitType: "seven_day" },
      message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your weekly limit" }] },
    }),
  );
  const w = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 30, prices: {} });
  assert.deepStrictEqual(
    w.usage?.limitHit,
    { kind: "seven_day", at: now - 5 * 60e3, resetsAt: week },
    "die Woche gilt, ihr Reset kommt später",
  );

  // Live 16.10.2026: a newer status line says 91 % in the same week, sessions work: the old hit is over.
  fs.mkdirSync(path.join(home, "statusline"), { recursive: true });
  const status = (pct: number, t: number) =>
    fs.writeFileSync(
      path.join(home, "statusline", "s.json"),
      JSON.stringify({
        sessionId: "s",
        at: t,
        rateLimits: { seven_day: { used_percentage: pct, resets_at: week / 1000 } },
      }),
    );
  status(91, now);
  const x = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 30, prices: {} });
  assert.strictEqual(x.usage?.limitHit, null, "die neuere Messung gilt");
  // An older status line does not undo a newer hit.
  status(91, now - 60 * 60e3);
  const y = await collectUsage({ claudeHome: home, _fleetHome: home, statsDays: 30, prices: {} });
  assert.strictEqual(y.usage?.limitHit?.kind, "seven_day", "eine ältere Messung hebt den Treffer nicht auf");
});

test("Cache-Countdown: Laufzeit aus dem Transcript, Restzeit ab dem letzten Aufruf", async () => {
  const at = Date.parse(T);
  const use = (cc: object) => ({
    type: "assistant",
    timestamp: T,
    message: {
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "fertig" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 199990, cache_creation_input_tokens: 0, cache_creation: cc },
    },
  });
  const h1 = await parse([prompt("los"), use({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 })]);
  assert.strictEqual(h1.cacheTtl, "1h");
  const m5 = await parse([prompt("los"), use({ ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 })]);
  assert.strictEqual(m5.cacheTtl, "5m");
  const c = cacheState({ ttl: h1.cacheTtl, at: h1.ctx?.at, tokens: 200000, model: "claude-opus-5-5" });
  assert.strictEqual(c?.until, at + 3600e3, "eine Stunde ab dem letzten Aufruf");
  assert.ok(c && c.rebuild > 0, "nennt, was der Neuaufbau kostet");
  assert.strictEqual(cacheState({ ttl: "5m", at: null, tokens: 1, model: null }), null);
});

test("Ergebnis: letzter Testlauf aus dem Transcript, Git-Statistik gelesen", async () => {
  const run = (id: string, command: string) => call(id, "Bash", { command });
  const d = await parse([
    prompt("los"),
    run("t1", "pnpm test"),
    result("t1", true),
    run("b1", "ls"),
    result("b1"),
    run("t2", "cd app && pnpm check"),
    result("t2"),
  ]);
  assert.deepStrictEqual(
    [d.testRun?.cmd, d.testRun?.ok],
    ["cd app && pnpm check", true],
    "der letzte Testlauf zählt, nicht der rote davor",
  );
  const red = await parse([prompt("los"), run("t1", "npx vitest run"), result("t1", true)]);
  assert.strictEqual(red.testRun?.ok, false);
  const none = await parse([prompt("los"), run("b1", "git status"), result("b1")]);
  assert.strictEqual(none.testRun ?? null, null, "kein Testbefehl, keine Aussage");
  assert.deepStrictEqual(parseShortstat(" 7 files changed, 312 insertions(+), 41 deletions(-)"), {
    files: 7,
    add: 312,
    del: 41,
  });
  assert.deepStrictEqual(parseShortstat(" 1 file changed, 1 insertion(+)"), { files: 1, add: 1, del: 0 });
});

test("Ergebnis: nur eigene Commits der Session, Heredoc-Text ist kein Testlauf", async () => {
  // Gemeldet: Eine Session, die nichts geändert hat, zeigte 7 Commits anderer Sessions
  const run = (id: string, command: string) => call(id, "Bash", { command });
  const out = (id: string, text: string) => ({
    type: "user",
    timestamp: T,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: text }] },
  });
  const d = await parse([
    prompt("los"),
    run("c1", 'git add -A && git commit -qm "feat: x"'),
    out("c1", "[feat/x 1a2b3c4] feat: x\n 2 files changed"),
    run("c2", 'git commit -m "fix: y"'),
    out("c2", "[main (root-commit) 9f8e7d6] fix: y"),
    run("h1", "python3 - <<'EOF'\nprint('pnpm test')\nEOF"),
    out("h1", "ok"),
  ]);
  assert.deepStrictEqual(d.commits, ["1a2b3c4", "9f8e7d6"]);
  assert.strictEqual(d.testRun ?? null, null, "Text im Heredoc zählt nicht als Testlauf");
  const idle = await parse([prompt("schau nur"), run("l1", "git log --oneline"), out("l1", "abc1234 irgendwas")]);
  assert.strictEqual(idle.commits, undefined, "wer nicht committet, hat keine Commits");
  const quiet = await parse([prompt("los"), run("q1", 'git commit -qm "chore: z"'), out("q1", "")]);
  assert.deepStrictEqual(quiet.commitAt, [Date.parse(T)], "git commit -q: Zeitpunkt statt ID");
});

test("Werkzeug, das in der App auf dich wartet, „wartet auf dich“ statt „hängt?“", () => {
  // Gemeldet: „Change Directory“ wartete 20 Minuten auf eine Erlaubnis und stand als „keine Rückmeldung – hängt?“ da
  const at = Date.parse(T);
  for (const tool of [
    "mcp__ccd_directory__change_directory",
    "AskUserQuestion",
    "ExitPlanMode",
    "mcp__computer-use__request_access",
  ]) {
    const s = {
      id: "s",
      source: "local",
      mtime: at,
      lastTimestamp: at,
      hook: { status: "working", event: "PreToolUse", detail: tool, lastTool: tool, at, statusSince: at },
    } as Session;
    deriveStatus(s, cfg, at + 25 * 60e3);
    assert.strictEqual(s.status, "needs_input", tool);
    assert.match(String(s.detail), tool === "ExitPlanMode" ? /Plan freigeben/ : /wartet in der App auf dich/);
  }
  const busy = {
    id: "s",
    source: "local",
    mtime: at,
    lastTimestamp: at,
    hook: { status: "working", event: "PreToolUse", detail: "Bash", lastTool: "Bash", at, statusSince: at },
  } as Session;
  deriveStatus(busy, cfg, at + 25 * 60e3);
  assert.strictEqual(busy.status, "stale", "ein langer Befehl darf weiter „keine Rückmeldung“ heißen");
});

/* ---------- Waits for you: a question or a request for a yes at the end of the turn ---------- */

const statusOf = async (lines: object[], hook?: Partial<NonNullable<Session["hook"]>>, ago = 60e3) => {
  const d = await parse(lines);
  const at = Date.parse(T);
  const s = {
    ...d,
    source: "local",
    mtime: at,
    hook: hook
      ? ({ at, statusSince: at, detail: "", event: "Stop", status: "waiting", ...hook } as Session["hook"])
      : null,
  } as Session;
  deriveStatus(s, cfg, at + ago);
  return s;
};

test("Eitplanken: „… an der ersten Stelle, an der ich dein Ja brauche.“ zählt als wartet, nicht als fertig", async () => {
  const text = "Plan steht. Ich mache weiter bis an der ersten Stelle, an der ich dein Ja brauche.";
  const s = await statusOf([prompt("Leitplanken einbauen"), say(text)]);
  assert.strictEqual(s.status, "needs_input");
  assert.match(String(s.detail), /an der ich dein Ja brauche/);
  // The same with the hook only: Stop carries the answer, the transcript has not caught up yet
  const h = await statusOf([prompt("Leitplanken einbauen")], { lastAnswer: text });
  assert.deepStrictEqual([h.status, h.statusSource], ["needs_input", "hook"]);
  assert.match(String(h.detail), /dein Ja brauche/);
});

test("Fragen: wartet; Schluss ohne Handlung: fertig; Frage mit Werkzeugaufruf danach: arbeitet", async () => {
  assert.strictEqual((await statusOf([prompt("x"), say("Soll ich den PR aufmachen?")])).status, "needs_input");
  assert.strictEqual((await statusOf([prompt("x"), say("Shall I open the PR?")])).status, "needs_input");
  assert.strictEqual(
    (await statusOf([prompt("x"), say("Welche Variante?\n- A) jetzt\n- B) später\n- C) nie")])).status,
    "needs_input",
  );
  assert.strictEqual((await statusOf([prompt("x"), say("Fertig. Fragen?")])).status, "waiting");
  assert.strictEqual(
    (await statusOf([prompt("x"), say("Erledigt. Sag Bescheid, wenn ich weitermachen soll.")])).status,
    "waiting",
  );
  assert.strictEqual(
    (await statusOf([prompt("x"), say("Beispiel:\n```\nSoll ich?\nJa oder nein?\n```\nIst eingebaut.")])).status,
    "waiting",
    "a question only in a code block asks nothing",
  );
  // Question, then a tool call in the same turn: it goes on by itself
  const goesOn = await statusOf([prompt("x"), say("Soll ich die Tests auch anpassen?", "tool_use"), call("t9")]);
  assert.strictEqual(goesOn.status, "working");
  // Question, then the user interrupted: done, the question is gone
  const stopped = await statusOf([
    prompt("x"),
    say("Soll ich den PR aufmachen?"),
    {
      type: "user",
      timestamp: T,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
  ]);
  assert.strictEqual(stopped.status, "waiting");
  // A new prompt clears the question
  assert.strictEqual((await parse([prompt("x"), say("Soll ich den PR aufmachen?"), prompt("ja")])).ask, null);
});

/* ---------- Error: API errors in the transcript and from the StopFailure hook ---------- */

const apiError = (text: string, extra: object = {}) => ({
  type: "assistant",
  timestamp: T,
  isApiErrorMessage: true,
  ...extra,
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
});

test("Fehler aus dem Transcript: Limit mit Reset, Anmeldung, Ausgabenlimit, API-Fehler", async () => {
  const reset = Date.parse(T) + 2 * 3600e3;
  const limit = await statusOf([
    prompt("x"),
    apiError("You've hit your session limit · resets 6pm", {
      apiErrorStatus: 429,
      quotaLimits: { status: "rejected", resetsAt: reset / 1000, rateLimitType: "five_hour" },
    }),
  ]);
  assert.deepStrictEqual([limit.status, limit.failure?.kind, limit.failure?.resetsAt], ["error", "limit", reset]);
  assert.match(String(limit.detail), /^Limit erreicht, frei ab \d\d:\d\d$/);

  // Reported: "Failed to authenticate" sat under "resting" (no StopFailure hook, and the session ended)
  const auth = await statusOf(
    [prompt("x"), apiError("Failed to authenticate: OAuth session expired and could not be refreshed")],
    { status: "ended", event: "SessionEnd" },
  );
  assert.deepStrictEqual([auth.status, auth.failure?.kind, auth.detail], ["error", "auth", "Anmeldung abgelaufen"]);

  const spend = await statusOf([
    prompt("x"),
    apiError("You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage"),
  ]);
  assert.deepStrictEqual([spend.failure?.kind, spend.failure?.url], ["spend", "https://claude.ai/settings/usage"]);
  const foreign = await statusOf([
    prompt("x"),
    apiError("You've hit your monthly spend limit · raise it at https://evil.example/claude.ai/"),
  ]);
  assert.strictEqual(foreign.failure?.url, null, "only links to claude.ai");

  const api = await statusOf([prompt("x"), apiError("API Error: 529 Overloaded")]);
  assert.deepStrictEqual([api.failure?.kind, api.detail], ["api", "API-Fehler: 529 Overloaded"]);
  const apiEnded = await statusOf([prompt("x"), apiError("API Error: 529 Overloaded")], {
    status: "ended",
    event: "SessionEnd",
  });
  assert.strictEqual(apiEnded.status, "ended", "a plain API error does not outlast the end of the session");
});

test("Fehler verschwindet, sobald es weitergeht: neuer Auftrag, echte Antwort, neueres Hook-Ereignis", async () => {
  const err = apiError("Failed to authenticate: OAuth session expired");
  assert.strictEqual((await parse([prompt("x"), err, prompt("nochmal")])).failure, null);
  assert.strictEqual((await parse([prompt("x"), err, say("Weiter geht's.")])).failure, null);
  // Several error lines in a row: the last counts
  const two = await parse([prompt("x"), err, apiError("API Error: 500 Internal server error")]);
  assert.strictEqual(two.failure?.kind, "api");
  // Synthetic lines without an error text are no error
  const synth = await parse([
    prompt("x"),
    {
      type: "assistant",
      timestamp: T,
      message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
    },
  ]);
  assert.strictEqual(synth.failure ?? null, null);
  // The hook saw the session working again after the error: it is working
  const d = await parse([prompt("x"), err]);
  const at = Date.parse(T);
  const s = {
    ...d,
    source: "local",
    mtime: at,
    hook: { status: "working", event: "UserPromptSubmit", detail: "", at: at + 5000, statusSince: at + 5000 },
  } as Session;
  deriveStatus(s, cfg, at + 10e3);
  assert.strictEqual(s.status, "working");
});

test("Fehler aus dem StopFailure-Hook: die Art kommt aus dem Fehler-Enum", async () => {
  const kindOf = async (detail: string) =>
    (await statusOf([prompt("x")], { status: "error", event: "StopFailure", detail })).failure?.kind;
  assert.strictEqual(await kindOf("rate_limit: 429 Too Many Requests"), "limit");
  assert.strictEqual(await kindOf("authentication_failed: token expired"), "auth");
  assert.strictEqual(await kindOf("billing_error"), "spend");
  assert.strictEqual(await kindOf("overloaded: 529 Overloaded"), "api");
  const s = await statusOf([prompt("x")], {
    status: "error",
    event: "StopFailure",
    detail: "overloaded: 529 Overloaded",
  });
  assert.strictEqual(s.detail, "API-Fehler: overloaded: 529 Overloaded");
});

/* ---------- Waits for you: the Desktop app's question box and session offer (B1) ---------- */

const BOX = "mcp__ccd_turn__wrap_up";
const OFFER = "mcp__ccd_session__start_session";

test("Frage-Box der Desktop-App (wrap_up mit ask) ist „wartet“, nicht „fertig“", async () => {
  // Reported: 16 of 16 turns that ended with a question box stood as done; the question is never in the text
  const ask = "PR #3 mergen, sobald die CI grün ist?";
  const box = [
    prompt("Baue den Export"),
    call("w1", BOX, { recap: "Export gebaut, PR offen.", ask, actions: [{ label: "Mergen" }] }),
    result("w1"),
    say("PR ist offen, CI läuft."),
  ];
  const s = await statusOf(box);
  assert.deepStrictEqual([s.status, s.ask?.kind, s.ask?.text], ["needs_input", "question", ask]);
  assert.strictEqual(s.detail, ask);
  // The turn may end without any closing text
  const bare = await statusOf(box.slice(0, 3).concat([{ ...say(""), message: { ...say("").message, content: [] } }]));
  assert.strictEqual(bare.status, "needs_input");
  // Another tool call after the box (a follow-up proposal) keeps the question
  const more = await statusOf([
    ...box.slice(0, 3),
    call("p1", OFFER, { initiation: "own_initiative" }),
    result("p1"),
    say("Fertig."),
  ]);
  assert.strictEqual(more.ask?.text, ask);
  // A box without a question is only a recap: done
  const recap = await statusOf([prompt("x"), call("w2", BOX, { recap: "Erledigt." }), result("w2"), say("Erledigt.")]);
  assert.strictEqual(recap.status, "waiting");
  // A closing question in the text wins over the box
  const text = await statusOf([...box.slice(0, 3), say("Soll ich auch den Changelog schreiben?")]);
  assert.strictEqual(text.ask?.text, "Soll ich auch den Changelog schreiben?");
  // The next prompt (the button's answer) clears it
  assert.strictEqual((await parse([...box, prompt("Mergen")])).ask, null);
  // Odd input: not a string, too long
  const odd = await statusOf([prompt("x"), call("w3", BOX, { ask: { no: 1 } }), result("w3"), say("x")]);
  assert.strictEqual(odd.status, "waiting");
  const long = await statusOf([prompt("x"), call("w4", BOX, { ask: `${"a".repeat(500)}?` }), result("w4"), say("x")]);
  assert.ok(String(long.ask?.text).length <= 200);
});

test("Frage-Box nur über den Hook: Stop kommt, bevor das Transcript sie enthält", async () => {
  const s = await statusOf([prompt("x")], { boxAsk: "Branch pushen?" });
  assert.deepStrictEqual([s.status, s.statusSource, s.detail], ["needs_input", "hook", "Branch pushen?"]);
  const odd = await statusOf([prompt("x")], { boxAsk: 5 as unknown as string });
  assert.strictEqual(odd.status, "waiting", "a field of the wrong type asks nothing");
});

test("Angebot „Neue Session oder hier?“ (start_session offer) wartet, eigene Vorschläge nicht", async () => {
  const offer = { initiation: "offer", title: "Bremse kürzen" };
  // Transcript only: the offer waits for the user's click, no tool_result yet
  const s = await statusOf([prompt("x"), call("o1", OFFER, offer)], undefined, 30 * 60e3);
  assert.strictEqual(s.status, "needs_input");
  assert.match(String(s.detail), /Bremse kürzen/);
  const own = await statusOf([prompt("x"), call("o2", OFFER, { initiation: "own_initiative", title: "y" })]);
  assert.strictEqual(own.status, "working", "a proposal card does not block the turn");
  const answered = await statusOf([prompt("x"), call("o3", OFFER, offer), result("o3"), call("b1")]);
  assert.strictEqual(answered.status, "working");
  // Hook: PreToolUse of the offer carries its title
  const h = await statusOf([prompt("x")], {
    status: "working",
    event: "PreToolUse",
    detail: OFFER,
    lastTool: OFFER,
    offer: "Bremse kürzen",
  });
  assert.strictEqual(h.status, "needs_input");
  assert.match(String(h.detail), /Bremse kürzen/);
  const hOwn = await statusOf([prompt("x")], {
    status: "working",
    event: "PreToolUse",
    detail: OFFER,
    lastTool: OFFER,
  });
  assert.strictEqual(hOwn.status, "working");
});

test("Nachricht, die die App einspielt (CI-Monitor, Neben-Sessions, andere Sessions), beantwortet die Frage-Box nicht", async () => {
  // Live case on Fleet 5.0.0: a CI event seconds after the box turned the waiting session into "done"
  const ask = "PR #3 mergen, sobald die CI grün ist?";
  const box = [prompt("Baue den Export"), call("w1", BOX, { recap: "PR offen.", ask }), result("w1"), say("PR offen.")];
  const injected = [
    "<ci-monitor-event>CI für PR #3: 2 von 5 Checks fertig</ci-monitor-event>",
    "<side-sessions-event>Session export-tests hat ihren Turn beendet</side-sessions-event>",
    '<cross-session-message from="local_abc">Bitte Port 5199 freigeben</cross-session-message>',
    "<task-notification>Hintergrundbefehl beendet</task-notification>",
  ];
  for (const text of injected) {
    const auto = [...box, prompt(text)];
    const mid = await parse(auto);
    assert.strictEqual(mid.turn, "running", `${text}: the auto-turn may show as working`);
    assert.strictEqual(mid.lastPrompt, "Baue den Export", `${text}: never the task text (B8)`);
    const s = await statusOf([...auto, say("CI läuft noch.")]);
    assert.deepStrictEqual([s.status, s.ask?.text], ["needs_input", ask], `${text}: the question waits again`);
    const tools = await statusOf([...auto, call("g1", "Bash", { command: "gh pr checks 3" }), result("g1"), say("")]);
    assert.strictEqual(tools.ask?.text, ask, `${text}: tool calls in the auto-turn keep it`);
  }
  // The auto-turn ends with a new box: the new question wins
  const again = await statusOf([
    ...box,
    prompt(injected[0] as string),
    call("w2", BOX, { recap: "CI grün.", ask: "Jetzt mergen?" }),
    result("w2"),
    say("CI ist grün."),
  ]);
  assert.strictEqual(again.ask?.text, "Jetzt mergen?");
  // The user's own answer still clears it
  assert.strictEqual((await parse([...box, prompt(injected[0] as string), say("x"), prompt("Mergen")])).ask, null);
});

test("waitsFor: a question or plan the app holds is answered in words, a tool call with a yes (live 16.10.2026)", () => {
  const held = (key: string) =>
    ({ status: "needs_input", hook: { status: "needs_input", waitFor: [{ key, since: 0 }] } }) as unknown as Session;
  assert.strictEqual(waitsFor(held("AskUserQuestion:a1")), "question");
  assert.strictEqual(waitsFor(held("ExitPlanMode:b2")), "question");
  assert.strictEqual(waitsFor(held("Bash:c3")), "approval");
});
