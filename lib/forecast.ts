import { formatAccountLabel, formatWaitTime } from "./accounts.js";
import type { CodexQuotaSnapshot } from "./quota-probe.js";
import type { AccountMetadataV3 } from "./storage.js";
import type { TokenFailure } from "./types.js";

export type ForecastAvailability = "ready" | "delayed" | "unavailable";
export type ForecastRiskLevel = "low" | "medium" | "high";

export interface ForecastAccountInput {
	index: number;
	account: AccountMetadataV3;
	isCurrent: boolean;
	now: number;
	refreshFailure?: TokenFailure;
	liveQuota?: CodexQuotaSnapshot;
}

export interface ForecastAccountResult {
	index: number;
	label: string;
	isCurrent: boolean;
	availability: ForecastAvailability;
	riskScore: number;
	riskLevel: ForecastRiskLevel;
	waitMs: number;
	reasons: string[];
	hardFailure: boolean;
	disabled: boolean;
}

export interface ForecastRecommendation {
	recommendedIndex: number | null;
	reason: string;
}

export interface ForecastSummary {
	total: number;
	ready: number;
	delayed: number;
	unavailable: number;
	highRisk: number;
}

/**
 * Clamp a numeric risk score to the integer range 0–100.
 *
 * This function has no concurrency or filesystem side effects; callers are responsible for any token redaction or platform-specific handling.
 *
 * @param score - The input risk score to clamp; non-finite values produce 100.
 * @returns The input rounded to the nearest integer and constrained between 0 and 100; returns 100 if `score` is not finite.
 */
function clampRisk(score: number): number {
	if (!Number.isFinite(score)) return 100;
	return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Maps a numeric risk score to a categorical risk level.
 *
 * @param score - A risk score (typically 0–100) where higher values indicate greater risk
 * @returns `"high"` if `score` is greater than or equal to 75, `"medium"` if `score` is greater than or equal to 40, `"low"` otherwise
 */
function getRiskLevel(score: number): ForecastRiskLevel {
	if (score >= 75) return "high";
	if (score >= 40) return "medium";
	return "low";
}

/**
 * Finds the earliest future rate-limit reset timestamp for a specific rate-limit family on an account.
 *
 * Examines the account's rateLimitResetTimes and returns the smallest timestamp greater than `now`
 * whose key equals `family` or starts with `${family}:`. Concurrency: this function performs read-only
 * checks and is safe for concurrent reads (it does not mutate shared state). Filesystem: behavior is
 * independent of OS filesystem semantics (including Windows). Token redaction: this function does not
 * log or return tokens, but callers should avoid logging account metadata that may contain sensitive keys.
 *
 * @param account - Account metadata containing an optional `rateLimitResetTimes` map of keys to epoch-ms timestamps.
 * @param now - Reference time in milliseconds since epoch; only reset times strictly greater than `now` are considered.
 * @param family - Rate-limit family name to match (exact key or as prefix with `family:`); defaults to `"codex"`.
 * @returns The smallest reset timestamp (ms since epoch) for the specified family that is greater than `now`, or `null` if none exist.
 */
function getRateLimitResetTimeForFamily(
	account: AccountMetadataV3,
	now: number,
	family = "codex",
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}
	return minReset;
}

/**
 * Computes the maximum positive remaining milliseconds until the primary or secondary quota resets.
 *
 * @param snapshot - Quota snapshot containing `primary.resetAtMs` and `secondary.resetAtMs`
 * @param now - Current time in milliseconds (epoch ms) used as the reference point
 * @returns The largest positive remaining time in milliseconds until a reset, or `0` if neither reset time is in the future
 */
function getLiveQuotaWaitMs(snapshot: CodexQuotaSnapshot, now: number): number {
	const waits: number[] = [];
	for (const resetAt of [snapshot.primary.resetAtMs, snapshot.secondary.resetAtMs]) {
		if (typeof resetAt !== "number") continue;
		if (!Number.isFinite(resetAt)) continue;
		const remaining = resetAt - now;
		if (remaining > 0) waits.push(remaining);
	}
	return waits.length > 0 ? Math.max(...waits) : 0;
}

/**
 * Produces a human-readable quota usage string for a percentage value.
 *
 * This function performs no I/O, is safe to call concurrently, and does not handle or emit any secrets/tokens (no redaction concerns). It is platform-independent and has no special Windows filesystem behavior.
 *
 * @param label - Short label to prefix the message (e.g., "primary")
 * @param usedPercent - The used percentage; if not a finite number the function returns `null`
 * @returns A string like "`{label} quota {N}% used`" where `N` is `usedPercent` rounded and clamped to 0–100, or `null` if `usedPercent` is not a finite number
 */
function describeQuotaUsage(label: string, usedPercent: number | undefined): string | null {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
	const bounded = Math.max(0, Math.min(100, Math.round(usedPercent)));
	return `${label} quota ${bounded}% used`;
}

