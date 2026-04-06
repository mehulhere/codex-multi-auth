import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("inspectStorageHealth", () => {
	afterEach(() => {
		vi.resetModules();
	});

	it("keeps WAL inspection read-only and silent", async () => {
		const logWarn = vi.fn();
		const logInfo = vi.fn();
		vi.doMock("../lib/logger.js", () => ({
			createLogger: () => ({
				warn: logWarn,
				info: logInfo,
				debug: vi.fn(),
				error: vi.fn(),
			}),
		}));

		const workDir = join(tmpdir(), `storage-health-${Date.now()}`);
		await fs.mkdir(workDir, { recursive: true });
		const storagePath = join(workDir, "accounts.json");
		const walPath = `${storagePath}.wal`;

		const content = JSON.stringify({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					refreshToken: "refresh-token",
					accountId: "acc-1",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		});
		await fs.writeFile(
			walPath,
			JSON.stringify({ version: 1, content, checksum: sha256(content) }),
			"utf-8",
		);

		const storageModule = await import("../lib/storage.js");
		storageModule.setStoragePathDirect(storagePath);

		try {
			const summary = await storageModule.inspectStorageHealth();
			expect(summary.state).toBe("recoverable");
			expect(summary.recoverySource).toBe("wal");
			expect(existsSync(storagePath)).toBe(false);
			expect(logWarn).not.toHaveBeenCalledWith(
				"Recovered account storage from WAL journal",
				expect.anything(),
			);
			expect(logInfo).not.toHaveBeenCalled();
		} finally {
			storageModule.setStoragePathDirect(null);
			await fs.rm(workDir, { recursive: true, force: true });
		}
	});
});
