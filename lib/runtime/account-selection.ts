import {
	getAccountIdCandidates,
	selectBestAccountCandidate,
	type Workspace,
} from "../accounts.js";
import type { AccountIdSource, TokenResult } from "../types.js";

export type TokenSuccess = Extract<TokenResult, { type: "success" }>;

export type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	workspaces?: Workspace[];
};

export function resolveAccountSelection(
	tokens: TokenSuccess,
	deps: { logInfo: (message: string) => void },
): TokenSuccessWithAccount {
	const override = (process.env.CODEX_AUTH_ACCOUNT_ID ?? "").trim();
	if (override) {
		const suffix = override.length > 6 ? override.slice(-6) : override;
		deps.logInfo(
			`Using account override from CODEX_AUTH_ACCOUNT_ID (id:${suffix}).`,
		);
		return {
			...tokens,
			accountIdOverride: override,
			accountIdSource: "manual",
			accountLabel: `Override [id:${suffix}]`,
		};
	}

	const candidates = getAccountIdCandidates(tokens.access, tokens.idToken);
	if (candidates.length === 0) {
		return tokens;
	}

	const workspaces: Workspace[] = candidates.map((candidate) => ({
		id: candidate.accountId,
		name: candidate.label,
		enabled: true,
		isDefault: candidate.isDefault,
	}));

	if (candidates.length === 1) {
		const [candidate] = candidates;
		if (candidate) {
			return {
				...tokens,
				accountIdOverride: candidate.accountId,
				accountIdSource: candidate.source,
				accountLabel: candidate.label,
				workspaces,
			};
		}
	}

	const choice = selectBestAccountCandidate(candidates);
	if (!choice) return tokens;

	return {
		...tokens,
		accountIdOverride: choice.accountId,
		accountIdSource: choice.source ?? "token",
		accountLabel: choice.label,
		workspaces,
	};
}
