import type { RunDetails, RunState } from "../../shared/types";

/**
 * Details of a pipeline run from /api/run, checked field by field. The server passes on what GitHub sends; a
 * missing or odd field must cost one line in the card, never the page.
 */

const STATES: RunState[] = ["success", "failure", "skipped", "pending", "running", "none"];
const state = (v: unknown): RunState => (STATES.includes(v as RunState) ? (v as RunState) : "none");
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown, max = 500): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 200) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseRun(raw: unknown): RunDetails | { error: string } {
  const o = obj(raw);
  if (typeof o.error === "string") return { error: o.error.slice(0, 500) };
  return {
    id: Number.isInteger(o.id) ? (o.id as number) : 0,
    url: strOrNull(o.url, 2000),
    title: str(o.title),
    workflow: str(o.workflow),
    sha: strOrNull(o.sha, 64),
    branch: strOrNull(o.branch),
    state: state(o.state),
    jobs: list(o.jobs).map((j, i) => {
      const x = obj(j);
      return {
        id: Number.isInteger(x.id) ? (x.id as number) : i,
        name: str(x.name),
        state: state(x.state),
        current: strOrNull(x.current),
        steps: list(x.steps).map((st) => ({ name: str(obj(st).name), state: state(obj(st).state) })),
        notes: list(x.notes).filter((n): n is string => typeof n === "string"),
      };
    }),
    tests: list(o.tests).filter((n): n is string => typeof n === "string"),
    log: strOrNull(o.log, 20000),
  };
}

export async function fetchRun(root: string, id: number): Promise<RunDetails | { error: string }> {
  const res = await fetch(`/api/run?root=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}`);
  return parseRun(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
}
