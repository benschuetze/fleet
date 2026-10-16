/**
 * The server's change stream, one per browser instead of one per tab. A browser allows six connections per host,
 * and an open server-sent-events stream holds one for good: with six Fleet tabs open, the next page never loaded
 * (the frozen Activity tab from the review). One tab holds the stream (a Web Lock picks it, and the next one takes
 * over when it closes) and passes every change on to the others over a BroadcastChannel.
 */
const NAME = "fleet-stream";

export function subscribe(onChange: () => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof BroadcastChannel === "undefined") {
    // Old browser: a stream of its own, as before.
    const es = new EventSource("/api/stream");
    es.onmessage = onChange;
    return () => es.close();
  }
  const channel = new BroadcastChannel(NAME);
  channel.onmessage = onChange;
  const stop = new AbortController();
  let release = () => {};
  let es: EventSource | null = null;
  locks
    .request(NAME, { signal: stop.signal }, async () => {
      es = new EventSource("/api/stream");
      es.onmessage = () => {
        onChange();
        channel.postMessage(1);
      };
      // The new holder may have missed a change while the old one closed.
      onChange();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => {
      // aborted while waiting for the lock: this tab closed first
    });
  return () => {
    stop.abort();
    es?.close();
    release();
    channel.close();
  };
}
