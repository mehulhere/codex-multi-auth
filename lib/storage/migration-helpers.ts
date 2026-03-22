import { sleep } from "../utils.js";
import type { AccountStorageV3 } from "../storage.js";

export async function loadNormalizedStorageFromPathOrNull(
	path: string,
	label: string,
	deps: {
		loadAccountsFromPath: (path: string) => Promise<{
			normalized: AccountStorageV3 | null;
			schemaErrors: string[];
		}>;
		logWarn: (message: string, meta: Record<string, unknown>) => void;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<AccountStorageV3 | null> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const { normalized, schemaErrors } = await deps.loadAccountsFromPath(path);
			if (schemaErrors.length > 0) {
				deps.logWarn(`${label} schema validation warnings`, {
					path,
					errors: schemaErrors.slice(0, 5),
				});
			}
			return normalized;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EBUSY" || code === "EPERM" || code === "EAGAIN") {
				if (attempt < 3) {
					await (deps.sleep ?? sleep)(10 * 2 ** attempt);
					continue;
				}
			}
			if (code !== "ENOENT") {
				deps.logWarn(`Failed to load ${label}`, {
					path,
					error: String(error),
				});
			}
			return null;
		}
	}
}

export function mergeStorageForMigration(
	current: AccountStorageV3 | null,
	incoming: AccountStorageV3,
	deps: {
		normalizeAccountStorage: (data: unknown) => AccountStorageV3 | null;
		logWarn?: (message: string, meta: Record<string, unknown>) => void;
	},
): AccountStorageV3 {
	if (!current) {
		return incoming;
	}

	const merged = deps.normalizeAccountStorage({
		version: 3,
		activeIndex: current.activeIndex,
		activeIndexByFamily: current.activeIndexByFamily,
		accounts: [...current.accounts, ...incoming.accounts],
	});
	if (!merged) {
		deps.logWarn?.("Failed to merge legacy storage, incoming accounts dropped", {
			currentCount: current.accounts.length,
			incomingCount: incoming.accounts.length,
		});
		return current;
	}
	return merged;
}
