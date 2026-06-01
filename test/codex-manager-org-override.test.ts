import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAccountSelection } from "../lib/codex-manager.js";

// auth-flow org-override contract (codex-manager.ts): `login --org <id>` threads
// the org explicitly into resolveAccountSelection so it does NOT mutate the global
// CODEX_AUTH_ACCOUNT_ID for the duration of a login (which raced on concurrent
// re-entry / reused test workers). The explicit argument must win for THAT call
// only, and the env override must still be honored when no explicit org is passed.

const successTokens = {
	type: "success" as const,
	access: "opaque-access-no-jwt",
	refresh: "refresh-xyz",
	expires: Date.now() + 3_600_000,
	idToken: "opaque-id-no-jwt",
	multiAccount: true,
};

describe("resolveAccountSelection org-override (no env mutation)", () => {
	const prevEnv = process.env.CODEX_AUTH_ACCOUNT_ID;

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.CODEX_AUTH_ACCOUNT_ID;
		else process.env.CODEX_AUTH_ACCOUNT_ID = prevEnv;
		vi.restoreAllMocks();
	});

	it("an explicit org argument wins over the env override for that call", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "env-org-should-lose";
		const resolved = resolveAccountSelection(successTokens, "explicit-org-wins");
		expect(resolved.accountIdOverride).toBe("explicit-org-wins");
		expect(resolved.accountIdSource).toBe("manual");
		// The env var is untouched (no global mutation by this resolver).
		expect(process.env.CODEX_AUTH_ACCOUNT_ID).toBe("env-org-should-lose");
	});

	it("falls back to the env override when no explicit org is passed", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "env-org-used";
		const resolved = resolveAccountSelection(successTokens);
		expect(resolved.accountIdOverride).toBe("env-org-used");
		expect(resolved.accountIdSource).toBe("manual");
	});

	it("ignores a blank/whitespace explicit org and uses the env override", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "env-org-fallback";
		const resolved = resolveAccountSelection(successTokens, "   ");
		expect(resolved.accountIdOverride).toBe("env-org-fallback");
	});

	it("applies no override when neither explicit org nor env is set", () => {
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
		const resolved = resolveAccountSelection(successTokens);
		// Opaque (non-JWT) tokens yield no embedded candidates, so nothing is bound.
		expect(resolved.accountIdOverride).toBeUndefined();
	});
});
