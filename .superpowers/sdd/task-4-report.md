# Task 4 Report: Runtime Quota State And Automatic Failover Integration

## Status

Complete.

Commit subject: `feat: integrate runtime quota state`

## RED evidence

- The pre-change focused baseline had 102/103 passing; the unrelated `evicts oldest local thread goal fallbacks when capacity is exceeded` case hit its existing 5-second timeout.
- After adding Task 4 tests, `npm test -- --run test/rotation-proxy-state.test.ts test/runtime-rotation-proxy.test.ts` exited 1 with six expected failures and 102 passing.
- Failures proved the missing seeded index map, safe reorder remap, cache load, response refresh/persistence, below-floor affinity release, and zero-percent default global threshold.

## GREEN evidence

- `npm test -- --run test/rotation-proxy-state.test.ts test/runtime-rotation-proxy.test.ts test/rate-limit-decision.test.ts`: 3 files passed; 134/134 tests passed.
- Combined Task 1-4 focused verification covering quota routing/cache, account selection, terminal stream classification, and session affinity: 8 files passed; 216/216 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

## Implementation

- Loads the existing quota cache before the proxy server starts listening, with an optional initial cache for isolated callers and tests.
- Stores both the stable quota cache and live `quotaByAccountIndex` metrics in each proxy instance.
- Maps stable cache identities to current account indexes using `findQuotaCacheEntryForAccount` and `buildRuntimeQuotaMetrics`, and rebuilds that mapping after stale-pool reload/reorder.
- Feeds live quota metrics into `chooseAccount`, preserving unknown-quota accounts as fallbacks and Task 3's exact-5% affinity behavior.
- Parses Codex quota headers immediately after every upstream fetch, before any status branch; updates the live map synchronously, safely upserts the stable cache, and queues `saveQuotaCache`.
- Leaves an existing healthy weekly observation untouched when a 429 contains no quota headers, while the existing 429 cooldown and retry path still selects the next eligible account.
- Changes only the proxy default near-exhaustion threshold from 10% to 0%; explicit caller overrides remain effective.

## Files committed

- `lib/runtime-rotation-proxy.ts`
- `lib/runtime/rotation-proxy-state.ts`
- `lib/runtime/rotation-server-types.ts`
- `test/rotation-proxy-state.test.ts`
- `test/runtime-rotation-proxy.test.ts`
- `.superpowers/sdd/task-4-report.md`

## Concerns

- The full repository test suite was not run; verification used the requested focused suites plus the directly related Task 1-3 suites, typecheck, and full lint.
- The one pre-change timeout did not recur in either post-change runtime-proxy run (102 and then 216 focused tests were green).

## Follow-up: Delayed response after account reorder

### RED evidence

- Added a concurrent proxy regression that holds an `acc_1` response from the old manager, forces stale-state recovery into a pool whose account order is reversed, then completes the old response with exhausted quota headers.
- `npm test -- --run test/runtime-rotation-proxy.test.ts -t "remaps a delayed old-manager quota response by stable identity after reload reorder"` exited 1 before the fix: the third request incorrectly used `acc_1` because the delayed observation exhausted raw index 0, which belonged to `acc_2` in the reloaded pool.

### GREEN evidence

- The isolated race regression passed after the fix.
- The combined Task 1-4 related matrix passed: 8 files, 217/217 tests.
- `npm run typecheck`: passed.
- `npm run lint`: passed.

### Implementation and safety

- Upstream quota observations still synchronously upsert the stable cache identity associated with the responding account.
- The live index map is now rebuilt from that stable cache against `state.activeAccountManager`; it never writes using the responding request's possibly stale numeric index.
- Ambiguous identities remain safely unmapped through the existing cache upsert and lookup rules.
