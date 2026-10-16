import fs from "node:fs";
import path from "node:path";
import { UI_FRESH_MS } from "../core/brake";
import { fleetHome } from "../core/paths";

/**
 * Which Fleet tabs are visible and focused, as the tabs report it (app/lib/presence.ts). The mark `ui-active`
 * exists while at least one is: only then may the PermissionRequest hook hold an approval for Fleet, because
 * meanwhile the app shows no prompt (bug B3: a connected background tab held every approval 45 s).
 */
export const TAB_RE = /^[A-Za-z0-9-]{6,40}$/;
const MAX_TABS = 50;

export function presence(o: { demo: boolean }) {
  const tabs = new Map<string, number>();
  const mark = () => path.join(fleetHome(), "ui-active");
  const write = () => {
    try {
      fs.writeFileSync(mark(), String(Date.now()), { mode: 0o600 });
    } catch {
      // the brake then simply does not wait
    }
  };
  const remove = () => {
    try {
      fs.rmSync(mark(), { force: true });
    } catch {
      // nothing to remove
    }
  };
  const sync = (now: number) => {
    // A tab that stopped reporting (crashed, put to sleep) no longer counts.
    for (const [t, at] of tabs) if (now - at >= UI_FRESH_MS) tabs.delete(t);
    if (o.demo) return;
    if (tabs.size) write();
    else remove();
  };
  return {
    report(tab: string, active: boolean, now = Date.now()) {
      if (active) {
        if (!tabs.has(tab) && tabs.size >= MAX_TABS) return;
        tabs.set(tab, now);
      } else tabs.delete(tab);
      sync(now);
    },
  };
}
export type Presence = ReturnType<typeof presence>;
