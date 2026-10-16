import type http from "node:http";
import { hasToken } from "./token";

/**
 * Security model: the server only listens on loopback. On top of that every request must carry an expected
 * Host header (against DNS rebinding), cross-site pages may neither read nor write (Origin, Sec-Fetch-Site),
 * and writes need a custom header plus a JSON body, which forces a CORS preflight (against CSRF). Against other
 * local processes every API request needs the token cookie (token.ts); only /api/health stays open for launchers.
 */

export const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
};

export class Guard {
  private hosts = new Set<string>();
  private token = "";

  requireToken(token: string): void {
    this.token = token;
  }

  tokenValue(): string {
    return this.token;
  }

  allowPort(port: number): void {
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  }

  /** Returns an error status and text, or null when the request may pass. */
  check(req: http.IncomingMessage, pathname: string): { status: number; error: string } | null {
    // 1) DNS rebinding: only expected Host headers.
    if (!this.hosts.has(String(req.headers.host || "").toLowerCase())) return { status: 421, error: "unexpected host" };
    // 2) Foreign pages may neither read nor write.
    if (!this.origin(req.headers.origin)) return { status: 403, error: "foreign origin" };
    // API only from our own page (browsers set Sec-Fetch-Site; links from outside to "/" stay allowed).
    const sfs = req.headers["sec-fetch-site"];
    if (pathname.startsWith("/api/") && sfs && !["same-origin", "none"].includes(String(sfs)))
      return { status: 403, error: "foreign origin" };
    // 3) Writes: a custom header and JSON force a CORS preflight that foreign pages never pass.
    if (req.method === "POST" && req.headers["x-fleet"] !== "1") return { status: 403, error: "forbidden" };
    // 4) Other local processes: the API only with the token cookie of a paired browser (audit H1).
    if (this.token && pathname.startsWith("/api/") && pathname !== "/api/health" && !hasToken(req, this.token))
      return { status: 401, error: "not paired" };
    return null;
  }

  private origin(o: string | undefined): boolean {
    if (!o) return true; // same origin on GET without Origin
    try {
      const u = new URL(o);
      return u.protocol === "http:" && this.hosts.has(u.host);
    } catch {
      return false;
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readJson(req: http.IncomingMessage, limit = 20000): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || "")))
    throw new HttpError(415, "Content-Type must be application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const j: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid JSON");
}

export function send(
  res: http.ServerResponse,
  code: number,
  body: unknown,
  type = "application/json; charset=utf-8",
  extra: Record<string, string | number> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, {
    ...BASE_HEADERS,
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Length": buf.length,
    ...extra,
  });
  if (res.req?.method === "HEAD") res.end();
  else res.end(buf);
}
