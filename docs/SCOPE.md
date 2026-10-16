# Scope after 6.0.0 (frozen)

An independent review of 6.0.0 judged Fleet worth it only with a frozen scope: its strength is the waiting
detection (0 missed waits in 259 cases), and 33,000 lines are a lot to keep working against a Claude Code that
changes every week. From 6.0.0 on, Fleet grows only by fixes. What stays is decided by use, not by taste.

## Areas

| Area | Features | Rule |
| --- | --- | --- |
| **Core** | Who waits (Now view, alarm zone, waiting detection, hook), answering questions and approvals in Fleet, conflicts between sessions and PRs, start fresh with a handoff | Kept. Every fix here first gets a test (`tests/waiting-cases.test.ts` for waiting). |
| **Replacing the desktop app** | Claude in Fleet's terminal (`i`, `:new`, `:here`, `:wt`, `fleet` in a folder; a second session in a repo in its own worktree), a session's conversation in its drawer, diff and files, open in app or editor, log view, clear and `:cleanup` | Kept for the two test weeks; after them, what was not used goes. |
| **Extras** | Usage and Fleet balance, activity, Repos & PRs, merging PRs, CI rerun and fix sessions, week report, architecture folder, project briefing, pinning and naming sessions | Candidates to cut first. |

The same list, with the keys that show each feature in use, is `FEATURES` in `server/core/scope.ts`; a test fails
when an API route belongs to no feature (`tests/scope.test.ts`).

## How it is decided

1. During the test weeks Fleet counts locally which views, commands, keys and API features are used
   (`~/.claude-fleet/feature-use.json`, counts per day, never text).
2. After two weeks: `node dist/fleet.cjs scope --days 14`. A feature outside the core with 0 uses is cut in the next minor;
   one used rarely gets a hard look.
3. `node dist/fleet.cjs balance` says per week whether Fleet saves money – against going on in the old session and
   against `/compact`. `node dist/fleet.cjs compat` says whether it still fits the Claude Code versions in use.

## Rules until then

- No new features. Fixes, tests, docs and cuts only.
- Exception 6.1.0: worktrees (a second session in a repo starts in its own worktree, `:wt`, `:cleanup` offers
  merged ones; route `/api/worktrees`) and the local pre-push gate with a lean PR CI (Ben, 16.10.2026).
- The source (`app`, `server`, `hooks`, `shared`; `.ts`, `.tsx`, `.css` without tests) stays within
  `size-budget.json`. Raising it needs a reason in the same commit; cutting a feature lowers it.
- A new API route needs a feature in `server/core/scope.ts` (or a place in `NOT_COUNTED`) and a line here.

## Candidates after 6.1.0 (only after the test weeks)

Ideas from a review on 16.10.2026 of the two weak spots: start fresh does not pay against `/compact`
(+18.71 $ against going on, −1.30 $ against `/compact`), and replacing the desktop app holds most of the code and
most of the coupling to Claude Code internals. On purpose not in 6.0.x: they are features (frozen scope), they
would change Fleet's behaviour in the middle of the measurement, and the hook change hits every session at once.
Decide them with the numbers from `balance` and `scope`, one PR each.

1. **Recommend start fresh or `/compact` per case.** Fleet knows both costs (handoff plus a small new context,
   against old context plus summary); the row and the session drawer offer the cheaper one. Then the balance cannot
   go negative against `/compact` by construction. Cheaper handoffs: start fresh at task boundaries (PR merged, step
   done), a short fixed handoff form, and hand off right after the last turn while the cache is warm. First check
   whether −1.30 $ is noise: the `/compact` side rests on the median of only 6 compactions. Worth measuring too
   whether a fresh start ends in fewer turns and errors than `/compact` – that may be its real case, not dollars.
2. **Detect questions and approvals by hook, `screen.ts` as the fallback.** Screen patterns are the most brittle
   interface (then `~/.claude/sessions/<pid>.json`, then transcripts; hooks and the status line are documented).
   Use the hook events for approvals and notifications first and keep `screen.ts` only for sessions without hooks.
   Through the skill `hook-change`, with every case in `tests/waiting-cases.test.ts` and `fleet audit` at 0 missed
   before the merge. Later option: jobs and fix sessions nobody types into could run on the Agent SDK
   (structured approvals via `canUseTool`); interactive sessions stay in the real `claude` TUI.
3. **Cut by `fleet scope`, hand off instead of rebuilding.** Whatever the test weeks show unused goes, the parts
   that only rebuild the desktop app first. Where a feature stays, prefer "open in" (editor, `git difftool`, `gh`)
   over Fleet's own viewer. Keep each remaining coupling to Claude Code in one adapter module with a contract test,
   so that a format change breaks one module; `fleet compat` is the start of that.
