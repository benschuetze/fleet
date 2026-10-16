import { useEffect, useRef, useState } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { hit, type Mode } from "~/lib/keymap";
import { getTheme, onTheme, SETTINGS_EVENT, setTheme, type Theme } from "~/lib/theme";
import { Icon } from "./icons";

/** Light, dark or following the system; the palette's `theme` command sets the same (lib/theme.ts). */
export function ThemeSwitch() {
  const { t } = useI18n();
  const [theme, setShown] = useState<Theme>(getTheme);
  useEffect(() => onTheme(() => setShown(getTheme())), []);
  const opts: { id: Theme; icon: "sun" | "moon" | "monitor"; label: string }[] = [
    { id: "light", icon: "sun", label: t("Hell", "Light") },
    { id: "dark", icon: "moon", label: t("Dunkel", "Dark") },
    { id: "system", icon: "monitor", label: "System" },
  ];
  return (
    <fieldset className="theme" aria-label={t("Farbschema", "Colour scheme")}>
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          className={theme === o.id ? "on" : ""}
          aria-pressed={theme === o.id}
          title={o.label}
          onClick={() => setTheme(o.id)}
        >
          <Icon name={o.icon} />
          <span> {o.label}</span>
        </button>
      ))}
    </fieldset>
  );
}

export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <fieldset className="theme" aria-label={t("Sprache", "Language")}>
      {(["de", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className={lang === l ? "on" : ""}
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          title={l === "de" ? "Deutsch" : "English"}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * The gear: language and colour scheme live behind it, so the header keeps only what changes while working.
 * The panel stays mounted (hidden) so the theme applies on load as before; Escape and a click outside close it.
 */
export function SettingsMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The first-run hint's "change" opens the panel at the keyboard mode.
    const show = () => {
      setOpen(true);
      setTimeout(() => document.getElementById("keymode-standard")?.focus(), 0);
    };
    window.addEventListener(SETTINGS_EVENT, show);
    return () => window.removeEventListener(SETTINGS_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (!hit(e, "close")) return;
      // First, so the page's Escape does not also close the drawer behind the panel.
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down);
    };
  }, [open]);
  return (
    <div className="settings" ref={box}>
      <button
        ref={button}
        type="button"
        className={`iconbtn ${open ? "on" : ""}`}
        aria-label={t("Einstellungen", "Settings")}
        title={t(
          "Einstellungen: Sprache, Farbschema, Benachrichtigungen",
          "Settings: language, colour scheme, notifications",
        )}
        aria-expanded={open}
        aria-controls="settings-panel"
        onClick={() => setOpen(!open)}
      >
        <Icon name="gear" />
      </button>
      <div id="settings-panel" className="settings-panel" hidden={!open}>
        <span className="px">{t("Sprache", "Language")}</span>
        <LanguageSwitch />
        <span className="px">{t("Farbschema", "Colour scheme")}</span>
        <ThemeSwitch />
        <span className="px">{t("Tastaturmodus", "Keyboard mode")}</span>
        <KeyModeSwitch />
        <span className="px">{t("Benachrichtigungen", "Notifications")}</span>
        <NotifySwitch />
        <span className="px">{t("Terminal im Fenster", "Terminal in the window")}</span>
        <TerminalInfo />
      </div>
    </div>
  );
}

/** Standard or Vim keys; the palette's `mode` command sets the same (lib/keyboard.tsx). */
function KeyModeSwitch() {
  const { t } = useI18n();
  const { mode, setMode } = useKeys();
  const opts: { id: Mode; label: string; hint: string }[] = [
    { id: "standard", label: "Standard", hint: t("Pfeile, Enter, Buchstaben", "Arrows, Enter, letters") },
    { id: "vim", label: "Vim", hint: t("hjkl, gg, :, V, .", "hjkl, gg, :, V, .") },
  ];
  return (
    <fieldset className="theme" aria-label={t("Tastaturmodus", "Keyboard mode")}>
      {opts.map((o) => (
        <button
          key={o.id}
          id={`keymode-${o.id}`}
          type="button"
          className={mode === o.id ? "on" : ""}
          aria-pressed={mode === o.id}
          title={o.hint}
          onClick={() => mode !== o.id && setMode(o.id)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Can Fleet run Claude in its own window here, and if not, why (pty module, CLI, login). */
function TerminalInfo() {
  const { t } = useI18n();
  const { data } = useFleet();
  const st = data?.terminal;
  return (
    <span className="hint" data-testid="terminal-info">
      {!st
        ? "–"
        : st.available
          ? t(`verfügbar, bis ${st.max} Sessions`, `available, up to ${st.max} sessions`)
          : `${t("nicht verfügbar", "not available")}: ${st.why || "?"}`}
    </span>
  );
}

/**
 * Desktop notifications when a session needs you, finished or failed. A setting behind the gear: the header keeps
 * only the gear (spec), and what needs you is counted there already.
 */
function NotifySwitch() {
  const { t } = useI18n();
  const { prefs, setPref, showToast } = useFleet();
  const toggle = async () => {
    if (!("Notification" in window))
      return showToast(t("Dieser Browser kann keine Benachrichtigungen", "This browser cannot show notifications"));
    if (!prefs.notify && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted")
        return showToast(t("Benachrichtigungen sind im Browser blockiert", "Notifications are blocked in the browser"));
    }
    setPref("notify", !prefs.notify);
    showToast(
      prefs.notify ? t("Benachrichtigungen aus", "Notifications off") : t("Benachrichtigungen an", "Notifications on"),
    );
  };
  return (
    <button
      type="button"
      className={`ghost ${prefs.notify ? "on" : ""}`}
      title={t(
        "Desktop-Benachrichtigung, wenn eine Session dich braucht",
        "Desktop notification when a session needs you",
      )}
      aria-pressed={prefs.notify}
      onClick={toggle}
    >
      <Icon name="bell" />
      {t("Desktop-Benachrichtigungen", "Desktop notifications")}
    </button>
  );
}
