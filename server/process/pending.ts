import { readRegistry, writeRegistry } from "../handoff/registry";

/**
 * New sessions the hook asked for in Fleet's window ("Start fresh" with the target Fleet-Terminal). The hook runs
 * inside the old session and cannot start a terminal in the server; it leaves `pendingStart` in handoffs.json,
 * and the server takes each mark exactly once.
 */
export function takePending(): { root: string; prompt: string }[] {
  const reg = readRegistry();
  const out: { root: string; prompt: string }[] = [];
  for (const [root, e] of Object.entries(reg.byDir)) {
    if (!e?.pendingStart) continue;
    delete e.pendingStart;
    const prompt = typeof e.pendingPrompt === "string" ? e.pendingPrompt.slice(0, 4000) : "";
    delete e.pendingPrompt;
    out.push({ root, prompt });
  }
  if (out.length) writeRegistry(reg);
  return out;
}
