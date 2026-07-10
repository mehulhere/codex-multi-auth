# Refresh Token Reuse Quarantine Design

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

## Non-goals

- Automatically opening a browser or device-login prompt from Desktop routing.
- Retrying a permanently invalid refresh token after a short cooldown.
- Deleting account metadata or chat history.
- Changing quota ranking among healthy accounts.
- General OAuth provider refactoring unrelated to failure classification.

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

## Error handling and concurrency

- Persistence uses the existing account-manager save and transaction patterns;
  no direct ad hoc file writes are introduced.
- Concurrent requests that observe the same terminal failure perform an
  idempotent disable operation.
- A failed persistence attempt is reported and does not pretend the account was
  durably quarantined.
- Transient failures retain existing retry and cooldown behavior.
- Runtime client-facing errors remain redacted and machine-readable.

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

The focused tests will be followed by type checking, linting, the complete test
suite, and a live `codex-multi-auth check` verification on the installed build.

