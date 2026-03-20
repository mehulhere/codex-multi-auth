import { describe, expect, it, vi } from "vitest";
import {
	runVerifyFlaggedCommand,
	type VerifyFlaggedCliOptions,
	type VerifyFlaggedCommandDeps,
} from "../lib/codex-manager/commands/verify-flagged.js";
import type {
	AccountStorageV3,
	FlaggedAccountMetadataV1,
} from "../lib/storage.js";

function createFlaggedAccount(
	overrides: Partial<FlaggedAccountMetadataV1> = {},
): FlaggedAccountMetadataV1 {
	return {
		email: "flagged@example.com",
		refreshToken: "refresh-flagged",
		addedAt: 1,
		...overrides,
	};
}

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [],
	};
}

function createDeps(
	overrides: Partial<VerifyFlaggedCommandDeps> = {},
): VerifyFlaggedCommandDeps {
	const parse = vi.fn((args: string[]) => {
		if (args.includes("--bad"))
			return { ok: false as const, message: "Unknown option: --bad" };
		return {
			ok: true as const,
			options: {
				dryRun: false,
				json: true,
				restore: true,
			} satisfies VerifyFlaggedCliOptions,
		};
	});
	return {
		setStoragePath: vi.fn(),
		loadFlaggedAccounts: vi.fn(async () => ({
			version: 1 as const,
			accounts: [createFlaggedAccount()],
		})),
		loadAccounts: vi.fn(async () => createStorage()),
		queuedRefresh: vi.fn(async () => ({
			type: "failed",
			reason: "invalid_grant",
			message: "token expired",
		})),
		parseVerifyFlaggedArgs: parse,
		printVerifyFlaggedUsage: vi.fn(),
		createEmptyAccountStorage: vi.fn(() => createStorage()),
		upsertRecoveredFlaggedAccount: vi.fn(() => ({
			restored: false,
			changed: false,
			message: "restore skipped",
		})),
		resolveStoredAccountIdentity: vi.fn(() => ({})),
		extractAccountId: vi.fn(() => undefined),
		extractAccountEmail: vi.fn(() => undefined),
		sanitizeEmail: vi.fn((email) => email),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		withAccountAndFlaggedStorageTransaction: vi.fn(async (callback) => {
			await callback(createStorage(), async () => undefined);
		}),
		normalizeDoctorIndexes: vi.fn(),
		saveFlaggedAccounts: vi.fn(async () => undefined),
		formatAccountLabel: vi.fn(() => "1. flagged@example.com"),
		stylePromptText: vi.fn((text) => text),
		styleAccountDetailText: vi.fn((text) => text),
		formatResultSummary: vi.fn((segments) =>
			segments.map((segment) => segment.text).join(" | "),
		),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

describe("runVerifyFlaggedCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runVerifyFlaggedCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printVerifyFlaggedUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runVerifyFlaggedCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("emits json output for failed flagged refreshes", async () => {
		const deps = createDeps();
		const result = await runVerifyFlaggedCommand([], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"command": "verify-flagged"'),
		);
	});

	it("keeps retry-local flagged state isolated across transaction retries", async () => {
		const persistCalls: Array<{ version: 1; accounts: FlaggedAccountMetadataV1[] }> =
			[];
		const deps = createDeps({
			loadFlaggedAccounts: vi.fn(async () => ({
				version: 1 as const,
				accounts: [
					createFlaggedAccount({
						email: "restored@example.com",
						refreshToken: "refresh-restored",
					}),
					createFlaggedAccount({
						email: "still@example.com",
						refreshToken: "refresh-still",
					}),
				],
			})),
			queuedRefresh: vi
				.fn()
				.mockResolvedValueOnce({
					type: "success",
					access: "restored-access",
					refresh: "restored-refresh",
					expires: 5_000,
				})
				.mockResolvedValueOnce({
					type: "failed",
					reason: "invalid_grant",
					message: "token expired",
				}),
			upsertRecoveredFlaggedAccount: vi.fn(() => ({
				restored: true,
				changed: true,
				message: "restored",
			})),
			withAccountAndFlaggedStorageTransaction: vi.fn(async (callback) => {
				let attempt = 0;
				const persist = async (
					_nextStorage: AccountStorageV3,
					nextFlagged: { version: 1; accounts: FlaggedAccountMetadataV1[] },
				): Promise<void> => {
					persistCalls.push({
						version: nextFlagged.version,
						accounts: nextFlagged.accounts.map((account) => ({ ...account })),
					});
					attempt += 1;
					if (attempt === 1) {
						const error = new Error("busy") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					}
				};

				try {
					await callback(createStorage(), persist);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
					await callback(createStorage(), persist);
				}
			}),
		});

		const result = await runVerifyFlaggedCommand([], deps);

		expect(result).toBe(0);
		expect(persistCalls).toHaveLength(2);
		expect(persistCalls[0]!.accounts).toHaveLength(1);
		expect(persistCalls[1]!.accounts).toHaveLength(1);
		expect(persistCalls[1]!.accounts[0]).toEqual(
			expect.objectContaining({ email: "still@example.com" }),
		);

		const payload = JSON.parse(
			(deps.logInfo as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0],
		);
		expect(payload.remainingFlagged).toBe(1);
		expect(payload.reports).toHaveLength(2);
	});
});
