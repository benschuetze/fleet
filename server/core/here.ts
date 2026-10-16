import fs from "node:fs";
import path from "node:path";
import { fleetHome } from "./paths";

/**
 * `fleet` typed in a terminal (no arguments) opens Fleet for the folder it was typed in: Fleet starts if needed, the
 * folder's repo is chosen, and Claude can start right there. The CLI notes the folder here; the server shows it, and
 * starts Claude only in exactly this folder (the browser names it, but cannot pick any other path).
 */

export const HERE_TTL = 12 * 3600e3;
const file = () => path.join(fleetHome(), "here.json");

export interface Here {
  dir: string;
  at: number;
}

const valid = (dir: unknown): dir is string =>
  typeof dir === "string" && dir.length < 4096 && !dir.includes("\0") && path.isAbsolute(dir);

export function writeHere(dir: string, now = Date.now()): Here {
  const real = fs.realpathSync(dir);
  if (!valid(real) || !fs.statSync(real).isDirectory()) throw new Error(`not a folder: ${dir}`);
  fs.mkdirSync(fleetHome(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  const here = { dir: real, at: now };
  fs.writeFileSync(tmp, JSON.stringify(here), { mode: 0o600 });
  fs.renameSync(tmp, file());
  return here;
}

export function readHere(now = Date.now()): Here | null {
  try {
    const h = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!h || !valid(h.dir) || typeof h.at !== "number" || now - h.at > HERE_TTL || h.at > now + 60e3) return null;
    return fs.statSync(h.dir).isDirectory() ? { dir: h.dir, at: h.at } : null;
  } catch {
    return null;
  }
}