4. **Structure without behaviour change.** From a code review on 16.10.2026, checked against `main`. Not in 6.0.x:
   nothing a user sees changes, and reshaping the waiting detection right before the release would void the
   practice-test rounds. Do it after item 3, so that nothing gets moved that is cut anyway; one PR per step.
   - *Layer cycle:* `handoff` and `process` import from `core`, but four imports go back: `core/brake.ts` →
     `handoff/request`, `handoff/usage`; `core/overview.ts` → `handoff`; `core/status.ts` → `process/screen`
     (`LOOK_MS`). Move `LOOK_MS` and the handoff readers the overview needs into `core`, give the brake a port it
     is handed, then add a test that fails on any import from `core` into `handoff`, `process` or `http`.
   - *Long functions:* `buildOverview` (`core/overview.ts`, about 400 lines), `createFleetServer`
     (`http/server.ts`, about 250), `deriveStatus` (`core/status.ts`, about 200). Split `deriveStatus` into one
     function per rule (S, Q, stale …) through the skill `hook-change`, with `tests/waiting-cases.test.ts` and
     `fleet audit` at 0 missed unchanged. (`openNew` in `http/api.ts` is 27 lines; the review's 300 was wrong.)
   - *Flat `server/core`:* 55 files. Move the demo (`demo.ts` with 1465 lines, `demo-*.ts`) to `server/demo/`,
     so it no longer reads as core logic; group further only where it shortens imports, not for its own sake.

5. **Plan review in the decision card** (from the 6.1.0 plan, T3; postponed on 16.10.2026). "Approve plan?" shows
   the plan as a read-only buffer with line numbers and, on top, its flow as an ASCII diagram (a `## Ablauf` code
   block Claude writes, else one Fleet draws from the level-2 headings). Vim keys to move (`j/k`, counts, `gg/G`,
   `[[ ]]`, `/`), `i`/`o`/`V`+`i` comment a line or a range, `:ok` approves, `:w` sends the comments back as the
   hook's `deny` message so Claude revises, `:reject`, `:q`. Round two marks changed lines (`+`/`~`) and shows the
   old comments grey. Markdown only, never agent HTML; no new route besides `feedback` on `/api/decision`.
   `ExitPlanMode` leaves the hook's `SKIP` list behind a `planReview` switch, with its own timeout entry
   (skill `hook-change`). About +650 lines; the acceptance needs one real run in the desktop app's plan mode.
   Open: whether the hook can pass extra text with `allow` (for `:ok` with comments).
6. **Rule suggestions for CLAUDE.md from the sessions** (6.1.0 plan, T4; postponed). `fleet learn <repo>`
   collects signals of the last 14 days deterministically (corrections, interruptions, refused approvals, the
   same failing command in three sessions; secrets masked, at most 30k tokens), asks Haiku once in plan mode for
   strict JSON, and keeps a suggestion only with quotes from at least two sessions that stand word for word in the
   transcripts (at most five). Output to `~/.claude-fleet/learn/`, never into the repo; `:apply` starts a normal
   session that makes the change as a PR. CLI first; kept only if two real runs bring a rule worth taking, at under
   0.10 $ a run. About +300 lines.

## Later: phone

The phone (375 px) was left out of the 6.0.0 release on purpose; the practice test of 15.10.2026 (round 2) judged
it fit only for a look at who waits and for taking one of Fleet's suggestions. Open findings, for a later release:

- Header: counters and the 5h limit sit beyond 375 px, reachable only by an invisible sideways swipe.
- Alarm zone: no repo column, titles cut to one or two letters, actions cut mid-word, the clear `×` missing.
- Feedback after *Allow* or *Pause and rethink* shows only a few characters in the status line.
- Terminal: no key bar for Esc, `Ctrl+[`, `Ctrl+C`, `1`/`2`/`3` and Enter.
- Tab row: the marked tab does not always match the tile shown; *Details* or a tap on a stream row opens the
  drawer out of sight; the empty drawer gives a keyboard hint ("Enter on a row opens it").
- Tables cut columns without headers (usage "Where tokens are lost", repos), an active repo filter is not visible.
- Help is not reachable by tap (`?` in the command line finds nothing); targets are 20 px high, the `×` in the hint
  row 8 px, settings 16 px; "Desktop notifications" shows on the phone too.

Wishes from the same round: a card per session instead of a table, a collapsible alarm zone with swipe to clear,
*Allow*/*Deny* in the drawer, push notifications.
