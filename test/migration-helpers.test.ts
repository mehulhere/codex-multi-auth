import { describe, expect, it, vi } from "vitest";
import { loadNormalizedStorageFromPathOrNull } from "../lib/storage/migration-helpers.js";

describe("loadNormalizedStorageFromPathOrNull", () => {
	it("retries transient lock errors before succeeding", async () => {
		const sleep = vi.fn(async () => {});
		const loadAccountsFromPath = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
			.mockRejectedValueOnce(Object.assign(new Error("again"), { code: "EAGAIN" }))
			.mockResolvedValueOnce({ normalized: { version: 3, activeIndex: 0, activeIndexByFamily: {}, accounts: [] }, schemaErrors: [] });
		const result = await loadNormalizedStorageFromPathOrNull("legacy.json", "legacy storage", { loadAccountsFromPath, logWarn: vi.fn(), sleep });
		expect(result).toMatchObject({ version: 3, accounts: [] });
		expect(loadAccountsFromPath).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 10);
		expect(sleep).toHaveBeenNthCalledWith(2, 20);
	});

	it("returns null and logs once after retry budget is exhausted", async () => {
		const logWarn = vi.fn();
		const sleep = vi.fn(async () => {});
		const loadAccountsFromPath = vi.fn().mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
		const result = await loadNormalizedStorageFromPathOrNull("legacy.json", "legacy storage", { loadAccountsFromPath, logWarn, sleep });
		expect(result).toBeNull();
		expect(loadAccountsFromPath).toHaveBeenCalledTimes(4);
		expect(logWarn).toHaveBeenCalledTimes(1);
	});
});
