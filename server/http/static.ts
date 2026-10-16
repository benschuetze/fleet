import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_DIR } from "../core/paths";

/**
 * Serves the dashboard: the static React Router build (SPA mode) from build/client. Client routes get index.html;
 * hashed assets are cached for good. The CSP allows exactly the inline scripts of index.html (by hash) and
 * scripts from our own origin, nothing else.
 */

const CLIENT = path.join(APP_DIR, "build", "client");
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
/** Client-side routes of the dashboard; everything else is a file or 404. */
export const ROUTES = new Set(["/", "/repos", "/usage", "/activity"]);

let page: { mtime: number; buf: Buffer; csp: string } | null = null;

export function indexPage(): { buf: Buffer; csp: string } | null {
  const f = path.join(CLIENT, "index.html");
  let mtime: number;
  try {
    mtime = fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
  if (page && page.mtime === mtime) return page;
  const html = fs.readFileSync(f, "utf8");
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.trim())
    .map((s) => `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`);
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  page = { mtime, buf: Buffer.from(html), csp };
  return page;
}

const files = new Map<string, Buffer>();

/** A file below build/client, never outside it. */
export function asset(pathname: string): { buf: Buffer; type: string; immutable: boolean } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!rel || rel.includes("\0")) return null;
  const file = path.resolve(CLIENT, rel);
  if (!file.startsWith(CLIENT + path.sep)) return null;
  const type = TYPES[path.extname(file)];
  if (!type) return null;
  let buf = files.get(file);
  if (!buf) {
    try {
      buf = fs.readFileSync(file);
    } catch {
      return null;
    }
    if (files.size < 500) files.set(file, buf);
  }
  return { buf, type, immutable: rel.startsWith("assets/") };
}
