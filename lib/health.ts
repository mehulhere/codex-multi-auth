import { getCircuitBreaker, type CircuitState } from "./circuit-breaker.js";
import { getAccountIdentityKey } from "./storage/identity.js";

// AUDIT-M08 / D-04 docstring (master repository audit, Oracle-confirmed):
// --------------------------------------------------------------------------
// This module is a PURE SHAPE-TRANSFORMATION UTILITY. Callers pass an
// already-flattened accounts array with the fields defined in the public
// `getAccountHealth` parameter shape below. It is deliberately decoupled
// from the live AccountManager: that keeps the function easy to test, and
// lets external consumers (dashboards, diagnostics scripts, JSON exporters)
// build the input from any source without taking a hard dependency on the
// manager singleton.
//
// HOWEVER, the parameter shape uses field names that do NOT exactly match
// ManagedAccount in lib/accounts.ts:
//
//   getAccountHealth input   ManagedAccount field
//   ----------------------   --------------------
//   rateLimitedUntil         <computed from rateLimitResetTimes per family>
//   cooldownUntil            coolingDownUntil
//   lastUsedAt               lastUsed
//   health                   <computed from getHealthTracker().getScore()>
//
// Callers are responsible for flattening ManagedAccount → the input shape
// via a small adapter. If a future refactor wants a single call site that
// reads straight from AccountManager, add a `getPluginHealthFromManager(
// manager: AccountManager): PluginHealth` function here and implement the
// flattening inline. Do NOT change the signature of the existing
// `getAccountHealth` function without a deprecation cycle — it is exported
// via lib/index.ts and is considered public API.

export interface AccountHealth {
	index: number;
	email?: string;
	accountId?: string;
	health: number;
	isRateLimited: boolean;
	isCoolingDown: boolean;
	cooldownReason?: string;
	lastUsed?: number;
	circuitState: CircuitState;
}

export interface PluginHealth {
	status: "healthy" | "degraded" | "unhealthy";
	accountCount: number;
	healthyAccountCount: number;
	rateLimitedCount: number;
	coolingDownCount: number;
	accounts: AccountHealth[];
	timestamp: number;
}

export function getAccountHealth(
	accounts: Array<{
		index: number;
		email?: string;
		accountId?: string;
		refreshToken?: string;
		health: number;
		rateLimitedUntil?: number;
		cooldownUntil?: number;
		cooldownReason?: string;
		lastUsedAt?: number;
	}>,
	now = Date.now(),
): PluginHealth {
	const accountHealths: AccountHealth[] = accounts.map((acc) => {
		const circuitKey = getAccountIdentityKey(acc) ?? `account:${acc.index}`;
		const circuit = getCircuitBreaker(circuitKey);

		return {
			index: acc.index,
			email: acc.email,
			accountId: acc.accountId,
			health: acc.health,
			isRateLimited: (acc.rateLimitedUntil ?? 0) > now,
			isCoolingDown: (acc.cooldownUntil ?? 0) > now,
			cooldownReason: acc.cooldownReason,
			lastUsed: acc.lastUsedAt,
			circuitState: circuit.getState(),
		};
	});

	const healthyCount = accountHealths.filter(
		(a) =>
			!a.isRateLimited &&
			!a.isCoolingDown &&
			a.health >= 50 &&
			a.circuitState === "closed",
	).length;

	const rateLimitedCount = accountHealths.filter((a) => a.isRateLimited).length;
	const coolingDownCount = accountHealths.filter((a) => a.isCoolingDown).length;

	let status: PluginHealth["status"];
	if (healthyCount === 0 && accounts.length > 0) {
		status = "unhealthy";
	} else if (healthyCount < accounts.length) {
		status = "degraded";
	} else {
		status = "healthy";
	}

	return {
		status,
		accountCount: accounts.length,
		healthyAccountCount: healthyCount,
		rateLimitedCount,
		coolingDownCount,
		accounts: accountHealths,
		timestamp: now,
	};
}

export function formatHealthReport(health: PluginHealth): string {
	const lines: string[] = [
		`Plugin Health: ${health.status.toUpperCase()}`,
		``,
		`Accounts: ${health.healthyAccountCount}/${health.accountCount} healthy`,
	];

	if (health.rateLimitedCount > 0) {
		lines.push(`Rate Limited: ${health.rateLimitedCount}`);
	}
	if (health.coolingDownCount > 0) {
		lines.push(`Cooling Down: ${health.coolingDownCount}`);
	}

	if (health.accounts.length > 0) {
		lines.push(``, `Account Details:`);
		for (const acc of health.accounts) {
			const email = acc.email ?? `Account ${acc.index + 1}`;
			const flags: string[] = [];
			if (acc.isRateLimited) flags.push("rate-limited");
			if (acc.isCoolingDown) flags.push(`cooling-${acc.cooldownReason ?? "down"}`);
			if (acc.circuitState !== "closed") flags.push(`circuit-${acc.circuitState}`);
			const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
			lines.push(`  [${acc.index + 1}] ${email}: ${acc.health}%${flagStr}`);
		}
	}

	return lines.join("\n");
}
