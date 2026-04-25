import {
	isDisplayCurrentAccount,
	resolveAccountCurrentMarkers,
	type RuntimeCurrentAccountSelection,
} from "./runtime-current-account.js";

type LoginMenuAccount = {
	accountId?: string;
	accountLabel?: string;
	email?: string;
	index: number;
	addedAt?: number;
	lastUsed?: number;
	status: "active" | "ok" | "rate-limited" | "cooldown" | "disabled";
	isCurrentAccount: boolean;
	isDefaultAccount: boolean;
	isRuntimeCurrentAccount: boolean;
	currentMarkers: ReturnType<typeof resolveAccountCurrentMarkers>;
	enabled: boolean;
};

export function buildLoginMenuAccounts(
	accounts: Array<{
		accountId?: string;
		accountLabel?: string;
		email?: string;
		addedAt?: number;
		lastUsed?: number;
		enabled?: boolean;
		coolingDownUntil?: number;
		rateLimitResetTimes?: Record<string, number | undefined>;
	}>,
	deps: {
		now: number;
		activeIndex: number;
		runtimeCurrent?: RuntimeCurrentAccountSelection | null;
		formatRateLimitEntry: (
			account: {
				rateLimitResetTimes?: Record<string, number | undefined>;
			},
			now: number,
		) => string | null;
	},
): LoginMenuAccount[] {
	return accounts.map((account, index) => {
		const isCurrent = isDisplayCurrentAccount(
			index,
			deps.activeIndex,
			deps.runtimeCurrent ?? null,
		);
		let status: LoginMenuAccount["status"];
		if (account.enabled === false) {
			status = "disabled";
		} else if (
			typeof account.coolingDownUntil === "number" &&
			account.coolingDownUntil > deps.now
		) {
			status = "cooldown";
		} else if (deps.formatRateLimitEntry(account, deps.now)) {
			status = "rate-limited";
		} else if (isCurrent) {
			status = "active";
		} else {
			status = "ok";
		}

		return {
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			index,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status,
			isCurrentAccount: isCurrent,
			isDefaultAccount: index === deps.activeIndex,
			isRuntimeCurrentAccount: deps.runtimeCurrent?.index === index,
			currentMarkers: resolveAccountCurrentMarkers(
				index,
				deps.activeIndex,
				deps.runtimeCurrent ?? null,
			),
			enabled: account.enabled !== false,
		};
	});
}
