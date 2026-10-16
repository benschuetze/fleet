import { useActions } from "~/lib/actions";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { appOpens, approvalHolder, approvalWhere, openable, resumeCmds } from "~/lib/session";
import type { Session } from "../../../shared/types";
import { ExtLink } from "../tag";

/**
 * One button: open in the preferred program (or the successor session). Cloud and Cowork sessions open by link.
 * `label` names what opening is for (e.g. "Log in again" on an error card); `hint` says what to do there.
 */
export function OpenButton({ s, label, hint }: { s: Session; label?: string; hint?: string }) {
  const { t } = useI18n();
  const { data, preferred, showToast } = useFleet();
  const a = useActions();
  if (s.source === "cloud" || s.source === "cowork") {
    return s.url ? (
      <ExtLink href={s.url} className="act-link" title={hint}>
        {label || t("Öffnen", "Open")}
      </ExtLink>
    ) : null;
  }
  // Runs in Fleet's window, or Fleet's terminal is there: the terminal in the drawer. A target picked once in a drawer
  // does not rename every row (live 16.10.2026: one click on "VS Code" made every row say "VS Code").
  const inFleet = s.proc?.mode === "pty" && (s.proc.status === "running" || s.proc.status === "starting");
  // An approval held where the session runs (live 16.10.2026): a branch in Fleet's terminal cannot answer it and
  // showed the call as "Interrupted". The one action goes where the approval waits, or says where that is.
  const holder = approvalHolder(s, data?.decisions);
  if (holder === "app" || holder === "elsewhere" || holder === "fleet") {
    const app = holder === "app" && appOpens(s, data);
    const where = approvalWhere(holder, t, app, s.waits === "question");
    return app ? (
      // Opens once in the app; the choice of target stays as it was (review 16.10.2026).
      <button type="button" className="act-link" onClick={() => a.openIn(s, "desktop", false)} title={where}>
        {t("In der App öffnen", "Open in the app")}
      </button>
    ) : (
      <button type="button" className="act-link" onClick={() => showToast(where, true)} title={where}>
        {holder === "fleet"
          ? t("Freigabe in Fleet", "Approval in Fleet")
          : s.waits === "question"
            ? t("Wo antworten?", "Where to answer?")
            : t("Wo freigeben?", "Where to approve?")}
      </button>
    );
  }
  if (openable(s, !!data?.demo) && (inFleet || data?.terminal?.available || preferred?.id === "fleet")) {
    return (
      <button
        type="button"
        className="act-link"
        onClick={() => (inFleet ? a.openFleet(s) : a.openIn(s, "fleet"))}
        title={
          hint
            ? `${hint} (${t("Fleet-Terminal", "Fleet terminal")})`
            : inFleet
              ? t(
                  "Läuft im Fleet-Terminal – in der Schublade zeigen",
                  "Runs in the Fleet terminal: show it in the drawer",
                )
              : t(
                  "Im Fleet-Terminal fortsetzen – weitere Ziele in der aufgeklappten Ansicht",
                  "Continue in the Fleet terminal; more targets in the expanded view",
                )
        }
      >
        {label || (s.proc?.status === "interrupted" ? t("Fortsetzen", "Continue") : "Terminal")}
      </button>
    );
  }
  if (preferred && openable(s, !!data?.demo)) {
    return (
      <button
        type="button"
        className="act-link"
        onClick={() => a.openIn(s, preferred.id)}
        title={
          hint
            ? `${hint} (${preferred.label})`
            : t(
                `${s.next ? "Neue Session" : "Session"} in ${preferred.label} öffnen – weitere Ziele in der aufgeklappten Ansicht`,
                `Open the ${s.next ? "new session" : "session"} in ${preferred.label}; more targets in the expanded view`,
              )
        }
      >
        {label || (s.next ? t("Neue öffnen", "Open new") : preferred.label)}
      </button>
    );
  }
  const c = resumeCmds(s, data?.platform || "");
  return c.main ? (
    <button
      type="button"
      className="act-link"
      onClick={() => a.copy(c.main as string, t("Resume-Befehl", "Resume command"))}
    >
      Resume
    </button>
  ) : null;
}

/**
 * The targets for one session, Fleet's terminal first: a session of the desktop app never ran in VS Code or Cursor,
 * so it does not offer them (live 16.10.2026).
 */
function targetsFor<X extends { id: string }>(s: Session, all: X[]): X[] {
  const own = s.desktop ? all.filter((x) => x.id !== "vscode" && x.id !== "cursor") : all;
  return [...own.filter((x) => x.id === "fleet"), ...own.filter((x) => x.id !== "fleet")];
}

/** All targets, the preferred one marked; unavailable ones say why. */
export function OpenMenu({ s }: { s: Session }) {
  const { t } = useI18n();
  const { data, preferred } = useFleet();
  const a = useActions();
  if (!openable(s, !!data?.demo)) return null;
  const c = resumeCmds(s, data?.platform || "");
  // The menu marks the target picked last; the rows' button and Enter stay with Fleet's terminal (terminal first).
  const chosen = preferred?.id;
  const label = s.next ? t("Neue Session öffnen in", "Open the new session in") : t("Öffnen in", "Open in");
  return (
    <>
      <h4 className="sd-h">{label}</h4>
      <fieldset className="acts" aria-label={s.next ? label : t("Session öffnen in", "Open the session in")}>
        {targetsFor(s, data?.openTargets || []).map((x) =>
          x.ok ? (
            <button
              key={x.id}
              type="button"
              className={`ghost ${chosen === x.id ? "on" : ""}`}
              aria-pressed={chosen === x.id}
              onClick={() => a.openIn(s, x.id)}
            >
              {x.label}
            </button>
          ) : (
            <button
              key={x.id}
              type="button"
              className="ghost"
              disabled
              title={x.why}
              aria-label={`${x.label}: ${x.why || t("nicht verfügbar", "not available")}`}
            >
              {x.label}
            </button>
          ),
        )}
        {c.main && (
          <button
            type="button"
            className="ghost"
            onClick={() =>
              a.copy(c.main as string, c.mainLabel ? `Resume (${c.mainLabel})` : t("Resume-Befehl", "Resume command"))
            }
          >
            {t("Befehl kopieren", "Copy command")}
          </button>
        )}
      </fieldset>
    </>
  );
}
