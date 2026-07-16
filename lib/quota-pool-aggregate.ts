export const FIVE_HOUR_WINDOW_MINUTES = 300 as const;
export const SEVEN_DAY_WINDOW_MINUTES = 10_080 as const;

export interface QuotaPoolWindowLike {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
}

export interface QuotaPoolSnapshotLike {
	primary?: QuotaPoolWindowLike;
	secondary?: QuotaPoolWindowLike;
}

export interface QuotaPoolWindowAggregate {
	windowMinutes:
		| typeof FIVE_HOUR_WINDOW_MINUTES
		| typeof SEVEN_DAY_WINDOW_MINUTES;
	reportedCount: number;
	totalRemainingPercent: number;
	averageRemainingPercent: number;
	earliestResetAtMs?: number;
	latestResetAtMs?: number;
}

export interface QuotaPoolAggregate {
	accountCount: number;
	fiveHour: QuotaPoolWindowAggregate | null;
	sevenDay: QuotaPoolWindowAggregate | null;
}

function aggregateWindow(
	accountCount: number,
	snapshots: readonly QuotaPoolSnapshotLike[],
	windowMinutes:
		| typeof FIVE_HOUR_WINDOW_MINUTES
		| typeof SEVEN_DAY_WINDOW_MINUTES,
): QuotaPoolWindowAggregate | null {
	let reportedCount = 0;
	let totalRemainingPercent = 0;
	const resetTimes: number[] = [];
	for (const snapshot of snapshots) {
		for (const window of [snapshot.primary, snapshot.secondary]) {
			if (window?.windowMinutes !== windowMinutes) continue;
			if (
				typeof window.usedPercent !== "number" ||
				!Number.isFinite(window.usedPercent)
			) {
				continue;
			}
			reportedCount += 1;
			totalRemainingPercent += Math.max(
				0,
				Math.min(100, 100 - window.usedPercent),
			);
			if (
				typeof window.resetAtMs === "number" &&
				Number.isFinite(window.resetAtMs) &&
				window.resetAtMs > 0
			) {
				resetTimes.push(window.resetAtMs);
			}
		}
	}
	if (reportedCount === 0) return null;
	const result: QuotaPoolWindowAggregate = {
		windowMinutes,
		reportedCount,
		totalRemainingPercent,
		averageRemainingPercent:
			accountCount > 0 ? totalRemainingPercent / accountCount : 0,
	};
	if (resetTimes.length > 0) {
		result.earliestResetAtMs = Math.min(...resetTimes);
		result.latestResetAtMs = Math.max(...resetTimes);
	}
	return result;
}

export function aggregateQuotaPool(
	accountCount: number,
	snapshots: readonly QuotaPoolSnapshotLike[],
): QuotaPoolAggregate {
	const normalizedAccountCount = Math.max(0, Math.trunc(accountCount));
	return {
		accountCount: normalizedAccountCount,
		fiveHour: aggregateWindow(
			normalizedAccountCount,
			snapshots,
			FIVE_HOUR_WINDOW_MINUTES,
		),
		sevenDay: aggregateWindow(
			normalizedAccountCount,
			snapshots,
			SEVEN_DAY_WINDOW_MINUTES,
		),
	};
}

function formatWindow(window: QuotaPoolWindowAggregate | null): string {
	if (!window) return "unavailable";
	return `${Math.round(window.totalRemainingPercent)}% total | ${Math.round(window.averageRemainingPercent)}% average`;
}

export function formatQuotaPoolAggregate(value: QuotaPoolAggregate): string[] {
	return [
		`Combined limits (${value.accountCount} accounts):`,
		`  7d: ${formatWindow(value.sevenDay)}`,
		`  5h: ${formatWindow(value.fiveHour)}`,
	];
}
