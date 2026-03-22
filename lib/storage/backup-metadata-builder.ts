import type { BackupMetadata } from "../storage.js";

type Snapshot = {
	kind:
		| "accounts-primary"
		| "accounts-wal"
		| "accounts-backup"
		| "accounts-backup-history"
		| "accounts-discovered-backup"
		| "flagged-primary"
		| "flagged-backup"
		| "flagged-backup-history"
		| "flagged-discovered-backup";
	path: string;
	index?: number;
	exists: boolean;
	valid: boolean;
	bytes?: number;
	mtimeMs?: number;
	version?: number;
	accountCount?: number;
	flaggedCount?: number;
	schemaErrors?: string[];
};

export async function buildBackupMetadata(params: {
	storagePath: string;
	flaggedPath: string;
	walPath: string;
	getAccountsBackupRecoveryCandidatesWithDiscovery: (
		path: string,
	) => Promise<string[]>;
	describeAccountSnapshot: (
		path: string,
		kind:
			| "accounts-primary"
			| "accounts-backup"
			| "accounts-backup-history"
			| "accounts-discovered-backup",
		index?: number,
	) => Promise<Snapshot>;
	describeAccountsWalSnapshot: (path: string) => Promise<Snapshot>;
	describeFlaggedSnapshot: (
		path: string,
		kind:
			| "flagged-primary"
			| "flagged-backup"
			| "flagged-backup-history"
			| "flagged-discovered-backup",
		index?: number,
	) => Promise<Snapshot>;
	buildMetadataSection: (
		storagePath: string,
		snapshots: Snapshot[],
	) => {
		storagePath: string;
		latestValidPath?: string;
		snapshotCount: number;
		validSnapshotCount: number;
		snapshots: Snapshot[];
	};
}): Promise<BackupMetadata> {
	const {
		storagePath,
		flaggedPath,
		walPath,
		getAccountsBackupRecoveryCandidatesWithDiscovery,
		describeAccountSnapshot,
		describeAccountsWalSnapshot,
		describeFlaggedSnapshot,
		buildMetadataSection,
	} = params;

	const accountCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(storagePath);
	const accountSnapshots: Snapshot[] = [
		await describeAccountSnapshot(storagePath, "accounts-primary"),
		await describeAccountsWalSnapshot(walPath),
	];
	for (const [index, candidate] of accountCandidates.entries()) {
		const kind =
			candidate === `${storagePath}.bak`
				? "accounts-backup"
				: candidate.startsWith(`${storagePath}.bak.`)
					? "accounts-backup-history"
					: "accounts-discovered-backup";
		accountSnapshots.push(
			await describeAccountSnapshot(candidate, kind, index),
		);
	}

	const flaggedCandidates =
		await getAccountsBackupRecoveryCandidatesWithDiscovery(flaggedPath);
	const flaggedSnapshots: Snapshot[] = [
		await describeFlaggedSnapshot(flaggedPath, "flagged-primary"),
	];
	for (const [index, candidate] of flaggedCandidates.entries()) {
		const kind =
			candidate === `${flaggedPath}.bak`
				? "flagged-backup"
				: candidate.startsWith(`${flaggedPath}.bak.`)
					? "flagged-backup-history"
					: "flagged-discovered-backup";
		flaggedSnapshots.push(
			await describeFlaggedSnapshot(candidate, kind, index),
		);
	}

	return {
		accounts: buildMetadataSection(storagePath, accountSnapshots),
		flaggedAccounts: buildMetadataSection(flaggedPath, flaggedSnapshots),
	};
}
