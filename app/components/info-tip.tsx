import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "~/lib/i18n";
import { hit } from "~/lib/keymap";

/**
 * An explanation one reads once: an "i" that shows it on hover (title) and, for keyboard and touch, on click.
 * Explanations never stand as card text anymore; a user who works with Fleet daily knows them after a day.
 */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    // Escape closes the tip and nothing under it (one layer per key): caught before the drawer's and the page's
    // listeners, which leave a handled key alone.
    const key = (e: KeyboardEvent) => {
      if (!hit(e, "close")) return;
      e.preventDefault();
      setOpen(false);
    };
    const pointer = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", pointer);
    };
  }, [open]);
  return (
    <span className="infotip" ref={box}>
      <button
        type="button"
        className="info"
        title={text}
        aria-label={label || t("Erklärung", "Explanation")}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        i
      </button>
      <span id={id} role="note" className="tipbox" hidden={!open}>
        {text}
      </span>
    </span>
  );
}
