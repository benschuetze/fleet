import fs from "node:fs";
import path from "node:path";
import type { ArchDoc } from "../../shared/types";

/**
 * The architecture notes of a repo for the repo drawer: the private Architekturmappe (.architektur/README.md,
 * gitignored) first, then the usual public files. Only these fixed names inside the repo root; a link that leads
 * out of the repo is not followed. The text goes to the browser as Markdown and is rendered there without HTML.
 */

export const ARCH_FILES = [".architektur/README.md", "ARCHITECTURE.md", "docs/ARCHITECTURE.md"];
export const ARCH_MAX = 64 * 1024;

const inside = (root: string, p: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function real(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

export function readArchitecture(root: string): ArchDoc {
  const base = real(root);
  const none: ArchDoc = { file: null, text: null, truncated: false, mappe: false };
  if (!base) return none;
  const ok = (rel: string) => {
    const p = real(path.join(base, rel));
    if (!p || !inside(base, p)) return null;
    try {
      return fs.statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  };
  const mappe = !!ok(".architektur/mappe.html");
  for (const rel of ARCH_FILES) {
    const p = ok(rel);
    if (!p) continue;
    try {
      const fd = fs.openSync(p, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, ARCH_MAX));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        // A cut in the middle of a multi-byte character would end in a replacement character; drop it.
        const text = buf.subarray(0, n).toString("utf8").replace(/�+$/, "");
        return { file: rel, text, truncated: size > ARCH_MAX, mappe };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // unreadable: try the next name
    }
  }
  return { ...none, mappe };
}
