import { readUse, usesSince } from "../core/featureuse";
import { lang, tr } from "../core/lang";
import { type Area, byFeature } from "../core/scope";

/**
 * `fleet scope [--days 14] [--json]`: which features were used in the last days, by area (docs/SCOPE.md). What
 * stayed at zero is the first candidate to cut. Counts only, from this machine.
 */
export function scope(args: string[]): number {
  const i = args.indexOf("--days");
  const d = i >= 0 ? Number(args[i + 1]) : 14;
  const days = Number.isFinite(d) && d > 0 ? Math.min(d, 400) : 14;
  const from = new Date(Date.now() - (days - 1) * 86400e3);
  const fromDay = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
  const all = readUse();
  const r = byFeature(usesSince(all, fromDay));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ from: fromDay, ...r }, null, 2));
    return 0;
  }
  const first = Object.values(all)
    .flatMap((x) => Object.keys(x))
    .sort()[0];
  console.log(
    tr(
      `fleet scope: Nutzung seit ${fromDay}${first ? ` (gezählt ab ${first})` : " (noch nichts gezählt)"}`,
      `fleet scope: use since ${fromDay}${first ? ` (counted from ${first})` : " (nothing counted yet)"}`,
    ),
  );
  const AREA: Record<Area, string> = {
    core: tr("Kern", "Core"),
    desktop: tr("Ersatz der Desktop-App", "Replacing the desktop app"),
    extra: tr("Beiwerk", "Extras"),
  };
  const de = lang() === "de";
  // Nothing counted yet: no line is "unused" either (practical test 15 Oct: every line said so).
  const counted = r.features.some((f) => f.uses);
  for (const area of ["core", "desktop", "extra"] as Area[]) {
    console.log(`\n${AREA[area]}`);
    for (const f of r.features.filter((x) => x.area === area))
      console.log(
        `  ${String(f.uses).padStart(6)}  ${de ? f.de : f.en}${
          f.uses || !counted
            ? ""
            : f.area === "core"
              ? tr("   ← ungenutzt (Kern, bleibt)", "   ← unused (core, stays)")
              : tr("   ← ungenutzt", "   ← unused")
        }`,
      );
  }
  const extra = Object.entries(r.unmapped).sort((a, b) => b[1] - a[1]);
  if (extra.length) {
    console.log(tr("\nTasten und Befehle ohne Zuordnung:", "\nKeys and commands without a feature:"));
    for (const [k, n] of extra.slice(0, 20)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  const unused = r.features.filter((f) => !f.uses && f.area !== "core");
  // Nothing counted yet says nothing about what is unused: no candidates then (practical test 15 Oct).
  if (!r.features.some((f) => f.uses)) {
    console.log(
      tr(
        "\nNoch keine Nutzung gezählt: Fleet 6 zählt ab dem ersten Aufruf im Browser. Erst danach sagt dieser Bericht, was ungenutzt ist.",
        "\nNo use counted yet: Fleet 6 counts from the first use in the browser. Only then does this report say what is unused.",
      ),
    );
    return 0;
  }
  console.log(
    unused.length
      ? tr(
          `\n${unused.length} Funktionen ungenutzt: Kandidaten zum Streichen in 6.1 (docs/SCOPE.md).`,
          `\n${unused.length} features unused: candidates to cut in 6.1 (docs/SCOPE.md).`,
        )
      : tr("\nAlles wurde benutzt.", "\nEverything was used."),
  );
  return 0;
}