/**
 * Determines whether a token refresh failure is non-recoverable ("hard").
 *
 * @param failure - Token failure object to classify; the message is inspected case-insensitively and may be redacted or partial.
 * @returns `true` if the failure is considered non-recoverable (hard), `false` otherwise.
 *
 * Notes:
 * - No concurrency or filesystem assumptions.
 * - Message matching is case-insensitive; redacted/partial messages may prevent detection.
 */
export function isHardRefreshFailure(failure: TokenFailure): boolean {
	if (failure.reason === "missing_refresh") return true;
	if (failure.statusCode === 401) return true;
	if (failure.statusCode !== 400) return false;
	const message = (failure.message ?? "").toLowerCase();
	return (
		message.includes("invalid_grant") ||
		message.includes("invalid refresh") ||
		message.includes("token has been revoked")
	);
}

/**
 * Append a human-readable wait reason to a mutable reasons array when the wait time is positive.
 *
 * @param reasons - The array to append the formatted reason to; mutated in-place.
 * @param prefix - The leading text to describe the wait reason (e.g., "rate limit resets in").
 * @param waitMs - Wait time in milliseconds; an entry is appended only if this is greater than zero.
 *
 * Note: This function mutates `reasons` and is not concurrency-safe — callers must synchronize access if used concurrently.
 * It performs no filesystem operations and does not perform any token redaction; ensure `prefix` contains no sensitive data.
 */
function appendWaitReason(reasons: string[], prefix: string, waitMs: number): void {
	if (waitMs <= 0) return;
	reasons.push(`${prefix} ${formatWaitTime(waitMs)}`);
}

/**
 * Computes readiness, risk score, wait time, and human-readable reasons for a single account forecast.
 *
 * @param input - Forecast input containing the account metadata, current timestamp (`now`), `index`, `isCurrent`, and optional `liveQuota` and `refreshFailure`. Sensitive token fields in `account` may be redacted and are not inspected; the function only reads non-secret metadata. This function is synchronous and safe to call concurrently; it does not access the filesystem and behaves identically on Windows.
 * @returns A `ForecastAccountResult` describing the account's `availability` ("ready" | "delayed" | "unavailable"), clamped numeric `riskScore` (0–100), derived `riskLevel`, non-negative integer `waitMs`, diagnostic `reasons`, and flags `hardFailure` and `disabled`.
 */
export function evaluateForecastAccount(input: ForecastAccountInput): ForecastAccountResult {
	const { account, index, isCurrent, now } = input;
	const reasons: string[] = [];
	let availability: ForecastAvailability = "ready";
	let riskScore = isCurrent ? -5 : 0;
	let waitMs = 0;
	let hardFailure = false;
	const disabled = account.enabled === false;

	if (disabled) {
		availability = "unavailable";
		riskScore += 95;
		reasons.push("account is disabled");
	}

	if (input.refreshFailure) {
		const hard = isHardRefreshFailure(input.refreshFailure);
		hardFailure = hard;
		const detail = input.refreshFailure.message ?? input.refreshFailure.reason ?? "refresh failed";
		if (hard) {
			availability = "unavailable";
			riskScore += 90;
			reasons.push(`hard auth failure: ${detail}`);
		} else {
			riskScore += 25;
			reasons.push(`refresh warning: ${detail}`);
		}
	}

	if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) {
		const remaining = account.coolingDownUntil - now;
		waitMs = Math.max(waitMs, remaining);
		if (availability === "ready") availability = "delayed";
		riskScore += 45;
		appendWaitReason(reasons, "cooldown remaining", remaining);
	}

	const rateLimitResetAt = getRateLimitResetTimeForFamily(account, now, "codex");
	if (typeof rateLimitResetAt === "number") {
		const remaining = Math.max(0, rateLimitResetAt - now);
		waitMs = Math.max(waitMs, remaining);
		if (availability === "ready") availability = "delayed";
		riskScore += 35;
		appendWaitReason(reasons, "rate limit resets in", remaining);
	}

	const quota = input.liveQuota;
	if (quota) {
		if (quota.status === 429) {
			availability = availability === "unavailable" ? "unavailable" : "delayed";
			riskScore += 35;
			reasons.push("live probe returned 429");
		}
		const liveWait = getLiveQuotaWaitMs(quota, now);
		waitMs = Math.max(waitMs, liveWait);
		if (liveWait > 0 && availability === "ready") {
			availability = "delayed";
		}

		const primaryUsage = describeQuotaUsage("primary", quota.primary.usedPercent);
		if (primaryUsage) reasons.push(primaryUsage);
		const secondaryUsage = describeQuotaUsage("secondary", quota.secondary.usedPercent);
		if (secondaryUsage) reasons.push(secondaryUsage);

		const primaryUsed = quota.primary.usedPercent ?? 0;
		const secondaryUsed = quota.secondary.usedPercent ?? 0;
		if (primaryUsed >= 98 || secondaryUsed >= 98) {
			riskScore += 55;
		} else if (primaryUsed >= 90 || secondaryUsed >= 90) {
			riskScore += 35;
		} else if (primaryUsed >= 80 || secondaryUsed >= 80) {
			riskScore += 20;
		} else if (primaryUsed >= 70 || secondaryUsed >= 70) {
			riskScore += 10;
		}
	}

	const lastUsedAge = now - (account.lastUsed || 0);
	if (!Number.isFinite(lastUsedAge) || lastUsedAge < 0) {
		riskScore += 5;
	} else if (lastUsedAge > 7 * 24 * 60 * 60 * 1000) {
		riskScore += 10;
	}

	const finalRisk = clampRisk(riskScore);
	return {
		index,
		label: formatAccountLabel(account, index),
		isCurrent,
		availability,
		riskScore: finalRisk,
		riskLevel: getRiskLevel(finalRisk),
		waitMs: Math.max(0, Math.floor(waitMs)),
		reasons,
		hardFailure,
		disabled,
	};
}

