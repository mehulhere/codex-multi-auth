import { describe, expect, it, vi } from "vitest";
import type { BackupSnapshotMetadata } from "../lib/storage/backup-metadata.js";
import {
	buildRestoreAssessment,
	collectBackupMetadata,
} from "../lib/storage/restore-assessment.js";

function buildSection(
	storagePath: string,
	snapshots: BackupSnapshotMetadata[],
	latestValidPath?: string,
) {
	return {
		storagePath,
		latestValidPath,
		snapshotCount: snapshots.length,
		validSnapshotCount: snapshots.filter((snapshot) => snapshot.valid).length,
		snapshots,
	};
}

describe("collectBackupMetadata", () => {
	it("assigns backup kinds across slash styles", async () => {
		const describeAccountSnapshot = vi.fn(
			async (path: string, kind: BackupSnapshotMetadata["kind"], index?: number) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
		);
		const describeAccountsWalSnapshot = vi.fn(async (path: string) => ({
			path,
			kind: "accounts-wal" as const,
			exists: true,
			valid: true,
		}));
		const describeFlaggedSnapshot = vi.fn(
			async (path: string, kind: BackupSnapshotMetadata["kind"], index?: number) => ({
				path,
				kind,
				index,
				exists: true,
				valid: true,
			}),
		);
		const buildMetadataSection = vi.fn(buildSection);

		const metadata = await collectBackupMetadata({
			storagePath: "C:/repo/accounts.json",
			flaggedPath: "C:/repo/flagged.json",
			getAccountsWalPath: (path) => `${path}.wal`,
			getAccountsBackupRecoveryCandidatesWithDiscovery: async (path) =>
				path === "C:/repo/accounts.json"
					? [
							"C:\\repo\\accounts.json.bak",
							"C:\\repo\\accounts.json.bak.1",
							"C:/repo/accounts.json.discovered",
						]
					: [
							"C:\\repo\\flagged.json.bak",
							"C:\\repo\\flagged.json.bak.1",
							"C:/repo/flagged.json.discovered",
						],
			describeAccountSnapshot,
			describeAccountsWalSnapshot,
			describeFlaggedSnapshot,
			buildMetadataSection,
		});

		expect(describeAccountsWalSnapshot).toHaveBeenCalledWith("C:/repo/accounts.json.wal");
		expect(describeAccountSnapshot).toHaveBeenNthCalledWith(
			2,
			"C:\\repo\\accounts.json.bak",
			"accounts-backup",
			0,
		);
		expect(describeAccountSnapshot).toHaveBeenNthCalledWith(
			3,
			"C:\\repo\\accounts.json.bak.1",
			"accounts-backup-history",
			1,
		);
		expect(describeAccountSnapshot).toHaveBeenNthCalledWith(
			4,
			"C:/repo/accounts.json.discovered",
			"accounts-discovered-backup",
			2,
		);
		expect(describeFlaggedSnapshot).toHaveBeenNthCalledWith(
			2,
			"C:\\repo\\flagged.json.bak",
			"flagged-backup",
			0,
		);
		expect(describeFlaggedSnapshot).toHaveBeenNthCalledWith(
			3,
			"C:\\repo\\flagged.json.bak.1",
			"flagged-backup-history",
			1,
		);
		expect(describeFlaggedSnapshot).toHaveBeenNthCalledWith(
			4,
			"C:/repo/flagged.json.discovered",
			"flagged-discovered-backup",
			2,
		);
		expect(buildMetadataSection).toHaveBeenNthCalledWith(
			1,
			"C:/repo/accounts.json",
			expect.arrayContaining([expect.objectContaining({ kind: "accounts-wal" })]),
		);
		expect(metadata.accounts.snapshotCount).toBe(5);
		expect(metadata.flaggedAccounts.snapshotCount).toBe(4);
	});

	it("handles empty candidate lists without error", async () => {
		const metadata = await collectBackupMetadata({
			storagePath: "C:/repo/accounts.json",
			flaggedPath: "C:/repo/flagged.json",
			getAccountsWalPath: (path) => `${path}.wal`,
			getAccountsBackupRecoveryCandidatesWithDiscovery: async () => [],
			describeAccountSnapshot: async (path, kind) => ({
				path,
				kind,
				exists: true,
				valid: true,
			}),
			describeAccountsWalSnapshot: async (path) => ({
				path,
				kind: "accounts-wal",
				exists: true,
				valid: true,
			}),
			describeFlaggedSnapshot: async (path, kind) => ({
				path,
				kind,
				exists: true,
				valid: true,
			}),
			buildMetadataSection: buildSection,
		});

		expect(metadata.accounts.snapshotCount).toBe(2);
		expect(metadata.flaggedAccounts.snapshotCount).toBe(1);
	});
});

describe("buildRestoreAssessment", () => {
	it("prefers the latest valid backup over an empty primary", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: false,
			backupMetadata: {
				accounts: buildSection(
					"C:/repo/accounts.json",
					[
						{
							kind: "accounts-primary",
							path: "C:/repo/accounts.json",
							exists: true,
							valid: true,
							accountCount: 0,
						},
						{
							kind: "accounts-backup",
							path: "C:/repo/accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 2,
						},
					],
					"C:/repo/accounts.json.bak",
				),
				flaggedAccounts: buildSection("C:/repo/flagged.json", []),
			},
		});
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("empty-storage");
		expect(assessment.latestSnapshot?.path).toBe("C:/repo/accounts.json.bak");
	});

	it("matches latest valid snapshot paths across path separators", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: false,
			backupMetadata: {
				accounts: buildSection(
					"C:/repo/accounts.json",
					[
						{
							kind: "accounts-primary",
							path: "C:/repo/accounts.json",
							exists: false,
							valid: false,
						},
						{
							kind: "accounts-backup",
							path: "C:/repo/accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 1,
						},
					],
					"C:\\repo\\accounts.json.bak",
				),
				flaggedAccounts: buildSection("C:/repo/flagged.json", []),
			},
		});
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("missing-storage");
		expect(assessment.latestSnapshot?.path).toBe("C:/repo/accounts.json.bak");
	});

	it("returns intentional-reset when the reset marker exists", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: true,
			backupMetadata: {
				accounts: buildSection(
					"C:/repo/accounts.json",
					[
						{
							kind: "accounts-primary",
							path: "C:/repo/accounts.json",
							exists: true,
							valid: true,
							accountCount: 3,
						},
						{
							kind: "accounts-backup",
							path: "C:/repo/accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 3,
						},
					],
					"C:/repo/accounts.json.bak",
				),
				flaggedAccounts: buildSection("C:/repo/flagged.json", []),
			},
		});
		expect(assessment.restoreEligible).toBe(false);
		expect(assessment.restoreReason).toBe("intentional-reset");
	});

	it("restores from the latest backup when the primary exists but is invalid", () => {
		const assessment = buildRestoreAssessment({
			storagePath: "C:/repo/accounts.json",
			resetMarkerExists: false,
			backupMetadata: {
				accounts: buildSection(
					"C:/repo/accounts.json",
					[
						{
							kind: "accounts-primary",
							path: "C:/repo/accounts.json",
							exists: true,
							valid: false,
						},
						{
							kind: "accounts-backup",
							path: "C:/repo/accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 3,
						},
					],
					"C:/repo/accounts.json.bak",
				),
				flaggedAccounts: buildSection("C:/repo/flagged.json", []),
			},
		});
		expect(assessment.restoreEligible).toBe(true);
		expect(assessment.restoreReason).toBe("corrupted-primary");
		expect(assessment.latestSnapshot?.path).toBe("C:/repo/accounts.json.bak");
	});
});
