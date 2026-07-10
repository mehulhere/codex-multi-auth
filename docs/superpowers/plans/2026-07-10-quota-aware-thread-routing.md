# Quota-Aware Thread Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route shared Codex Desktop threads to quota-optimal accounts, retain thread/fork affinity above 5%, and fail over automatically on exhaustion.

**Architecture:** Extend the existing hybrid selector with explicit quota metrics and a lexicographic quota tier. The runtime proxy loads the existing quota cache, updates its in-memory/cache view from response headers, and passes independent current-thread and parent-response affinity keys into selection. Desktop remains bound to one shared `CODEX_HOME`.

**Tech Stack:** TypeScript ESM, Node.js 18+, Hono/undici-compatible Fetch APIs, Vitest, existing `AccountManager`, quota cache, and runtime rotation proxy.

## Global Constraints

- New threads require strictly more than 0% remaining in both the 5-hour and 7-day windows.
- Existing threads and forks retain affinity at exactly 5% and move only below 5%.
- Known eligible accounts sort by earliest future 7-day reset, then existing hybrid score, then stable account index.
- A pre-body HTTP 429 remains the authoritative exhaustion and retry signal.
- All accounts share the official `~/.codex` session/history tree.
- Do not expose tokens or account emails in proxy responses or logs.
- Do not edit generated `dist/` files.

---

### Task 1: Quota-Aware Hybrid Ordering

**Files:**
- Modify: `lib/rotation.ts`
- Test: `test/rotation.test.ts`

**Interfaces:**
- Produces: `HybridQuotaMetrics { left5h, left7d, reset7dAtMs }`
- Extends: `HybridSelectionOptions.quotaByAccountIndex` and `HybridSelectionOptions.now`

- [ ] **Step 1: Write failing selector tests**

Add tests proving: earliest future 7-day reset wins; a zero window is gated; unknown quota is fallback-only; equal resets use legacy score; and the injected clock controls freshness.

```ts
const selected = selectHybridAccount({
  accounts,
  healthTracker,
  tokenTracker,
  options: {
    now,
    quotaByAccountIndex: new Map([
      [0, { left5h: 80, left7d: 20, reset7dAtMs: now + 2_000 }],
      [1, { left5h: 80, left7d: 80, reset7dAtMs: now + 9_000 }],
    ]),
  },
});
expect(selected?.index).toBe(0);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run test/rotation.test.ts`

Expected: type/test failures because quota options do not exist.

- [ ] **Step 3: Implement the minimal lexicographic selector**

Compute the existing health/token/freshness score for each runtime-available candidate. Rank known positive-quota candidates by `reset7dAtMs ASC`, legacy score `DESC`, and index `ASC`. Use unknown candidates only when no known positive candidate exists.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run test/rotation.test.ts`

Expected: all tests pass.

### Task 2: Quota Snapshot Normalization And Cache Update

**Files:**
- Create: `lib/runtime/quota-routing.ts`
- Modify: `lib/quota-cache.ts`
- Test: `test/runtime-quota-routing.test.ts`

**Interfaces:**
- Produces: `buildRuntimeQuotaMetrics(entry, now): HybridQuotaMetrics | null`
- Produces: `hasAffinityQuota(entry, now, floorPercent): boolean`
- Produces: `upsertQuotaCacheEntryForAccount(cache, account, accounts, entry): boolean`

- [ ] **Step 1: Write failing normalization tests**

Cover primary/secondary window reversal, exact 5% affinity retention, 4.99% rejection, zero new-thread rejection, expired reset handling, and unique-account-ID cache writes.

```ts
expect(hasAffinityQuota(entryWith({ left5h: 5, left7d: 5 }), now, 5)).toBe(true);
expect(hasAffinityQuota(entryWith({ left5h: 4.99, left7d: 5 }), now, 5)).toBe(false);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm test -- --run test/runtime-quota-routing.test.ts`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement pure normalization and lower-layer cache upsert**

Identify the 300-minute and 10080-minute windows by `windowMinutes`, clamp raw `100 - usedPercent` without rounding, and treat a passed reset as a fresh unknown window rather than exhausted stale data. Keep account identity matching in the lower quota layer so runtime code does not import from `codex-manager/`.

- [ ] **Step 4: Run the new and existing quota cache tests**

Run: `npm test -- --run test/runtime-quota-routing.test.ts test/quota-cache.test.ts test/codex-manager-quota-cache-helpers.test.ts`

Expected: all tests pass.

### Task 3: Independent Current And Parent Affinity

**Files:**
- Modify: `lib/runtime/rotation-server-types.ts`
- Modify: `lib/runtime-rotation-proxy.ts`
- Modify: `lib/runtime/rotation-account-selection.ts`
- Modify: `lib/session-affinity.ts`
- Test: `test/rotation-account-selection.test.ts`
- Test: `test/session-affinity.test.ts`
- Test: `test/runtime-rotation-proxy.test.ts`

**Interfaces:**
- Adds: `RequestContext.previousResponseId: string | null`
- Extends: `chooseAccount({ previousResponseId, quotaByAccountIndex, affinityQuotaFloorPercent })`

- [ ] **Step 1: Write failing realistic-fork tests**

Create a parent response, then fork with both a new `x-openai-session-id` or `prompt_cache_key` and `previous_response_id`. Assert the child inherits the parent account at 5% and chooses a different quota-ranked account at 4.99%.

- [ ] **Step 2: Run focused affinity tests and verify RED**

Run: `npm test -- --run test/session-affinity.test.ts test/rotation-account-selection.test.ts test/runtime-rotation-proxy.test.ts`

Expected: the realistic fork uses the new current-thread key and does not inherit the parent.

- [ ] **Step 3: Implement independent lookup keys**

Parse `previous_response_id` separately from `resolveSessionKey`. Selection checks current-thread affinity first for normal continuations, then parent-response affinity for an unbound child. If a bound account is below 5%, exclude that preferred index for the current selection so hybrid fallback cannot immediately pick it again.

- [ ] **Step 4: Preserve completion aliases and request ordering**

Retain the existing SSE observer changes, allocate a request write version, and bind successful terminal response IDs to the account without allowing an older concurrent completion to overwrite a newer mapping.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run test/session-affinity.test.ts test/rotation-account-selection.test.ts test/runtime-rotation-proxy.test.ts`

