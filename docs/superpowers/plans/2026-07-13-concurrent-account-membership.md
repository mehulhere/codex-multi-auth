# Concurrent Account Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent long-lived Desktop routers from erasing accounts added or removed by another process.

**Architecture:** Track each `AccountManager` instance's loaded membership baseline and reconcile routine snapshots against the latest locked disk state. Apply only deliberate local membership deltas while preserving external changes and newer token material.

**Tech Stack:** TypeScript, Node.js, Vitest, JSON account storage with filesystem locking.

## Global Constraints

- Preserve the existing `MAX_ACCOUNTS = 20` limit.
- Never print, log, or commit access or refresh tokens.
- Do not replace or discard the existing uncommitted implementation.
- Restart every long-lived router after building the repaired `dist/` output.

---

### Task 1: Validate concurrent membership reconciliation

**Files:**
- Modify: `lib/accounts.ts`
- Test: `test/h3-token-clobber.test.ts`

**Interfaces:**
- `AccountManager.membershipBaseline` records membership loaded or intentionally persisted by that manager.
- `reconcileStorageFromDisk(snapshot, current)` returns a complete V3 storage object with identity-remapped indexes.

- [ ] **Step 1: Review the inherited regression cases**

Confirm the tests independently cover a concurrent addition, an external removal, an intentional local removal, and the original newer-token protection.

- [ ] **Step 2: Run the focused suite**

Run: `npx vitest run test/h3-token-clobber.test.ts`

Expected: four passing tests.

- [ ] **Step 3: Review persistence paths**

Confirm both token-refresh persistence and routine `saveToDisk()` call `reconcileStorageFromDisk` while inside `withAccountStorageTransaction`, and update `membershipBaseline` only after persistence succeeds.

- [ ] **Step 4: Run repository verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit successfully.

- [ ] **Step 5: Commit the scoped repair**

```bash
git add lib/accounts.ts test/h3-token-clobber.test.ts
git commit -m "fix: preserve concurrent account membership"
```

### Task 2: Deploy and restore account 7

**Files:**
- Runtime: `~/.codex/multi-auth/openai-codex-accounts.json`
- Runtime: `~/.codex/multi-auth/app-bind/`

**Interfaces:**
- `codex-multi-auth rotation reset-runtime` restarts the main app-bound router.
- `codex-multi-auth-compat-36639.service` owns the compatibility router.

- [ ] **Step 1: Restart both repaired routers**

Run `codex-multi-auth rotation reset-runtime`, restart `codex-multi-auth-compat-36639.service`, and verify both router process start times are newer than the build.

- [ ] **Step 2: Restore account 7**

If no credential-bearing local artifact contains account 7, run one `codex-multi-auth login --manual` or device-auth flow for that account after both routers are repaired.

- [ ] **Step 3: Verify persistence twice**

Run `codex-multi-auth check` twice and verify both runs report seven accounts, then confirm the primary registry and rotating backups retain seven unique account identities.
