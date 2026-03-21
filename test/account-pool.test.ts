import { describe, expect, it, vi } from "vitest";

import type { ModelFamily } from "../lib/prompts/codex.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { TokenSuccessWithAccount } from "../lib/runtime/account-selection.js";
import {
	persistAccountPool,
	type PersistAccountPoolDeps,
} from "../lib/runtime/account-pool.js";

const MODEL_FAMILIES = ["codex", "gpt-5.1"] as const satisfies readonly ModelFamily[];

function createResult(
	overrides: Partial<TokenSuccessWithAccount> = {},
): TokenSuccessWithAccount {
	return {
		type: "success",
		access: "access-token",
		refresh: "refresh-token",
		expires: 1_800_000_000_000,
		idToken: "User@Example.com",
		...overrides,
	};
}

function createDeps(options?: {
	loadedStorage?: AccountStorageV3 | null;
	now?: number;
}) {
	let persistedStorage: AccountStorageV3 | null = null;
	const persist = vi.fn(async (nextStorage: AccountStorageV3) => {
		persistedStorage = nextStorage;
	});
	const withAccountStorageTransaction = vi.fn<
		PersistAccountPoolDeps["withAccountStorageTransaction"]
	>(async (callback) => {
		await callback(options?.loadedStorage ?? null, persist);
	});
	const deps: PersistAccountPoolDeps = {
		withAccountStorageTransaction,
		extractAccountId: (accessToken) =>
			accessToken ? `derived:${accessToken}` : undefined,
		extractAccountEmail: (_accessToken, idToken) =>
			typeof idToken === "string" ? idToken : undefined,
		sanitizeEmail: (email) => email?.trim().toLowerCase(),
		findMatchingAccountIndex: (accounts, target) => {
			const matchIndex = accounts.findIndex((account) => {
				if (
					target.refreshToken &&
					account.refreshToken === target.refreshToken
				) {
					return true;
				}
				if (
					target.accountId &&
					target.email &&
					account.accountId === target.accountId &&
					account.email === target.email
				) {
					return true;
				}
				return Boolean(
					target.accountId &&
						!target.email &&
						account.accountId === target.accountId,
				);
			});
			return matchIndex >= 0 ? matchIndex : undefined;
		},
		MODEL_FAMILIES,
		getNow: () => options?.now ?? 1_700_000_000_000,
	};

	return {
		deps,
		persist,
		withAccountStorageTransaction,
		getPersistedStorage: () => persistedStorage,
	};
}

