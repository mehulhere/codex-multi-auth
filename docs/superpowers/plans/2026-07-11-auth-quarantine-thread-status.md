# Auth Quarantine and Per-Thread Desktop Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine permanently invalid OAuth accounts from routing and show each Desktop thread's actual account plus its own quota windows in `/status`.

**Architecture:** `codex-multi-auth` will centralize terminal credential classification, persist account disablement, and maintain a bounded redacted per-thread status map in the existing app-router status file. An opt-in `codex-desktop-linux` feature will add a trusted main-process IPC reader and patch the status dialog to use only the current conversation's redacted record.

**Tech Stack:** TypeScript, Node.js HTTP/filesystem APIs, Vitest, CommonJS ASAR patch descriptors, Electron IPC, Node test runner.

## Global Constraints

- Never expose full emails, raw account IDs, refresh tokens, or access tokens to the Desktop renderer.
- The Desktop status label is `Account N (first-two-local-characters***@full-domain)`.
- A failed retry never changes the thread's displayed account; status changes only after a successful routed response.
- Quarantined accounts rank below every healthy account regardless of quota or affinity.
- Transient network/server/rate-limit failures retain existing cooldown and retry behavior.
- Desktop integration is an opt-in `linux-features/` feature and remains disabled in committed configuration.
- ASAR patches are idempotent, fail-soft, and warn on unsupported current-upstream shapes.

---

### Task 1: Shared terminal credential classifier

**Files:**
- Create: `lib/auth/permanent-failure.ts`
- Modify: `lib/runtime/account-check-helpers.ts`
- Modify: `lib/forecast.ts`
- Modify: `lib/request/rate-limit-decision.ts`
- Test: `test/permanent-auth-failure.test.ts`
- Test: `test/account-check-helpers.test.ts`
- Test: `test/forecast.test.ts`
- Test: `test/rate-limit-decision.test.ts`

**Interfaces:**
- Produces: `isPermanentAuthFailure(result: TokenFailureLike): boolean`
- Produces: `isRefreshTokenReuseMessage(message: string): boolean`
- Consumes: failure `reason`, `statusCode`, and `message` fields already returned by token refresh.

- [ ] **Step 1: Write failing classifier tests**

```ts
it("classifies OpenAI refresh-token reuse as permanent", () => {
  expect(isPermanentAuthFailure({
    type: "failed",
    reason: "http_error",
    statusCode: 400,
    message: "Your refresh token has already been used to generate a new access token. Please try signing in again.",
  })).toBe(true);
});

it("does not classify transient failures as permanent", () => {
  expect(isPermanentAuthFailure({ type: "failed", reason: "network_error", message: "timeout" })).toBe(false);
  expect(isPermanentAuthFailure({ type: "failed", reason: "http_error", statusCode: 500 })).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run test/permanent-auth-failure.test.ts test/account-check-helpers.test.ts test/forecast.test.ts test/rate-limit-decision.test.ts`

Expected: FAIL because the shared classifier and refresh-token-reuse recognition do not exist.

- [ ] **Step 3: Implement the minimal shared classifier**

```ts
const REFRESH_TOKEN_REUSE_PHRASES = [
  "refresh token has already been used",
  "already been used to generate a new access token",
] as const;

export function isRefreshTokenReuseMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return REFRESH_TOKEN_REUSE_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function isPermanentAuthFailure(failure: TokenFailureLike): boolean {
  if (failure.reason === "missing_refresh") return true;
  if (failure.statusCode === 401) return true;
  if (failure.statusCode !== 400) return false;
  const message = (failure.message ?? "").toLowerCase();
  return message.includes("invalid_grant") ||
    message.includes("invalid refresh") ||
    message.includes("token has been revoked") ||
    isRefreshTokenReuseMessage(message);
}
```

