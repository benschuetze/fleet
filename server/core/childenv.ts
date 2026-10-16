/**
 * The environment for a `claude` that Fleet starts. Fleet itself is often started from inside a Claude Code
 * session (Desktop app, terminal), and then carries that session's markers: CLAUDE_CODE_CHILD_SESSION turns off
 * transcript saving in every child, CLAUDE_CODE_SESSION_ID and the messaging socket point at the parent,
 * CLAUDE_CODE_SIMPLE and the SDK flags change the interface. A session in Fleet's window must start as clean as
 * one the user starts in a terminal (live probe 2026-10-15: "Transcript saving is off – inherited
 * CLAUDE_CODE_CHILD_SESSION marker").
 *
 * User configuration that people export on purpose stays (provider switches, auth helpers, output limits,
 * telemetry, proxies of their own).
 */

const MARKER =
  /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_AGENT_SDK_\w+|CLAUDE_PREVIEW_\w+|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/;

/** Documented settings a user sets on purpose; everything else under the prefixes above belongs to a session. */
const USER_CONFIG =
  /^CLAUDE_CODE_(USE_\w+|SKIP_\w+_AUTH|MAX_OUTPUT_TOKENS|API_KEY_HELPER_TTL_MS|CLIENT_\w+|SHELL|SHELL_PREFIX|DISABLE_NONESSENTIAL_TRAFFIC|ENABLE_TELEMETRY|OTEL_\w+|EXTRA_BODY|GIT_BASH_PATH|TMPDIR)$/;

/** True when this environment belongs to a Claude Code session (the host's own markers are present). */
export function insideClaude(env: NodeJS.ProcessEnv): boolean {
  return !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID);
}

/** A copy without the markers of the session Fleet was started from. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inside = insideClaude(env);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (MARKER.test(k) && !USER_CONFIG.test(k)) continue;
    // The Desktop app routes its sessions through its own auth proxy; a child must use the user's login.
    if (k === "ANTHROPIC_BASE_URL" && inside && env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH) continue;
    out[k] = v;
  }
  return out;
}
