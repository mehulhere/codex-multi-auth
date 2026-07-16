# Concurrent Account Membership Preservation Design

## Problem

Desktop routing helpers are long-lived `AccountManager` processes. If one starts with six accounts and a separate login process later adds a seventh, a routine quota, cooldown, refund, or token-refresh save from the stale helper can serialize its six-account in-memory pool over the newer seven-account registry.

The configured account cap is 20. The observed loss is a stale cross-process full-snapshot overwrite, not a six-account limit.

## Design

Each manager records the account membership it loaded. Before any routine full-pool save, it reloads storage while holding the existing account-storage transaction lock and computes membership changes relative to that baseline.

- Accounts added only on disk remain present.
- Accounts removed only on disk remain removed.
- Accounts intentionally added or removed by the current manager are applied.
- Newer rotated token material on disk remains authoritative.
- Active, pinned, and model-family indexes are remapped by account identity after reconciliation.
- The manager updates its baseline only after persistence succeeds.

No account count is hardcoded. Existing `MAX_ACCOUNTS = 20` validation remains unchanged.

## Deployment And Recovery

Build the package and restart every long-lived Desktop router so no process continues running the stale implementation. Restore account 7 from a credential-bearing local artifact only if one exists; otherwise perform one OAuth login after the repaired routers are active.

## Verification

- A stale manager preserves a concurrently added account.
- A stale manager does not resurrect an externally removed account.
- An intentional local removal persists.
- Token-clobber protection remains intact.
- After router restart and account login, two consecutive `codex-multi-auth check` runs both report seven accounts.
