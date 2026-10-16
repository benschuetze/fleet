import type { Ask } from "../../shared/types";

/**
 * Does the last assistant turn end with a question or a request for approval? Then the session waits for you
 * and is not just done. Pure and without dependencies, so the hook may load it too.
 *
 * The alarm rule (ISA-18.2): only when an action is expected. A conditional offer ("let me know if you want …")
 * leaves the decision optional, so the turn is done, not waiting.
 */

const TAIL = 600;

/**
 * Tools that wait for an answer in the app (question, plan, folder choice, access) until their tool_result. Their
 * PreToolUse often arrives after the permission notification and overwrites it; "stuck?" would be wrong.
 */
export const INTERACTIVE =
  /^(AskUserQuestion|ExitPlanMode|mcp__ccd_directory__\w+|mcp__[\w-]+__request_(access|teach_access|full_control))$/;

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * The question such a tool puts to the user, for the alarm row: the first question of AskUserQuestion, the reason
 * of a folder or access request. Empty when the input says nothing; the caller words a fallback.
 */
export function toolQuestion(name: unknown, input: unknown): string {
  if (typeof name !== "string" || !INTERACTIVE.test(name) || !input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  let q = "";
  if (name === "AskUserQuestion" && Array.isArray(i.questions)) {
    const first = i.questions[0] as Record<string, unknown> | undefined;
    q = str(first?.question);
  } else if (name !== "ExitPlanMode")
    q =
      str(i.reason) ||
      str(i.path) ||
      (Array.isArray(i.apps) ? i.apps.filter((a) => typeof a === "string").join(", ") : "");
  return q.length > MAX_TEXT ? `${q.slice(0, MAX_TEXT - 1)}…` : q;
}
const MAX_TEXT = 200;

// Something only the user can do now ("deshalb wartet er auf dich: … ausführen").
const WAITING: RegExp[] = [/\bwartet\b.{0,30}\bauf dich\b/i, /\bwaits (on|for) you\b/i];

/** Phrases that ask for a yes, a decision or input, German and English. Covered by tests/ask.test.ts. */
export const APPROVAL: RegExp[] = [
  /\bdein(e|en)? (ja|okay|ok|go|freigabe|zustimmung|entscheidung|bestätigung)\b/i,
  /\bbrauche\b.{0,40}\b(ja|okay|ok|freigabe|zustimmung|entscheidung|bestätigung|rückmeldung)\b/i,
  // Question forms only at the start of a sentence: "next I should write the tests" asks nothing.
  /^(oder |und |also |or |and |so )?(soll(en)? (ich|wir)|möchtest du|willst du|(shall|should) (i|we)|do you want me to|would you like)\b/i,
  /\bbitte (bestätige|bestätigen|entscheide)\b/i,
  // y/n as the answer format ("Weiter? (y/n)", "Proceed [y/N]", "Antworte mit y/n, dann …"), not as a word in a description ("fragt nach
  // y/n alle Sessions", fleet audit 16.10.2026).
  /[([]\s*(y|ja)\s*\/\s*(n|nein)\s*[)\]]|\b(antworte|tippe|reply|answer|type)\b.{0,20}\b(y|ja)\s*\/\s*(n|nein)\b|\b(y|ja)\s*\/\s*(n|nein)\s*[?.!:]?$/i,
  /\bneed your (yes|ok|okay|go|approval|go-ahead|decision|input|confirmation)\b/i,
  /\bwaiting for your\b/i,
  ...WAITING,
  /\bwhich option\b/i,
  /\byour call\b/i,
  /\bwelche (option|variante)\b/i,
];

/** Conditional offers: the work is done, the decision is optional. */
const CONDITIONAL: RegExp[] = [
  /\b(sag|gib) (mir )?bescheid\b/i,
  /\bmelde dich\b/i,
  /\bfalls du\b/i,
  /\bwenn du (willst|möchtest|magst)\b/i,
  /\blet me know\b/i,
  /\bif you('d| would)? (like|want|prefer)\b/i,
];

const NEGATED = /\b(nicht|nichts|kein\w*|mehr|not|no longer|nothing)\b/i;
const QUOTED = /[„“"»«][^„“”"»«]*[“”"«»]/g;

/** Generic closing lines that ask nothing in particular. */
const GENERIC =
  /^(hast du |habt ihr |gibt es |any |do you have any )?(noch |sonst noch |other |more |further )?(weitere |noch )?(fragen|questions|etwas|was|anything else)\??$/i;

// A closing note of where knowledge was recorded (a rule in the user's CLAUDE.md): it follows the question.
const NOTED = /^(was wo |what (is |was )?|where )?(festgehalten|notiert|gespeichert|recorded|noted|saved)\b/i;
// A question form ("Soll ich …?", "Shall I …?") is a question wherever it stands in the closing lines.
const QUESTION_FORM = APPROVAL[2] as RegExp;
// What follows a question to the user: what happens on a yes, or how to answer ("Sag „C“ …", "Reply …").
const THEN = /^(dann|danach|sonst|sag|gib|antworte|wähle|then|after that|otherwise|tell|reply|pick|choose)\b/i;
// Or only what is still open beside it (fleet audit, round 5: "Was wolltest du noch sagen? Offen ist sonst nur …").
const STILL = /^(offen|noch offen|es fehlt|fehlt noch|sonst fehlt|open|still open|missing|also missing)\b/i;
// The question speaks to the user (a rhetorical one in a report does not).
const ADDRESSED = /\b(du|dich|dir|dein\w*|ihr|euch|you|your|soll(en)? (ich|wir)|(shall|should) (i|we))\b/i;

const OPTION = /^([-*•]|\d+[.)]|[a-z][.)]|[A-Z][.)])\s+\S/;
const TRAIL = /[\s*_`)"“”'»«]+$/;
const LEAD = /^[\s*_`>#"“”'»«-]+/;

const clean = (s: string) =>
  s
    .replace(LEAD, "")
    .replace(TRAIL, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const sentences = (line: string) => line.split(/(?<=[.!?])\s+/).filter(Boolean);

export function detectAsk(text: unknown): Ask | null {
  if (typeof text !== "string" || !text.trim()) return null;
  // Code blocks may contain question marks and words like "should I" that ask nothing.
  const body = text.replace(/```[\s\S]*?(```|$)/g, "\n").slice(-TAIL);
  const all = body.split(/\r?\n/).map(clean).filter(Boolean);
  if (!all.length) return null;
  let end = all.length;
  while (end > 1 && end > all.length - 2 && NOTED.test(all[end - 1] as string)) end--;
  const lines = all.slice(0, end);

  // A question in the last four lines; only short option lines may follow it.
  const last4 = lines.slice(-4);
  for (let i = last4.length - 1; i >= 0; i--) {
    const line = last4[i] as string;
    if (!line.endsWith("?")) continue;
    const after = last4.slice(i + 1);
    if (after.length > 3 || after.some((l) => l.length > 120 || !OPTION.test(l))) break;
    const q = sentences(line).pop() || line;
    // Short questions like "Noch etwas?" ask nothing in particular, unless options follow ("Welche Variante?").
    if (q.split(/\s+/).length < (after.length ? 2 : 3) || GENERIC.test(q)) break;
    return { kind: "question", text: cut(q) };
  }

  // A question form opening a sentence in the last two lines, with its explanation after it; or any question in
  // the last line followed only by what happens on a yes ("Dann …", "Then …").
  for (const line of lines.slice(-2).reverse()) {
    const ss = sentences(line);
    const q =
      ss.find((x) => x.endsWith("?") && QUESTION_FORM.test(x)) ||
      (line === lines[lines.length - 1]
        ? ss.find(
            (x, i) =>
              x.endsWith("?") &&
              ADDRESSED.test(x) &&
              i < ss.length - 1 &&
              ss.slice(i + 1).every((y) => THEN.test(y) || STILL.test(y)),
          )
        : undefined);
    if (q) return { kind: "question", text: cut(q) };
  }

  // An approval phrase in the closing sentences, unless it is a conditional offer.
  const closing = lines.slice(-2).flatMap(sentences).slice(-3);
  for (let i = closing.length - 1; i >= 0; i--) {
    const sentence = closing[i] as string;
    if (CONDITIONAL.some((r) => r.test(sentence))) continue;
    if (APPROVAL.some((r) => r.test(sentence))) return { kind: "approval", text: cut(sentence) };
  }
  // "Die Anmeldung wartet noch auf dich. … Danach sag kurz Bescheid." waits, even with the steps and a "tell me"
  // after it (fleet audit 16.10.2026: missed for 4 min).
  // Not when it is optional, denied ("Nichts wartet mehr auf dich") or quoted ("zeigt „wartet auf dich“").
  const waiting = lines
    .slice(-2)
    .flatMap(sentences)
    .find(
      (x) =>
        !CONDITIONAL.some((r) => r.test(x)) && !NEGATED.test(x) && WAITING.some((r) => r.test(x.replace(QUOTED, ""))),
    );
  return waiting ? { kind: "approval", text: cut(waiting) } : null;
}
