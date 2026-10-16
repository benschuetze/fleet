/**
 * Stale-while-revalidate cache for the slow parts of the overview (git, usage, session results).
 *
 * Every hook event rebuilds the overview, and a waiting session has to reach the browser within a second. A plain
 * TTL cache makes the unlucky build that hits an expired entry wait for git or a full usage scan (measured: up to
 * 6.6 s with ~100 sessions). Here only the very first call for a key waits; after that a call always answers from
 * the last value at once and refreshes it in the background. When a refresh brings a different value, the
 * listeners hear about it (the server pushes a change), so the stale answer lives only until the next build.
 */

type Entry<R> = { at: number; p: Promise<R>; value?: { v: R }; refreshing: boolean };

const listeners = new Set<() => void>();

/** Called after a background refresh or a late first load changed a value. Returns the unsubscribe function. */
export function onRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a listener never breaks the cache
    }
  }
}

const same = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

export interface Swr<A extends unknown[], R> {
  /** The value: fresh, stale (refresh starts in the background) or, only for an unknown key, awaited. */
  (key: string, ...a: A): Promise<R>;
  /** Never waits: the known value or undefined; an unknown key starts loading and notifies when it arrives. */
  peek(key: string, ...a: A): R | undefined;
}

export function swr<A extends unknown[], R>(
  ttlMs: number,
  fn: (key: string, ...a: A) => Promise<R> | R,
  { max = 500, announce = true }: { max?: number; announce?: boolean } = {},
): Swr<A, R> {
  const m = new Map<string, Entry<R>>();
  const load = (key: string, a: A, late: boolean): Entry<R> => {
    const e: Entry<R> = { at: Date.now(), p: Promise.resolve().then(() => fn(key, ...a)), refreshing: false };
    m.set(key, e);
    e.p.then(
      (v) => {
        // The TTL counts from the answer: a slow first load is not stale the moment it arrives.
        e.at = Date.now();
        e.value = { v };
        if (late && announce) notify();
      },
      () => {
        if (m.get(key) === e) m.delete(key);
      },
    );
    const oldest = m.keys().next().value;
    if (m.size > max && oldest !== undefined) m.delete(oldest);
    return e;
  };
  const refresh = (key: string, e: Entry<R> & { value: { v: R } }, a: A) => {
    e.refreshing = true;
    Promise.resolve()
      .then(() => fn(key, ...a))
      .then(
        (v) => {
          const changed = !same(e.value.v, v);
          e.value = { v };
          e.p = Promise.resolve(v);
          e.at = Date.now();
          if (changed && announce) notify();
        },
        () => {
          // keep the last value and try again after the TTL
          e.at = Date.now();
        },
      )
      .finally(() => {
        e.refreshing = false;
      });
  };
  const get = (key: string, ...a: A): Promise<R> => {
    const e = m.get(key);
    if (!e) return load(key, a, false).p;
    if (!e.value) return e.p; // first load still running
    if (Date.now() - e.at >= ttlMs && !e.refreshing) refresh(key, e as Entry<R> & { value: { v: R } }, a);
    return Promise.resolve(e.value.v);
  };
  get.peek = (key: string, ...a: A): R | undefined => {
    const e = m.get(key);
    if (!e) {
      load(key, a, true);
      return undefined;
    }
    if (e.value && Date.now() - e.at >= ttlMs && !e.refreshing) refresh(key, e as Entry<R> & { value: { v: R } }, a);
    return e.value?.v;
  };
  return get;
}
