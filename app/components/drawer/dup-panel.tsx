import { useState } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { groupState } from "~/lib/session";
import { usePlaces, useStatus } from "~/lib/use-status";
import type { Place } from "../../../shared/inbox";
import type { Duplicate } from "../../../shared/types";
import { InfoTip } from "../info-tip";
import { ConflictButton } from "./conflict-button";

type T = (de: string, en: string) => string;

/** How the sessions of a group stand, in the words of Now: "alle arbeiten", "1 arbeitet, 1 fertig". */
export function dupState(d: Duplicate, where: Map<string, Place>, t: T): string {
  return groupState(
    d.sessions.map((x) => x.id),
    where,
    t,
  );
}

/** Why they count as one group: shared files first, then the same branch, then the same task. */
export function dupReason(d: Duplicate, t: T): string {
  return d.reason === "files"
    ? `${t("gleiche Dateien", "same files")}: ${d.files.join(", ")}`
    : d.reason === "branch"
      ? `${t("gleicher Branch", "same branch")}: ${d.branch || ""}`
      : t("gleicher Auftrag", "same task");
}

/** The two sides the drawer opens with: the first pair that shares files, else the first two sessions. */
export function dupPair(d: Duplicate): [string, string] | null {
  const p = d.pairs[0] || (d.sessions.length > 1 ? [d.sessions[0]?.id, d.sessions[1]?.id] : null);
  return p?.[0] && p[1] ? [p[0], p[1]] : null;
}

export const dupTitle = (d: Duplicate, a: string, b: string) => {
  const titleOf = (id: string) => d.sessions.find((x) => x.id === id)?.title || id;
  return `${titleOf(a)} ↔ ${titleOf(b)}`;
};

/**
 * Several sessions on the same work in one checkout, at the top of the conflict drawer (a duplicate's row on the
 * board opens it): one line per session, the other pairs that share files, and merging them into one with one click.
 * With shared files it is "Doppelt"; with only the same branch or task it is "parallel, without overlap"
 * (spec, Konflikt-Visualisierung).
 */
export function DupPanel({ root }: { root: string }) {
  const { t } = useI18n();
  const statusOf = useStatus();
  const where = usePlaces();
  const { data, targets } = useFleet();
  const a = useActions();
  const [merging, setMerging] = useState(false);
  const d = data?.duplicates.find((x) => x.root === root);
  if (!d) return null;
  const n = d.sessions.length;
  const merge = async (target: string) => {
    setMerging(true);
    await a.mergeSessions(d.root, target);
    // Let the merge stand briefly, then show the new state.
    setTimeout(() => setMerging(false), 900);
  };
  return (
    <section className="dup-panel" aria-label={t("Sessions der Gruppe", "Sessions of the group")}>
      <h3>
        {d.overlap
          ? t(`${n} offene Sessions im selben Checkout`, `${n} open sessions in the same checkout`)
          : t("parallel, ohne Überschneidung", "parallel, without overlap")}{" "}
        · {dupState(d, where, t)}
      </h3>
      <p className="hint">
        {dupReason(d, t)}{" "}
        <InfoTip
          label={d.overlap ? t("Warum doppelt?", "Why duplicate?") : t("Warum parallel?", "Why parallel?")}
          text={
            d.overlap
              ? t(
                  "Beide haben dieselben Dateien geändert. Jede hat ihren eigenen Kontext und liest ihn bei jedem Aufruf neu. Zu einer zusammengefasst kostet das weniger, und nichts geht zwischen ihnen verloren. Sessions, die Fleet selbst abgelöst hat, zählen hier nicht.",
                  "Both changed the same files. Each has its own context and re-reads it on every call. Combined into one, that costs less and nothing gets lost between them. Sessions Fleet replaced itself do not count here.",
                )
              : t(
                  "Gleicher Branch oder gleicher Auftrag, aber keine Datei von beiden geändert: Sie kommen sich nicht in die Quere. Zusammenfassen geht trotzdem.",
                  "Same branch or same task, but no file changed by both: they do not get in each other's way. Combining them still works.",
                )
          }
        />
      </p>
      <ul className="dup-list">
        {d.sessions.map((x) => (
          <li key={x.id} title={x.cwd || undefined}>
            <span className="dup-t">{x.title}</span> <span className="hint">{statusOf(x).label}</span>
          </li>
        ))}
      </ul>
      <div className="dup-act">
        {d.pairs.length > 1 &&
          d.pairs.map(([x, y]) => (
            <ConflictButton
              key={`${x}|${y}`}
              root={d.root}
              a={`s:${x}`}
              b={`s:${y}`}
              dup
              title={dupTitle(d, x, y)}
              label={t(`Konflikt ansehen: ${dupTitle(d, x, y)}`, `Show conflict: ${dupTitle(d, x, y)}`)}
            />
          ))}
        {merging ? (
          <span className="hint">{t("Wird zusammengefasst…", "Combining…")}</span>
        ) : d.busy ? (
          <span className="hint">
            {t(
              "Eine arbeitet noch – nach ihrem Turn lassen sie sich zu einer Session zusammenfassen.",
              "One is still working: they can be combined into one session after its turn.",
            )}
          </span>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: an inline button group inside running text, where a fieldset is not allowed
          <span className="pick" role="group" aria-label={t("Zusammenfassen in", "Combine into")}>
            <span className="hint">{t("Zu einer zusammenfassen in", "Combine into one in")}</span>
            {targets.map((x) => (
              <button key={x.id} type="button" className="act-link" onClick={() => merge(x.id)}>
                {x.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
