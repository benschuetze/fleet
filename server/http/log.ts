import crypto from "node:crypto";
import path from "node:path";
import { inbox, places } from "../../shared/inbox";
import type { ChatPage, LogPage } from "../../shared/types";
import { readChat } from "../core/chat";
import { loadConfig } from "../core/config";
import { demoChat, demoLog } from "../core/demo-log";
import { tr } from "../core/lang";
import { createLogReader } from "../core/log";
import { ID_RE } from "../core/paths";
import { transcriptOf } from "../core/sessions";
import type { Handler } from "./api";
import { HttpError, send } from "./security";

/**
 * The log view (Shift+L): every session's steps from the transcripts, newer than `after`. Names come from the
 * overview where it knows the session, from the transcript otherwise; which sessions wait comes from the same
 * groups as "Now" (shared/inbox.ts), so the orange line in the log and the waiting row agree.
 */

const reader = createLogReader();
/** Steps a session's drawer shows: the last screen of what it did. */
export const SESSION_STEPS = 12;
/** A restarted server numbers its lines anew; the page notices by this and starts over. */
const EPOCH = crypto.randomBytes(6).toString("hex");

export const LOG_GET: Record<string, Handler> = {
  "/api/log": async (_req, res, url, ctx) => {
    const raw = url.searchParams.get("after") || "0";
    if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, tr("after ungültig", "after invalid"));
    const after = Number(raw);
    // One session's last steps for its drawer (release 6, "what is going on"); without it every session.
    const only = url.searchParams.get("session");
    if (only !== null && !ID_RE.test(only)) throw new HttpError(400, tr("session ungültig", "session invalid"));
    const data = (await ctx.overview()).data;
    const log = ctx.demo ? demoLog() : await reader.read(loadConfig().claudeHome);
    const byId = new Map(data.sessions.map((s) => [s.id, s]));
    const lines = only
      ? log.lines.filter((l) => l.session === only && l.seq > after).slice(-SESSION_STEPS)
      : log.lines.filter((l) => l.seq > after);
    const sessions: LogPage["sessions"] = {};
    for (const l of lines) {
      if (sessions[l.session]) continue;
      const s = byId.get(l.session);
      const t = log.info.get(l.session);
      const cwd = t?.cwd || s?.cwd || null;
      sessions[l.session] = {
        name: s?.title || t?.title || null,
        project: s?.project || (cwd ? path.basename(cwd) : null),
      };
    }
    const waiting = [...places(inbox(data))].filter(([, p]) => p === "needs" || p === "decision").map(([id]) => id);
    const page: LogPage = { epoch: ctx.demo ? "demo" : EPOCH, seq: log.seq, lines, sessions, waiting };
    send(res, 200, page, undefined, { "Cache-Control": "no-store" });
  },
  // One session's conversation for its drawer, from its own transcript (server/core/chat.ts).
  "/api/chat": async (_req, res, url, ctx) => {
    const id = url.searchParams.get("session") || "";
    if (!ID_RE.test(id)) throw new HttpError(400, tr("session ungültig", "session invalid"));
    let page: ChatPage;
    if (ctx.demo) {
      const s = (await ctx.overview()).data.sessions.find((x) => x.id === id);
      page = demoChat(id, s);
    } else {
      const file = await transcriptOf(loadConfig().claudeHome, id);
      page = file ? await readChat(id, file) : { session: id, entries: [], more: false };
    }
    send(res, 200, page, undefined, { "Cache-Control": "no-store" });
  },
};