Expected: all tests pass.

### Task 4: Runtime Quota State And Automatic Failover Integration

**Files:**
- Modify: `lib/runtime/rotation-proxy-state.ts`
- Modify: `lib/runtime-rotation-proxy.ts`
- Modify: `lib/request/stream-failover-runtime.ts`
- Test: `test/rotation-proxy-state.test.ts`
- Test: `test/runtime-rotation-proxy.test.ts`

**Interfaces:**
- State: `quotaCache` plus `quotaByAccountIndex`
- Behavior: parse quota headers before every success/429 branch, update state/cache, and feed selection metrics into `chooseAccount`

- [ ] **Step 1: Write failing proxy integration tests**

Cover startup cache seeding, nearest-reset selection, response-header refresh, cache persistence, below-5 affinity release, successful terminal classification, and 429 retry to the next eligible account.

- [ ] **Step 2: Run focused proxy tests and verify RED**

Run: `npm test -- --run test/rotation-proxy-state.test.ts test/runtime-rotation-proxy.test.ts`

Expected: new quota-routing assertions fail against health/freshness-only selection.

- [ ] **Step 3: Load, update, and persist quota state**

Await `loadQuotaCache()` before listening. Map entries to live account indexes with the existing safe identity rules. Parse every upstream response's quota headers, update the in-memory metrics immediately, and queue the existing atomic cache writer. Leave unknown-quota accounts as fallback candidates.

- [ ] **Step 4: Align exhaustion thresholds**

Set the proxy's default global near-exhaustion threshold to 0 so low positive quota remains usable for new chats. Keep explicit caller overrides and the existing 429 cooldown/retry behavior intact.

- [ ] **Step 5: Run focused proxy tests and verify GREEN**

Run: `npm test -- --run test/rotation-proxy-state.test.ts test/runtime-rotation-proxy.test.ts test/rate-limit-decision.test.ts`

Expected: all tests pass.

### Task 5: Documentation, Build, Install, And Live Desktop Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/reference/settings.md` only if a documented default changes
- Modify: installed package via `npm install -g` after source verification

- [ ] **Step 1: Document routing semantics and status commands**

Document shared history, new-thread quota ordering, 5% affinity floor, terminal completion behavior, 429 failover, and the reversible app bind commands.

- [ ] **Step 2: Run complete source verification**

Run:

```bash
npm run typecheck
npm run typecheck:scripts
npm run lint
npm test
npm run build
```

Expected: every command exits 0.

- [ ] **Step 3: Install the verified local build**

Run: `npm install -g /absolute/path/to/work/codex-multi-auth`

Expected: global package installation exits 0 and reports version 2.5.0.

- [ ] **Step 4: Enable automatic routing**

Run:

```bash
codex-multi-auth unpin
codex-multi-auth forecast --live --json
codex-multi-auth rotation enable
codex-multi-auth rotation bind-app
```

Expected: the manual pin is removed, quota cache contains all healthy accounts, and app bind points shared `~/.codex/config.toml` to the running localhost router.

- [ ] **Step 5: Verify live status and shared history**

Run:

```bash
codex-multi-auth status
codex-multi-auth rotation status
codex-multi-auth doctor --json
codex-multi-auth history list --json
```

Expected: five accounts remain in one pool, no manual pin is active, router status is running, Desktop uses the runtime provider, and existing sessions remain visible through the shared history command.
