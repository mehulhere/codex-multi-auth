import { describe, expect, it, vi } from "vitest";
import {
	type DoctorCliOptions,
	type DoctorCommandDeps,
	runDoctorCommand,
} from "../lib/codex-manager/commands/doctor.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [],
	};
}

function createDeps(
	overrides: Partial<DoctorCommandDeps> = {},
): DoctorCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/mock/openai-codex-accounts.json"),
		getCodexCliAuthPath: vi.fn(() => "/mock/auth.json"),
		getCodexCliConfigPath: vi.fn(() => "/mock/config.toml"),
		loadCodexCliState: vi.fn(async () => null),
		parseDoctorArgs: vi.fn((args: string[]) => {
			if (args.includes("--bad"))
				return { ok: false as const, message: "Unknown option: --bad" };
			return {
				ok: true as const,
				options: {
					json: true,
					fix: false,
					dryRun: false,
				} satisfies DoctorCliOptions,
			};
		}),
		printDoctorUsage: vi.fn(),
		loadAccounts: vi.fn(async () => createStorage()),
		applyDoctorFixes: vi.fn(() => ({ changed: false, actions: [] })),
		saveAccounts: vi.fn(async () => undefined),
		resolveActiveIndex: vi.fn(() => 0),
		evaluateForecastAccounts: vi.fn(() => []),
		recommendForecastAccount: vi.fn(() => ({
			recommendedIndex: null,
			reason: "none",
		})),
		sanitizeEmail: vi.fn((email) => email),
		extractAccountEmail: vi.fn(() => undefined),
		extractAccountId: vi.fn(() => undefined),
		hasPlaceholderEmail: vi.fn(() => false),
		hasLikelyInvalidRefreshToken: vi.fn(() => false),
		getDoctorRefreshTokenKey: vi.fn(() => undefined),
		hasUsableAccessToken: vi.fn(() => true),
		queuedRefresh: vi.fn(async () => ({
			type: "failed",
			reason: "invalid_grant",
			message: "token expired",
		})),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		applyTokenAccountIdentity: vi.fn(() => false),
		setCodexCliActiveSelection: vi.fn(async () => true),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		...overrides,
	};
}

describe("runDoctorCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand(["--help"], deps);
		expect(result).toBe(0);
		expect(deps.printDoctorUsage).toHaveBeenCalled();
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand(["--bad"], deps);
		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bad");
	});

	it("prints json diagnostics", async () => {
		const deps = createDeps();
		const result = await runDoctorCommand([], deps);
		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"command": "doctor"'),
		);
	});
});
