/**
 * Resolve the effective account-id override for a login, with the documented
 * precedence: an explicit `login --org <id>` argument wins over the ambient
 * CODEX_AUTH_ACCOUNT_ID env var, for that call only.
 *
 * This lives in its own internal module (not exported from the CLI entrypoint)
 * so the concurrency contract — the launcher must NOT mutate process.env for the
 * duration of a login, which raced on re-entry / reused test workers — can be
 * unit-tested without widening the public surface of lib/codex-manager.ts.
 *
 * A blank/whitespace explicit org is treated as absent so an empty `--org ""`
 * does not suppress the env fallback.
 *
 * @param explicitOrg - the value passed to `login --org`, if any
 * @param env - environment to read CODEX_AUTH_ACCOUNT_ID from (injectable for tests)
 * @returns the trimmed effective override, or null when neither source provides one
 */
export function resolveOrgOverride(
	explicitOrg?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const explicit = explicitOrg?.trim();
	const override = (explicit || env.CODEX_AUTH_ACCOUNT_ID || "").trim();
	return override.length > 0 ? override : null;
}