Delegate existing helper bodies to this classifier and extend runtime invalidation phrase recognition with the same shared predicate.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run test/permanent-auth-failure.test.ts test/account-check-helpers.test.ts test/forecast.test.ts test/rate-limit-decision.test.ts`

Expected: PASS with the exact production error classified as permanent and transient cases unchanged.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/auth/permanent-failure.ts lib/runtime/account-check-helpers.ts lib/forecast.ts lib/request/rate-limit-decision.ts test/permanent-auth-failure.test.ts test/account-check-helpers.test.ts test/forecast.test.ts test/rate-limit-decision.test.ts
git commit -m "fix: classify refresh token reuse as permanent"
```

### Task 2: Persist quarantine and restore through login

**Files:**
- Modify: `lib/codex-manager/health-check.ts`
- Modify: `lib/runtime/rotation-token-refresh.ts`
- Modify: `lib/runtime-rotation-proxy.ts`
- Modify: `lib/codex-manager/account-pool-write.ts`
- Test: `test/health-check.test.ts`
- Test: `test/rotation-token-refresh.test.ts`
- Test: `test/runtime-rotation-proxy.test.ts`
- Test: `test/codex-manager-account-pool-write.test.ts`

**Interfaces:**
- Consumes: `isPermanentAuthFailure(...)` from Task 1.
- Produces: durable `enabled: false` quarantine in account storage.
- Produces: explicit `refresh token reused; run codex-multi-auth login to reconnect this account` output.

- [ ] **Step 1: Write failing health-check and runtime tests**

Add tests that return the exact 400 reuse error and assert:

```ts
expect(saved.accounts[2]?.enabled).toBe(false);
expect(output).toContain("refresh token reused");
expect(output).toContain("codex-multi-auth login");
expect(manager.getAccountByIndex(2)?.enabled).toBe(false);
```

Add a selector assertion proving a quarantined 100%-quota account loses to a healthy lower-quota account, and a `buildUpdatedAccount` assertion proving successful credentials set `enabled` back to `true`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/health-check.test.ts test/rotation-token-refresh.test.ts test/runtime-rotation-proxy.test.ts test/codex-manager-account-pool-write.test.ts`

Expected: FAIL because `check` and runtime refresh currently report/cool down without consistently disabling the account.

- [ ] **Step 3: Implement durable quarantine**

In `runHealthCheck`, when a failed refresh is permanent and no usable access token remains:

```ts
if (isPermanentAuthFailure(result)) {
  if (account.enabled !== false) {
    account.enabled = false;
    changed = true;
  }
  detail = isRefreshTokenReuseMessage(result.message ?? "")
    ? "refresh token reused; run codex-multi-auth login to reconnect this account"
    : `${detail}; run codex-multi-auth login to reconnect this account`;
}
```

In runtime refresh, call `accountManager.setAccountEnabled(account.index, false)`, forget its session affinity, save debounced state, and return a non-retryable invalidation result. Preserve existing all-disabled recovery behavior and ensure the current attempt does not reuse the invalid account.

Confirm `buildUpdatedAccount` continues to explicitly re-enable the matched account and preserve that contract with the new regression test.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run test/health-check.test.ts test/rotation-token-refresh.test.ts test/runtime-rotation-proxy.test.ts test/codex-manager-account-pool-write.test.ts`

