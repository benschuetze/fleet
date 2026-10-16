/**
 * Small per-browser settings (tab, theme, language, chart options) in localStorage. Private windows or blocked
 * storage throw: then the defaults apply and nothing breaks.
 */
export function load<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(`fleet.${key}`);
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`fleet.${key}`, JSON.stringify(value));
  } catch {
    // not stored, still works for this page
  }
}
