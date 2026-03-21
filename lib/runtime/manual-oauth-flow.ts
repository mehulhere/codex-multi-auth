import type { TokenResult } from "../types.js";

type TokenSuccess = Extract<TokenResult, { type: "success" }>;

export function buildManualOAuthFlow<TResolved extends TokenSuccess>(params: {
	pkce: { verifier: string };
	url: string;
	expectedState: string;
	redirectUri: string;
	parseAuthorizationInput: (input: string) => {
		code?: string;
		state?: string;
	};
	exchangeAuthorizationCode: (
		code: string,
		verifier: string,
		redirectUri: string,
	) => Promise<TokenResult>;
	resolveTokenSuccess: (tokens: TokenSuccess) => TResolved;
	onSuccess?: (tokens: TResolved) => Promise<void>;
	instructions: string;
}): {
	url: string;
	method: "code";
	instructions: string;
	validate: (input: string) => string | undefined;
	callback: (input: string) => Promise<TokenResult | TResolved>;
} {
	return {
		url: params.url,
		method: "code",
		instructions: params.instructions,
		validate: (input: string): string | undefined => {
			const parsed = params.parseAuthorizationInput(input);
			if (!parsed.code) {
				return `No authorization code found. Paste the full callback URL (e.g., ${params.redirectUri}?code=...)`;
			}
			if (!parsed.state) {
				return "Missing OAuth state. Paste the full callback URL including both code and state parameters.";
			}
			if (parsed.state !== params.expectedState) {
				return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt.";
			}
			return undefined;
		},
		callback: async (input: string) => {
			const parsed = params.parseAuthorizationInput(input);
			if (!parsed.code || !parsed.state) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "Missing authorization code or OAuth state",
				};
			}
			if (parsed.state !== params.expectedState) {
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message: "OAuth state mismatch. Restart login and try again.",
				};
			}
			const tokens = await params.exchangeAuthorizationCode(
				parsed.code,
				params.pkce.verifier,
				params.redirectUri,
			);
			if (tokens?.type === "success") {
				const resolved = params.resolveTokenSuccess(tokens);
				if (params.onSuccess) {
					await params.onSuccess(resolved);
				}
				return resolved;
			}
			return tokens?.type === "failed" ? tokens : { type: "failed" as const };
		},
	};
}
