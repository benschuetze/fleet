# Security

Claude Fleet is a single-user tool for one machine. What it protects against and how is in the README
([Security](README.md#security)). This file lists what it does **not** protect against, so nobody relies on more.
Last independent audit: 15 Oct 2026 (release 6.0.0), read-only, with probes against a demo server.

## Report a problem

Open a private security advisory on GitHub (Security → Report a vulnerability), not a public issue.

## Known limits

- **Processes of your own user account.** The API needs a token cookie (`~/.claude-fleet/token`, `0600`), so a local
  process with only network access (`curl`) gets `401`. A process that can read files in your home folder can read
  the token, just as it could edit `~/.claude/settings.json`. Claude sessions ask before reading outside their
  project; do not allow them to read `~/.claude-fleet/` in general. If you want it enforced, add
  `"Read(~/.claude-fleet/**)"` to `permissions.deny` in `~/.claude/settings.json` yourself (Fleet does not change
  your permission rules).
- **Pairing link.** `fleet start`/`fleet open` opens `/pair?t=<token>`; the link can stay in the browser history.
  Whoever can read your browser history can also read the token file. Deleting `~/.claude-fleet/token` and
  restarting Fleet makes a new token; paired browsers then pair again with `fleet open`.
- **The demo** (`serve --demo`) has no token: it reads and writes nothing real.
- **The hook runs in every Claude session.** Sessions run a guard that loads only a self-tested copy of the build,
  and at start only from a clean `main` equal to `origin/main` (`server/core/pinhook.ts`). `fleet install-hooks`
  takes the current build on purpose; whoever runs it vouches for that build. `fleet hook off` stops the hook in
  every session.
- **Approvals held in Fleet.** While a visible, focused Fleet tab reports itself, an approval waits in Fleet (up to
  `brake.approvalSeconds`, default 45 s) and the desktop app shows no prompt of its own. Only a paired browser can
  report itself.
- **Commands in approval rows.** A permission request shows its command, file or address (up to 200 characters) in
  `~/.claude-fleet/state/`, `events.jsonl` and a browser notification. Fleet masks obvious secrets (`Bearer …`,
  `…key=`/`token=`/`password=` values, `sk-`/`ghp_`/`xox…` tokens); a secret in another shape stays readable there,
  as it already is in the transcript.
- **Git filters.** `git status` and the diff view (`git diff` against the working tree) may run clean filters a
  repo configures (e.g. Git LFS), only in repos where Claude already works. Exploiting it needs write access to
  that repo's `.git/config`.
- **Text from outside reaches Claude.** CI logs, PR titles and branch names are shown and, for "Fix", handed to a new
  session as quoted data with the instruction to treat them as data (`server/core/pipeline.ts`). A model can still be
  swayed by them; Fleet starts such a session in `auto` instead of `bypassPermissions`.
- **Native terminal module.** The optional `@lydell/node-pty` is pinned to an exact (beta) version and is the only
  dependency with native code; without it Fleet runs without the terminal in the window.
