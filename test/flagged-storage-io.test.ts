import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccountsOnDisk,
	loadFlaggedAccountsState,
	saveFlaggedAccountsUnlockedToDisk,
} from "../lib/storage/flagged-storage-io.js";

// Use os.tmpdir() instead of process.cwd() so the test never leaves stray
// tmp-flagged.* artifacts at the repo root. Previously these files leaked
// into the worktree and tripped repo hygiene checks (AUDIT-M31 / E-02).
const testTmpRoot = join(tmpdir(), "codex-multi-auth-flagged-storage-tests");

describe("flagged storage io helpers", () => {
	beforeEach(async () => {
		await fs.mkdir(testTmpRoot, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		try {
			await fs.rm(testTmpRoot, { recursive: true, force: true });
		} catch {
			// Ignore: rm can race with antivirus scanners on Windows.
		}
	});

	it("returns empty storage when files are missing", async () => {
		const result = await loadFlaggedAccountsState({
			path: join(testTmpRoot, "flagged.json"),
			legacyPath: join(testTmpRoot, "legacy.json"),
			resetMarkerPath: join(testTmpRoot, "reset"),
			normalizeFlaggedStorage: () => ({
				version: 1,
				accounts: [{ refreshToken: "x" }],
			}),
			saveFlaggedAccounts: vi.fn(),
			logError: vi.fn(),
			logInfo: vi.fn(),
		});

		expect(result).toEqual({ version: 1, accounts: [] });
	});

	it("writes flagged storage using injected helpers", async () => {
		const copyFileWithRetry = vi.fn(async () => undefined);
		const renameFileWithRetry = vi.fn(async () => undefined);
		await saveFlaggedAccountsUnlockedToDisk(
			{ version: 1, accounts: [] },
			{
				path: join(testTmpRoot, "tmp-flagged.json"),
				markerPath: join(testTmpRoot, "tmp-flagged.marker"),
				normalizeFlaggedStorage: (data) => data as never,
				copyFileWithRetry,
				renameFileWithRetry,
				logWarn: vi.fn(),
				logError: vi.fn(),
			},
		);

		expect(renameFileWithRetry).toHaveBeenCalled();
		expect(copyFileWithRetry).not.toThrow;
	});

	it("clears flagged account files with best-effort backup cleanup", async () => {
		await expect(
			clearFlaggedAccountsOnDisk({
				path: join(testTmpRoot, "tmp-flagged.json"),
				markerPath: join(testTmpRoot, "tmp-flagged.marker"),
				backupPaths: [join(testTmpRoot, "tmp-flagged.json.bak")],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		// storage-07: prove unlinkWithRetry honours the widened shared retryable
		// set (ENOTEMPTY/EACCES), not just the legacy EBUSY subset.
		"ENOTEMPTY",
		"EACCES",
	] as const)(
		"retries transient %s errors while clearing flagged storage",
		async (code) => {
			// Marker write is a real fs.writeFile; stub it so the test does not
			// depend on real disk I/O and so fake timers can drain the retry
			// backoff without racing a live write.
			const writeFileSpy = vi.spyOn(fs, "writeFile");
			writeFileSpy.mockResolvedValue(undefined);

			vi.useFakeTimers();
			const unlinkSpy = vi.spyOn(fs, "unlink");
			let attempts = 0;
			unlinkSpy.mockImplementation(async (targetPath) => {
				if (String(targetPath).endsWith("tmp-flagged.json") && attempts < 1) {
					attempts += 1;
					const error = new Error(code) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return undefined as never;
			});

			const clearPromise = clearFlaggedAccountsOnDisk({
				path: join(testTmpRoot, "tmp-flagged.json"),
				markerPath: join(testTmpRoot, "tmp-flagged.marker"),
				backupPaths: [],
				logError: vi.fn(),
			});

			await vi.runAllTimersAsync();
			await expect(clearPromise).resolves.toBeUndefined();
			// Retried at least once on the primary path (failed attempt + retry)
			// plus the marker unlink, so the spy fires more than once overall.
			expect(unlinkSpy.mock.calls.length).toBeGreaterThan(1);
			const primaryUnlinkCalls = unlinkSpy.mock.calls.filter((call) =>
				String(call[0]).endsWith("tmp-flagged.json"),
			);
			expect(primaryUnlinkCalls.length).toBeGreaterThan(1);
		},
	);
});
