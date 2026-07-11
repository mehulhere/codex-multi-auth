import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedAccount } from "../lib/accounts.js";
import {
	maskThreadStatusEmail,
	ThreadStatusStore,
} from "../lib/runtime/thread-status.js";

const NOW = 1_700_000_000_000;

function managedAccount(
	index: number,
	email: string,
	overrides: Partial<ManagedAccount> = {},
): ManagedAccount {
	return {
		index,
		accountId: `acc_${index + 1}`,
		email,
		refreshToken: `refresh-secret-${index + 1}`,
		enabled: true,
		access: `access-secret-${index + 1}`,
		expires: NOW + 60_000,
		addedAt: NOW - 60_000,
		lastUsed: NOW - 30_000,
		rateLimitResetTimes: {},
		...overrides,
	};
}

const quota = {
	status: 200,
	primary: { usedPercent: 4, windowMinutes: 300, resetAtMs: NOW + 3_600_000 },
	secondary: {
		usedPercent: 1,
		windowMinutes: 10_080,
		resetAtMs: NOW + 86_400_000,
	},
};

describe("ThreadStatusStore", () => {
	it("returns distinct redacted status for simultaneous threads", () => {
		const accounts = [
			managedAccount(0, "alice@example.com"),
			managedAccount(1, "bob@example.net"),
		];
		const store = new ThreadStatusStore({ ttlMs: 60_000, maxEntries: 10 });

		store.remember("thread-a", accounts[0], quota, NOW);
		store.remember(
			"thread-b",
			accounts[1],
			{
				...quota,
				primary: { ...quota.primary, usedPercent: 55 },
			},
			NOW + 1,
		);

		expect(store.get("thread-a", accounts, NOW + 2)).toMatchObject({
			accountNumber: 1,
			accountDisplay: "Account 1 (al***@example.com)",
			primary: { usedPercent: 4 },
		});
		expect(store.get("thread-b", accounts, NOW + 2)).toMatchObject({
			accountNumber: 2,
			accountDisplay: "Account 2 (bo***@example.net)",
			primary: { usedPercent: 55 },
		});

		const serialized = JSON.stringify(store.snapshot(accounts, NOW + 2));
		expect(serialized).not.toContain("alice@example.com");
		expect(serialized).not.toContain("refresh-secret");
		expect(serialized).not.toContain("access-secret");
		expect(serialized).not.toContain("acc_1");
	});

	it("re-resolves account numbers after the pool is reordered", () => {
		const alice = managedAccount(0, "alice@example.com");
		const bob = managedAccount(1, "bob@example.net");
		const store = new ThreadStatusStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("thread-a", alice, quota, NOW);

		const reordered = [
			{ ...bob, index: 0 },
			{ ...alice, index: 1 },
		];

		expect(store.get("thread-a", reordered, NOW + 1)).toMatchObject({
			accountNumber: 2,
			accountDisplay: "Account 2 (al***@example.com)",
		});
	});

	it("returns null instead of guessing when the account no longer resolves", () => {
		const account = managedAccount(0, "alice@example.com");
		const store = new ThreadStatusStore({ ttlMs: 60_000, maxEntries: 10 });
		store.remember("thread-a", account, quota, NOW);

		expect(store.get("thread-a", [], NOW + 1)).toBeNull();
	});

	it("persists redacted account affinity across router restarts", () => {
		const root = mkdtempSync(join(tmpdir(), "codex-thread-status-"));
		const storagePath = join(root, "thread-assignments.json");
		try {
			const account = managedAccount(0, "alice@example.com");
			const first = new ThreadStatusStore({
				ttlMs: 90 * 24 * 60 * 60_000,
				maxEntries: 10,
				storagePath,
			});
			first.remember("thread-persistent", account, quota, NOW);

			const restored = new ThreadStatusStore({
				ttlMs: 90 * 24 * 60 * 60_000,
				maxEntries: 10,
				storagePath,
			});
			expect(restored.get("thread-persistent", [account], NOW + 60 * 60_000)).toMatchObject({
				accountDisplay: "Account 1 (al***@example.com)",
				primary: { usedPercent: 4 },
			});

			const persisted = readFileSync(storagePath, "utf8");
			expect(persisted).not.toContain("alice@example.com");
			expect(persisted).not.toContain("refresh-secret");
			expect(persisted).not.toContain("access-secret");
			expect(persisted).not.toContain("acc_1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("expires stale records and evicts the oldest record at the size bound", () => {
		const account = managedAccount(0, "alice@example.com");
		const store = new ThreadStatusStore({ ttlMs: 1_000, maxEntries: 2 });
		store.remember("oldest", account, quota, NOW);
		store.remember("middle", account, quota, NOW + 1);
		store.remember("newest", account, quota, NOW + 2);

		expect(store.get("oldest", [account], NOW + 3)).toBeNull();
		expect(Object.keys(store.snapshot([account], NOW + 3))).toEqual([
			"middle",
			"newest",
		]);
		expect(store.get("middle", [account], NOW + 1_001)).toBeNull();
	});
});

describe("maskThreadStatusEmail", () => {
	it("keeps the full domain while masking the local part", () => {
		expect(maskThreadStatusEmail("octanes.arsenic18@icloud.com")).toBe(
			"oc***@icloud.com",
		);
		expect(maskThreadStatusEmail("a@example.com")).toBe("a***@example.com");
	});

	it("rejects malformed or missing email", () => {
		expect(maskThreadStatusEmail(undefined)).toBeNull();
		expect(maskThreadStatusEmail("not-an-email")).toBeNull();
	});
});
