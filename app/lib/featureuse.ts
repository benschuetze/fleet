/**
 * Counts which views, commands and keys are used (server/core/featureuse.ts, docs/SCOPE.md): a few counters, sent
 * in one request every ten seconds and when the page goes away. Never text, only the feature's key.
 */
const USE_RE = /^(view|cmd|key):[\w:/.-]{1,60}$/;
const buf = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;

function flush() {
  timer = null;
  if (!buf.size) return;
  const counts = Object.fromEntries(buf);
  buf.clear();
  fetch("/api/use", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fleet": "1" },
    body: JSON.stringify({ counts }),
    keepalive: true,
  }).catch(() => {});
}

export function countUse(key: string): void {
  if (typeof window === "undefined" || !USE_RE.test(key)) return;
  buf.set(key, (buf.get(key) || 0) + 1);
  if (!hooked) {
    hooked = true;
    window.addEventListener("pagehide", flush);
  }
  timer ??= setTimeout(flush, 10_000);
}
