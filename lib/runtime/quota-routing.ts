import type { QuotaCacheEntry, QuotaCacheWindow } from "../quota-cache.js";
import type { HybridQuotaMetrics } from "../rotation.js";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const SEVEN_DAY_WINDOW_MINUTES = 10_080;

type RuntimeQuotaEntry = Pick<
	QuotaCacheEntry,
	"updatedAt" | "primary" | "secondary"
>;

function findWindow(
	entry: RuntimeQuotaEntry,
	windowMinutes: number,
): QuotaCacheWindow | null {
	return (
		[entry.primary, entry.secondary].find(
			(window) => window.windowMinutes === windowMinutes,
		) ?? null
	);
}

function remainingPercent(window: QuotaCacheWindow): number | null {
	if (
		typeof window.usedPercent !== "number" ||
		!Number.isFinite(window.usedPercent)
	) {
		return null;
	}
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function windowExpiresAt(
	entry: RuntimeQuotaEntry,
	window: QuotaCacheWindow,
): number | null {
	if (
		typeof window.resetAtMs === "number" &&
		Number.isFinite(window.resetAtMs)
	) {
		return window.resetAtMs;
	}
	const windowMinutes = window.windowMinutes;
	if (
		!Number.isFinite(entry.updatedAt) ||
		typeof windowMinutes !== "number" ||
		!Number.isFinite(windowMinutes) ||
		windowMinutes <= 0
	) {
		return null;
	}
	return entry.updatedAt + windowMinutes * 60_000;
}

/** Normalize a persisted quota snapshot for quota-aware runtime selection. */
export function buildRuntimeQuotaMetrics(
	entry: RuntimeQuotaEntry,
	now: number,
): HybridQuotaMetrics | null {
	const fiveHourWindow = findWindow(entry, FIVE_HOUR_WINDOW_MINUTES);
	const sevenDayWindow = findWindow(entry, SEVEN_DAY_WINDOW_MINUTES);
	if (!fiveHourWindow || !sevenDayWindow) return null;
	const fiveHourExpiresAtMs = windowExpiresAt(entry, fiveHourWindow);
	const sevenDayExpiresAtMs = windowExpiresAt(entry, sevenDayWindow);
	if (
		fiveHourExpiresAtMs === null ||
		sevenDayExpiresAtMs === null ||
		fiveHourExpiresAtMs <= now ||
		sevenDayExpiresAtMs <= now
	) {
		return null;
	}

	const left5h = remainingPercent(fiveHourWindow);
	const left7d = remainingPercent(sevenDayWindow);
	const reset7dAtMs = sevenDayExpiresAtMs;
	if (
		left5h === null ||
		left7d === null ||
		!Number.isFinite(reset7dAtMs)
	) {
		return null;
	}

	return { left5h, left7d, reset7dAtMs };
}

/** Return whether both live quota windows retain the requested affinity floor. */
export function hasAffinityQuota(
	entry: RuntimeQuotaEntry,
	now: number,
	floorPercent: number,
): boolean {
	if (!Number.isFinite(floorPercent)) return false;
	const metrics = buildRuntimeQuotaMetrics(entry, now);
	return (
		metrics !== null &&
		metrics.left5h >= floorPercent &&
		metrics.left7d >= floorPercent
	);
}
