import { describe, expect, it, vi } from "vitest";
import { buildBackupMetadata } from "../lib/storage/backup-metadata-builder.js";

describe("backup metadata builder", () => {
	it("builds account and flagged metadata sections from discovered snapshots", async () => {
		const buildMetadataSection = vi.fn(
			(storagePath: string, snapshots: Array<{ path: string }>) => ({
				storagePath,
				latestValidPath: snapshots.at(-1)?.path,
				snapshotCount: snapshots.length,
				validSnapshotCount: snapshots.length,
				snapshots,
			}),
		);

		const result = await buildBackupMetadata({
			storagePath: "/tmp/accounts.json",
			flaggedPath: "/tmp/flagged.json",
			walPath: "/tmp/accounts.json.wal",
			getAccountsBackupRecoveryCandidatesWithDiscovery: async (path) =>
				path.includes("flagged")
					? ["/tmp/flagged.json.bak"]
					: ["/tmp/accounts.json.bak"],
			describeAccountSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
			describeAccountsWalSnapshot: async (path) => ({
				path,
				kind: "accounts-wal",
				exists: true,
				valid: true,
			}),
			describeFlaggedSnapshot: async (path, kind, index) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
			buildMetadataSection,
		});

		expect(buildMetadataSection).toHaveBeenCalledTimes(2);
		expect(result.accounts.snapshotCount).toBe(3);
		expect(result.flaggedAccounts.snapshotCount).toBe(2);
	});
});
