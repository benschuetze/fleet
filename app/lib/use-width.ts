import { type RefObject, useEffect, useState } from "react";

/** Width of an element, kept up to date: charts draw at their real width so text and bars are not scaled. */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback = 900): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth || fallback);
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return w;
}
