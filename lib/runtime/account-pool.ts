import type { ModelFamily } from "../prompts/codex.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../storage.js";
import type { TokenSuccessWithAccount } from "./account-selection.js";

export interface PersistAccountPoolDeps {
	withAccountStorageTransaction: (
		callback: (
			loadedStorage: AccountStorageV3 | null,
			persist: (nextStorage: AccountStorageV3) => Promise<void>,
		) => Promise<void>,
	) => Promise<void>;
	extractAccountId: (accessToken: string | undefined) => string | undefined;
	extractAccountEmail: (
		accessToken: string | undefined,
		idToken?: string | undefined,
	) => string | undefined;
	sanitizeEmail: (email: string | undefined) => string | undefined;
	findMatchingAccountIndex: (
		accounts: Array<{
			accountId?: string;
			email?: string;
			refreshToken?: string;
		}>,
		target: { accountId?: string; email?: string; refreshToken?: string },
		options: { allowUniqueAccountIdFallbackWithoutEmail?: boolean },
	) => number | undefined;
	MODEL_FAMILIES: readonly ModelFamily[];
	getNow?: () => number;
}

export async function persistAccountPool(
	results: TokenSuccessWithAccount[],
	replaceAll: boolean,
	deps: PersistAccountPoolDeps,
): Promise<void> {
	if (results.length === 0) return;
	await deps.withAccountStorageTransaction(async (loadedStorage, persist) => {
		const now = deps.getNow?.() ?? Date.now();
		const stored = replaceAll ? null : loadedStorage;
		const accounts = stored?.accounts ? [...stored.accounts] : [];

		for (const result of results) {
			const accountId =
				result.accountIdOverride ?? deps.extractAccountId(result.access);
			const accountIdSource = accountId
				? (result.accountIdSource ??
					(result.accountIdOverride ? "manual" : "token"))
				: undefined;
			const accountLabel = result.accountLabel;
			const accountEmail = deps.sanitizeEmail(
				deps.extractAccountEmail(result.access, result.idToken),
			);
			const existingIndex = deps.findMatchingAccountIndex(
				accounts,
				{ accountId, email: accountEmail, refreshToken: result.refresh },
				{ allowUniqueAccountIdFallbackWithoutEmail: true },
			);

			if (existingIndex === undefined) {
				const initialWorkspaceIndex =
					result.workspaces && result.workspaces.length > 0
						? (() => {
								if (accountId) {
									const matchingWorkspaceIndex = result.workspaces.findIndex(
										(workspace) => workspace.id === accountId,
									);
									if (matchingWorkspaceIndex >= 0)
										return matchingWorkspaceIndex;
								}
								const firstEnabledWorkspaceIndex = result.workspaces.findIndex(
									(workspace) => workspace.enabled !== false,
								);
								return firstEnabledWorkspaceIndex >= 0
									? firstEnabledWorkspaceIndex
									: 0;
							})()
						: undefined;
				accounts.push({
					accountId,
					accountIdSource,
					accountLabel,
					email: accountEmail,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					addedAt: now,
					lastUsed: now,
					workspaces: result.workspaces,
					currentWorkspaceIndex: initialWorkspaceIndex,
				} satisfies AccountMetadataV3);
				continue;
			}

			const existing = accounts[existingIndex];
			if (!existing) continue;
			const nextEmail = accountEmail ?? deps.sanitizeEmail(existing.email);
			const nextAccountId = accountId ?? existing.accountId;
			const nextAccountIdSource = accountId
				? (accountIdSource ?? existing.accountIdSource)
				: existing.accountIdSource;
			const nextAccountLabel = accountLabel ?? existing.accountLabel;
			const mergedWorkspaces = result.workspaces
				? result.workspaces.map((newWs) => {
						const existingWs = existing.workspaces?.find(
							(workspace) => workspace.id === newWs.id,
						);
						return existingWs
							? {
									...newWs,
									enabled: existingWs.enabled,
									disabledAt: existingWs.disabledAt,
								}
							: newWs;
					})
				: existing.workspaces;
			const currentWorkspaceId =
				existing.workspaces?.[
					typeof existing.currentWorkspaceIndex === "number"
						? existing.currentWorkspaceIndex
						: 0
				]?.id;
			const nextCurrentWorkspaceIndex =
				mergedWorkspaces && mergedWorkspaces.length > 0
					? (() => {
							if (currentWorkspaceId) {
								const matchingWorkspaceIndex = mergedWorkspaces.findIndex(
									(workspace) => workspace.id === currentWorkspaceId,
								);
								if (matchingWorkspaceIndex >= 0) return matchingWorkspaceIndex;
							}
							const defaultWorkspaceIndex = mergedWorkspaces.findIndex(
								(workspace) => workspace.isDefault === true,
							);
							if (defaultWorkspaceIndex >= 0) return defaultWorkspaceIndex;
							const firstEnabledWorkspaceIndex = mergedWorkspaces.findIndex(
								(workspace) => workspace.enabled !== false,
							);
							return firstEnabledWorkspaceIndex >= 0
								? firstEnabledWorkspaceIndex
								: 0;
						})()
					: existing.currentWorkspaceIndex;

			accounts[existingIndex] = {
				...existing,
				accountId: nextAccountId,
				accountIdSource: nextAccountIdSource,
				accountLabel: nextAccountLabel,
				email: nextEmail,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				lastUsed: now,
				workspaces: mergedWorkspaces,
				currentWorkspaceIndex: nextCurrentWorkspaceIndex,
			};
		}

		if (accounts.length === 0) return;
		const activeIndex = replaceAll
			? 0
			: typeof stored?.activeIndex === "number" &&
					Number.isFinite(stored.activeIndex)
				? stored.activeIndex
				: 0;
		const clampedActiveIndex = Math.max(
			0,
			Math.min(activeIndex, accounts.length - 1),
		);
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of deps.MODEL_FAMILIES) {
			const storedFamilyIndex = stored?.activeIndexByFamily?.[family];
			const rawFamilyIndex = replaceAll
				? 0
				: typeof storedFamilyIndex === "number" &&
						Number.isFinite(storedFamilyIndex)
					? storedFamilyIndex
					: clampedActiveIndex;
			activeIndexByFamily[family] = Math.max(
				0,
				Math.min(Math.floor(rawFamilyIndex), accounts.length - 1),
			);
		}

		await persist({
			version: 3,
			accounts,
			activeIndex: clampedActiveIndex,
			activeIndexByFamily,
		});
	});
}
