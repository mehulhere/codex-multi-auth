import { describe, expect, it, vi } from "vitest";
import {
	type ReportCommandDeps,
	runReportCommand,
} from "../lib/codex-manager/commands/report.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "one@example.com",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				expiresAt: 10,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		],
	};
}

function createDeps(
	overrides: Partial<ReportCommandDeps> = {},
): ReportCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/mock/openai-codex-accounts.json"),
		loadAccounts: vi.fn(async () => createStorage()),
		resolveActiveIndex: vi.fn(() => 0),
		queuedRefresh: vi.fn(async () => ({
			type: "success",
			access: "access-token-1",
			refresh: "refresh-token-1",
			expires: 100,
			idToken: "id-token-1",
		})),
		fetchCodexQuotaSnapshot: vi.fn(async () => ({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		})),
		formatRateLimitEntry: vi.fn(() => null),
		normalizeFailureDetail: vi.fn((message) => message ?? "unknown"),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: vi.fn(() => 1_000),
		getCwd: vi.fn(() => "/repo"),
		writeFile: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("runReportCommand", () => {
	it("prints usage for help", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--help"], deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("Usage: codex auth report"),
		);
	});

	it("rejects invalid options", async () => {
		const deps = createDeps();

		const result = await runReportCommand(["--bogus"], deps);

		expect(result).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith("Unknown option: --bogus");
	});

	it("writes json report output when requested", async () => {
		const deps = createDeps();

		const result = await runReportCommand(
			["--json", "--out", "report.json"],
			deps,
		);

		expect(result).toBe(0);
		expect(deps.writeFile).toHaveBeenCalledWith(
			expect.stringContaining("report.json"),
			expect.stringContaining('"command": "report"'),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"forecast"'),
		);
	});
});
