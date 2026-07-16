import { describe, expect, it } from "vitest";
import {
	isPermanentAuthFailure,
	isRefreshTokenReuseMessage,
} from "../lib/auth/permanent-failure.js";

describe("permanent auth failure classification", () => {
	it("classifies the observed OpenAI refresh-token reuse failure", () => {
		const message =
			"Your refresh token has already been used to generate a new access token. Please try signing in again.";

		expect(isRefreshTokenReuseMessage(message)).toBe(true);
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message,
			}),
		).toBe(true);
	});

	it("recognizes token reuse wording case-insensitively", () => {
		expect(
			isRefreshTokenReuseMessage(
				"REFRESH TOKEN HAS ALREADY BEEN USED by another session",
			),
		).toBe(true);
		expect(
			isRefreshTokenReuseMessage(
				"It has ALREADY BEEN USED TO GENERATE A NEW ACCESS TOKEN",
			),
		).toBe(true);
	});

	it("retains existing terminal credential classifications", () => {
		expect(
			isPermanentAuthFailure({ type: "failed", reason: "missing_refresh" }),
		).toBe(true);
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 401,
			}),
		).toBe(true);
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message: "invalid_grant: token has been revoked",
			}),
		).toBe(true);
	});

	it("does not classify transient or unrelated failures as permanent", () => {
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "network_error",
				message: "timeout",
			}),
		).toBe(false);
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 500,
				message: "upstream unavailable",
			}),
		).toBe(false);
		expect(
			isPermanentAuthFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message: "different bad request",
			}),
		).toBe(false);
	});
});
