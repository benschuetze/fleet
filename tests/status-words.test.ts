// One status word per session in every view (practical test 15 Oct: data-pipeline was "Dein Ja" on Now and
// "arbeitet" on Repos; mobile-app "Fleet hat angehalten" on Now and "keine Rückmeldung" on usage; a group of two
// finished sessions said "alle warten"). The word comes from the place on Now, never from the raw status.
import assert from "node:assert";
import { afterAll, beforeAll, test } from "vitest";
import { groupState, nowLines, placeLabel } from "../app/lib/session";
import { inbox, places, waitKind } from "../shared/inbox";
import { nowForStream, stateChanges } from "../shared/stream";
import type { Overview } from "../shared/types";
import { startServer } from "./helpers/server";

const t = (de: string) => de;
let srv: Awaited<ReturnType<typeof startServer>>;
let o: Overview;
beforeAll(async () => {
  srv = await startServer({ args: ["--demo"] });
  o = JSON.parse((await srv.request("/api/overview")).body) as Overview;
});
afterAll(() => srv.stop());

test("a session Fleet holds a question for waits, whatever its raw status", () => {
  const where = places(inbox(o));
  for (const d of (o.decisions || []).filter((x) => x.status === "open")) {
    const s = o.sessions.find((x) => x.id === d.sessionId);
    assert.ok(s);
    assert.strictEqual(where.get(s.id), "decision");
    assert.strictEqual(placeLabel(where.get(s.id), s, t).label, "wartet auf dich", `${s.id} (${s.status})`);
  }
});

test("every session's word matches its place: waiting, error, working, done, resting", () => {
  const where = places(inbox(o));
  const want: Record<string, RegExp> = {
    decision: /^wartet auf dich$/,
    needs: /^wartet auf dich$/,
    errors: /^(Fehler|keine Rückmeldung)$/,
    working: /^arbeitet$/,
    done: /^fertig$/,
    resting: /^ruht$/,
    archive: /^archiviert$/,
    replaced: /^abgelöst$/,
  };
  for (const s of o.sessions) {
    const p = where.get(s.id);
    if (!p) continue;
    assert.match(placeLabel(p, s, t).label, want[p] as RegExp, `${s.id} at ${p}`);
  }
});

test("a group says how its sessions stand in the words of Now", () => {
  const where = new Map([
    ["a", "done"],
    ["b", "done"],
    ["c", "working"],
    ["d", "needs"],
  ] as const);
  assert.strictEqual(groupState(["a", "b"], where, t), "alle fertig");
  assert.strictEqual(groupState(["a", "c"], where, t), "1 arbeitet, 1 fertig");
  assert.strictEqual(groupState(["d", "c", "a"], where, t), "1 wartet, 1 arbeitet, 1 fertig");
});

test("why it waits: the demo's tool approval is an approval, a sentence that wants a yes is a question", () => {
  const w = (title: string) => o.sessions.find((s) => s.title === title)?.waits;
  assert.strictEqual(w("Rundung im Warenkorb korrigieren"), "approval");
  assert.strictEqual(w("Eitplanken-Aufträge Guardrails"), "question");
  assert.strictEqual(w("Doku für Farb-Tokens"), "question");
  const where = places(inbox(o));
  const cart = o.sessions.find((s) => s.title === "Rundung im Warenkorb korrigieren");
  assert.ok(cart);
  assert.strictEqual(placeLabel(where.get(cart.id), cart, t, waitKind(cart)).label, "wartet · Freigabe");
});

test("the history's newest line of a session that waits or failed says so (rounds 3 and 4: DONE/SESSION ENDED beside ? and ✗)", () => {
  const where = places(inbox(o));
  const now = nowLines(o.events, (id) => where.get(id));
  for (const s of o.sessions.filter((x) => ["needs", "decision", "errors"].includes(String(where.get(x.id))))) {
    const newest = o.events.filter((e) => e.sessionId === s.id).sort((a, b) => b.at - a.at)[0];
    if (!newest) continue;
    const says = newest.event === "Notification" || newest.event === "PermissionRequest" || newest.status === "error";
    if (says && where.get(s.id) !== "errors") continue;
    if (where.get(s.id) === "errors" && newest.status === "error") continue;
    assert.ok(now.has(newest), `${s.id}: ${newest.event} at ${newest.at}`);
  }
  for (const e of now.keys()) {
    const newer = o.events.some((x) => x.sessionId === e.sessionId && x.at > e.at);
    assert.ok(!newer, `${e.sessionId}: only the newest line`);
  }
});

test("the stream ends with the place on Now: a session Fleet holds a question for waits there too (round 4: ● beside WAITS)", () => {
  const where = places(inbox(o));
  const items = stateChanges(o.events, 400, nowForStream(o));
  for (const s of o.sessions) {
    const p = where.get(s.id);
    const last = items.filter((i) => i.sessionId === s.id).sort((a, b) => b.at - a.at)[0];
    if (!last) continue;
    if (p === "needs" || p === "decision") assert.strictEqual(last.status, "needs_input", `${s.id} (${p})`);
    if (p === "errors") assert.ok(last.status === "error" || last.status === "stale", `${s.id}: ${last.status}`);
  }
});

test("Round 5: the history names why a session ended in words, unknown reasons stay as sent", async () => {
  const { endReason } = await import("../app/components/activity/ledger");
  const t = (de: string) => de;
  assert.strictEqual(endReason({ event: "SessionEnd", detail: "logout" }, t), "abgemeldet");
  assert.strictEqual(endReason({ event: "SessionEnd", detail: "something_new" }, t), null);
  assert.strictEqual(endReason({ event: "Stop", detail: "logout" }, t), null);
});

test("Activity log: a permission request's wait word comes from its kind, not from its words (review #145)", async () => {
  const { eventWait } = await import("../app/components/activity/ledger");
  const base = { at: 1, sessionId: "s", event: "PermissionRequest", status: "needs_input" as const, cwd: "/p" };
  assert.strictEqual(eventWait({ ...base, detail: "Soll die Datei rot heißen", waits: "question" }), "question");
  assert.strictEqual(eventWait({ ...base, detail: "Freigabe für Bash: echo ok?", waits: "approval" }), "approval");
  // Lines written before the kind was logged keep the old reading.
  assert.strictEqual(eventWait({ ...base, detail: "Freigabe für AskUserQuestion" }), "question");
  assert.strictEqual(eventWait({ ...base, detail: "Freigabe für Bash" }), "approval");
  assert.strictEqual(eventWait({ ...base, event: "Notification", detail: "x" }), null);
});
