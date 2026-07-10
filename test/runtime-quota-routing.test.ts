import { describe, expect, it } from "vitest";
import {
	type QuotaCacheData,
	type QuotaCacheEntry,
	upsertQuotaCacheEntryForAccount,
} from "../lib/quota-cache.js";
import {
	buildRuntimeQuotaMetrics,
	hasAffinityQuota,
} from "../lib/runtime/quota-routing.js";

const NOW = 1_700_000_000_000;

function entryWith(
	overrides: Partial<QuotaCacheEntry> = {},
): QuotaCacheEntry {
	return {
		updatedAt: NOW - 1_000,
		status: 200,
		model: "gpt-5-codex",
		primary: {
			usedPercent: 50,
			windowMinutes: 300,
			resetAtMs: NOW + 10_000,
		},
		secondary: {
			usedPercent: 20,
			windowMinutes: 10_080,
			resetAtMs: NOW + 20_000,
		},
		...overrides,
	};
}

describe("runtime quota normalization", () => {
	it("identifies 5-hour and 7-day windows when primary and secondary are reversed", () => {
		const entry = entryWith({
			primary: {
				usedPercent: 25,
				windowMinutes: 10_080,
				resetAtMs: NOW + 40_000,
			},
			secondary: {
				usedPercent: 60,
				windowMinutes: 300,
				resetAtMs: NOW + 30_000,
			},
		});

		expect(buildRuntimeQuotaMetrics(entry, NOW)).toEqual({
			left5h: 40,
			left7d: 75,
			reset7dAtMs: NOW + 40_000,
		});
	});

	it("retains exact 5 percent affinity", () => {
		const entry = entryWith({
			primary: { usedPercent: 95, windowMinutes: 300, resetAtMs: NOW + 10_000 },
			secondary: {
				usedPercent: 95,
				windowMinutes: 10_080,
				resetAtMs: NOW + 20_000,
			},
		});

		expect(hasAffinityQuota(entry, NOW, 5)).toBe(true);
	});

	it("rejects 4.99 percent affinity without rounding it to 5", () => {
		const entry = entryWith({
			primary: {
				usedPercent: 95.01,
				windowMinutes: 300,
				resetAtMs: NOW + 10_000,
			},
			secondary: {
				usedPercent: 95,
				windowMinutes: 10_080,
				resetAtMs: NOW + 20_000,
			},
		});

		expect(buildRuntimeQuotaMetrics(entry, NOW)?.left5h).toBeCloseTo(4.99, 10);
		expect(hasAffinityQuota(entry, NOW, 5)).toBe(false);
	});

	it("clamps raw remaining percentages to the 0 through 100 range", () => {
		const entry = entryWith({
			primary: {
				usedPercent: -20,
				windowMinutes: 300,
				resetAtMs: NOW + 10_000,
			},
			secondary: {
				usedPercent: 120,
				windowMinutes: 10_080,
				resetAtMs: NOW + 20_000,
			},
		});

		expect(buildRuntimeQuotaMetrics(entry, NOW)).toEqual({
			left5h: 100,
			left7d: 0,
			reset7dAtMs: NOW + 20_000,
		});
	});

	it("keeps zero remaining as known exhausted metrics for new-thread gating", () => {
		const entry = entryWith({
			primary: {
				usedPercent: 100,
				windowMinutes: 300,
				resetAtMs: NOW + 10_000,
			},
		});

		expect(buildRuntimeQuotaMetrics(entry, NOW)).toEqual({
			left5h: 0,
			left7d: 80,
			reset7dAtMs: NOW + 20_000,
		});
		expect(hasAffinityQuota(entry, NOW, 0.01)).toBe(false);
	});

	it.each(["primary", "secondary"] as const)(
		"treats a passed %s reset as stale unknown quota",
		(windowName) => {
			const entry = entryWith({
				[windowName]: {
					...(windowName === "primary"
						? entryWith().primary
						: entryWith().secondary),
					resetAtMs: NOW,
				},
			});

			expect(buildRuntimeQuotaMetrics(entry, NOW)).toBeNull();
			expect(hasAffinityQuota(entry, NOW, 5)).toBe(false);
		},
	);
});

describe("upsertQuotaCacheEntryForAccount", () => {
	it("writes by unique account id and removes a redundant email entry", () => {
		const staleEntry = entryWith({ model: "stale" });
		const nextEntry = entryWith({ model: "next" });
		const cache: QuotaCacheData = {
			byAccountId: {},
			byEmail: { "owner@example.com": staleEntry },
		};
		const account = { accountId: " acc_owner ", email: "Owner@Example.com " };
		const accounts = [
			account,
			{ accountId: "acc_other", email: "other@example.com" },
		];

		expect(
			upsertQuotaCacheEntryForAccount(cache, account, accounts, nextEntry),
		).toBe(true);
		expect(cache.byAccountId.acc_owner).toBe(nextEntry);
		expect(cache.byEmail).toEqual({});
	});

	it("falls back to a unique normalized email when the account id is ambiguous", () => {
		const nextEntry = entryWith({ model: "email-fallback" });
		const cache: QuotaCacheData = { byAccountId: {}, byEmail: {} };
		const accounts = [
			{ accountId: "acc_shared", email: "Owner@Example.com " },
			{ accountId: "acc_shared", email: "other@example.com" },
		];

		expect(
			upsertQuotaCacheEntryForAccount(cache, accounts[0], accounts, nextEntry),
		).toBe(true);
		expect(cache.byAccountId).toEqual({});
		expect(cache.byEmail["owner@example.com"]).toBe(nextEntry);
	});

	it("rejects ambiguous account ids and emails and prunes an unsafe email entry", () => {
		const staleEntry = entryWith({ model: "stale" });
		const nextEntry = entryWith({ model: "unsafe" });
		const cache: QuotaCacheData = {
			byAccountId: {},
			byEmail: { "shared@example.com": staleEntry },
		};
		const accounts = [
			{ accountId: "acc_shared", email: "shared@example.com" },
			{ accountId: "acc_shared", email: "shared@example.com" },
		];

		expect(
			upsertQuotaCacheEntryForAccount(cache, accounts[0], accounts, nextEntry),
		).toBe(true);
		expect(cache).toEqual({ byAccountId: {}, byEmail: {} });
	});
});
