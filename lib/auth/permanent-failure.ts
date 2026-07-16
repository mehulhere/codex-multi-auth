import type { TokenFailure } from "../types.js";

const REFRESH_TOKEN_REUSE_PHRASES = [
	"refresh token has already been used",
	"already been used to generate a new access token",
] as const;

/** Detect the terminal refresh-token rotation error returned by OpenAI OAuth. */
export function isRefreshTokenReuseMessage(message: string): boolean {
	const normalized = message.toLowerCase();
	return REFRESH_TOKEN_REUSE_PHRASES.some((phrase) =>
		normalized.includes(phrase),
	);
}

/** Return true only for credential failures that require an explicit re-login. */
export function isPermanentAuthFailure(failure: TokenFailure): boolean {
	if (failure.reason === "missing_refresh") return true;
	if (failure.statusCode === 401) return true;
	if (failure.statusCode !== 400) return false;
	const message = (failure.message ?? "").toLowerCase();
	return (
		message.includes("invalid_grant") ||
		message.includes("invalid refresh") ||
		message.includes("token has been revoked") ||
		isRefreshTokenReuseMessage(message)
	);
}