/**
 * Evaluate forecasts for multiple accounts and return results in input order.
 *
 * Processes each account input independently and produces a corresponding ForecastAccountResult for each element.
 * This function is synchronous, performs no filesystem I/O (including on Windows), and does not perform token
 * redaction or external side effects; calling code is responsible for any redaction or I/O concerns.
 *
 * @param inputs - Array of account inputs to evaluate
 * @returns An array of ForecastAccountResult values corresponding to each input in the same order
 */
export function evaluateForecastAccounts(inputs: ForecastAccountInput[]): ForecastAccountResult[] {
	return inputs.map((input) => evaluateForecastAccount(input));
}

/**
 * Compare two forecast results for deterministic sorting.
 *
 * Ordering: availability (ready < delayed < unavailable), shorter `waitMs` when both delayed,
 * lower `riskScore`, `isCurrent` preferred, then ascending `index`.
 *
 * @param a - The first forecast result to compare
 * @param b - The second forecast result to compare
 * @returns A negative number if `a` should come before `b`, a positive number if `a` should come after `b`, or `0` if they are equivalent
 */
function compareForecastResults(a: ForecastAccountResult, b: ForecastAccountResult): number {
	if (a.availability !== b.availability) {
		const rank: Record<ForecastAvailability, number> = {
			ready: 0,
			delayed: 1,
			unavailable: 2,
		};
		return rank[a.availability] - rank[b.availability];
	}

	if (a.availability === "delayed" && b.availability === "delayed" && a.waitMs !== b.waitMs) {
		return a.waitMs - b.waitMs;
	}

	if (a.riskScore !== b.riskScore) {
		return a.riskScore - b.riskScore;
	}

	if (a.isCurrent !== b.isCurrent) {
		return a.isCurrent ? -1 : 1;
	}

	return a.index - b.index;
}

/**
 * Selects the best available account to recommend based on availability, wait time, and risk.
 *
 * @param results - Precomputed forecast results for each account (e.g., from evaluateForecastAccounts). This function is pure and synchronous; callers are responsible for providing up-to-date inputs if forecasting is done concurrently. The function performs no filesystem access (works the same on Windows) and does not expose or mutate sensitive tokens — ensure any token fields in `results` are already redacted.
 * @returns The chosen account index and a human-readable reason. `recommendedIndex` is `null` when no healthy candidate exists or no recommendation can be made.
 */
export function recommendForecastAccount(results: ForecastAccountResult[]): ForecastRecommendation {
	const candidates = results.filter((result) => !result.disabled && !result.hardFailure);
	if (candidates.length === 0) {
		return {
			recommendedIndex: null,
			reason: "No healthy accounts are available. Run `codex auth login` to add a fresh account.",
		};
	}

	const sorted = [...candidates].sort(compareForecastResults);
	const best = sorted[0];
	if (!best) {
		return {
			recommendedIndex: null,
			reason: "No recommendation available.",
		};
	}

	if (best.availability === "ready") {
		return {
			recommendedIndex: best.index,
			reason: `Lowest risk ready account (${best.riskLevel}, score ${best.riskScore}).`,
		};
	}

	return {
		recommendedIndex: best.index,
		reason: `No account is immediately ready; pick shortest wait (${formatWaitTime(best.waitMs)}).`,
	};
}

/**
 * Produce an aggregate summary of forecast results.
 *
 * Computes counts for total results and how many are `ready`, `delayed`, `unavailable`, and `highRisk`.
 * This function is pure and performs no I/O; it has no concurrency or filesystem side effects (safe to call on Windows),
 * and it does not expose or redacted tokens — input objects are read-only for counting purposes.
 *
 * @param results - Array of forecasted account results to summarize
 * @returns An object with aggregated counts: `total`, `ready`, `delayed`, `unavailable`, and `highRisk`
 */
export function summarizeForecast(results: ForecastAccountResult[]): ForecastSummary {
	return {
		total: results.length,
		ready: results.filter((result) => result.availability === "ready").length,
		delayed: results.filter((result) => result.availability === "delayed").length,
		unavailable: results.filter((result) => result.availability === "unavailable").length,
		highRisk: results.filter((result) => result.riskLevel === "high").length,
	};
}

