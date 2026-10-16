import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fleetHome } from "../core/paths";

/**
 * The API key of this machine's Fleet (security audit H1). Loopback, Host, Origin and the X-Fleet header keep foreign
 * web pages out, but not other local processes: a Claude session taken over by a prompt injection could approve its
 * own permission request with `curl`. So every /api/ request needs this token as an HttpOnly cookie. The browser gets
 * it once per profile through the link `fleet start`/`fleet open` opens (`/pair?t=…`); it lives in
 * ~/.claude-fleet/token (0600) and stays the same across restarts, so a paired browser stays paired. The demo has no
 * real effects and needs no token.
 */

export const COOKIE = "fleet_t";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const tokenFile = () => path.join(fleetHome(), "token");

export function loadToken(): string {
  try {
    const t = fs.readFileSync(tokenFile(), "utf8").trim();
    if (TOKEN_RE.test(t)) return t;
  } catch {
    // first start
  }
  const t = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  const tmp = `${tokenFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, t, { mode: 0o600 });
  fs.renameSync(tmp, tokenFile());
  return t;
}

/** The token if one exists, without creating it (the launcher of an older running instance). */
export function readToken(): string {
  try {
    const t = fs.readFileSync(tokenFile(), "utf8").trim();
    return TOKEN_RE.test(t) ? t : "";
  } catch {
    return "";
  }
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function hasToken(req: http.IncomingMessage, token: string): boolean {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE && same(part.slice(i + 1).trim(), token)) return true;
  }
  return false;
}

export const tokenMatches = (t: unknown, token: string) => typeof t === "string" && same(t, token);

/** The cookie a paired browser keeps: never readable by scripts, never sent cross-site, a year long. */
export const tokenCookie = (token: string) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

/** The link that pairs a browser and then shows `hash` (e.g. "#decision"). Without a token, the plain URL. */
export function pairUrl(base: string, hash = ""): string {
  const t = readToken();
  return t ? `${base}/pair?t=${t}${hash}` : `${base}/${hash}`;
}
