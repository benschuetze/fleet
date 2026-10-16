import { tr } from "../core/lang";
import { readLedger, weeks } from "../core/ledger";

/**
 * `fleet balance [--json]`: Fleet's balance per week in dollars at list prices, from the days the server kept
 * (core/ledger.ts). Two comparisons: against going on in the old session, and against /compact at the same points.
 */
export function balance(args: string[]): number {
  const w = weeks(readLedger());
  if (args.includes("--json")) {
    console.log(JSON.stringify(w, null, 2));
    return 0;
  }
  if (!w.length) {
    console.log(
      tr(
        "Noch keine Bilanztage: Fleet hält sie fest, sobald die Verbrauchsseite einmal gerechnet hat.",
        "No balance days yet: Fleet keeps them once the usage page has been computed.",
      ),
    );
    return 0;
  }
  const $ = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : " "}${Math.abs(v).toFixed(2)} $`.padStart(10);
  const c = (v: number) => `${v.toFixed(2)} $`.padStart(9);
  console.log(
    tr(
      "Woche ab      Tage  gekostet   gespart  Bilanz    | /compact  Fleet     gegen /compact",
      "week from     days  spent      saved    balance   | /compact  Fleet     vs /compact",
    ),
  );
  for (const x of w)
    console.log(
      `${x.from}   ${String(x.days).padStart(3)}  ${c(x.costUsd)} ${c(x.savedUsd)} ${$(x.net)}  | ${c(x.compactUsd)} ${c(x.freshUsd)} ${$(x.vsCompact)}`,
    );
  const sum = w.reduce((a, x) => ({ net: a.net + x.net, vs: a.vs + x.vsCompact }), { net: 0, vs: 0 });
  console.log(
    tr(
      `\nSumme: ${$(sum.net).trim()} gegen Weitermachen in der alten Session, ${$(sum.vs).trim()} gegen /compact.`,
      `\nTotal: ${$(sum.net).trim()} against going on in the old session, ${$(sum.vs).trim()} against /compact.`,
    ),
  );
  console.log(
    tr(
      "Listenpreise; im Pro/Max-Abo stehen sie für den Anteil am Limit. Gespart ist eine Schätzung gegen einen nicht eingetretenen Fall; /compact rechnet einen Aufruf über den alten Kontext plus 5 Tsd. Tokens Zusammenfassung (gemessen).",
      "List prices; on a Pro/Max plan they stand for the share of the limit. Saved is an estimate against a case that did not happen; /compact counts one call over the old context plus a 5k-token summary (measured).",
    ),
  );
  return 0;
}
