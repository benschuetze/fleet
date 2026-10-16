import type { JobResult, Proc } from "../../shared/types";
import { post } from "./api";

/**
 * Client for /api/term: output arrives as server-sent events with Base64 chunks, input goes back as POST. What
 * the server sends is checked like any input (run.ts): an odd event costs that chunk, never the page.
 */

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The exit event: `{ code }` with a number or null. */
export function exitCode(data: unknown): number | null {
  try {
    const j = JSON.parse(String(data)) as { code?: unknown };
    return typeof j.code === "number" && Number.isInteger(j.code) ? j.code : null;
  } catch {
    return null;
  }
}

export const streamUrl = (id: string) => `/api/term/stream?id=${encodeURIComponent(id)}`;
export const sendInput = (id: string, text: string) => post("/api/term/input", { id, data: toBase64(text) });
export const sendResize = (id: string, cols: number, rows: number) => post("/api/term/resize", { id, cols, rows });
export const sendKill = (id: string, signal: "int" | "term") => post("/api/term/kill", { id, signal });

/** A finished job in the overview: its exact numbers, or null while it runs. */
export function jobDone(procs: Proc[] | undefined, id: string): JobResult | null {
  const p = (procs || []).find((x) => x.id === id && x.kind === "job");
  return p && p.status !== "running" && p.status !== "starting" && p.result ? p.result : null;
}