Expected: PASS; exact reuse failures persist quarantine, healthy accounts route, and login restores eligibility.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/codex-manager/health-check.ts lib/codex-manager/account-pool-write.ts lib/runtime/rotation-token-refresh.ts lib/runtime-rotation-proxy.ts test/health-check.test.ts test/rotation-token-refresh.test.ts test/runtime-rotation-proxy.test.ts test/codex-manager-account-pool-write.test.ts
git commit -m "fix: quarantine invalid OAuth accounts"
```

### Task 3: Redacted per-thread router status

**Files:**
- Create: `lib/runtime/thread-status.ts`
- Modify: `lib/runtime/rotation-proxy-state.ts`
- Modify: `lib/runtime/rotation-server-types.ts`
- Modify: `lib/runtime-rotation-proxy.ts`
- Modify: `scripts/codex-app-router.js`
- Modify: `lib/runtime/app-bind.ts`
- Test: `test/thread-status.test.ts`
- Test: `test/runtime-rotation-proxy.test.ts`
- Test: `test/codex-app-router.test.ts`

**Interfaces:**
- Produces: `ThreadStatusStore` with TTL and max-entry bounds matching affinity defaults.
- Produces: `RuntimeThreadStatus { sessionKey, accountKey, accountLabel, maskedEmail, primary, secondary, updatedAt }`.
- Produces: `threadStatuses` in the owner-only app-router status JSON.

- [ ] **Step 1: Write failing store and proxy tests**

```ts
store.remember("thread-a", accountA, quotaA, now);
store.remember("thread-b", accountB, quotaB, now);
expect(store.get("thread-a", accounts, now)?.accountDisplay).toBe("Account 1 (al***@example.com)");
expect(store.get("thread-b", accounts, now)?.accountDisplay).toBe("Account 2 (bo***@example.net)");
expect(JSON.stringify(store.snapshot(accounts, now))).not.toContain("refresh-");
expect(JSON.stringify(store.snapshot(accounts, now))).not.toContain("access-");
```

Add proxy tests proving a failed stream/retry does not overwrite the prior record and a successful replacement does. Add app-router tests asserting file mode `0600`, bounded records, masked email, and no raw account ID/tokens.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run test/thread-status.test.ts test/runtime-rotation-proxy.test.ts test/codex-app-router.test.ts`

Expected: FAIL because no per-thread status store or serialized map exists.

- [ ] **Step 3: Implement the bounded redacted store**

Use the stable storage identity helper for `accountKey`, but resolve the current ordinal and email only when producing a snapshot. Mask the email as:

```ts
export function maskThreadStatusEmail(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return `${email.slice(0, Math.min(2, at))}***@${email.slice(at + 1)}`;
}
```

Record status only after `streamSucceeded` is known. Store parsed quota headers from the successful upstream response and preserve the previous thread record when the stream fails.

