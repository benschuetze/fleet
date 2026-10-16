import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";

/** Opens the conflict drawer for two sides of a repo; the one way in from Now, the PR lists and a session. */
export function ConflictButton({
  root,
  a,
  b,
  title,
  label,
  crit = false,
  dup = false,
  className = "act-link",
  opener = false,
}: {
  root: string;
  /** `s:<session id>` or `pr:<number>`. */
  a: string;
  b: string;
  title: string;
  label: string;
  /** A real merge conflict between PRs is merge danger: red text (colour grammar, --crit). */
  crit?: boolean;
  /** From a duplicate group: the drawer shows the group and how to merge it on top. */
  dup?: boolean;
  className?: string;
  /** The title of a board row: Enter on the row presses it (`data-opener`). */
  opener?: boolean;
}) {
  const { t } = useI18n();
  const { openDrawer } = useFleet();
  return (
    <button
      type="button"
      className={`${className}${crit ? " crit" : ""}`}
      title={t(`Konflikt ansehen: ${title}`, `Show the conflict: ${title}`)}
      onClick={() => openDrawer({ kind: "conflict", root, a, b, title, ...(dup ? { dup } : {}) })}
      {...(opener ? { "data-opener": "" } : {})}
    >
      {label}
    </button>
  );
}
