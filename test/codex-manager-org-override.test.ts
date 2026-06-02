import { afterEach } from "vitest";
import { resolveOrgOverride } from "../lib/auth/org-override.js";

// auth-flow org-override contract: `login --org <id>` must win over the ambient
// CODEX_AUTH_ACCOUNT_ID env for that call only, and the launcher must NOT mutate
// process.env (which raced on concurrent re-entry / reused test workers). The
// precedence lives in resolveOrgOverride (lib/auth/org-override.ts); the login
// flow threads the org through it instead of touching the global env.

describe("resolveOrgOverride (no env mutation)", () => {
	const prevEnv = process.env.CODEX_AUTH_ACCOUNT_ID;

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.CODEX_AUTH_ACCOUNT_ID;
		else process.env.CODEX_AUTH_ACCOUNT_ID = prevEnv;
	});

	it("an explicit org argument wins over the env override for that call", () => {
		const env = { CODEX_AUTH_ACCOUNT_ID: "env-org-should-lose" };
		expect(resolveOrgOverride("explicit-org-wins", env)).toBe("explicit-org-wins");
	});

	it("does not mutate the ambient process.env", () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "env-stays-put";
		resolveOrgOverride("explicit-org", process.env);
		expect(process.env.CODEX_AUTH_ACCOUNT_ID).toBe("env-stays-put");
	});

	it("falls back to the env override when no explicit org is passed", () => {
		expect(resolveOrgOverride(undefined, { CODEX_AUTH_ACCOUNT_ID: "env-org-used" })).toBe(
			"env-org-used",
		);
	});

	it("ignores a blank/whitespace explicit org and uses the env override", () => {
		expect(resolveOrgOverride("   ", { CODEX_AUTH_ACCOUNT_ID: "env-org-fallback" })).toBe(
			"env-org-fallback",
		);
	});

	it("returns null when neither explicit org nor env is set", () => {
		expect(resolveOrgOverride(undefined, {})).toBeNull();
		expect(resolveOrgOverride("   ", {})).toBeNull();
	});

	it("trims surrounding whitespace from the chosen value", () => {
		expect(resolveOrgOverride("  org-padded  ", {})).toBe("org-padded");
		expect(resolveOrgOverride(undefined, { CODEX_AUTH_ACCOUNT_ID: "  env-padded " })).toBe(
			"env-padded",
		);
	});
});
