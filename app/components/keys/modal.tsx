import { type ReactNode, useEffect, useRef } from "react";
import { hit } from "~/lib/keymap";

/** A Mac shows ⌘ and ⌥ in key labels; elsewhere Ctrl and Alt. */
export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/**
 * A modal dialog for help and palette: the browser keeps the focus inside, Escape closes it (through the keymap),
 * and the focus goes back where it came from (WCAG 2.4.3).
 */
export function Modal({
  label,
  className,
  onClose,
  onKey,
  children,
}: {
  label: string;
  className: string;
  onClose: () => void;
  onKey?: (e: React.KeyboardEvent) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const d = ref.current;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) d.showModal?.();
    return () => {
      d?.close?.();
      if (back?.isConnected) back.focus();
    };
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const key = (e: KeyboardEvent) => {
      if (hit(e, "close")) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    // The browser's own Escape would close the dialog behind React's back.
    const cancel = (e: Event) => {
      e.preventDefault();
      close.current();
    };
    d.addEventListener("keydown", key);
    d.addEventListener("cancel", cancel);
    return () => {
      d.removeEventListener("keydown", key);
      d.removeEventListener("cancel", cancel);
    };
  }, []);
  return (
    <dialog ref={ref} aria-label={label} className={`modal ${className}`} onKeyDown={onKey}>
      {children}
    </dialog>
  );
}
