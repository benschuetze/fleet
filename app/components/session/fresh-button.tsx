import { useState } from "react";
import { useActions } from "~/lib/actions";
import { contextTokens, useDollars } from "~/lib/billing";
import { useFleet } from "~/lib/fleet";
import { money, toks } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import type { Session } from "../../../shared/types";

/**
 * "Start fresh": pick where the new session should open, then the session writes its handoff first and Fleet
 * opens the new one there. Pending: shows where it is going and can be withdrawn.
 */
export function FreshButton({ s, label }: { s: Session; label?: string }) {
  const { t, locale } = useI18n();
  const dollars = useDollars();
  const ctx = contextTokens(s);
  const { targets } = useFleet();
  const a = useActions();
  const [picking, setPicking] = useState(false);
  if (!s.fresh) return null;
  if (s.fresh.pending) {
    const where = s.fresh.target ? ` → ${a.label(s.fresh.target)}` : "";
    return (
      <button
        type="button"
        className="ghost on"
        onClick={() => a.freshOff(s)}
        title={t(
          "Die Session schreibt zuerst ihre Übergabe, dann öffnet Fleet die neue Session. Klicken nimmt es zurück.",
          "The session writes its handoff first, then Fleet opens the new session. Click to withdraw.",
        )}
      >
        {t("Fasst zusammen, dann frisch", "Summarising, then fresh")}
        {where}
      </button>
    );
  }
  if (picking && targets.length > 1) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: an inline button group inside running text, where a fieldset is not allowed
      <span className="pick" role="group" aria-label={t("Frisch starten in", "Start fresh in")}>
        <span className="hint">{t("Weiter in", "Continue in")}</span>
        {targets.map((x) => (
          <button
            key={x.id}
            type="button"
            className="ghost"
            onClick={() => {
              setPicking(false);
              a.fresh(s, x.id);
            }}
          >
            {x.label}
          </button>
        ))}
        <button type="button" className="link" onClick={() => setPicking(false)}>
          {t("abbrechen", "cancel")}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ghost"
      title={t(
        "Die Session schreibt zuerst eine Übergabe, dann öffnet Fleet die neue Session dort, wo du sie haben willst",
        "The session writes a handoff first, then Fleet opens the new session where you want it",
      )}
      onClick={() => (targets.length > 1 ? setPicking(true) : a.fresh(s, targets[0]?.id || null))}
    >
      {label || t("Frisch starten", "Start fresh")}
      {dollars
        ? s.fresh.perCall >= 0.01
          ? ` · ${t("spart", "saves")} ≈ ${money(s.fresh.perCall, locale)}/${t("Aufruf", "call")}`
          : ""
        : ctx
          ? ` · ${t("liest jetzt", "reads now")} ${toks(ctx, locale)}/${t("Aufruf", "call")}`
          : ""}
    </button>
  );
}
