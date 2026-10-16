import { useState } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { mmss } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useNow } from "~/lib/use-now";
import { decisionText } from "../../../shared/decision-words";

/**
 * Fleet's own question in the drawer (stage 12.5): what happened, and every option as one line with what it does.
 * The alarm row keeps one action, the recommended one (stage 12.6); here the others stand beside it.
 */
export function DecisionPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const { data } = useFleet();
  const a = useActions();
  const now = useNow(1000);
  const [sent, setSent] = useState<string | null>(null);
  const d = (data?.decisions || []).find((x) => x.id === id);
  if (!d) return <p className="sd-dim">{t("Diese Frage gibt es nicht mehr.", "This question is gone.")}</p>;
  const open = d.status === "open" && d.expiresAt > now;
  const perm = d.kind === "permission";
  return (
    <div className="sd" data-owner={d.sessionId}>
      <p className="sd-dim">
        {d.sessionTitle || d.project || "—"} ·{" "}
        {open
          ? `${t("wartet noch", "still waits")} ${mmss(d.expiresAt - now)}`
          : perm
            ? t("abgelaufen – die App fragt jetzt selbst", "expired: the app asks itself now")
            : t(
                "lief weiter – deine Antwort greift beim nächsten Schritt",
                "carried on: your answer applies at the next step",
              )}
      </p>
      <p className="sd-msg">
        <b>{perm ? decisionText(d.title, t) : `${t("Fleet hat angehalten", "Fleet paused")}: ${d.title}`}</b>
      </p>
      <p className="sd-msg">{d.text}</p>
      {!(perm && !open) && (
        <>
          <h4 className="sd-h">{t("Antworten", "Answers")}</h4>
          <ul className="sd-advice" aria-label={t("Antworten", "Answers")}>
            {d.options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className="link"
                  disabled={!!sent}
                  aria-pressed={sent === o.id}
                  onClick={() => {
                    setSent(o.id);
                    a.decide(d.id, o.id, decisionText(o.label, t));
                  }}
                >
                  {decisionText(o.label, t)}
                </button>
                {o.id === d.recommended && <span className="sd-dim"> · {t("empfohlen", "recommended")}</span>}
                {o.hint && <p>{decisionText(o.hint, t)}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
