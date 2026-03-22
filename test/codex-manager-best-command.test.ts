import { describe, expect, it, vi } from "vitest";
import {
	type BestCliOptions,
	type BestCommandDeps,
	runBestCommand,
} from "../lib/codex-manager/commands/best.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "best@example.com",
				refreshToken: "refresh-best",
				accessToken: "access-best",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		],
	};
}

function createDeps(overrides: Partial<BestCommandDeps> = {}): BestCommandDeps {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		saveAccounts: vi.fn(async () => undefined),
		parseBestArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			return {
				ok: true as const,
				options: {
					live: false,
					json: true,
					model: "gpt-5-codex",
					modelProvided: false,
				} satisfies BestCliOptions,
			};
		}),
		printBestUsage: vi.fn(),
		resolveActiveIndex: vi.fn(() => 0),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-best",
			refresh: "refresh-best",
			expires: Date.now() + 60_000,
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		extractAccountId: vi.fn(() => "account-id"),
		extractAccountEmail: vi.fn(() => "best@example.com"),
		sanitizeEmail: vi.fn((email) => email),
		formatAccountLabel: vi.fn(
			(_account, index) => `${index + 1}. best@example.com`,
		),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		})),
		evaluateForecastAccounts: vi.fn(() => [
			{
				index: 0,
				label: "1. best@example.com",
				isCurrent: true,
				availability: "ready",
				riskScore: 0,
				riskLevel: "low",
				waitMs: 0,
				reasons: ["healthy"],
			},
		]),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: 0,
			reason: "lowest risk",
		})),
		persistAndSyncSelectedAccount: vi.fn(async () => ({
			synced: true,
			wasDisabled: false,
		})),
		setCodexCliActiveSelection: vi.fn(async () => true),
		logInfo: vi.fn(),
		logWarn: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

describe("runBestCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runBestCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printBestUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runBestCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("prints json output when already on the best account", async () => {
		const deps = createDeps();
		const result = await runBestCommand([], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"accountIndex": 1'),
		);
	});
});
