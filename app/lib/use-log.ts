import { useCallback, useEffect, useRef, useState } from "react";
import { mergeLog } from "../../shared/log";
import type { LogPage } from "../../shared/types";
import { useFleet } from "./fleet";
import { parseLogPage } from "./log";

/**
 * The log view's lines while it is open. Only the component of the open view calls this: closed, nothing is
 * fetched, held or drawn (spec: "solange die Log-Sicht zu ist, wird nichts gerendert"). Asks for newer lines on
 * every change the server pushes (no stream of its own: stream.ts holds the one connection) and every few seconds,
 * since a headless run without hooks pushes nothing.
 */

const POLL_MS = 2000;
const EMPTY: LogPage = { epoch: "", seq: 0, lines: [], sessions: {}, waiting: [] };

export function useLog(): LogPage & { failed: boolean } {
  const { data } = useFleet();
  const [page, setPage] = useState<LogPage>(EMPTY);
  const [failed, setFailed] = useState(false);
  const have = useRef(EMPTY);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`/api/log?after=${have.current.seq}`, { cache: "no-store" });
      const next = parseLogPage(await res.json());
      if (!res.ok || !next) throw new Error(`HTTP ${res.status}`);
      const prev = have.current;
      // A restarted server counts from the start again: what is here no longer fits its numbers.
      const same = prev.epoch === next.epoch;
      const lines = mergeLog(same ? prev.lines : [], next.lines);
      const all = { ...(same ? prev.sessions : {}), ...next.sessions };
      // Names only for the sessions still in the lines, so nothing grows while the view stays open.
      const sessions: LogPage["sessions"] = {};
      for (const l of lines) {
        const name = all[l.session];
        if (name) sessions[l.session] = name;
      }
      const merged: LogPage = {
        epoch: next.epoch,
        seq: Math.max(same ? prev.seq : 0, next.seq),
        lines,
        sessions,
        waiting: next.waiting,
      };
      have.current = merged;
      setPage(merged);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  // A change the server pushed: the overview is new, so may be the transcripts.
  useEffect(() => {
    if (data) load();
  }, [data, load]);

  return { ...page, failed };
}
