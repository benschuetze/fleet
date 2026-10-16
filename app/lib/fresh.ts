/**
 * Which alarms are new (spec, "Ein Schirm im CLI-Look", rule 16; ISA-101): blinking is kept for an alarm that has
 * just come up. What already stood there when the page first saw the data is not new, nor is an alarm that only
 * re-rendered; one that went away and comes back is new again. Three beats of 1 Hz, then it stands.
 */
export const BLINK_MS = 3000;

export class Fresh {
  private known: Set<string> | null = null;
  private since = new Map<string, number>();

  /** The keys on screen now; returns those that came up less than BLINK_MS ago. */
  seen(keys: string[], now: number): Set<string> {
    const before = this.known;
    this.known = new Set(keys);
    for (const k of this.since.keys()) if (!this.known.has(k)) this.since.delete(k);
    if (!before) return new Set();
    for (const k of keys) if (!before.has(k)) this.since.set(k, now);
    return new Set(keys.filter((k) => now - (this.since.get(k) ?? Number.NEGATIVE_INFINITY) < BLINK_MS));
  }
}

/** The alarm zone's memory, for as long as the page lives. */
export const freshAlarms = new Fresh();
