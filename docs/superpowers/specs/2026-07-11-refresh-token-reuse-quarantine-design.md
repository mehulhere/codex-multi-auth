# Refresh Token Reuse Quarantine and Per-Thread Desktop Status Design

## Problem

OpenAI can reject a saved OAuth refresh token with a terminal message such as:

> Your refresh token has already been used to generate a new access token. Please try signing in again.

The current code recognizes several permanent authentication failures, including
`invalid_grant`, revoked tokens, missing refresh tokens, and some 400/401
responses. It does not consistently recognize the refresh-token-reuse wording.
The `check` command can therefore report that an account needs re-login while
forecasting and Desktop runtime routing still consider the account after a
temporary cooldown or until another failure path updates its state.

## Goals

- Classify refresh-token reuse as a permanent authentication failure.
- Exclude a permanently invalid account from every best-account selector as
  soon as the condition is observed.
- Explain the condition and recovery action clearly to the user.
- Restore the account automatically after a successful explicit re-login.
- Keep healthy accounts and shared Codex chat/workspace state undisturbed.
- Prevent a background Desktop request from opening an interactive login flow.
- Make the Desktop `/status` dialog show the account assigned to the current
  thread as `Account N (ma***@example.com)`.
- Make the 5-hour and 7-day values in `/status` come from the current thread's
  assigned account rather than the most recently observed process-global quota.

## Non-goals

- Automatically opening a browser or device-login prompt from Desktop routing.
- Retrying a permanently invalid refresh token after a short cooldown.
- Deleting account metadata or chat history.
- Changing quota ranking among healthy accounts.
- General OAuth provider refactoring unrelated to failure classification.
- Exposing full account emails, raw account IDs, OAuth tokens, or the complete
  account pool to the Desktop renderer.
- Supporting the per-thread status extension in unmodified upstream Desktop
  builds; the feature targets the ilysenko Linux Desktop patch set.

## Design

### Shared permanent-failure classification

Introduce one lower-layer classifier for terminal credential failures. It will
recognize:

- missing refresh tokens;
- terminal HTTP 401 credential failures;
- terminal HTTP 400 failures containing `invalid_grant`, invalid-refresh, token
  revocation, or refresh-token-reuse wording;
- the observed phrases `refresh token has already been used` and
  `already been used to generate a new access token`, case-insensitively.

Existing account-check, forecast, repair, and runtime invalidation helpers will
delegate to this shared classifier. Transient network errors, server errors,
timeouts, and quota/rate-limit responses remain non-terminal.

### Durable quarantine

When a terminal credential failure is observed, the account is quarantined by
persisting `enabled: false` in the existing account store. This reuses a state
already honored by the account manager and all selection paths; no parallel
quarantine database or new schema version is required.

The failure path will retain the account record and its identifying metadata so
the user can reconnect it. It will not delete tokens, account labels, workspace
bindings, or history. The `check` command will persist the quarantine before it
returns. Runtime routing will persist the same state when it discovers the
failure independently.

If disabling the failed account would leave the pool with no enabled accounts,
existing lockout protection remains authoritative: one account may remain
enabled for recovery visibility, but it must be treated as unavailable by the
live selection attempt that observed the terminal failure. In the normal
multi-account case, healthy enabled accounts are selected immediately.

### Selection behavior

All selectors continue to exclude `enabled: false` accounts before quota
ranking. This gives authentication validity higher priority than 5-hour or
7-day quota availability: an account with 100% quota but an invalid refresh
credential can never be selected as best.

The existing quota-aware ordering remains unchanged for the remaining healthy
pool. Continuation and fork affinity cannot override quarantine; when an
affinitized account becomes quarantined, routing falls back to normal eligible
account selection.

### User-facing behavior and recovery

For the refresh-token-reuse case, commands will describe the condition as a
permanent credential failure and print a direct recovery action:

```text
refresh token reused; run codex-multi-auth login to reconnect this account
```

Background runtime responses will remain machine-readable and will not expose
emails or tokens. They will identify the account as requiring re-login without
launching an interactive flow.

The user recovers the account with:

```bash
codex-multi-auth login
```

A successful login for the same account updates its credentials and re-enables
it through the existing login merge behavior. Subsequent checks and routing can
then include it normally.

### Per-thread Desktop status

The current Desktop status dialog receives a process-global rate-limit object.
With concurrent tabs, that object can represent whichever account reported
quota most recently. The router will therefore maintain a separate redacted
status record for each routed thread/session.

After a successful response begins using an account, the router records:

- the normalized thread/session key already used by affinity routing;
- a stable account identity key used only for re-resolution inside the router;
- the display ordinal at the time the status response is produced;
- a masked email produced by the existing email-redaction rules;
- the latest valid 5-hour and 7-day quota windows observed for that account;
- the update timestamp.

The renderer-visible display value is formatted as:

```text
Account 4 (oc***@icloud.com)
```

The full email, raw account ID, refresh token, and access token are never stored
in the renderer-facing record. If an account can no longer be safely resolved,
the record returns an explicit unassigned reason rather than guessing from a stale
array index.