Extend `getStatus()` and `createStatusPayload()` with a fixed redacted `threadStatuses` object, pruning expired entries and capping at 512 entries. Extend `readRouterStatus` types without exposing full identity data in CLI output.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run test/thread-status.test.ts test/runtime-rotation-proxy.test.ts test/codex-app-router.test.ts`

Expected: PASS with distinct thread records, correct success timing, bounded storage, and credential redaction.

- [ ] **Step 5: Commit Task 3**

```bash
git add lib/runtime/thread-status.ts lib/runtime/rotation-proxy-state.ts lib/runtime/rotation-server-types.ts lib/runtime-rotation-proxy.ts scripts/codex-app-router.js lib/runtime/app-bind.ts test/thread-status.test.ts test/runtime-rotation-proxy.test.ts test/codex-app-router.test.ts
git commit -m "feat: persist redacted per-thread runtime status"
```

### Task 4: Opt-in Desktop `/status` integration

**Repository:** `/var/home/poodle/.gemini/antigravity/scratch/codex-desktop-linux`

**Files:**
- Create: `linux-features/multi-auth-thread-status/feature.json`
- Create: `linux-features/multi-auth-thread-status/README.md`
- Create: `linux-features/multi-auth-thread-status/patch.js`
- Create: `linux-features/multi-auth-thread-status/test.js`
- Create: `linux-features/multi-auth-thread-status/main-process.js`
- Create: `linux-features/multi-auth-thread-status/webview.js`

**Interfaces:**
- Consumes: `~/.codex/multi-auth/app-bind/runtime-rotation-app-bind-status.json`.
- Produces IPC: `codex_linux:multi-auth-thread-status` with one validated session ID.
- Produces renderer result: `{ accountDisplay, primary, secondary, updatedAt } | null`.

- [ ] **Step 1: Create the Desktop feature branch**

Run: `git switch -c feature/multi-auth-thread-status`

Expected: branch changes from `main` to `feature/multi-auth-thread-status` with a clean worktree.

- [ ] **Step 2: Write failing feature tests**

Create fixtures for the current main-process and `zg` status-dialog bundle shapes. Assert the patched output:

```js
assert.match(patchedMain, /codex_linux:multi-auth-thread-status/);
assert.match(patchedMain, /runtime-rotation-app-bind-status\.json/);
assert.match(patchedWebview, /Account:/);
assert.match(patchedWebview, /accountDisplay/);
assert.equal(applyPatch(applyPatch(source)), applyPatch(source));
```

Execute the injected reader in a VM fixture and assert it rejects `../`, oversized IDs, untrusted senders, stale entries, raw emails, and records for other sessions.

- [ ] **Step 3: Run feature tests and verify RED**

Run: `node --test linux-features/multi-auth-thread-status/test.js`

Expected: FAIL because the feature and patch implementations do not yet exist.

- [ ] **Step 4: Implement the feature descriptors and secure IPC reader**

`feature.json`:

```json
{
  "id": "multi-auth-thread-status",
  "name": "Multi-auth per-thread status",
  "description": "Shows the routed codex-multi-auth account and thread-specific quota in the Desktop status dialog.",
  "entrypoints": { "patchDescriptors": "./patch.js" }
}
```

The main-process patch registers one trusted `ipcMain.handle` operation, derives the fixed status path from `HOME`/`CODEX_HOME`, validates session IDs with `^[A-Za-z0-9._:-]{1,256}$`, reads JSON defensively, selects only `threadStatuses[sessionId]`, validates the fixed redacted schema, and returns `null` on any error.

The webview patch augments the current `zg({ conversationId, threadId, rateLimit, onOpenChange })` status component. It queries the IPC bridge for `conversationId`, adds an `Account:` row, and substitutes the returned primary/secondary quota windows only when the record is present and fresh. Existing context/session rows and the global rate-limit fallback remain unchanged.

- [ ] **Step 5: Run feature and core patch tests and verify GREEN**

Run: `node --test linux-features/multi-auth-thread-status/test.js scripts/patch-linux-window-ui.test.js`

Expected: PASS with idempotent feature patches and no core patch regression.

- [ ] **Step 6: Commit Task 4**

```bash
git add linux-features/multi-auth-thread-status
git commit -m "feat: show per-thread multi-auth status"
```

### Task 5: Documentation, full verification, installation, and publication

**Files:**
- Modify: `README.md`
- Modify: `docs/troubleshooting.md`
- Modify locally only: `codex-desktop-linux/linux-features/features.json` to enable `multi-auth-thread-status` for this machine.

**Interfaces:**
- Produces: documented setup, recovery, and verification commands.
- Produces: locally installed Desktop build using the opt-in feature.

- [ ] **Step 1: Document behavior and recovery**

Document `check` quarantine, `codex-multi-auth login` recovery, per-thread `/status`, `Not assigned yet`, and the requirement that the Linux Desktop build enable `multi-auth-thread-status`.

- [ ] **Step 2: Run full multi-auth verification**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all commands exit 0 with no failed tests or lint errors.

- [ ] **Step 3: Run full affected Desktop verification**

Run:

```bash
node --test linux-features/multi-auth-thread-status/test.js
node --test scripts/patch-linux-window-ui.test.js
bash tests/scripts_smoke.sh
```

Expected: all commands exit 0.

- [ ] **Step 4: Rebuild and install the Desktop feature**

Enable the feature in gitignored `linux-features/features.json`, then run the repository's side-by-side rebuild/install flow:

```bash
./scripts/rebuild-candidate.sh --install ./Codex.dmg
```

Expected: candidate build completes, installs, and launches with the app router still bound.

- [ ] **Step 5: Run live verification**

Run `codex-multi-auth check`, confirm the reused-token account is disabled and the four healthy accounts remain eligible, then open two Desktop chats, force or naturally obtain different accounts, and verify each `/status` dialog shows a different `Account N (masked email)` and matching 5h/7d values.

- [ ] **Step 6: Commit documentation and push both repositories**

```bash
git add README.md docs/troubleshooting.md docs/superpowers/plans/2026-07-11-auth-quarantine-thread-status.md
git commit -m "docs: explain quarantine and per-thread status"
git push personal feature/quota-aware-thread-routing
```

In `codex-desktop-linux`, fork `ilysenko/codex-desktop-linux` under `mehulhere` if needed, add `personal`, and push `feature/multi-auth-thread-status`.
