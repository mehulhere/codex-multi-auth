import { describe, expect, it, vi } from "vitest";
import { createPersistAccounts, runRuntimeOAuthFlow } from "../lib/runtime/auth-facade.js";

describe("runRuntimeOAuthFlow", () => {
	it("prefixes debug and warn logs with the plugin name", async () => {
		const logDebug = vi.fn();
		const logWarn = vi.fn();
		await runRuntimeOAuthFlow(true, {
			runOAuthBrowserFlow: vi.fn(async (input) => {
				input.logDebug("debug message");
				input.logWarn("warn message");
				return { type: "failed", reason: "cancelled" };
			}),
			manualModeLabel: "manual",
			logInfo: vi.fn(),
			logDebug,
			logWarn,
			pluginName: "codex-multi-auth",
		});
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
		expect(persistAccountPool).toHaveBeenCalledWith(
			results,
			true,
			expect.objectContaining({ MODEL_FAMILIES: ["codex"] }),
		);
	});
});
