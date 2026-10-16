import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { post } from "./api";
import { load, save } from "./store";

/**
 * Two languages, German and English. Texts stand next to each other at the place they are used,
 * `t("Läuft gerade", "Running")`, so a reader sees both and nothing hides in a key file. The dashboard
 * starts with the server's language (the system language of the machine) until the user picks one.
 */
export type Lang = "de" | "en";

/** Fired once the server speaks the chosen language: the data store loads the overview again. */
export const LANG_CHANGED = "fleet:language";

interface I18n {
  lang: Lang;
  /** German text, English text. */
  t: (de: string, en: string) => string;
  setLang: (l: Lang) => void;
  locale: string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ serverLang, children }: { serverLang: Lang | undefined; children: ReactNode }) {
  const [chosen, setChosen] = useState<Lang | null>(() => {
    const v = load<string>("lang");
    return v === "de" || v === "en" ? v : null;
  });
  const lang: Lang =
    chosen || serverLang || (typeof navigator !== "undefined" && /^de/i.test(navigator.language) ? "de" : "en");
  const setLang = useCallback((l: Lang) => {
    save("lang", l);
    setChosen(l);
  }, []);
  // Fleet speaks the language chosen here, its server's texts too (round 5: "Permission for Bash" beside
  // "Freigabe: Bash"). Also after a server restart, which starts in the system language again.
  useEffect(() => {
    if (chosen && serverLang && chosen !== serverLang)
      post("/api/language", { lang: chosen })
        // Ask for the overview in the new words at once, not with the next push (round 7: mixed languages for seconds).
        .then(() => window.dispatchEvent(new Event(LANG_CHANGED)))
        .catch(() => {});
  }, [chosen, serverLang]);
  const value = useMemo<I18n>(
    () => ({ lang, setLang, t: (de, en) => (lang === "de" ? de : en), locale: lang === "de" ? "de-DE" : "en-GB" }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
