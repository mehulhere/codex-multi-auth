import { describe, expect, it } from "vitest";
import { isQuotaCacheEntryExhausted } from "../lib/quota-readiness.js";

describe("quota readiness", () => {
	it("treats either exhausted quota window as unavailable", () => {
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 100, windowMinutes: 300 },
				secondary: { usedPercent: 20, windowMinutes: 10080 },
			}),
		).toBe(true);
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 20, windowMinutes: 300 },
				secondary: { usedPercent: 100, windowMinutes: 10080 },
			}),
		).toBe(true);
	});

	it("keeps accounts available when both known windows have quota left", () => {
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 99, windowMinutes: 300 },
				secondary: { usedPercent: 99, windowMinutes: 10080 },
			}),
		).toBe(false);
	});

	it("does not treat expired quota windows as exhausted", () => {
		const now = 10_000;
		expect(
			isQuotaCacheEntryExhausted(
				{
					primary: {
						usedPercent: 100,
						windowMinutes: 300,
						resetAtMs: now - 1,
					},
					secondary: { usedPercent: 20, windowMinutes: 10080 },
				},
				now,
			),
		).toBe(false);
		expect(
			isQuotaCacheEntryExhausted(
				{
					primary: { usedPercent: 20, windowMinutes: 300 },
					secondary: {
						usedPercent: 100,
						windowMinutes: 10080,
						resetAtMs: now,
					},
				},
				now,
			),
		).toBe(false);
	});

	// quota-forecast-02: an exhausted window with NO resetAtMs must not read as
	// exhausted forever — once a full window has elapsed since the snapshot it is
	// treated as rolled over.
	it("expires an exhausted window with no resetAtMs after windowMinutes elapse", () => {
		const updatedAt = 1_000_000;
		const windowMinutes = 300; // 5h
		const entry = {
			primary: { usedPercent: 100, windowMinutes },
			secondary: { usedPercent: 10, windowMinutes: 10080 },
			updatedAt,
		};
		// Right after the snapshot: still exhausted.
		expect(isQuotaCacheEntryExhausted(entry, updatedAt + 60_000)).toBe(true);
		// After a full window elapsed without a reset timestamp: no longer exhausted.
		expect(
			isQuotaCacheEntryExhausted(entry, updatedAt + windowMinutes * 60_000 + 1),
		).toBe(false);
	});

	it("still reports exhausted with no resetAtMs before the window elapses", () => {
		const updatedAt = 2_000_000;
		const entry = {
			primary: { usedPercent: 100, windowMinutes: 300 },
			updatedAt,
		};
		expect(isQuotaCacheEntryExhausted(entry, updatedAt + 1000)).toBe(true);
	});
});
