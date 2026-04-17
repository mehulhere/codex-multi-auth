import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	loadAccountsFromPath,
	parseAndNormalizeStorage,
} from "../lib/storage/storage-parser.js";
import { normalizeAccountStorage } from "../lib/storage.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

describe("storage parser helpers", () => {
	it("parses and normalizes record storage payloads", () => {
		const result = parseAndNormalizeStorage(
			{ version: 3, activeIndex: 0, accounts: [] },
			normalizeAccountStorage,
			isRecord,
		);

		expect(result.normalized?.version).toBe(3);
		expect(result.storedVersion).toBe(3);
		expect(Array.isArray(result.schemaErrors)).toBe(true);
	});

	it("loads and parses storage files from disk", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-test.json`;
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf8",
		);
		try {
			const result = await loadAccountsFromPath(filePath, {
				normalizeAccountStorage,
				isRecord,
			});
			expect(result.normalized?.version).toBe(3);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});

	it("propagates SyntaxError on malformed JSON (preserved contract)", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-syntax-error.json`;
		await fs.writeFile(filePath, "{not valid json {[", "utf8");
		try {
			await expect(
				loadAccountsFromPath(filePath, {
					normalizeAccountStorage,
					isRecord,
				}),
			).rejects.toBeInstanceOf(SyntaxError);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});

	it("surfaces schema warnings for JSON-valid but schema-invalid payloads", async () => {
		const filePath = `${process.cwd()}/tmp-storage-parser-schema-invalid.json`;
		// Version 2 is not part of AnyAccountStorageSchema; normalizer returns
		// null, but the raw payload still reaches parseAndNormalizeStorage so
		// schemaErrors is populated for observability.
		await fs.writeFile(
			filePath,
			JSON.stringify({ version: 2, accounts: [], activeIndex: 0 }),
			"utf8",
		);
		try {
			const result = await loadAccountsFromPath(filePath, {
				normalizeAccountStorage,
				isRecord,
			});
			expect(result.normalized).toBeNull();
			expect(result.storedVersion).toBe(2);
			expect(result.schemaErrors.length).toBeGreaterThan(0);
		} finally {
			await fs.rm(filePath, { force: true });
		}
	});
});
