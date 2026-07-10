# Task 3 Report: Independent Current And Parent Affinity

## Status

Complete.

Commit: `6370e59 feat: preserve parent response affinity`

## RED evidence

- `npm test -- --run test/session-affinity.test.ts test/property/session-affinity.property.test.ts test/rotation-account-selection.test.ts test/runtime-rotation-proxy.test.ts` exited 1 before implementation: 12 failed and 127 passed.
- Failures covered missing response-alias APIs, aliases changing session `size()`/`prune()` behavior, missing parent-response selection, below-floor and zero-quota reselection, failed terminal aliasing, and unversioned overlapping completions.

## GREEN evidence

- Final focused run: `npm test -- --run test/session-affinity.test.ts test/property/session-affinity.property.test.ts test/rotation-account-selection.test.ts test/runtime-rotation-proxy.test.ts`: 4 test files passed; 139/139 tests passed.
- `npm run typecheck`: passed.
- Targeted ESLint for all Task 3 implementation and test files: passed with no warnings or errors.
- `git diff --check`: passed.

## Implementation

- Split bounded session affinity entries from bounded response-to-account aliases so session `size()` and `prune()` retain their existing semantics.
- Added independent `previousResponseId` request context parsing and current-session-first, parent-response-second selection.
- Wired quota metrics and the fixed 5% affinity floor into selection without loading the quota cache; known zero and below-floor preferred accounts are excluded from hybrid and linear fallback for the current selection.
- Allocated per-request write versions so stale completions cannot overwrite newer current-session metadata while every successful terminal response still receives its own producer alias.
- Bound `response.completed`, `response.done`, and `response.incomplete` IDs; `response.failed` and `error` remain failures and create no alias.
- Rolled back the short-term global sticky boost for terminal stream failures so an unaliased failed parent cannot pin a new child request back to the failed account.

## Files committed

- `lib/request/stream-failover-runtime.ts`
- `lib/runtime-rotation-proxy.ts`
- `lib/runtime/rotation-account-selection.ts`
- `lib/runtime/rotation-server-types.ts`
- `lib/session-affinity.ts`
- `test/rotation-account-selection.test.ts`
- `test/runtime-rotation-proxy.test.ts`
- `test/session-affinity.test.ts`

## Concerns

- Task 3 only wires the quota-map parameters. Loading and refreshing the runtime quota map remains Task 4 by design.
- Verification was scoped to the required focused suites, the full session-affinity property suite, typecheck, and targeted lint; the full repository test suite was not run.

## Follow-up: Large terminal SSE lines

### RED evidence

- Added a real proxy regression that streams one valid `response.completed` JSON line with a 9 MiB output field in 128 KiB upstream chunks, verifies byte-for-byte client forwarding, moves unrelated traffic to account 2, then forks from the large response ID.
- `npx vitest run test/runtime-rotation-proxy.test.ts --maxWorkers=1 -t "binds a response id from a chunked 9 MiB terminal event"` exited 1 before the fix: the fork used `acc_2` instead of its producing `acc_1`, proving the prior 64 KiB observer truncation lost the response ID.

### GREEN evidence

- The same isolated regression passed after the fix.
- `npm test -- --run test/session-affinity.test.ts test/property/session-affinity.property.test.ts test/rotation-account-selection.test.ts test/runtime-rotation-proxy.test.ts`: 4 files passed; 141/141 tests passed.
- `npm run typecheck`: passed.
- `npx eslint lib/request/stream-failover-runtime.ts test/runtime-rotation-proxy.test.ts --max-warnings=0`: passed with no warnings or errors.

### Implementation and safety

- Replaced lossy string-tail truncation with a raw-byte SSE line observer bounded to the repository's existing 10 MiB SSE parsing limit.
- Complete accepted lines are joined and decoded once, preserving UTF-8 split across chunks so terminal type and response ID parsing remains correct.
- When an observed line exceeds the cap, only observer state is discarded until the next newline; upstream chunks still pass directly to the client unchanged.
- Added an oversized malformed-line regression above 10 MiB that verifies byte-for-byte forwarding remains lossless.
