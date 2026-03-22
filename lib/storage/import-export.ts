import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AccountStorageV3 } from "../storage.js";

export async function exportAccountsToFile(params: {
	resolvedPath: string;
	force: boolean;
	storage: AccountStorageV3 | null;
	beforeCommit?: (resolvedPath: string) => Promise<void> | void;
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	if (!params.force && existsSync(params.resolvedPath)) {
		throw new Error(`File already exists: ${params.resolvedPath}`);
	}
	if (!params.storage || params.storage.accounts.length === 0) {
		throw new Error("No accounts to export");
	}

	await fs.mkdir(dirname(params.resolvedPath), { recursive: true });
	await params.beforeCommit?.(params.resolvedPath);
	if (!params.force && existsSync(params.resolvedPath)) {
		throw new Error(`File already exists: ${params.resolvedPath}`);
	}

	const content = JSON.stringify(
		{
			version: params.storage.version,
			accounts: params.storage.accounts,
			activeIndex: params.storage.activeIndex,
			activeIndexByFamily: params.storage.activeIndexByFamily,
		},
		null,
		2,
	);
	await fs.writeFile(params.resolvedPath, content, {
		encoding: "utf-8",
		mode: 0o600,
	});
	params.logInfo("Exported accounts", {
		path: params.resolvedPath,
		count: params.storage.accounts.length,
	});
}

export async function readImportFile(params: {
	resolvedPath: string;
	normalizeAccountStorage: (value: unknown) => AccountStorageV3 | null;
}): Promise<AccountStorageV3> {
	if (!existsSync(params.resolvedPath)) {
		throw new Error(`Import file not found: ${params.resolvedPath}`);
	}

	const content = await fs.readFile(params.resolvedPath, "utf-8");
	let imported: unknown;
	try {
		imported = JSON.parse(content);
	} catch {
		throw new Error(`Invalid JSON in import file: ${params.resolvedPath}`);
	}

	const normalized = params.normalizeAccountStorage(imported);
	if (!normalized) {
		throw new Error("Invalid account storage format");
	}
	return normalized;
}

export function mergeImportedAccounts(params: {
	existing: AccountStorageV3 | null;
	imported: AccountStorageV3;
	maxAccounts: number;
	deduplicateAccounts: (
		accounts: AccountStorageV3["accounts"],
	) => AccountStorageV3["accounts"];
}): {
	newStorage: AccountStorageV3;
	imported: number;
	total: number;
	skipped: number;
} {
	const existingAccounts = params.existing?.accounts ?? [];
	const existingActiveIndex = params.existing?.activeIndex ?? 0;
	const merged = [...existingAccounts, ...params.imported.accounts];

	if (merged.length > params.maxAccounts) {
		const deduped = params.deduplicateAccounts(merged);
		if (deduped.length > params.maxAccounts) {
			throw new Error(
				`Import would exceed maximum of ${params.maxAccounts} accounts (would have ${deduped.length})`,
			);
		}
	}

	const deduplicatedAccounts = params.deduplicateAccounts(merged);
	const newStorage: AccountStorageV3 = {
		version: 3,
		accounts: deduplicatedAccounts,
		activeIndex: existingActiveIndex,
		activeIndexByFamily: params.existing?.activeIndexByFamily,
	};
	const importedCount = deduplicatedAccounts.length - existingAccounts.length;
	const skippedCount = params.imported.accounts.length - importedCount;
	return {
		newStorage,
		imported: importedCount,
		total: deduplicatedAccounts.length,
		skipped: skippedCount,
	};
}
