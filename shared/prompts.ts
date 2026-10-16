/**
 * Which "prompts" did the user not type? Shared by the hook (UserPromptSubmit) and the transcript reader, so
 * both agree on what a new turn of the user is. Kept tiny: the hook bundles it.
 */

/** Local commands and context lines: no turn for Claude at all. */
export const LOCAL_PROMPT_RE = /^<(bash-|local-command|command-|system-reminder|user-memory)/;

/**
 * Messages the app injects on its own (CI monitor, side-session notes, messages from other sessions, background
 * task notifications). They start a short turn of their own but are no answer of the user: an open question
 * stays open and they are never the session's task text. `<…-event>` covers further Desktop events of the
 * same shape.
 */
// A subagent's report and the note that a watched session went idle start with Claude Code's own words, not a tag
// (fleet audit, round 5: an open okay was lost for 11 and 76 min).
export const AUTO_PROMPT_RE =
  /^(<(task-notification|cross-session-message|[a-z][\w-]*-event)[\s>]|Another Claude session sent a message:|\[Cross-session [a-z ]+\])/;

/**
 * The prompt without the context the app puts in front of it (`<system-reminder>Linked sessions now …`): the
 * Desktop app adds it to prompts the user typed, so it must not make them look injected (fleet audit 16.10.2026:
 * an answered box stayed "wartet" for 26 min). Empty when there is nothing else.
 */
export const ownText = (text: string) =>
  text.replace(/^\s*(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, "").trim();

/** Any prompt the user did not type. */
export const isInjectedPrompt = (text: string) => {
  const t = ownText(text);
  return !t || LOCAL_PROMPT_RE.test(t) || AUTO_PROMPT_RE.test(t);
};
