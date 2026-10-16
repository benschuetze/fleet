import { useState } from "react";
import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { mmss } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { rowProps } from "~/lib/rows";
import { waitWord } from "~/lib/session";
import { useNow } from "~/lib/use-now";
import { alarmKey } from "~/lib/view";
import { decisionText } from "../../../shared/decision-words";
import { GLYPH } from "../../../shared/inbox";
import type { Decision } from "../../../shared/types";
import { Mark } from "../mark";
import { ClearAlarm } from "./alarm-rows";

/**
 * Fleet paused a session or forwards an approval: one row of the alarm zone like any other (rule 9). Where, the
 * session, what Fleet asks in one sentence, how long it still waits, and one action, the recommended answer, which
 * Enter on the row gives. The title opens the drawer with every answer and what each does.
 */
export function DecisionRow({ d, first, nr }: { d: Decision; first: boolean; nr: number }) {
  const { t } = useI18n();
  const a = useActions();
  const { openDrawer } = useFleet();
  const now = useNow(1000);
  const [sent, setSent] = useState(false);
  const open = d.status === "open" && d.expiresAt > now;
  const perm = d.kind === "permission";
  // The server's fixed words in the dashboard's language (round 4).
  const title = decisionText(d.title, t);
  const what = perm ? title : `${t("Fleet hat angehalten", "Fleet paused")}: ${title}`;
  const why = perm ? `${what}: ${d.text}` : what;
  const pick = d.options.find((o) => o.id === d.recommended) || d.options[0];
  return (
    <article
      className="arow t-warn"
      id={first ? "decision" : undefined}
      aria-label={what}
      {...rowProps("alarm", "decision", alarmKey.decision(d.id), nr, {
        owner: d.sessionId,
        mute: alarmKey.decision(d.id),
        approval: perm && open ? "fleet" : null,
      })}
    >
      <span className="nr">{nr}</span>
      <span className="a-k">
        <Mark g={GLYPH.needs} />
        <span>{waitWord(perm ? "approval" : "fleet", t)}</span>
      </span>
      <span className="a-where" title={d.project || undefined}>
        <b>{d.project || "—"}</b>
      </span>
      <span className="a-what">
        <button
          type="button"
          className="opener"
          data-opener=""
          title={t("Alle Antworten in der Schublade", "Every answer in the drawer")}
          onClick={() => openDrawer({ kind: "decision", id: d.id, title: d.sessionTitle || d.project || d.title })}
        >
          {d.sessionTitle || d.title}
        </button>
        <span className="a-why" title={perm ? why : `${why} – ${d.text}`}>
          {why}
        </span>
      </span>
      <span
        className="a-age a-keep"
        title={open ? t("So lange wartet die Session noch", "How long the session still waits") : ""}
      >
        {open ? mmss(d.expiresAt - now) : perm ? t("abgelaufen", "expired") : t("lief weiter", "carried on")}
      </span>
      {/* An approval lets Claude run a tool: Enter asks y/n first (key-actions.ts), a click is the explicit yes. */}
      <span className="a-act" data-act={perm ? "approve" : ""}>
        {pick && !(perm && !open) && (
          <button
            type="button"
            className="act-link"
            title={pick.hint ? decisionText(pick.hint, t) : undefined}
            disabled={sent}
            onClick={() => {
              setSent(true);
              a.decide(d.id, pick.id, decisionText(pick.label, t));
            }}
          >
            {decisionText(pick.label, t)}
          </button>
        )}
      </span>
      <ClearAlarm what={what} />
    </article>
  );
}
