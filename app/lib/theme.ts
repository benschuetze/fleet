import { load, save } from "./store";

/**
 * Light, dark or the system's choice; stored per browser and applied before the first paint (root.tsx). One
 * setter for the gear and the palette (`theme dark`), so both always show the same.
 */
export type Theme = "light" | "dark" | "system";
const EVENT = "fleet:theme";

export function getTheme(): Theme {
  const v = load<string>("theme");
  return v === "light" || v === "dark" ? v : "system";
}

export function setTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  save("theme", theme);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onTheme(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** The gear's panel opens from elsewhere too (the first-run bar's "change"). */
export const SETTINGS_EVENT = "fleet:settings";
export const openSettings = () => window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
