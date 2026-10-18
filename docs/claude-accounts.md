# Claude accounts

The Claude subscriptions Oracle's built-in model jobs run on: review comments,
reporting and refinement (`oracle.llm.gateway.JOBS`; the jobs themselves:
[llm-jobs.md](llm-jobs.md)). The pool copies SwarmCloud's
account management (questions P3b, the owner's instruction: "use the EXACT account
management functionality as in SwarmCloud"); the code says which SwarmCloud file each
part comes from. Agent workflows do not use it: runs execute in SwarmCloud, on
SwarmCloud's own accounts (`ORACLE_RUNTIME=swarmcloud`, the default).

## Adding an account

Settings > Claude accounts > **Add account** (owner), or `oracle account add --label
personal`:

1. Oracle starts a sign-in (`POST /v1/claude-accounts/authorize`): a 32-byte `state`
   and a PKCE verifier, kept server-side for 15 minutes, and Claude's authorize URL.
2. You sign in on Claude's page, which shows a code (`<code>#<state>`).
3. You paste it (`POST /v1/claude-accounts/exchange`). Only whoever started the sign-in
   can finish it. Oracle redeems the code (JSON, with `state`, Claude Code's User-Agent)
   and stores the credential pair encrypted.

Or paste Claude Code's saved login JSON (`POST /v1/claude-accounts`, the keychain item
"Claude Code-credentials" verbatim). A credential with no refresh token is refused.

Labels: lowercase letters, digits and dashes, starting and ending alphanumeric, at most
40 characters. Adding a label that exists replaces its credential and keeps its state,
holds and readings; an account that needed a sign-in gets back the state it had.

## How a call picks an account

`oracle.claude_accounts.accounts.choose`: AVAILABLE accounts whose credential is readable
and whose headroom is at least 15% (`DEFAULT_ASSIGN_FLOOR`); most headroom first, then
fewest jobs on it, then label. Headroom is the binding window (the least remaining), a
window past its reset counts as full, a never-read account counts as full, and a reading
older than 30 minutes (`DEFAULT_STALE_AFTER`) is halved.

When nothing qualifies, `eligibility` says why: `no_accounts_registered` (use the
fallback credential), `pool_paused` (a person), `no_account_available` (a clock, with
the earliest reset when one is known) or `no_recent_reading` (the next usage poll). Only
the first falls back; the others raise `NoClaudeAccount` with the reason.

Each call takes a **hold** (3 hours, `DEFAULT_HOLD_TTL`), recorded in the hold log
(`claude_account_holds`, kept 90 days) in the same transaction. At the call's turn
boundary: a hold marked `drain` moves first; a rejected `rate_limit_event` (the account
is spent) records the reading and moves the call to another account (`exhausted`); a
credential that will not read moves it too (`unusable`). Every reading the stream
carried is merged into the account, window by window. The hold is released when the
call ends.

## The sweep

Every five minutes (`ORACLE_CLAUDE_SWEEP_SECONDS`, `0` turns the background task off),
and on every `oracle tick`:

1. Expired holds are pruned and their records closed `expired` at their own deadline;
   hold records past retention are deleted.
2. Under the company's sweep lease (120 s, renewed before every exchange; no lease, no
   exchange), every account except REAUTH_REQUIRED ones is refreshed when its token
   expires within 3 hours. An account a job holds waits until its token is within 30
   minutes of expiry (`ORACLE_CLAUDE_HELD_REFRESH_MARGIN_SECONDS`). The rotated pair is
   written before the access token. A refresh token that is refused (`invalid_grant`)
   is confirmed with a second exchange, then the account is marked REAUTH_REQUIRED,
   remembering its state; signing in again or a successful Refresh gives it back.
3. Usage is read from Claude's `/api/oauth/usage` for at most three accounts per sweep
   (`ORACLE_CLAUDE_MAX_POLLS_PER_SWEEP`), oldest reading first; a 429 ends the round.

The lease records when the sweep last completed, which the screen shows.

## States

| State | New jobs | Jobs on it |
|---|---|---|
| AVAILABLE | yes | stay |
| PAUSED | no | stay |
| DRAINING | no | move to another account at their next turn boundary |
| REAUTH_REQUIRED | no | the sweep has stopped trying; an owner signs in again |

Owners set the first three (with a reason for PAUSED and DRAINING). A state set by a
person clears what the sweep remembered.

## The screen and the CLI

The list reads like `cs status`: label, five-hour figure, state, and when the binding
window CLEARS. `—` means not measured (never zero), `~` marks a figure that is real but
older than 30 minutes, and `reset` a window that has refilled since it was read. The
chosen account shows 5h / 7d / Clears / Last given out tiles, Holding now and History,
and an owner's controls (state with a confirm, Refresh, Sign in again, Remove by typing
the label). Every member can read the pool; only owners change it.

`oracle accounts` prints ACCOUNT | 5H USED | 7D USED | CLEARS | STATE with the footnote
`~ projected from an older reading · — not measured`. `oracle account
pause|resume|drain ACCOUNT [--reason]` and `oracle account remove ACCOUNT` (type the
label to confirm) name an account by label or id.

## Fallback credential

While no account is registered, built-in jobs use the fallback credential set on the
same page (`PUT /v1/claude-accounts/fallback`): a `claude setup-token` value (run
through Claude Code) or an Anthropic API key (the Messages API). It is never used for a
pool whose accounts are spent or paused.

## Adapted from SwarmCloud

No lending (one company, every table tenant-scoped); credentials encrypted in Postgres
with `oracle.crypto` instead of Secret Manager (so removing an account deletes its
credential); the sweep runs from `oracle tick` and a background task instead of Cloud
Scheduler; the Firestore documents are the migration 0007 tables; the tenant secret is
the fallback credential; assignment, swap and release are in-process calls instead of
worker HTTP routes; and the sign-in's owner check compares the user (or API token) that
started it rather than the tenant.
