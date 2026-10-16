import fs from "node:fs";
import path from "node:path";
import type { Handoff } from "../../shared/types";
import { FILE, MAX_BYTES, readRegistry, sha } from "./registry";

/** For the dashboard: the handoff of a repo, split into sections (German or English headings). */
export function readHandoff(root: string): Handoff | null {
  const file = path.join(root, FILE);
  let buf: Buffer;
  let at: number;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) return null;
    buf = fs.readFileSync(file);
    at = st.mtimeMs;
  } catch {
    return null;
  }
  const e = readRegistry().byDir[root];
  const parts: Record<"open" | "next" | "done", string[]> = { open: [], next: [], done: [] };
  let cur: keyof typeof parts | "" = "";
  let title = "";
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const text = h[2] ?? "";
      if (h[1] === "#" && !title) title = text.trim().slice(0, 160);
      const t = text.toLowerCase();
      cur = /nächst|next/.test(t) ? "next" : /offen|open|todo/.test(t) ? "open" : /erledigt|done/.test(t) ? "done" : "";
      continue;
    }
    const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line)?.[1]?.trim();
    if (cur && item && parts[cur].length < 20) parts[cur].push(item.slice(0, 300));
  }
  const trusted = !!(e?.sha && e.sha === sha(buf));
  // Opened but not sent yet: the app only pre-fills the prompt, sending is up to the user.
  const opened = trusted && e?.openedAt && !e?.deliveredTo ? { at: e.openedAt, target: e.openIn || null } : null;
  return {
    file,
    at,
    trusted,
    delivered: trusted && !!e?.deliveredTo,
    opened,
    session: e ? e.sessionId : null,
    origin: e?.key.startsWith("failure:") ? "emergency" : "claude",
    reason: e ? e.reason : null,
    title,
    open: parts.open,
    next: parts.next,
    done: parts.done,
  };
}
