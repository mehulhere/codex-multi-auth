import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";

describe("verifyRuntimeFlaggedAccounts", () => {
	it("exits early when there are no flagged accounts", async () => {
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			lookupCodexCliTokensByEmail: async () => { throw new Error("busy"); },
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			resolveAccountSelection: () => ({}) as never,
			persistAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			logInfo: vi.fn(),
			showLine,
		});
		expect(showLine).toHaveBeenCalledWith("\nNo flagged accounts to verify.\n");
	});
	it("restores accounts from Codex CLI cache and preserves the remainder", async () => {
		const now = 10_000;
		const persistAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{ email: "cached@example.com", refreshToken: "cached-refresh", addedAt: 1, lastUsed: 1 },
					{ email: "flagged@example.com", refreshToken: "flagged-refresh", addedAt: 1, lastUsed: 1 },
				],
			}),
			lookupCodexCliTokensByEmail: async (email) =>
				email === "cached@example.com"
					? { accessToken: "access", refreshToken: "new-refresh", expiresAt: now + 60_000 }
					: null,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant", message: "refresh failed" }),
			resolveAccountSelection: (tokens) => ({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			now: () => now,
			showLine,
		});
		expect(persistAccounts).toHaveBeenCalledTimes(1);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "flagged-refresh" })],
		});
		expect(showLine).toHaveBeenCalledWith(expect.stringContaining("ca***@***.com: RESTORED (Codex CLI cache)"));
	});

	it("restores accounts after a successful refresh when cache misses", async () => {
		const now = 10_000;
		const persistAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [{ email: "refresh@example.com", refreshToken: "refresh-token", addedAt: 1, lastUsed: 1 }] }),
			lookupCodexCliTokensByEmail: async () => null,
			queuedRefresh: async () => ({ type: "success", access: "new-access", refresh: "new-refresh", expires: now + 60_000 }),
			resolveAccountSelection: (tokens) => ({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			now: () => now,
			showLine,
		});
		expect(persistAccounts).toHaveBeenCalledWith([expect.objectContaining({ refreshToken: "new-refresh", accessToken: "new-access" })], false);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({ version: 1, accounts: [] });
		expect(showLine).toHaveBeenCalledWith(expect.stringContaining("re***@***.com: RESTORED"));
	});

	it("logs verification failures through logError and keeps the account flagged", async () => {
		const now = 10_000;
		const logError = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [{ email: "broken@example.com", refreshToken: "broken-refresh", addedAt: 1, lastUsed: 1 }] }),
			lookupCodexCliTokensByEmail: async () => ({ accessToken: "cached-access", refreshToken: "cached-refresh", expiresAt: now + 60_000 }),
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			resolveAccountSelection: () => { throw new Error("selection failed"); },
			persistAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			logError,
			now: () => now,
			showLine: vi.fn(),
		});
		expect(logError).toHaveBeenCalledWith(expect.stringContaining("Failed to verify flagged account br***@***.com: selection failed"));
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "broken-refresh", lastError: "selection failed" })],
		});
	});
	it("writes restored accounts before flagged state cleanup", async () => {
		const now = 10_000;
		const calls: string[] = [];
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [{ email: "refresh@example.com", refreshToken: "refresh-token", addedAt: 1, lastUsed: 1 }] }),
			lookupCodexCliTokensByEmail: async () => { throw new Error("busy"); },
			queuedRefresh: async () => ({ type: "success", access: "new-access", refresh: "new-refresh", expires: now + 60_000 }),
			resolveAccountSelection: (tokens) => ({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts: vi.fn(async () => { calls.push("persistAccounts"); }),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => { calls.push("saveFlaggedAccounts"); }),
			logInfo: vi.fn(),
			now: () => now,
			showLine: vi.fn(),
		});
		expect(calls).toEqual(["persistAccounts", "saveFlaggedAccounts"]);
	});

	it("leaves flagged state untouched when persistAccounts throws EBUSY", async () => {
		const now = 10_000;
		const saveFlaggedAccounts = vi.fn(async () => {});
		const persistAccounts = vi.fn(async () => {
			const error = new Error("busy") as Error & { code?: string };
			error.code = "EBUSY";
			throw error;
		});
		await expect(
			verifyRuntimeFlaggedAccounts({
				loadFlaggedAccounts: async () => ({ version: 1, accounts: [{ email: "refresh@example.com", refreshToken: "refresh-token", addedAt: 1, lastUsed: 1 }] }),
				lookupCodexCliTokensByEmail: async () => { throw new Error("busy"); },
				queuedRefresh: async () => ({ type: "success", access: "new-access", refresh: "new-refresh", expires: now + 60_000 }),
				resolveAccountSelection: (tokens) => ({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
				persistAccounts,
				invalidateAccountManagerCache: vi.fn(),
				saveFlaggedAccounts,
				logInfo: vi.fn(),
				now: () => now,
				showLine: vi.fn(),
			}),
		).rejects.toThrow("busy");
		expect(saveFlaggedAccounts).not.toHaveBeenCalled();
	});
});
