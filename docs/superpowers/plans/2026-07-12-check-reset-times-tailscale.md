# Check Reset Times and Tailscale Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full quota reset timestamps and a best-effort Tailscale auto-recovery preflight to `codex-multi-auth check`.

**Architecture:** Keep quota presentation in the existing quota formatter. Add a small, dependency-injected Tailscale helper under the command layer, and invoke it from the check command before the existing health check. Tailscale failures remain warnings so account diagnostics always run.

**Tech Stack:** TypeScript, Node.js child processes, Vitest.

## Global Constraints

- Render timestamps in the user's local timezone with day, month, year, hour, and minute.
- Prefer the direct `tailscale` CLI, then Linux `flatpak-spawn --host` fallback.
- Never install Tailscale or block account health checks when it is absent or cannot be started.

---

### Task 1: Full quota reset timestamps

**Files:**
- Modify: `lib/codex-manager/formatters/quota-formatters.ts`
- Test: `test/codex-manager-formatters.test.ts`

**Interfaces:**
- Consumes: `resetAtMs: number | undefined` and an injectable `now` timestamp.
- Produces: `formatCompactQuotaSnapshot(snapshot, now): string` with full local reset timestamps.

- [ ] Add a formatter test asserting that both same-day and later reset values contain local day, abbreviated month, year, hour, and minute.
- [ ] Run `npx vitest run test/codex-manager-formatters.test.ts --maxWorkers=1` and confirm the new assertion fails because same-day output lacks a date and all output lacks a year.
- [ ] Update `formatCompactResetAt` to always render the complete local date and 24-hour time.
- [ ] Re-run the focused formatter test and confirm it passes.

### Task 2: Tailscale preflight and recovery

**Files:**
- Create: `lib/codex-manager/tailscale-check.ts`
- Modify: `lib/codex-manager/commands/check.ts`
- Test: `test/codex-manager-tailscale-check.test.ts`
- Test: `test/codex-manager-check-command.test.ts`

**Interfaces:**
- Produces: `ensureTailscaleRunning(options?): Promise<TailscaleCheckResult>` with injected command execution for tests.
- Consumes: `ensureTailscaleRunning(): Promise<TailscaleCheckResult>` from `runCheckCommand` dependencies.

- [ ] Add tests for direct status success, `flatpak-spawn --host` fallback, recovery via `tailscale up`, and non-fatal unavailable/failure results.
- [ ] Add a check-command test asserting Tailscale preflight runs before `runHealthCheck` and a warning does not prevent account probing.
- [ ] Run both focused suites and confirm they fail because the helper and dependency do not exist.
- [ ] Implement the minimal command runner, status parser, recovery flow, and warning output.
- [ ] Re-run both focused suites and confirm they pass.

### Task 3: Verification and installation

**Files:**
- Modify generated installation only through `npm install -g`; do not edit `dist/` by hand.

- [ ] Run all focused tests for the formatter, Tailscale helper, and check command.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`.
- [ ] Install from the checkout with the user's NVM Node runtime using `npm install -g <checkout>`.
- [ ] Run `codex-multi-auth --version` and `codex-multi-auth check`, confirming version `2.5.0`, Tailscale `Running`, and full reset timestamps on all live account rows.
