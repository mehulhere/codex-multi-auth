import { describe, expect, it, vi } from "vitest";
import {
	loadNormalizedStorageFromPathOrNull,
	mergeStorageForMigration,
} from "../lib/storage/migration-helpers.js";

const currentStorage = {
	version: 3 as const,
	activeIndex: 0,
	activeIndexByFamily: { codex: 0 },
	accounts: [{ refreshToken: "current-refresh", addedAt: 1, lastUsed: 1 }],
};

const incomingStorage = {
	version: 3 as const,
	activeIndex: 0,
	activeIndexByFamily: { codex: 0 },
	accounts: [{ refreshToken: "incoming-refresh", addedAt: 2, lastUsed: 2 }],
};

describe("loadNormalizedStorageFromPathOrNull", () => {
	it("retries transient lock errors before succeeding", async () => {
		const sleep = vi.fn(async () => {});
		const logWarn = vi.fn();
		const loadAccountsFromPath = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
			.mockRejectedValueOnce(Object.assign(new Error("again"), { code: "EAGAIN" }))
			.mockResolvedValueOnce({
				normalized: {
					version: 3,
					activeIndex: 0,
					activeIndexByFamily: {},
					accounts: [],
				},
				schemaErrors: [],
			});
		const result = await loadNormalizedStorageFromPathOrNull(
			"legacy.json",
			"legacy storage",
			{
				loadAccountsFromPath,
				logWarn,
				sleep,
			},
		);
		expect(result).toMatchObject({ version: 3, accounts: [] });
		expect(loadAccountsFromPath).toHaveBeenCalledTimes(3);
		expect(logWarn).not.toHaveBeenCalled();
		expect(sleep).toHaveBeenNthCalledWith(1, 10);
		expect(sleep).toHaveBeenNthCalledWith(2, 20);
	});

	it("logs schema validation warnings and still returns normalized storage", async () => {
		const logWarn = vi.fn();
		const normalized = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [],
		};
		const result = await loadNormalizedStorageFromPathOrNull(
			"legacy.json",
			"legacy storage",
			{
				loadAccountsFromPath: vi.fn(async () => ({
					normalized,
					schemaErrors: ["missing refreshToken"],
				})),
				logWarn,
			},
		);
		expect(result).toBe(normalized);
		expect(logWarn).toHaveBeenCalledWith(
			"legacy storage schema validation warnings",
			{
				path: "legacy.json",
				errors: ["missing refreshToken"],
			},
		);
	});

	it("returns null without warning when the file is missing", async () => {
		const logWarn = vi.fn();
		const result = await loadNormalizedStorageFromPathOrNull(
			"legacy.json",
			"legacy storage",
			{
				loadAccountsFromPath: vi
					.fn()
					.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
				logWarn,
			},
		);
		expect(result).toBeNull();
		expect(logWarn).not.toHaveBeenCalled();
	});

	it("returns null and logs once after retry budget is exhausted", async () => {
		const logWarn = vi.fn();
		const sleep = vi.fn(async () => {});
		const loadAccountsFromPath = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
		const result = await loadNormalizedStorageFromPathOrNull(
			"legacy.json",
			"legacy storage",
			{
				loadAccountsFromPath,
				logWarn,
				sleep,
			},
		);
		expect(result).toBeNull();
		expect(loadAccountsFromPath).toHaveBeenCalledTimes(4);
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(logWarn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to load"),
			expect.objectContaining({ path: "legacy.json" }),
		);
	});
});

describe("mergeStorageForMigration", () => {
	it("returns incoming storage when there is no current storage", () => {
		const normalizeAccountStorage = vi.fn();
		expect(
			mergeStorageForMigration(null, incomingStorage, {
				normalizeAccountStorage,
			}),
		).toBe(incomingStorage);
		expect(normalizeAccountStorage).not.toHaveBeenCalled();
	});

	it("returns the normalized merged storage when normalization succeeds", () => {
		const mergedStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [currentStorage.accounts[0], incomingStorage.accounts[0]],
		};
		const normalizeAccountStorage = vi.fn(() => mergedStorage);
		const result = mergeStorageForMigration(currentStorage, incomingStorage, {
			normalizeAccountStorage,
		});
		expect(result).toBe(mergedStorage);
		expect(normalizeAccountStorage).toHaveBeenCalledWith({
			version: 3,
			activeIndex: currentStorage.activeIndex,
			activeIndexByFamily: currentStorage.activeIndexByFamily,
			accounts: [...currentStorage.accounts, ...incomingStorage.accounts],
		});
	});

	it("logs and falls back to current storage when normalization fails", () => {
		const logWarn = vi.fn();
		const result = mergeStorageForMigration(currentStorage, incomingStorage, {
			normalizeAccountStorage: vi.fn(() => null),
			logWarn,
		});
		expect(result).toBe(currentStorage);
		expect(logWarn).toHaveBeenCalledWith(
			"Failed to merge legacy storage, incoming accounts dropped",
			{
				currentCount: currentStorage.accounts.length,
				incomingCount: incomingStorage.accounts.length,
			},
		);
	});
});
