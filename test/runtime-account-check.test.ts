import { describe, expect, it, vi } from "vitest";
import type { FlaggedAccountMetadataV1 } from "../lib/storage.js";
import { runRuntimeAccountCheck } from "../lib/runtime/account-check.js";

function createEmptyStorage() {
	return {
		version: 3 as const,
		accounts: [],
		activeIndex: 0,
		activeIndexByFamily: {},
	};
}

function createWorkingState(flaggedStorage: {
	version: 1;
	accounts: FlaggedAccountMetadataV1[];
}) {
	return {
		flaggedStorage,
		removeFromActive: new Set<string>(),
		storageChanged: false,
		flaggedChanged: false,
		ok: 0,
		errors: 0,
		disabled: 0,
	};
}

describe("runRuntimeAccountCheck", () => {
	it("reports when there are no accounts to check", async () => {
		const showLine = vi.fn();
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => null,
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: () =>
				createWorkingState({ version: 1, accounts: [] }),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ quotaKey: "codex", limits: {} } as never),
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine,
		});
		expect(showLine).toHaveBeenCalledWith("\nNo accounts to check.\n");
	});

	it("reuses the current time when flagging an invalid refresh token", async () => {
		const saveAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		const now = vi.fn(() => 1000 + now.mock.calls.length - 1);

		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "one@example.com",
						refreshToken: "refresh-1",
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({
				type: "failed",
				reason: "invalid_grant",
				message: "refresh failed",
			}),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => {
				throw new Error("should not probe quota in deep mode");
			},
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			now,
			showLine: vi.fn(),
		});

		const flaggedStorage = saveFlaggedAccounts.mock.calls[0]?.[0];
		expect(flaggedStorage.accounts).toHaveLength(1);
		expect(flaggedStorage.accounts[0]?.flaggedAt).toBe(1000);
		expect(saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({ accounts: [] }),
		);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(now).toHaveBeenCalledTimes(1);
	});

	it("uses cached access tokens without refreshing", async () => {
		const fixedNow = 1_000;
		const lookupCodexCliTokensByEmail = vi.fn(async () => null);
		const queuedRefresh = vi.fn(async () => ({
			type: "failed" as const,
			reason: "invalid_grant",
		}));
		const fetchCodexQuotaSnapshot = vi.fn(async () => ({
			remaining5h: 1,
			remaining7d: 2,
		}) as never);
		const showLine = vi.fn();

		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "cached@example.com",
						refreshToken: "r1",
						accessToken: "cached-access",
						addedAt: 1,
						lastUsed: 1,
						expiresAt: fixedNow + 60_000,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh,
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot,
			resolveRequestAccountId: () => "acct-cached",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => fixedNow,
			showLine,
		});

		expect(lookupCodexCliTokensByEmail).not.toHaveBeenCalled();
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(fetchCodexQuotaSnapshot).toHaveBeenCalledWith({
			accountId: "acct-cached",
			accessToken: "cached-access",
		});
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("ca***@***.com: quota ok"),
		);
	});

	it("falls back to the Codex CLI cache before refreshing", async () => {
		const fixedNow = 1_000;
		const lookupCodexCliTokensByEmail = vi.fn(async () => ({
			accessToken: "cached-access",
			refreshToken: "cached-refresh",
			expiresAt: fixedNow + 60_000,
		}));
		const queuedRefresh = vi.fn(async () => ({
			type: "failed" as const,
			reason: "invalid_grant",
		}));
		const saveAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();

		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "cache@example.com",
						refreshToken: "old-refresh",
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail,
			extractAccountId: () => "acct-cache",
			shouldUpdateAccountIdFromToken: () => true,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => "cache@example.com",
			queuedRefresh,
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				remaining5h: 1,
				remaining7d: 2,
			}) as never),
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => fixedNow,
			showLine: vi.fn(),
		});

		expect(lookupCodexCliTokensByEmail).toHaveBeenCalledWith("cache@example.com");
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						accessToken: "cached-access",
						refreshToken: "cached-refresh",
						expiresAt: fixedNow + 60_000,
						accountId: "acct-cache",
					}),
				],
			}),
		);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
	});

	it("refreshes accounts successfully and persists updated credentials", async () => {
		const fixedNow = 1_000;
		const queuedRefresh = vi.fn(async () => ({
			type: "success" as const,
			access: "refreshed-access",
			refresh: "refreshed-refresh",
			expires: fixedNow + 120_000,
			idToken: "id-token",
		}));
		const saveAccounts = vi.fn(async () => {});
		const showLine = vi.fn();

		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "refresh@example.com",
						refreshToken: "old-refresh",
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => "acct-refresh",
			shouldUpdateAccountIdFromToken: () => true,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => "refresh@example.com",
			queuedRefresh,
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: vi.fn(async () => ({
				remaining5h: 1,
				remaining7d: 2,
			}) as never),
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => fixedNow,
			showLine,
		});

		expect(queuedRefresh).toHaveBeenCalledWith("old-refresh");
		expect(saveAccounts).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						accessToken: "refreshed-access",
						refreshToken: "refreshed-refresh",
						expiresAt: fixedNow + 120_000,
						email: "refresh@example.com",
						accountId: "acct-refresh",
					}),
				],
			}),
		);
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("re***@***.com: quota ok"),
		);
	});

	it("reports missing refresh tokens without queuing refresh", async () => {
		const queuedRefresh = vi.fn(async () => ({
			type: "success" as const,
			access: "unused",
			refresh: "unused",
			expires: 2_000,
		}));
		const showLine = vi.fn();

		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						accountLabel: "Missing token",
						refreshToken: undefined,
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
					{
						accountLabel: "Blank token",
						refreshToken: "   ",
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh,
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => {
				throw new Error("should not probe quota");
			},
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine,
		});

		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("Missing token: ERROR (missing refreshToken)"),
		);
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("Blank token: ERROR (missing refreshToken)"),
		);
	});

	it("masks emails in output lines", async () => {
		const fixedNow = 1_000;
		const showLine = vi.fn();
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "visible@example.com",
						refreshToken: "r1",
						accessToken: "a1",
						addedAt: 1,
						lastUsed: 1,
						expiresAt: fixedNow + 60_000,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({
				remaining5h: 1,
				remaining7d: 2,
			}) as never,
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => fixedNow,
			showLine,
		});
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("vi***@***.com: quota ok"),
		);
	});

	it("persists flagged storage before saving active accounts", async () => {
		const calls: string[] = [];
		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "one@example.com",
						refreshToken: "refresh-1",
						accessToken: undefined,
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage,
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) =>
				createWorkingState(flaggedStorage),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({
				type: "failed",
				reason: "invalid_grant",
				message: "refresh failed",
			}),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => {
				throw new Error("should not probe quota in deep mode");
			},
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {
				calls.push("saveAccounts");
			}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {
				calls.push("saveFlaggedAccounts");
			}),
			showLine: vi.fn(),
		});
		expect(calls).toEqual(["saveFlaggedAccounts", "saveAccounts"]);
	});

	it("keeps flagged accounts durable when saving active accounts fails", async () => {
		const saveFlaggedAccounts = vi.fn(async () => {});
		const saveAccounts = vi.fn(async () => {
			const error = new Error("busy") as Error & { code?: string };
			error.code = "EBUSY";
			throw error;
		});
		await expect(
			runRuntimeAccountCheck(true, {
				hydrateEmails: async (storage) => storage,
				loadAccounts: async () => ({
					version: 3,
					accounts: [
						{
							email: "one@example.com",
							refreshToken: "refresh-1",
							accessToken: undefined,
							addedAt: 1,
							lastUsed: 1,
						},
					],
					activeIndex: 0,
					activeIndexByFamily: { codex: 0 },
				}),
				createEmptyStorage,
				loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
				createAccountCheckWorkingState: (flaggedStorage) =>
					createWorkingState(flaggedStorage),
				lookupCodexCliTokensByEmail: async () => null,
				extractAccountId: () => undefined,
				shouldUpdateAccountIdFromToken: () => false,
				sanitizeEmail: (email) => email,
				extractAccountEmail: () => undefined,
				queuedRefresh: async () => ({
					type: "failed",
					reason: "invalid_grant",
					message: "refresh failed",
				}),
				isRuntimeFlaggableFailure: () => true,
				fetchCodexQuotaSnapshot: async () => {
					throw new Error("should not probe quota in deep mode");
				},
				resolveRequestAccountId: () => undefined,
				formatCodexQuotaLine: () => "quota",
				clampRuntimeActiveIndices: vi.fn(),
				MODEL_FAMILIES: ["codex"],
				saveAccounts,
				invalidateAccountManagerCache: vi.fn(),
				saveFlaggedAccounts,
				showLine: vi.fn(),
			}),
		).rejects.toThrow("busy");
		expect(saveFlaggedAccounts).toHaveBeenCalledTimes(1);
		expect(saveAccounts).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts.mock.invocationCallOrder[0]).toBeLessThan(
			saveAccounts.mock.invocationCallOrder[0],
		);
	});
});
