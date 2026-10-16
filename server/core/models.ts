/** Model knowledge shared by server and hook (as of October 2026). */

/** Models with a one-million-token context; older ones have 200k. */
const MILLION = /fable|mythos|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-[6-9]/;

/**
 * Size of the context window. More than 200k tokens only fit into a one-million window.
 * `configured` forces a size (0 = automatic).
 */
export function contextSize(model: unknown, tokens: number, configured = 0): number {
  if (configured) return configured;
  return MILLION.test(String(model || "").toLowerCase()) || tokens > 200000 ? 1000000 : 200000;
}
