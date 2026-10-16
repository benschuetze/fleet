import { useState } from "react";
import { useActions } from "~/lib/actions";
import { useI18n } from "~/lib/i18n";
import type { Repo } from "../../../shared/types";

/** A new Claude session in this repo, in Fleet's window: one line for the task, then the drawer opens. */
export function NewSession({ r }: { r: Repo }) {
  const { t } = useI18n();
  const a = useActions();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="new-session"
      aria-label={t(`Neue Session in ${r.name}`, `New session in ${r.name}`)}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await a.newSession(r.root, task.trim());
        setBusy(false);
        if (ok) setTask("");
      }}
    >
      <input
        type="text"
        value={task}
        maxLength={4000}
        onChange={(e) => setTask(e.target.value)}
        aria-label={t("Auftrag", "Task")}
        placeholder={t("Auftrag (optional)", "Task (optional)")}
        autoComplete="off"
      />
      <button type="submit" className="act-link" disabled={busy}>
        {t("Neue Session", "New session")}
      </button>
    </form>
  );
}
