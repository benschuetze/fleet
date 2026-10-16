/**
 * The fixed words of Fleet's own questions (answers and their hints, the approval's title), in both languages. The
 * server writes them in its language (`tr` in server/core/brake.ts); the dashboard shows them in the language the user
 * picked (round 4: "Allow" and "Pause and rethink" in a German dashboard). tests/decision-words.test.ts keeps this list
 * in step with brake.ts.
 */
export const DECISION_WORDS: readonly (readonly [string, string])[] = [
  ["Erlauben", "Allow"],
  ["Immer für diese Session", "Always for this session"],
  ["Gleiche Aufrufe fragen in dieser Session nicht mehr", "Same calls no longer ask in this session"],
  ["Ablehnen", "Deny"],
  ["Innehalten und neu ansetzen", "Pause and rethink"],
  ["Claude fasst zusammen, was nicht klappt, und fragt dich", "Claude sums up what does not work and asks you"],
  ["An Opus-Subagent geben", "Hand to an Opus subagent"],
  ["Ein stärkeres Modell übernimmt den festgefahrenen Schritt", "A stronger model takes over the stuck step"],
  ["Weiter so", "Carry on"],
  ["Weiter", "Continue"],
  ["Anhalten", "Stop"],
  ["Übergabe schreiben", "Write a handoff"],
  ["Claude hält den Stand in HANDOFF.md fest und hört auf", "Claude records the state in HANDOFF.md and stops"],
];

const PREFIX: readonly (readonly [string, string])[] = [["Freigabe", "Approval"]];

/** A fixed word of a question in the dashboard's language; anything else (commands, file names) as it came. */
export function decisionText(s: string, t: (de: string, en: string) => string): string {
  const pair = DECISION_WORDS.find(([de, en]) => s === de || s === en);
  if (pair) return t(pair[0], pair[1]);
  for (const [de, en] of PREFIX)
    for (const p of [de, en]) if (s.startsWith(`${p}: `)) return `${t(de, en)}: ${s.slice(p.length + 2)}`;
  return s;
}
