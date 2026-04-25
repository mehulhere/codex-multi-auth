import { describe, expect, it } from "vitest";
import {
	appRuntimeHelperStatusToSignal,
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
} from "../lib/runtime/runtime-current-account.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "selected@example.com",
				accountId: "acc_selected",
				refreshToken: "refresh-selected",
			},
			{
				email: "runtime@example.com",
				accountId: "acc_runtime",
				refreshToken: "refresh-runtime",
			},
		],
	};
}

describe("resolveRuntimeCurrentAccount", () => {
	it("uses the freshest runtime source and matches by account id", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				runtimeSnapshot: {
					version: 1,
					updatedAt: now - 500,
					currentRequestId: null,
					responsesRequests: 1,
					authRefreshRequests: 0,
					diagnosticProbeRequests: 0,
					poolExhaustionCooldownUntil: null,
					serverBurstCooldownUntil: null,
					lastAccountIndex: 1,
					lastAccountId: "acc_runtime",
					lastAccountUpdatedAt: now - 500,
					runtimeMetrics: {
						startedAt: now - 1_000,
						totalRequests: 1,
						successfulRequests: 1,
						failedRequests: 0,
						responsesRequests: 1,
						authRefreshRequests: 0,
						diagnosticProbeRequests: 0,
						outboundRequestAttemptBudget: null,
						outboundRequestAttemptsConsumed: 0,
						requestAttemptBudgetExhaustions: 0,
						poolExhaustionFastFails: 0,
						serverBurstFastFails: 0,
						rateLimitedResponses: 0,
						serverErrors: 0,
						networkErrors: 0,
						userAborts: 0,
						authRefreshFailures: 0,
						emptyResponseRetries: 0,
						accountRotations: 1,
						sameAccountRetries: 0,
						streamFailoverAttempts: 0,
						streamFailoverCandidatesConsidered: 0,
						lastStreamFailoverCandidateCount: 0,
						streamFailoverRecoveries: 0,
						streamFailoverCrossAccountRecoveries: 0,
						cumulativeLatencyMs: 10,
						lastRequestAt: now - 500,
						lastError: null,
					},
				},
				appBindStatus: {
					state: "running",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 0,
					lastAccountLabel: "Account 1",
					lastAccountEmail: "selected@example.com",
					lastAccountId: "acc_selected",
					updatedAt: now - 1_000,
					lastError: null,
				},
			},
			{ now },
		);

		expect(result).toMatchObject({
			index: 1,
			source: "runtime-observability",
			matchedBy: "account-id",
		});
	});

	it("ignores stale runtime account signals", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appBindStatus: {
					state: "running",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2",
					lastAccountEmail: "runtime@example.com",
					lastAccountId: "acc_runtime",
					updatedAt: now - 5_000,
					lastError: null,
				},
			},
			{ now, maxAgeMs: 1_000 },
		);

		expect(result).toBeNull();
	});

	it("ignores app-bind router status that is not running", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appBindStatus: {
					state: "stopped",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2",
					lastAccountEmail: "runtime@example.com",
					lastAccountId: "acc_runtime",
					updatedAt: now,
					lastError: null,
				},
			},
			{ now },
		);

		expect(result).toBeNull();
	});

	it("only turns a running live app helper status into a runtime signal", () => {
		const baseStatus = {
			kind: "codex-app-runtime-rotation-helper",
			state: "running",
			pid: process.pid,
			lastAccountIndex: 1,
			lastAccountLabel: "Account 2",
			lastAccountEmail: null,
			lastAccountId: "acc_runtime",
			lastAccountUpdatedAt: 10_000,
			updatedAt: 10_000,
		};

		expect(appRuntimeHelperStatusToSignal(baseStatus)).toMatchObject({
			source: "app-helper",
			lastAccountIndex: 1,
			lastAccountId: "acc_runtime",
		});
		expect(
			appRuntimeHelperStatusToSignal({
				...baseStatus,
				state: "idle-timeout",
			}),
		).toBeNull();
		expect(
			appRuntimeHelperStatusToSignal({
				...baseStatus,
				kind: "unrelated-process",
			}),
		).toBeNull();
	});

	it("labels stored selected and runtime in-use rows separately", () => {
		const runtimeCurrent = {
			index: 1,
			source: "runtime-observability" as const,
			matchedBy: "account-id" as const,
			updatedAt: 10_000,
		};

		expect(resolveAccountCurrentMarkers(0, 0, runtimeCurrent)).toEqual([
			"selected",
		]);
		expect(resolveAccountCurrentMarkers(1, 0, runtimeCurrent)).toEqual([
			"in-use",
		]);
		expect(resolveAccountCurrentMarkers(0, 0, null)).toEqual(["current"]);
	});
});
