import { readDesktop } from "../core/desktop";

/** The desktop app session behind a CLI session: its sidebar group and title, so the new session can take them over. */

function desktopOf(sid: string) {
  try {
    return readDesktop().byCli.get(sid.toLowerCase()) || null;
  } catch {
    return null;
  }
}

/** Sidebar group of the session (the new session should go into the same one). */
export function groupOf(sid: string): { id: string; name: string } | null {
  return desktopOf(sid)?.group || null;
}

/** Predecessor: the new session renames it ("· replaced") and takes its name. */
export function prevOf(sid: string): { id: string; title: string } | null {
  const d = desktopOf(sid);
  return d ? { id: d.desktopId, title: String(d.title || "") } : null;
}
