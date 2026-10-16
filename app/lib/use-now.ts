import { useEffect, useState } from "react";

/** The current time, re-read every `ms`: relative times and countdowns tick without reloading data. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
