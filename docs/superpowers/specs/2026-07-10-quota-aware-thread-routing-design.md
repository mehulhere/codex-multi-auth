# Quota-Aware Thread Routing Design

## Goal

Route every Codex Desktop thread through one shared account pool without splitting
`CODEX_HOME`, chat history, or workspaces. New threads use the account whose
7-day quota resets soonest while both its 5-hour and 7-day windows retain at
least 5%. Existing threads and forks remain on their current account while that
account remains above the same floor.

## Architecture

The feature belongs in the existing `codex-multi-auth` Responses proxy. Desktop
already sends stable thread and continuation identifiers through that proxy and
already stores all sessions under the shared official `CODEX_HOME`. Modifying
the ilysenko Electron wrapper would duplicate account logic and make CLI and
Desktop behavior diverge.

The proxy gains a quota-aware router with three inputs:

1. Persisted quota-cache entries loaded when the proxy starts.
2. Fresh 5-hour and 7-day quota headers learned from each upstream response.
3. The existing account health, cooldown, policy, and manual-pin eligibility
   checks.

The router is advisory. It orders eligible accounts for hybrid selection; it
does not bypass authentication, policy blocks, cooldowns, or the existing
failure loop.

## Account Selection

For a new thread, known quota snapshots are normalized by window duration. The
300-minute window is treated as 5-hour quota and the 10080-minute window as
7-day quota, regardless of whether upstream reports them as primary or
secondary.

An account with a known snapshot is eligible for a new thread only when both
windows have at least 5% remaining. Eligible known accounts sort by:

1. Earliest future 7-day reset time.
2. More 7-day quota remaining.
3. More 5-hour quota remaining.
4. Existing hybrid health/token/freshness score.

Unknown quota accounts remain eligible but rank behind known eligible accounts.
If every known account is below the floor, unknown accounts are tried before the
proxy reports pool exhaustion. This preserves availability during cold starts
or missing-header responses.

Quota snapshots expire naturally when their reset timestamps pass. A completed
response updates the in-memory view and the existing quota cache so restarts do
not discard learned quota state.

## Thread And Fork Affinity

The request context keeps both the current thread key and
`previous_response_id`. A direct continuation first uses current-thread
affinity. A fork with a new thread key consults the parent response mapping and
inherits its account when that account has at least 5% remaining in both quota
windows.

When a successful stream emits `response.completed`, `response.done`, or
`response.incomplete`, the proxy maps the response ID to the account that
produced it. `response.failed` and `error` are terminal failures and do not
create a response-to-account mapping.

Affinity entries use the existing configurable TTL and capacity limits. The
scope of this change is runtime routing; chat history remains durable because
all accounts continue to share official Codex session storage.

## Exhaustion And Completion

A pre-body HTTP 429 is the authoritative quota-exhaustion signal. The existing
retry loop marks that account rate-limited, selects the next eligible account,
and retries before returning bytes to Desktop. The successful replacement
account becomes the thread's new affinity.

A successful terminal SSE event means the turn completed. Completion retains
affinity; it does not rotate accounts by itself. A successful response whose
quota headers show either window below 5% is delivered normally, but the account
is excluded from the next turn or fork until its quota window resets.

Network errors, server errors, token invalidation, manual pins, and policy
blocks retain their current behavior.

## Persistence And Shared History

Quota state is persisted through the existing
`~/.codex/multi-auth/quota-cache.json` format using stable account IDs with the
existing safe email fallback. No access tokens, response content, prompts, or
account emails are added to logs or client-facing headers.

Desktop stays bound to one `~/.codex` tree. There are no per-account
`CODEX_HOME` directories, workspace copies, or profile switching commands.

## Tests

Focused unit tests cover quota-window normalization, the 5% boundary, reset-time
ordering, unknown quota fallback, and expired snapshots. Selection tests cover
new-thread routing, direct continuation affinity, realistic fork requests that
carry both a new thread key and `previous_response_id`, and rotation below the
floor. Proxy tests cover 429 failover and terminal event classification.

The final verification runs the focused Vitest suites, typecheck, build, lint,
and the complete test suite before installing the local package and checking the
live Desktop bind/status.