describe("persistAccountPool", () => {
	it("adds a new account and uses getNow for addedAt and lastUsed", async () => {
		const { deps, getPersistedStorage } = createDeps({ now: 123_456 });

		await persistAccountPool(
			[
				createResult({
					accountIdOverride: "workspace-b",
					accountIdSource: "manual",
					accountLabel: "Workspace B [id:ace-b]",
					workspaces: [
						{ id: "workspace-a", name: "Workspace A", enabled: true },
						{
							id: "workspace-b",
							name: "Workspace B",
							enabled: true,
							isDefault: true,
						},
					],
				}),
			],
			false,
			deps,
		);

		expect(getPersistedStorage()).toEqual({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {
				codex: 0,
				"gpt-5.1": 0,
			},
			accounts: [
				expect.objectContaining({
					accountId: "workspace-b",
					accountIdSource: "manual",
					accountLabel: "Workspace B [id:ace-b]",
					email: "user@example.com",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: 1_800_000_000_000,
					addedAt: 123_456,
					lastUsed: 123_456,
					currentWorkspaceIndex: 1,
					workspaces: [
						{ id: "workspace-a", name: "Workspace A", enabled: true },
						{
							id: "workspace-b",
							name: "Workspace B",
							enabled: true,
							isDefault: true,
						},
					],
				}),
			],
		});
	});

	it("updates an existing account and preserves the active workspace id", async () => {
		const loadedStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0, "gpt-5.1": 0 },
			accounts: [
				{
					accountId: "shared-workspace",
					accountIdSource: "manual",
					accountLabel: "Workspace B [id:ace-b]",
					email: "user@example.com",
					refreshToken: "refresh-token",
					accessToken: "old-access",
					expiresAt: 10,
					addedAt: 111,
					lastUsed: 222,
					workspaces: [
						{ id: "workspace-a", name: "Workspace A", enabled: true },
						{
							id: "workspace-b",
							name: "Workspace B",
							enabled: false,
							disabledAt: 999,
							isDefault: true,
						},
					],
					currentWorkspaceIndex: 1,
				},
			],
		};
		const { deps, getPersistedStorage } = createDeps({
			loadedStorage,
			now: 456_789,
		});

		await persistAccountPool(
			[
				createResult({
					accountIdOverride: "shared-workspace",
					accountIdSource: "manual",
					accountLabel: "Workspace B Renamed [id:ace-b]",
					workspaces: [
						{
							id: "workspace-b",
							name: "Workspace B Renamed",
							enabled: true,
							isDefault: true,
						},
						{ id: "workspace-a", name: "Workspace A", enabled: true },
					],
				}),
			],
			false,
			deps,
		);

		expect(getPersistedStorage()?.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "shared-workspace",
				accountLabel: "Workspace B Renamed [id:ace-b]",
				email: "user@example.com",
				refreshToken: "refresh-token",
				accessToken: "access-token",
				addedAt: 111,
				lastUsed: 456_789,
				currentWorkspaceIndex: 0,
				workspaces: [
					{
						id: "workspace-b",
						name: "Workspace B Renamed",
						enabled: false,
						disabledAt: 999,
						isDefault: true,
					},
					{ id: "workspace-a", name: "Workspace A", enabled: true },
				],
			}),
		);
	});

	it("falls back to the default workspace when the current workspace disappears", async () => {
		const loadedStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0, "gpt-5.1": 0 },
			accounts: [
				{
					accountId: "shared-workspace",
					accountIdSource: "manual",
					accountLabel: "Workspace B [id:ace-b]",
					email: "user@example.com",
					refreshToken: "refresh-token",
					accessToken: "old-access",
					expiresAt: 10,
					addedAt: 111,
					lastUsed: 222,
					workspaces: [
						{ id: "workspace-a", name: "Workspace A", enabled: true },
						{ id: "workspace-b", name: "Workspace B", enabled: true },
					],
					currentWorkspaceIndex: 1,
				},
			],
		};
		const { deps, getPersistedStorage } = createDeps({ loadedStorage });

		await persistAccountPool(
			[
				createResult({
					accountIdOverride: "shared-workspace",
					workspaces: [
						{
							id: "workspace-a",
							name: "Workspace A",
							enabled: true,
							isDefault: true,
						},
						{ id: "workspace-c", name: "Workspace C", enabled: true },
					],
				}),
			],
			false,
			deps,
		);

		expect(getPersistedStorage()?.accounts[0]?.currentWorkspaceIndex).toBe(0);
	});

	it("resets active indices when replaceAll is requested", async () => {
		const loadedStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 9,
			activeIndexByFamily: { codex: 8, "gpt-5.1": 7 },
			accounts: [
				{
					accountId: "old-account",
					refreshToken: "old-refresh",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		const { deps, getPersistedStorage } = createDeps({ loadedStorage });

		await persistAccountPool(
			[
				createResult({
					accountIdOverride: "new-account",
					refresh: "refresh-a",
				}),
				createResult({
					accountIdOverride: "other-account",
					refresh: "refresh-b",
					access: "access-b",
				}),
			],
			true,
			deps,
		);

		expect(getPersistedStorage()).toEqual(
			expect.objectContaining({
				activeIndex: 0,
				activeIndexByFamily: {
					codex: 0,
					"gpt-5.1": 0,
				},
			}),
		);
		expect(getPersistedStorage()?.accounts).toHaveLength(2);
	});

	it("short-circuits before opening a storage transaction when results are empty", async () => {
		const { deps, withAccountStorageTransaction, persist } = createDeps();

		await persistAccountPool([], false, deps);

		expect(withAccountStorageTransaction).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});
});
