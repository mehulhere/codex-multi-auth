import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";

describe("verifyRuntimeFlaggedAccounts", () => {
	it("restores accounts from Codex CLI cache and preserves the remainder", async () => {
		const fixedNow = 1_000;
		const persistAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "cached@example.com",
						refreshToken: "cached-refresh",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						email: "flagged@example.com",
						refreshToken: "flagged-refresh",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async (email) =>
				email === "cached@example.com"
					? {
							accessToken: "access",
							refreshToken: "new-refresh",
							expiresAt: fixedNow + 60_000,
						}
					: null,
			queuedRefresh: async () => ({
				type: "failed",
				reason: "invalid_grant",
				message: "refresh failed",
			}),
			resolveAccountSelection: (tokens) =>
				({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			now: () => fixedNow,
			showLine,
		});
		expect(persistAccounts).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "flagged-refresh" })],
		});
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("ca***@***.com: RESTORED (Codex CLI cache)"),
		);
	});

	it("restores accounts after a successful refresh", async () => {
		const persistAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "restored@example.com",
						refreshToken: "old-refresh",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async () => null,
			queuedRefresh: async () => ({
				type: "success",
				access: "new-access",
				refresh: "new-refresh",
				expires: 2_000,
			}),
			resolveAccountSelection: (tokens) =>
				({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			showLine,
		});
		expect(persistAccounts).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					refreshToken: "new-refresh",
					accessToken: "new-access",
				}),
			],
			false,
		);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [],
		});
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("re***@***.com: RESTORED"),
		);
	});

	it("logs verification failures through logError and keeps the account flagged", async () => {
		const logError = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "broken@example.com",
						refreshToken: "broken-refresh",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async () => {
				throw new Error("cache unavailable");
			},
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			resolveAccountSelection: () => ({}) as never,
			persistAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			logError,
			showLine: vi.fn(),
		});
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining(
				"Failed to verify flagged account br***@***.com: cache unavailable",
			),
		);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [
				expect.objectContaining({
					refreshToken: "broken-refresh",
					lastError: "cache unavailable",
				}),
			],
		});
	});
});
