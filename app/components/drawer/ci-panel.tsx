import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { type CiCard, inbox } from "../../../shared/inbox";
import { RunPanel, useRun } from "../now/ci-card";

/**
 * A pipeline in the drawer (stage 12.6): what failed, the jobs, failed tests and the log excerpt, and every action.
 * The alarm row keeps one action; nothing unfolds in it any more, its three lines are for the alarms.
 */
export function CiPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const { data } = useFleet();
  const ib = data ? inbox(data) : null;
  const c = ib ? [...ib.ciRed, ...ib.ciRunning].find((x) => x.key === id) : undefined;
  if (!c) return <p className="sd-dim">{t("Diesen Lauf gibt es nicht mehr.", "This run is gone.")}</p>;
  return <Run c={c} />;
}

function Run({ c }: { c: CiCard }) {
  const { id, live, details, cause, fix, rerun, github } = useRun(c, true);
  return (
    <div className="sd ci-panel">
      <p className={live ? "sd-msg" : "sd-msg sd-err"}>{cause}</p>
      {id ? <RunPanel details={details} /> : null}
      <div className="acts">
        {id && !live && fix}
        {id && !live && rerun}
        {github}
      </div>
    </div>
  );
}
