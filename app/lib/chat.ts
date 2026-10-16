import type { ChatEntry, ChatPage } from "../../shared/types";

/** A session's conversation from /api/chat, checked like any input: a broken entry costs that entry, never the drawer. */

const KINDS: ChatEntry["kind"][] = ["you", "claude", "tool", "error"];
/** As the server: at most 200 entries, texts up to 8000 characters. */
const MAX = 200;
const TEXT_MAX = 8000;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseChatPage(raw: unknown): ChatPage | null {
  const o = obj(raw);
  if (typeof o.session !== "string" || !Array.isArray(o.entries)) return null;
  const entries: ChatEntry[] = [];
  for (const v of o.entries.slice(-MAX)) {
    const e = obj(v);
    const at = Number(e.at);
    if (!Number.isFinite(at) || !KINDS.includes(e.kind as ChatEntry["kind"]) || typeof e.text !== "string") continue;
    entries.push({
      at,
      kind: e.kind as ChatEntry["kind"],
      tool: typeof e.tool === "string" && e.tool ? e.tool.slice(0, 60) : null,
      text: e.text.slice(0, TEXT_MAX),
      ...(e.open === true ? { open: true } : {}),
    });
  }
  return { session: o.session, entries, more: o.more === true };
}
