import { describe, expect, it, vi } from "vitest";
import {
	exportAccountsToFile,
	mergeImportedAccounts,
	readImportFile,
} from "../lib/storage/import-export.js";

describe("import export helpers", () => {
	it("merges imported accounts with dedupe guardrails", () => {
		const result = mergeImportedAccounts({
			existing: {
				version: 3,
				accounts: [{ refreshToken: "a" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			imported: {
				version: 3,
				accounts: [{ refreshToken: "b" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			maxAccounts: 10,
			deduplicateAccounts: (accounts) => accounts,
		});

		expect(result.total).toBe(2);
		expect(result.imported).toBe(1);
	});

	it("throws for invalid import payloads and empty exports", async () => {
		await expect(
			readImportFile({
				resolvedPath: `${process.cwd()}/missing-import.json`,
				normalizeAccountStorage: () => null,
			}),
		).rejects.toThrow("Import file not found");

		await expect(
			exportAccountsToFile({
				resolvedPath: `${process.cwd()}/out.json`,
				force: true,
				storage: null,
				logInfo: vi.fn(),
			}),
		).rejects.toThrow("No accounts to export");
	});
});
