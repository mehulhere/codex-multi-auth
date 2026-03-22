import type { BackupMetadata, RestoreAssessment } from "../storage.js";
import type { BackupSnapshotMetadata } from "./backup-metadata.js";

type BackupSnapshotKind = BackupSnapshotMetadata["kind"];

function normalizeSnapshotPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function resolveBackupKind(
	candidatePath: string,
	storagePath: string,
	backupKind: BackupSnapshotKind,
	historyKind: BackupSnapshotKind,
	discoveredKind: BackupSnapshotKind,
): BackupSnapshotKind {
	const normalizedCandidatePath = normalizeSnapshotPath(candidatePath);
	const normalizedStoragePath = normalizeSnapshotPath(storagePath);
	if (normalizedCandidatePath === `${normalizedStoragePath}.bak`) {
		return backupKind;
	}
	if (normalizedCandidatePath.startsWith(`${normalizedStoragePath}.bak.`)) {
		return historyKind;
	}
	return discoveredKind;
}

function resolveLatestSnapshot(backupMetadata: BackupMetadata): BackupSnapshotMetadata | undefined {
	const latestValidPath = backupMetadata.accounts.latestValidPath;
	if (!latestValidPath) return undefined;
	const normalizedLatest = normalizeSnapshotPath(latestValidPath);
	return backupMetadata.accounts.snapshots.find(
		(snapshot) => normalizeSnapshotPath(snapshot.path) === normalizedLatest,
	);
}

export async function collectBackupMetadata(deps: {
	storagePath: string;
	flaggedPath: string;
	getAccountsWalPath: (path: string) => string;
	getAccountsBackupRecoveryCandidatesWithDiscovery: (
		path: string,
	) => Promise<string[]>;
	describeAccountSnapshot: (
		path: string,
		kind: BackupSnapshotKind,
		index?: number,
	) => Promise<BackupSnapshotMetadata>;
	describeAccountsWalSnapshot: (
		path: string,
	) => Promise<BackupSnapshotMetadata>;
	describeFlaggedSnapshot: (
		path: string,
		kind: BackupSnapshotKind,
		index?: number,
	) => Promise<BackupSnapshotMetadata>;
	buildMetadataSection: (
		path: string,
		snapshots: BackupSnapshotMetadata[],
	) => BackupMetadata["accounts"];
}): Promise<BackupMetadata> {
	const walPath = deps.getAccountsWalPath(deps.storagePath);
	const accountCandidates =
		await deps.getAccountsBackupRecoveryCandidatesWithDiscovery(
			deps.storagePath,
		);
	const accountSnapshots: BackupSnapshotMetadata[] = [
		await deps.describeAccountSnapshot(deps.storagePath, "accounts-primary"),
		await deps.describeAccountsWalSnapshot(walPath),
	];
	for (const [index, candidate] of accountCandidates.entries()) {
		const kind = resolveBackupKind(
			candidate,
			deps.storagePath,
			"accounts-backup",
			"accounts-backup-history",
			"accounts-discovered-backup",
		);
		accountSnapshots.push(
			await deps.describeAccountSnapshot(candidate, kind, index),
		);
	}

	const flaggedCandidates =
		await deps.getAccountsBackupRecoveryCandidatesWithDiscovery(
			deps.flaggedPath,
		);
	const flaggedSnapshots: BackupSnapshotMetadata[] = [
		await deps.describeFlaggedSnapshot(deps.flaggedPath, "flagged-primary"),
	];
	for (const [index, candidate] of flaggedCandidates.entries()) {
		const kind = resolveBackupKind(
			candidate,
			deps.flaggedPath,
			"flagged-backup",
			"flagged-backup-history",
			"flagged-discovered-backup",
		);
		flaggedSnapshots.push(
			await deps.describeFlaggedSnapshot(candidate, kind, index),
		);
	}

	return {
		accounts: deps.buildMetadataSection(deps.storagePath, accountSnapshots),
		flaggedAccounts: deps.buildMetadataSection(
			deps.flaggedPath,
			flaggedSnapshots,
		),
	};
}

export function buildRestoreAssessment(deps: {
	storagePath: string;
	resetMarkerExists: boolean;
	backupMetadata: BackupMetadata;
}): RestoreAssessment {
	if (deps.resetMarkerExists) {
		return {
			storagePath: deps.storagePath,
			restoreEligible: false,
			restoreReason: "intentional-reset",
			backupMetadata: deps.backupMetadata,
		};
	}

	const primarySnapshot = deps.backupMetadata.accounts.snapshots.find(
		(snapshot) => snapshot.kind === "accounts-primary",
	);
	if (!primarySnapshot?.exists) {
		return {
			storagePath: deps.storagePath,
			restoreEligible: true,
			restoreReason: "missing-storage",
			latestSnapshot: resolveLatestSnapshot(deps.backupMetadata),
			backupMetadata: deps.backupMetadata,
		};
	}
	if (primarySnapshot.valid && primarySnapshot.accountCount === 0) {
		return {
			storagePath: deps.storagePath,
			restoreEligible: true,
			restoreReason: "empty-storage",
			latestSnapshot: resolveLatestSnapshot(deps.backupMetadata) ?? primarySnapshot,
			backupMetadata: deps.backupMetadata,
		};
	}
	if (primarySnapshot.exists && !primarySnapshot.valid) {
		return {
			storagePath: deps.storagePath,
			restoreEligible: true,
			restoreReason: "corrupted-primary",
			latestSnapshot: resolveLatestSnapshot(deps.backupMetadata) ?? primarySnapshot,
			backupMetadata: deps.backupMetadata,
		};
	}
	return {
		storagePath: deps.storagePath,
		restoreEligible: false,
		latestSnapshot: resolveLatestSnapshot(deps.backupMetadata),
		backupMetadata: deps.backupMetadata,
	};
}
