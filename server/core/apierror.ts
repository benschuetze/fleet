import type { Failure, FailureKind } from "../../shared/types";
import { locale, tr } from "./lang";

/**
 * Why a turn broke off, from two sources: the transcript (Claude Code writes API errors as synthetic assistant
 * lines, also where no StopFailure hook fires, e.g. an expired login in the desktop app) and the StopFailure
 * hook (`error` is an enum, `error_details` free text). The kind decides the one action that helps: log in
 * again, continue after the limit, raise the spend limit, or restart.
 */

// biome-ignore lint/suspicious/noExplicitAny: a transcript line (internal format, unchecked)
type Line = Record<string, any>;

const ERROR_TEXT =
  /\bAPI Error\b|hit your .{0,20}limit|spend limit|authenticat|\bOAuth\b|\/login\b|API key|overloaded/i;
const SPEND = /spend limit|billing|account (is )?on hold|credit balance/i;
const AUTH = /authenticat|\bOAuth\b|\/login\b|API key|unauthori[sz]ed|\b401\b/i;
const LIMIT = /hit your .{0,20}limit|rate.?limit|usage limit|\b429\b/i;
const CLAUDE_URL = /https:\/\/claude\.ai\/[^\s"'<>)\]]*/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** An API error line from the transcript, or null (also for synthetic lines that are no error). */
export function classifyLine(o: Line): Failure | null {
  if (o?.type !== "assistant" || !o.message) return null;
  const text = textOf(o.message.content);
  const synthetic = o.message.model === "<synthetic>";
  if (o.isApiErrorMessage !== true && !(synthetic && ERROR_TEXT.test(text))) return null;
  const at = Date.parse(o.timestamp) || 0;
  const q = o.quotaLimits && typeof o.quotaLimits === "object" ? o.quotaLimits : null;
  const status = Number(o.apiErrorStatus) || null;
  const raw = oneLine(text || (status ? `API Error ${status}` : "API Error"), 200);
  if (SPEND.test(text)) return { kind: "spend", text: raw, at, url: CLAUDE_URL.exec(text)?.[0] ?? null };
  if (AUTH.test(text) || status === 401) return { kind: "auth", text: raw, at };
  if (q?.status === "rejected" || status === 429 || LIMIT.test(text)) {
    const r = Number(q?.resetsAt);
    return { kind: "limit", text: raw, at, resetsAt: Number.isFinite(r) && r > 0 ? (r < 1e12 ? r * 1000 : r) : null };
  }
  return { kind: "api", text: raw, at };
}

/** The StopFailure hook writes `${error}: ${error_details}`; the enum before the colon names the kind. */
export function classifyHook(detail: unknown): FailureKind {
  const e = String(detail || "")
    .split(/[:\s·]/)[0]
    ?.trim();
  if (e === "rate_limit") return "limit";
  if (e === "authentication_failed" || e === "oauth_org_not_allowed" || e === "cloud_credential_error") return "auth";
  if (e === "billing_error" || e === "account_on_hold") return "spend";
  return "api";
}

const clock = (ts: number, now: number) =>
  ts - now < 20 * 3600e3
    ? new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })
    : new Date(ts).toLocaleString(locale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** The cause in one sentence, in the server's language. */
export function describe(f: Pick<Failure, "kind" | "text" | "resetsAt">, now: number): string {
  switch (f.kind) {
    case "limit":
      if (!f.resetsAt) return tr("Limit erreicht", "Limit reached");
      return f.resetsAt > now
        ? tr(`Limit erreicht, frei ab ${clock(f.resetsAt, now)}`, `Limit reached, free from ${clock(f.resetsAt, now)}`)
        : tr("Limit war erreicht, jetzt wieder frei", "Limit was reached, free again now");
    case "spend":
      return tr("Monatliches Ausgabenlimit erreicht", "Monthly spend limit reached");
    case "auth":
      return tr("Anmeldung abgelaufen", "Login expired");
    case "stuck":
    case "crash":
      return f.text;
    default: {
      const rest = oneLine(String(f.text || "").replace(/^API Error:?\s*/i, ""), 160);
      return `${tr("API-Fehler", "API error")}${rest ? `: ${rest}` : ""}`;
    }
  }
}
