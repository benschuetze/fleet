import fs from "node:fs";
import path from "node:path";
import type { Balance } from "../../shared/types";
import { fleetHome } from "./paths";

/**
 * The balance over weeks (independent review: "several weeks of dollar balance"). The usage window holds seven days;
 * each computation writes its days to ~/.claude-fleet/balance-days.json, so a day keeps its last numbers after it
 * left the window and `fleet balance` can sum weeks. Dollars at list prices; on a Pro/Max plan they stand for the
 * share of the limit, not money paid.
 */

export type Day = Balance["daily"][number];
const KEEP = 400;
const file = () => path.join(fleetHome(), "balance-days.json");

export function readLedger(): Record<string, Day> {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Merges the window's days in; writes only when something changed. Never throws. */
export function recordDays(days: Day[]): void {
  try {
    const before = readLedger();
    const next: Record<string, Day> = { ...before };
    for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d.day)) next[d.day] = d;
    const keys = Object.keys(next).sort().slice(-KEEP);
    const out = Object.fromEntries(keys.map((k) => [k, next[k] as Day]));
    const text = JSON.stringify(out);
    if (text === JSON.stringify(before)) return;
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    // the next computation writes again
  }
}

export interface Week {
  /** Monday of the week, local. */
  from: string;
  days: number;
  costUsd: number;
  savedUsd: number;
  /** savedUsd − costUsd: against going on in the old session. */
  net: number;
  compactUsd: number;
  freshUsd: number;
  /** compactUsd − freshUsd: against /compact at the same points. */
  vsCompact: number;
}

const monday = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y || 1970, (m || 1) - 1, d || 1);
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

export function weeks(ledger: Record<string, Day>): Week[] {
  const by = new Map<string, Week>();
  for (const d of Object.values(ledger)) {
    const k = monday(d.day);
    const w = by.get(k) || {
      from: k,
      days: 0,
      costUsd: 0,
      savedUsd: 0,
      net: 0,
      compactUsd: 0,
      freshUsd: 0,
      vsCompact: 0,
    };
    w.days++;
    w.costUsd += d.costUsd || 0;
    w.savedUsd += d.savedUsd || 0;
    w.compactUsd += d.compactUsd || 0;
    w.freshUsd += d.freshUsd || 0;
    by.set(k, w);
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [...by.values()]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((w) => ({
      ...w,
      costUsd: r2(w.costUsd),
      savedUsd: r2(w.savedUsd),
      compactUsd: r2(w.compactUsd),
      freshUsd: r2(w.freshUsd),
      net: r2(w.savedUsd - w.costUsd),
      vsCompact: r2(w.compactUsd - w.freshUsd),
    }));
}