The thread record changes after token refresh confirms the selected account is
usable and before its upstream request begins. A retry that selects another
usable account replaces the provisional assignment. Continuations and forks use
their actual affinity result; a fork that inherits the parent account shows that
account, while a fork moved by the quota floor shows the replacement selection.

### Secure sidecar and Desktop IPC

The persistent app router will extend its existing owner-only (`0600`) local
status state with a bounded per-thread status map. Entries persist in an
owner-only redacted sidecar across router restarts and expire after 90 days,
rather than sharing the short session-affinity expiry. Both the durable store
and renderer-facing status snapshot are capped so abandoned threads cannot grow
the files without bound. Writes retain the existing atomic
temporary-file-and-rename pattern with bounded retries for transient file locks.
On the first restart after upgrading, the router validates and imports the
existing redacted status snapshot before publishing its new status file.

The ilysenko Desktop main process will read this owner-only state. It will expose
one narrow IPC operation accepting the current local conversation/session ID
and returning only the matching redacted record. The handler will:

- accept requests only from the trusted Codex renderer;
- validate and bound the session identifier;
- read only the known app-router status path;
- return a fixed schema containing display alias, masked email, quota windows,
  and update time;
- return a fixed unassigned reason for missing or unavailable records and
  `null` only for invalid session identifiers.

The renderer cannot request the account list, choose an arbitrary file path, or
receive credentials. The Desktop `/status` component will query this operation
for the current conversation and prefer its valid per-thread quota over the
process-global rate-limit object. If no per-thread record exists, it keeps the
existing quota display and adds the reason no routed assignment exists.

The UI patch is implemented through the existing tested
`codex-desktop-linux` patch pipeline rather than by modifying generated app
assets by hand. Patch detection remains idempotent and warns safely when an
upstream bundle shape is unsupported.

## Data flow

1. `check`, forecast probing, repair, or runtime refresh receives a failed token
   result.
2. The shared classifier determines whether the failure is permanent.
3. For refresh-token reuse or another permanent failure, the owning path marks
   the account disabled and persists account storage.
4. The current selection attempt excludes the account immediately.
5. The selector ranks only the remaining eligible accounts using existing quota
   and affinity rules.
6. The CLI or runtime reports that explicit re-login is required.
7. A later successful login replaces the invalid credentials and re-enables the
   account.
8. As soon as a usable account is selected, the router updates the redacted
   per-thread assignment sidecar atomically; successful response headers then
   refresh the quota snapshot.
9. Opening `/status` asks the trusted Desktop main process for the current
   session's record and renders its account and quota snapshot.

## Error handling and concurrency

- Assignment persistence uses an owner-only atomic temporary-file-and-rename
  sidecar and never stores raw email, account ID, or credentials.
- A persistence failure suppresses the in-memory assignment from renderer
  status and exposes a fixed storage-unavailable state until a later write
  succeeds.
- Concurrent requests that observe the same terminal failure perform an
  idempotent disable operation.
- A failed assignment-sidecar write does not disrupt routing; `/status` reports
  that multi-auth status is unavailable instead of inventing an assignment.
- Transient failures retain existing retry and cooldown behavior.
- A streamed `usage_limit` failure cannot safely replay a turn that may already
  have executed tools. It marks the served account quota-limited and releases
  thread affinity so the next Continue request selects another eligible account.
- Runtime client-facing errors remain redacted and machine-readable.
- Sidecar entries are bounded, expire, and never contain tokens or full emails.
- Desktop IPC rejects untrusted senders, malformed identifiers, and arbitrary
  path input.
- Missing sidecar state degrades to existing Desktop quota behavior without
  breaking `/status`.

## Testing

Tests will be written before implementation and will cover:

1. The exact observed refresh-token-reuse message is classified as permanent.
2. Similar non-terminal wording is not over-classified.
3. `check` disables and persists a failed account while leaving healthy accounts
   enabled.
4. Forecast and best-account selection never recommend the quarantined account,
   even when it has the best quota snapshot.
5. Runtime token refresh excludes and persists the account immediately rather
   than using a short retry cooldown.
6. Continuation and fork affinity fall back when the affinitized account is
   quarantined.
7. Successful re-login re-enables the account.
8. Pool lockout protection and transient-error behavior remain intact.
9. User-facing output includes the explicit re-login instruction and does not
   expose credentials.
10. Two simultaneous thread IDs assigned to different accounts return different
    account labels and quota windows.
11. A thread record is not moved to a retry account until that retry succeeds.
12. Reordered or removed accounts do not cause a stale ordinal to identify the
    wrong account.
13. The sidecar masks email, omits credentials, expires stale entries, enforces
    its size bound, and remains owner-only.
14. Desktop IPC returns only the requested redacted thread record and rejects
    untrusted or malformed requests.
15. The `/status` patch renders `Account N (masked email)` and the matching
    thread-specific 5-hour and 7-day values, with a safe unassigned fallback.
16. The Desktop patch remains idempotent and its fixture tests cover supported
    upstream bundle shapes and drift warnings.

The focused tests will be followed by type checking, linting, and the complete
test suites in both repositories. Live verification will include
`codex-multi-auth check`, two Desktop threads routed to different accounts, and
their respective `/status` dialogs.
