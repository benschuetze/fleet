import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, fleetHome } from "./paths";

/**
 * Language of texts the server and the hook write (warnings, decision texts, prompts for new sessions). The
 * dashboard has its own dictionary and starts with the same language.
 *
 * Order: FLEET_LANG, then "language" in config.json, then the system language the server stored at its start
 * (Node does not see the macOS setting; asking the OS on every hook call would be too slow), then LANG/LC_*,
 * then English.
 */
export type Lang = "de" | "en";

const pick = (v: unknown): Lang | null => {
  const s = String(v || "").toLowerCase();
  return /^de/.test(s) ? "de" : /^en/.test(s) ? "en" : null;
};
const langFile = () => path.join(fleetHome(), "language");

let cached: { home: string; lang: Lang } | null = null;

/** The language picked in the dashboard (round 5): Fleet speaks one language, the one the user chose last. */
let chosen: Lang | null = null;

export function lang(): Lang {
  const forced = pick(process.env.FLEET_LANG);
  if (forced) return forced;
  if (chosen) return chosen;
  const home = fleetHome();
  if (cached && cached.home === home) return cached.lang;
  let l: Lang | null = null;
  for (const p of [path.join(APP_DIR, "config.json"), path.join(home, "config.json")]) {
    try {
      l = pick(JSON.parse(fs.readFileSync(p, "utf8"))?.language);
      break;
    } catch {
      // no config here
    }
  }
  if (!l) {
    try {
      l = pick(fs.readFileSync(langFile(), "utf8").trim());
    } catch {
      // not stored yet
    }
  }
  l =
    l ||
    pick(process.env.LC_ALL) ||
    pick(process.env.LC_MESSAGES) ||
    pick(process.env.LANG) ||
    pick(Intl.DateTimeFormat().resolvedOptions().locale) ||
    "en";
  cached = { home, lang: l };
  return l;
}

/** The server asks the OS once at start and stores the answer for the hook. */
export function storeSystemLanguage(): void {
  let sys: Lang | null = null;
  try {
    if (process.platform === "darwin")
      sys = pick(execFileSync("defaults", ["read", "-g", "AppleLocale"], { encoding: "utf8", timeout: 3000 }).trim());
  } catch {
    // no macOS setting
  }
  sys =
    sys || pick(process.env.LC_ALL) || pick(process.env.LANG) || pick(Intl.DateTimeFormat().resolvedOptions().locale);
  if (!sys) return;
  try {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(langFile(), sys, { mode: 0o600 });
    cached = null;
  } catch {
    // the hook falls back to LANG
  }
}

/**
 * The dashboard's choice: the server's texts follow at once, the hook too (it reads the stored language). FLEET_LANG
 * still wins; the answer says which language holds.
 */
export function chooseLanguage(v: unknown): Lang | null {
  const l = v === "de" || v === "en" ? v : null;
  if (!l) return null;
  chosen = l;
  cached = null;
  try {
    fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(langFile(), l, { mode: 0o600 });
  } catch {
    // the server follows anyway
  }
  return lang();
}

/** Picks the German or English variant. Both stand next to each other at the call site. */
export const tr = (de: string, en: string): string => (lang() === "de" ? de : en);

export const locale = () => (lang() === "de" ? "de-DE" : "en-GB");
