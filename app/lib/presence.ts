/**
 * Tells the server whether this tab is in front (visible and focused). Only then may the hook hold an approval
 * for Fleet: while it waits, the desktop app shows no prompt (bug B3). Every tab reports for itself; the shared
 * stream (stream.ts) cannot say it, because the tab that holds it may well be in the background.
 */
const BEAT_MS = 15e3;

export function watchPresence(): () => void {
  if (typeof document === "undefined" || typeof fetch === "undefined") return () => {};
  const tab = `tab-${Math.random().toString(36).slice(2, 12)}`;
  let last: boolean | null = null;
  let beat: ReturnType<typeof setInterval> | undefined;
  const send = (active: boolean) => {
    // keepalive: the report of a closing tab still arrives.
    fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fleet": "1" },
      body: JSON.stringify({ tab, active }),
      keepalive: true,
    }).catch(() => {
      // offline: the server's mark ages out by itself
    });
  };
  const check = (e?: Event) => {
    // On blur, hasFocus() may still be true for a moment.
    const active =
      e?.type !== "blur" && e?.type !== "pagehide" && document.visibilityState === "visible" && document.hasFocus();
    if (active === last) return;
    last = active;
    send(active);
    clearInterval(beat);
    if (active) beat = setInterval(() => send(true), BEAT_MS);
  };
  const events = ["visibilitychange", "focus", "blur", "pagehide", "pageshow"] as const;
  for (const n of events) (n === "visibilitychange" ? document : window).addEventListener(n, check);
  check();
  return () => {
    for (const n of events) (n === "visibilitychange" ? document : window).removeEventListener(n, check);
    clearInterval(beat);
    if (last) send(false);
  };
}
