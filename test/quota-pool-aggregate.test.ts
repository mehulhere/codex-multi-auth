import { describe, expect, it } from "vitest";
import {
	aggregateQuotaPool,
	formatQuotaPoolAggregate,
} from "../lib/quota-pool-aggregate.js";

describe("quota pool aggregation", () => {
	it("sums all seven 7-day limits and divides by all configured accounts", () => {
		const resetTimes = [6, 5, 4, 3, 2, 1, 7].map(
			(day) => Date.UTC(2026, 6, 14 + day),
		);
		const remaining = [0, 0, 37, 40, 35, 26, 38];
		const snapshots = remaining.map((left, index) => ({
			primary: {},
			secondary: {
				usedPercent: 100 - left,
				windowMinutes: 10_080,
				resetAtMs: resetTimes[index],
			},
		}));

		expect(aggregateQuotaPool(7, snapshots)).toEqual({
			accountCount: 7,
			fiveHour: null,
			sevenDay: {
				windowMinutes: 10_080,
				reportedCount: 7,
				totalRemainingPercent: 176,
				averageRemainingPercent: 176 / 7,
				earliestResetAtMs: Math.min(...resetTimes),
				latestResetAtMs: Math.max(...resetTimes),
			},
		});
	});

	it("recognizes windows by duration and keeps missing values out of the sum", () => {
		const result = aggregateQuotaPool(7, [
			{
				primary: { usedPercent: 10, windowMinutes: 10_080 },
				secondary: { usedPercent: 20, windowMinutes: 300 },
			},
			{
				primary: { usedPercent: Number.NaN, windowMinutes: 300 },
				secondary: { usedPercent: 60, windowMinutes: 10_080 },
			},
		]);

		expect(result.fiveHour).toMatchObject({
			reportedCount: 1,
			totalRemainingPercent: 80,
			averageRemainingPercent: 80 / 7,
		});
		expect(result.sevenDay).toMatchObject({
			reportedCount: 2,
			totalRemainingPercent: 130,
			averageRemainingPercent: 130 / 7,
		});
	});

	it("clamps remaining values and reports absent windows as unavailable", () => {
		const result = aggregateQuotaPool(2, [
			{ primary: {}, secondary: { usedPercent: -20, windowMinutes: 10_080 } },
			{ primary: {}, secondary: { usedPercent: 140, windowMinutes: 10_080 } },
		]);

		expect(result.fiveHour).toBeNull();
		expect(result.sevenDay).toMatchObject({
			totalRemainingPercent: 100,
			averageRemainingPercent: 50,
		});
	});

	it("formats totals and nearest-whole averages for people", () => {
		const result = aggregateQuotaPool(7, [
			...Array.from({ length: 6 }, () => ({
				primary: {},
				secondary: { usedPercent: 75, windowMinutes: 10_080 },
			})),
			{
				primary: {},
				secondary: { usedPercent: 74, windowMinutes: 10_080 },
			},
		]);

		expect(formatQuotaPoolAggregate(result)).toEqual([
			"Combined limits (7 accounts):",
			"  7d: 176% total | 25% average",
			"  5h: unavailable",
		]);
	});
});
