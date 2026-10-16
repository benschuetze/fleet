// "Waits for you" vs. "done": a turn that ends with a question or a request for a yes waits for a decision.
import assert from "node:assert";
import { test } from "vitest";
import { detectAsk } from "../server/core/ask";

const waits = (text: string, kind?: "question" | "approval") => {
  const a = detectAsk(text);
  assert.ok(a, `should wait: ${text}`);
  if (kind) assert.strictEqual(a.kind, kind, text);
  return a;
};
const done = (text: string) => assert.strictEqual(detectAsk(text), null, `should be done: ${text}`);

test("Eitplanken: „an der ersten Stelle, an der ich dein Ja brauche“ wartet, auch ohne Fragezeichen", () => {
  const a = waits(
    "Plan steht: vier Leitplanken. Ich mache weiter bis an der ersten Stelle, an der ich dein Ja brauche.",
    "approval",
  );
  assert.match(a.text, /dein Ja brauche/);
  waits("The plan is ready. I stop here, at the first point where I need your yes.", "approval");
});

test("Fragen am Schluss warten, Deutsch und Englisch", () => {
  assert.strictEqual(
    waits("Doku ist fertig. Soll ich den PR aufmachen?", "question").text,
    "Soll ich den PR aufmachen?",
  );
  waits("Docs are done. Shall I open the PR?", "question");
  waits("**Soll ich den PR aufmachen?**");
  waits(
    "Zwei Wege sind möglich. Welchen nehmen wir?\n\n- A) Migration jetzt\n- B) erst nach dem Release\n- C) gar nicht",
  );
});

test("Freigabe-Sätze ohne Fragezeichen warten", () => {
  for (const t of [
    "Bevor ich die Tabelle lösche, brauche ich deine Freigabe.",
    "Bitte bestätige, dann pushe ich.",
    "Weiter? (y/n)",
    "Antworte mit y/n.",
    "Antworte mit y/n, dann lösche ich die Branches.",
    "Proceed [y/N]",
    "Löschen? ja/nein",
    "Ich warte hier. Do you want me to run the migration",
    "Waiting for your go-ahead before I deploy.",
    "Which option do you prefer: A or B.",
  ])
    waits(t);
});

test("Ohne Handlungsbedarf ist die Session fertig", () => {
  // A waiting sentence that is optional, denied or quoted asks nothing (review 16.10.2026).
  done("Falls du magst, wartet der Branch auf dich. Ich habe alles gepusht. CI ist grün.");
  done("Erledigt: Nichts wartet mehr auf dich. Der PR ist gemergt. Tests grün. Release ist getaggt.");
  done("Neu: die Zeile zeigt jetzt „wartet auf dich“, sobald Claude fragt. Tests grün. PR gemergt. Release getaggt.");
  // y/n named in a description asks nothing (fleet audit 16.10.2026).
  done(
    "Im selben Commit kam dazu:\n- **`:stop`** beendet nach `y/n` alle Sessions im Fleet-Fenster. Jobs lässt er laufen.",
  );
  done("Fertig. Fragen?");
  done("Alles erledigt. Any questions?");
  done("Prüfung eingebaut, 23 Tests grün, PR #112 ist approved und kann gemergt werden.");
  done("Erledigt. Sag Bescheid, wenn ich weitermachen soll.");
  done("Done. Let me know if you want me to open the PR.");
  done("Als Nächstes soll ich laut Plan die Tests schreiben, das mache ich morgen.");
  // Question only inside a code block
  done("So sieht der Prompt aus:\n```\nSoll ich den PR aufmachen?\n```\nDas Beispiel ist eingebaut.");
  // Question in the middle of a long report, the end has none
  done(
    "Soll ich das so lassen? Ja, denn es passt.\nDann habe ich die Tests angepasst.\nDie CI ist grün.\nDer Branch ist gepusht.\nPR #12 ist offen.",
  );
  done("");
  done(undefined as unknown as string);
});

test("Lange Sätze werden gekappt", () => {
  const a = waits(`${"Sehr ".repeat(80)}lange Frage, soll ich weitermachen?`);
  assert.ok(a.text.length <= 200);
});

test("A closing question before a note of what was recorded still waits (fleet audit, 15.10.2026)", () => {
  // The user's own rule asks for a last line saying where knowledge was noted: the question comes before it.
  assert.strictEqual(
    waits(
      "PR 3 ist vorbereitet.\n\nSoll ich PR 3 so committen und öffnen? Den Ruleset-Aufruf zeige ich dir danach.\n\n**Festgehalten:** Der Prüfpunkt steht im Skill `verify`.",
      "question",
    ).text,
    "Soll ich PR 3 so committen und öffnen?",
  );
  waits("Meinst du die Architekturmappe und nicht die Bewerbungsmappe?\n\n**Was wo festgehalten ist:** nichts Neues.");
  waits("Shall I open the PR?\n\nRecorded: the checkpoint is in the verify skill.");
  // A question form opens the last line, its explanation follows in the same line.
  waits(
    "Den Merge kann ich nicht selbst ausführen.\n\nSoll ich #11 übernehmen? Dann würde ich main in den Branch mergen und die Konflikte lösen. Dafür sollte die andere Session vorher stillstehen.",
  );
  waits(
    "**Die Mappe:** Daran arbeitet noch eine andere Session. Meinst du die Architekturmappe? Dann übernehme ich, sobald sie fertig ist.\n\nFestgehalten: nichts Neues.",
  );
  done("Warum war die CI rot? Der Cache war leer. Jetzt ist sie grün.");
  waits(
    "Eine Ausnahme im Hook wäre eine Änderung an den Leitplanken.\n\nWas soll ich machen? Sag „C“, dann lege ich direkt los.",
  );
  waits("Den Commit lehnt der Hook ab, deshalb wartet er auf dich: im Worktree `git commit` ausführen.", "approval");
  waits("The commit is blocked by the hook, so it waits for you: run `git commit` in the worktree.", "approval");
  // 16.10.2026: the waiting sentence opens the second last line, steps and a "tell me" follow.
  waits(
    "Die Anmeldung wartet noch auf dich. Drück im Terminal Enter, damit sich die Seite im Browser öffnet. Gib dort den Code ein.\n\nDanach sag kurz Bescheid. Dann frage ich ab, wie viele Minuten verbraucht sind.",
    "approval",
  );
  // A rule of thumb in question form asks nothing.
  done(
    "Faustregel: **Geht das Ding später an einen Kunden?** Dann ist es Wareneingang. **Verbraucht die Firma es selbst?** Dann ist es Aufwand.",
  );
  // Still done: a question in the middle of a report, and a rhetorical one before the result.
  done("Was war die Ursache? Ein fehlender Index.\n\nDer Index ist angelegt, alle Tests sind grün.");
  done("Festgehalten: alles im Skill.");
  // Round 5 (fleet audit): a question to the user, then only what is still open.
  waits("Dein Satz bricht ab. Was wolltest du noch sagen? Offen ist sonst nur die Telefonnummer.");
  waits("Your sentence breaks off. What did you want to add? Still open: the phone number.");
  // A rhetorical question to nobody in a report stays done, also with such a sentence after it.
  done("Was war die Ursache? Ein fehlender Index. Offen ist nichts mehr.");
});
