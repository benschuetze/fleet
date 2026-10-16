import { locale, tr } from "../lang";

/** The one way Fleet talks to Git host APIs: no redirects, size limits, ETags, rate-limit bookkeeping. */

// biome-ignore lint/suspicious/noExplicitAny: answers of foreign APIs, read defensively field by field
export type Json = Record<string, any>;

const MAX_BODY = 5 * 1024 * 1024;
const etags = new Map<string, { etag: string; body: unknown }>();
/** Host -> time after a rate limit from which it is asked again. */
export const blockedUntil = new Map<string, number>();

export const clock = (t: number) => new Date(t).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

export class RetryError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

export async function http(url: string, headers: Record<string, string> = {}, timeout = 10000): Promise<Json> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const prev = etags.get(url);
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": "claude-fleet", ...headers };
  if (prev) h["If-None-Match"] = prev.etag;
  try {
    const res = await fetch(url, { headers: h, signal: ctrl.signal, redirect: "error" });
    const host = new URL(url).host;
    if (res.status === 304 && prev) return prev.body as Json; // does not count against GitHub's rate limit
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      const reset =
        Number(res.headers.get("x-ratelimit-reset")) * 1000 ||
        Date.now() + (Number(res.headers.get("retry-after")) || 300) * 1000;
      blockedUntil.set(host, reset);
      const anon = !(headers.Authorization || headers["PRIVATE-TOKEN"]);
      throw new RetryError(
        tr(
          `Rate-Limit erreicht – weiter ab ${clock(reset)}${anon ? " (Token hinterlegen!)" : ""}`,
          `Rate limit reached, resuming at ${clock(reset)}${anon ? " (add a token!)" : ""}`,
        ),
        reset,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(
        tr(`Keine Berechtigung (${res.status}) – Token prüfen`, `Not allowed (${res.status}), check the token`),
      );
    if (res.status === 404)
      throw new Error(
        tr("Nicht gefunden (404) – privates Repo? Token prüfen", "Not found (404): private repo? Check the token"),
      );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BODY) throw new Error(tr("Antwort zu groß", "Response too large"));
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error(tr("Antwort zu groß", "Response too large"));
    const body = JSON.parse(text) as Json;
    const etag = res.headers.get("etag");
    if (etag) {
      etags.set(url, { etag, body });
      const oldest = etags.keys().next().value;
      if (etags.size > 1000 && oldest !== undefined) etags.delete(oldest);
    }
    return body;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(tr("Zeitüberschreitung", "Timed out"));
    if (
      e instanceof TypeError &&
      /redirect/i.test(String((e.cause instanceof Error && e.cause.message) || e.message))
    ) {
      throw new Error(tr("Umleitung blockiert (Token-Schutz)", "Redirect blocked (token protection)"));
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const safeUrl = (u: unknown) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
export const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
