import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { continueCmd } from "~/lib/session";
import type { Repo } from "../../../shared/types";
import { InfoTip } from "../info-tip";

/** A repo with a handoff nobody continues yet. */
export type ReadyRepo = Repo & { handoff: NonNullable<Repo["handoff"]> };

/** Opened in a new session in the last half hour: it waits there for Enter. */
export const openedRecently = (h: ReadyRepo["handoff"]) =>
  h.opened && Date.now() - h.opened.at < 30 * 60e3 ? h.opened : null;

/**
 * A handoff nobody continues yet, in the drawer (its row on the board opens it): next steps, open points, and
 * every target to continue in.
 */
export function HandoffPanel({ root }: { root: string }) {
  const { t } = useI18n();
  const { targets, data } = useFleet();
  const a = useActions();
  const r = data?.repos.find((x): x is ReadyRepo => x.root === root && !!x.handoff);
  if (!r) return <p className="hint">{t("Diese Übergabe gibt es nicht mehr.", "This handoff is gone.")}</p>;
  const h = r.handoff;
  const opened = openedRecently(h);
  return (
    <section className="ho-panel" aria-label={t("Übergabe", "Handoff")}>
      {opened && (
        <div className="why waiting">
          {opened.target
            ? t(`In ${a.label(opened.target)} geöffnet`, `Opened in ${a.label(opened.target)}`)
            : t("Neue Session geöffnet", "New session opened")}{" "}
          – {t("dort steht der Auftrag, mit Enter abschicken.", "the prompt is there, send it with Enter.")}
        </div>
      )}
      {h.origin === "emergency" ? (
        <div className="why">
          {t("automatisch", "automatic")}: {h.reason || t("Turn abgebrochen", "turn broke off")}
        </div>
      ) : h.reason ? (
        <div className="why">
          {t("aus Übergabe", "from a handoff")}: {h.reason}
        </div>
      ) : !h.trusted ? (
        <div className="why">
          {t("fremde Übergabe", "foreign handoff")}{" "}
          <InfoTip
            label={t("Was heißt fremde Übergabe?", "What is a foreign handoff?")}
            text={t(
              "Nicht von Fleet angefordert – wird einer neuen Session nur erwähnt, nicht mitgegeben.",
              "Not requested by Fleet: a new session only hears about it, it is not passed on.",
            )}
          />
        </div>
      ) : null}
      {h.next.length > 0 && (
        <>
          <h4>{t("Nächste Schritte", "Next steps")}</h4>
          <ol>
            {h.next.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </>
      )}
      {h.open.length > 0 && (
        <>
          <h4>{t("Offen", "Open")}</h4>
          <ul>
            {h.open.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      <div className="acts">
        <span className="hint">
          {h.opened ? t("Nochmal öffnen in", "Open again in") : t("Weiter in", "Continue in")}
        </span>
        {targets.length ? (
          targets.map((x) => (
            <button key={x.id} type="button" className="act-link" onClick={() => a.continueIn(r.root, x.id)}>
              {x.label}
            </button>
          ))
        ) : (
          <button
            type="button"
            className="act-link"
            onClick={() =>
              a.copy(
                continueCmd(
                  r.root,
                  data?.platform || "",
                  t("Mach mit der Übergabe weiter", "Continue from the handoff"),
                ),
                t("Befehl", "Command"),
              )
            }
          >
            {t("Befehl kopieren", "Copy command")}
          </button>
        )}
      </div>
    </section>
  );
}
