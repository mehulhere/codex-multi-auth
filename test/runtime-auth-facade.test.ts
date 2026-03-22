import { describe, expect, it, vi } from "vitest";
import {
	createAccountManagerReloader,
	createPersistAccounts,
	runRuntimeOAuthFlow,
} from "../lib/runtime/auth-facade.js";

describe("runRuntimeOAuthFlow", () => {
	it("passes through info logs and prefixes debug/warn logs with the plugin name", async () => {
		const logInfo = vi.fn();
		const logDebug = vi.fn();
		const logWarn = vi.fn();
		const result = await runRuntimeOAuthFlow(true, {
			runOAuthBrowserFlow: vi.fn(async (input) => {
				input.logInfo("info message");
				input.logDebug("debug message");
				input.logWarn("warn message");
				return { type: "failed", reason: "cancelled" };
			}),
			manualModeLabel: "manual",
			logInfo,
			logDebug,
			logWarn,
			pluginName: "codex-multi-auth",
		});
		expect(result).toEqual({ type: "failed", reason: "cancelled" });
		expect(logInfo).toHaveBeenCalledWith("info message");
		expect(logDebug).toHaveBeenCalledWith("[codex-multi-auth] debug message");
		expect(logWarn).toHaveBeenCalledWith("[codex-multi-auth] warn message");
	});

	it("returns successful oauth results unchanged", async () => {
		const logInfo = vi.fn();
		const logDebug = vi.fn();
		const logWarn = vi.fn();
		const successResult = {
			type: "success" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: 1234,
		};

		const result = await runRuntimeOAuthFlow(false, {
			runOAuthBrowserFlow: vi.fn(async (input) => {
				input.logInfo("info message");
				input.logDebug("debug message");
				input.logWarn("warn message");
				return successResult;
			}),
			manualModeLabel: "manual",
			logInfo,
			logDebug,
			logWarn,
			pluginName: "codex-multi-auth",
		});

		expect(result).toBe(successResult);
		expect(logInfo).toHaveBeenCalledWith("info message");
		expect(logDebug).toHaveBeenCalledWith("[codex-multi-auth] debug message");
		expect(logWarn).toHaveBeenCalledWith("[codex-multi-auth] warn message");
	});
});

describe("createPersistAccounts", () => {
	it("forwards persist dependencies and replaceAll flag", async () => {
		const persistAccountPool = vi.fn(async () => {});
		const persistAccounts = createPersistAccounts({
			persistAccountPool,
			withAccountStorageTransaction: vi.fn(),
			extractAccountId: vi.fn(),
			extractAccountEmail: vi.fn(),
			sanitizeEmail: vi.fn(),
			findMatchingAccountIndex: vi.fn(),
			MODEL_FAMILIES: ["codex"],
		});
		const results = [{ refreshToken: "r1" }] as never[];
		await persistAccounts(results, true);
		await persistAccounts(results);
		expect(persistAccountPool).toHaveBeenNthCalledWith(
			1,
			results,
			true,
			expect.objectContaining({ MODEL_FAMILIES: ["codex"] }),
		);
		expect(persistAccountPool).toHaveBeenNthCalledWith(
			2,
			results,
			false,
			expect.objectContaining({ MODEL_FAMILIES: ["codex"] }),
		);
	});
});

describe("createAccountManagerReloader", () => {
	it("forwards auth fallback and current reload state", async () => {
		const reloadRuntimeAccountManager = vi.fn(async () => "manager");
		const reloader = createAccountManagerReloader({
			reloadRuntimeAccountManager,
			getReloadInFlight: () => null,
			loadFromDisk: vi.fn(async () => "manager"),
			setCachedAccountManager: vi.fn(),
			setAccountManagerPromise: vi.fn(),
			setReloadInFlight: vi.fn(),
		});
		await expect(
			reloader({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
		).resolves.toBe("manager");
		expect(reloadRuntimeAccountManager).toHaveBeenCalledWith(
			expect.objectContaining({
				authFallback: expect.objectContaining({ refresh: "r" }),
			}),
		);
	});
});
