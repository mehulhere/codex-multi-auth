import type { DashboardDisplaySettings } from "../../dashboard-settings.js";
import type { QuotaCacheEntry } from "../../quota-cache.js";
import {
	type CodexQuotaSnapshot,
	fetchCodexQuotaSnapshot,
	formatQuotaSnapshotLine,
} from "../../quota-probe.js";
import {
	isQuotaCacheEntryExhausted,
	quotaLeftPercentFromUsed,
} from "../../quota-readiness.js";
import { quotaToneFromLeftPercent } from "../../ui/format.js";
import {
	collapseWhitespace,
	joinStyledSegments,
	stylePromptText,
} from "./text-style.js";

export function styleQuotaSummary(summary: string): string {
	const normalized = collapseWhitespace(summary);
	if (!normalized) return stylePromptText(summary, "muted");
	const segments = normalized
		.split("|")
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return stylePromptText(normalized, "muted");

	const rendered = segments.map((segment) => {
		if (/rate-limited/i.test(segment)) {
			return stylePromptText(segment, "danger");
		}
		const match = segment.match(
			/^([0-9a-zA-Z]+)\s+(\d{1,3})%(\s+\(resets .+\))?$/,
		);
		if (!match) {
			return stylePromptText(segment, "muted");
		}
		const windowLabel = match[1] ?? "";
		const leftPercent = Math.max(
			0,
			Math.min(100, Number.parseInt(match[2] ?? "", 10)),
		);
		if (!Number.isFinite(leftPercent)) {
			return stylePromptText(segment, "muted");
		}
		const tone = quotaToneFromLeftPercent(leftPercent);
		const resetSuffix = match[3] ?? "";
		return `${stylePromptText(windowLabel, "muted")} ${stylePromptText(`${leftPercent}%`, tone)}${resetSuffix ? stylePromptText(resetSuffix, "muted") : ""}`;
	});

	return joinStyledSegments(rendered);
}

export function formatQuotaSnapshotForDashboard(
	snapshot: Awaited<ReturnType<typeof fetchCodexQuotaSnapshot>>,
	settings: DashboardDisplaySettings,
): string {
	if (!settings.showQuotaDetails) return "live session OK";
	return `live session OK (${formatCompactQuotaSnapshot(snapshot)})`;
}

export function quotaCacheEntryToSnapshot(
	entry: QuotaCacheEntry,
): CodexQuotaSnapshot {
	return {
		status: entry.status,
		planType: entry.planType,
		model: entry.model,
		primary: {
			usedPercent: entry.primary.usedPercent,
			windowMinutes: entry.primary.windowMinutes,
			resetAtMs: entry.primary.resetAtMs,
		},
		secondary: {
			usedPercent: entry.secondary.usedPercent,
			windowMinutes: entry.secondary.windowMinutes,
			resetAtMs: entry.secondary.resetAtMs,
		},
	};
}

function formatCompactQuotaWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function formatCompactQuotaPart(
	windowMinutes: number | undefined,
	usedPercent: number | undefined,
	resetAtMs: number | undefined,
	now: number,
): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	const reset = formatCompactResetAt(resetAtMs, now);
	return `${label} ${left}%${reset ? ` (resets ${reset})` : ""}`;
}

function formatCompactResetAt(
	resetAtMs: number | undefined,
	now: number,
): string | null {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return null;
	}
	const reset = new Date(resetAtMs);
	const current = new Date(now);
	if (!Number.isFinite(reset.getTime()) || !Number.isFinite(current.getTime())) {
		return null;
	}
	const time = reset.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const date = reset.toLocaleDateString(undefined, {
		day: "2-digit",
		month: "short",
		year: "numeric",
	});
	return `${date} ${time}`;
}

export function formatCompactQuotaSnapshot(
	snapshot: CodexQuotaSnapshot,
	now = Date.now(),
): string {
	const parts = [
		formatCompactQuotaPart(
			snapshot.primary.windowMinutes,
			snapshot.primary.usedPercent,
			snapshot.primary.resetAtMs,
			now,
		),
		formatCompactQuotaPart(
			snapshot.secondary.windowMinutes,
			snapshot.secondary.usedPercent,
			snapshot.secondary.resetAtMs,
			now,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (snapshot.status === 429) {
		parts.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(snapshot, now)) {
		parts.push("quota-exhausted");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(snapshot);
}

export function formatAccountQuotaSummary(
	entry: QuotaCacheEntry,
	now = Date.now(),
): string {
	const parts = [
		formatCompactQuotaPart(
			entry.primary.windowMinutes,
			entry.primary.usedPercent,
			entry.primary.resetAtMs,
			now,
		),
		formatCompactQuotaPart(
			entry.secondary.windowMinutes,
			entry.secondary.usedPercent,
			entry.secondary.resetAtMs,
			now,
		),
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (entry.status === 429) {
		parts.push("rate-limited");
	}
	if (isQuotaCacheEntryExhausted(entry, now)) {
		parts.push("quota-exhausted");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(quotaCacheEntryToSnapshot(entry));
}
