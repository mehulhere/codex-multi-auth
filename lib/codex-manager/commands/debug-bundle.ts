import type { ConfigExplainReport } from "../../config.js";
import { homedir } from "node:os";
import { sep } from "node:path";
import { maskEmail, maskToken, sanitizeValue } from "../../logger.js";

/**
 * Replace the user's home-directory prefix with `~` so the bundle does not leak
 * the OS username embedded in absolute paths (errors-logging-04).
 *
 * The match is path-aware, not a raw `startsWith`:
 *   - Windows path comparison is case-insensitive, so `C:\Users\Alice` and
 *     `c:\users\alice` must both redact. We case-fold both sides on win32.
 *   - A bare prefix check falsely matches sibling directories that merely share
 *     a string prefix (e.g. home `/users/alice` would "match" `/users/alice2`).
 *     We require a real path boundary: either an exact home match or the next
 *     character after the prefix is a path separator.
 *
 * @internal Exported for unit testing of the windows-casing / prefix-collision
 * branches; not part of the public CLI surface.
 */
export function redactHome(value: string): string {
	const home = homedir();
	if (!home) {
		return value;
	}

	const isWindows = process.platform === "win32";
	const normalizedValue = isWindows ? value.toLowerCase() : value;
	const normalizedHome = isWindows ? home.toLowerCase() : home;

	if (normalizedValue === normalizedHome) {
		return "~";
	}

	// Require a path boundary after the home prefix so `/users/alice2` is not
	// treated as living under home `/users/alice`. Accept either path separator
	// so a value captured with the foreign separator still redacts.
	const boundary = normalizedValue.slice(normalizedHome.length, normalizedHome.length + 1);
	if (
		normalizedValue.startsWith(normalizedHome) &&
		(boundary === sep || boundary === "/" || boundary === "\\")
	) {
		return `~${value.slice(home.length)}`;
	}

	return value;
}

/**
 * Sanitize the config report before it lands in a shared debug bundle.
 *
 * Two leaks closed here:
 *   - `configPath` is an absolute path that embeds the OS username; redact the
 *     home prefix like every other path in the bundle.
 *   - `entries[].value` can hold sensitive config (e.g. a runtime-rotation-proxy
 *     URL with `user:pass@host` credentials). Route each value through the
 *     shared logger `sanitizeValue`, which masks token/secret/email-shaped data,
 *     so a `--json` bundle pasted into a bug report cannot carry live creds.
 */
function sanitizeConfigReport(config: ConfigExplainReport): ConfigExplainReport {
	return {
		...config,
		configPath: config.configPath ? redactHome(config.configPath) : config.configPath,
		entries: config.entries.map((entry) => ({
			...entry,
			value: sanitizeValue(entry.value),
			defaultValue: sanitizeValue(entry.defaultValue),
		})),
	};
}

export function runDebugBundleCommand(
	args: string[],
	deps: {
		getConfigReport: () => ConfigExplainReport;
		getStoragePath: () => string;
		loadAccounts: () => Promise<{
			accounts: Array<{ enabled?: boolean }>;
			activeIndex?: number;
		} | null>;
		loadFlaggedAccounts: () => Promise<{ accounts: unknown[] }>;
		loadCodexCliState: (options: { forceRefresh: boolean }) => Promise<{
			path: string;
			accounts: unknown[];
			activeEmail?: string;
			activeAccountId?: string;
			syncVersion?: number;
			sourceUpdatedAtMs?: number;
		} | null>;
		getLastAccountsSaveTimestamp: () => number;
		logInfo?: (message: string) => void;
		logError?: (message: string) => void;
	},
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--json");
	if (unknown.length > 0) {
		logError(`Unknown option: ${unknown[0]}`);
		return Promise.resolve(1);
	}

	return Promise.all([
		Promise.resolve(deps.getConfigReport()),
		deps.loadAccounts(),
		deps.loadFlaggedAccounts(),
		deps.loadCodexCliState({ forceRefresh: true }),
	])
		.then(([config, accounts, flagged, codexCli]) => {
			const bundle = {
				generatedAt: new Date().toISOString(),
				storagePath: redactHome(deps.getStoragePath()),
				lastAccountsSaveTimestamp: deps.getLastAccountsSaveTimestamp(),
				config: sanitizeConfigReport(config),
				accounts: {
					total: accounts?.accounts.length ?? 0,
					enabled:
						accounts?.accounts.filter((account) => account.enabled !== false)
							.length ?? 0,
					activeIndex:
						typeof accounts?.activeIndex === "number"
							? accounts.activeIndex + 1
							: null,
				},
				flaggedAccounts: {
					total: flagged.accounts.length,
				},
				codexCli: codexCli
					? {
							path: redactHome(codexCli.path),
							accountCount: codexCli.accounts.length,
							activeEmail: codexCli.activeEmail
								? maskEmail(codexCli.activeEmail)
								: null,
							// accountid is in the logger's SENSITIVE_KEYS and is masked
							// everywhere else; mask it here too so the shared bundle does
							// not expose the account/org identifier in cleartext.
							activeAccountId: codexCli.activeAccountId
								? maskToken(codexCli.activeAccountId)
								: null,
							syncVersion: codexCli.syncVersion ?? null,
							sourceUpdatedAtMs: codexCli.sourceUpdatedAtMs ?? null,
						}
					: null,
			};

			if (json) {
				logInfo(JSON.stringify(bundle, null, 2));
				return 0;
			}

			logInfo(`Generated: ${bundle.generatedAt}`);
			logInfo(`Storage: ${bundle.storagePath}`);
			logInfo(
				`Accounts: ${bundle.accounts.total} total, ${bundle.accounts.enabled} enabled`,
			);
			logInfo(`Flagged: ${bundle.flaggedAccounts.total}`);
			if (bundle.codexCli) {
				logInfo(
					`Codex CLI: ${bundle.codexCli.accountCount} account(s), active ${bundle.codexCli.activeEmail ?? "unknown"}`,
				);
			}
			return 0;
		})
		.catch((error) => {
			logError(
				`Failed to generate debug bundle: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		});
}
