import { readFileSync, existsSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginConfig } from "./types.js";
import { logWarn } from "./logger.js";
import { PluginConfigSchema, getValidationErrors } from "./schemas.js";
import { getCodexHomeDir, getCodexMultiAuthDir, getLegacyOpenCodeDir } from "./runtime-paths.js";
import {
	getUnifiedSettingsPath,
	loadUnifiedPluginConfigSync,
	saveUnifiedPluginConfig,
	saveUnifiedPluginConfigSync,
} from "./unified-settings.js";

const CONFIG_DIR = getCodexMultiAuthDir();
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const LEGACY_CODEX_CONFIG_PATH = join(getCodexHomeDir(), "codex-multi-auth-config.json");
const LEGACY_OPENCODE_CONFIG_PATH = join(
	getLegacyOpenCodeDir(),
	"codex-multi-auth-config.json",
);
const LEGACY_OPENCODE_AUTH_CONFIG_PATH = join(
	getLegacyOpenCodeDir(),
	"openai-codex-auth-config.json",
);
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const emittedConfigWarnings = new Set<string>();

export type UnsupportedCodexPolicy = "strict" | "fallback";

function logConfigWarnOnce(message: string): void {
	if (emittedConfigWarnings.has(message)) {
		return;
	}
	emittedConfigWarnings.add(message);
	logWarn(message);
}

export function __resetConfigWarningCacheForTests(): void {
	emittedConfigWarnings.clear();
}

/**
 * Determines the filesystem path to the plugin configuration file, preferring an explicit environment override and falling back to current and legacy locations.
 *
 * The lookup order is:
 * 1. `CODEX_MULTI_AUTH_CONFIG_PATH` environment variable (if set and non-empty)
 * 2. current CONFIG_PATH
 * 3. legacy Codex/OpenCode config locations (with a one-time migration warning)
 *
 * Concurrency: the function is synchronous and relies on the filesystem state at call time; callers should handle concurrent config writes externally.
 *
 * Windows: path existence checks use Node's filesystem semantics (case sensitivity and symlink behavior follow the host OS).
 *
 * Security: the returned path may reference files containing sensitive tokens; callers MUST redact or avoid logging full paths or file contents.
 *
 * @returns The resolved config file path as a string, or `null` if no config file was found.
 */
function resolvePluginConfigPath(): string | null {
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();
	if (envPath.length > 0) {
		return envPath;
	}

	if (existsSync(CONFIG_PATH)) {
		return CONFIG_PATH;
	}

	if (existsSync(LEGACY_CODEX_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy config path ${LEGACY_CODEX_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_CODEX_CONFIG_PATH;
	}

	if (existsSync(LEGACY_OPENCODE_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy OpenCode config path ${LEGACY_OPENCODE_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_OPENCODE_CONFIG_PATH;
	}

	if (existsSync(LEGACY_OPENCODE_AUTH_CONFIG_PATH)) {
		logConfigWarnOnce(
			`Using legacy OpenCode config path ${LEGACY_OPENCODE_AUTH_CONFIG_PATH}. ` +
				`Please migrate to ${CONFIG_PATH}.`,
		);
		return LEGACY_OPENCODE_AUTH_CONFIG_PATH;
	}

	return null;
}

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
	codexMode: true,
	codexTuiV2: true,
	codexTuiColorProfile: "truecolor",
	codexTuiGlyphMode: "ascii",
	fastSession: false,
	fastSessionStrategy: "hybrid",
	fastSessionMaxInputItems: 30,
	retryAllAccountsRateLimited: true,
	retryAllAccountsMaxWaitMs: 0,
	retryAllAccountsMaxRetries: Infinity,
	unsupportedCodexPolicy: "strict",
	fallbackOnUnsupportedCodexModel: false,
	fallbackToGpt52OnUnsupportedGpt53: true,
	unsupportedCodexFallbackChain: {},
	tokenRefreshSkewMs: 60_000,
	rateLimitToastDebounceMs: 60_000,
	toastDurationMs: 5_000,
	perProjectAccounts: true,
	sessionRecovery: true,
	autoResume: true,
	parallelProbing: false,
	parallelProbingMaxConcurrency: 2,
	emptyResponseMaxRetries: 2,
	emptyResponseRetryDelayMs: 1_000,
	pidOffsetEnabled: false,
	fetchTimeoutMs: 60_000,
	streamStallTimeoutMs: 45_000,
	liveAccountSync: true,
	liveAccountSyncDebounceMs: 250,
	liveAccountSyncPollMs: 2_000,
	sessionAffinity: true,
	sessionAffinityTtlMs: 20 * 60_000,
	sessionAffinityMaxEntries: 512,
	proactiveRefreshGuardian: true,
	proactiveRefreshIntervalMs: 60_000,
	proactiveRefreshBufferMs: 5 * 60_000,
	networkErrorCooldownMs: 6_000,
	serverErrorCooldownMs: 4_000,
	storageBackupEnabled: true,
	preemptiveQuotaEnabled: true,
	preemptiveQuotaRemainingPercent5h: 5,
	preemptiveQuotaRemainingPercent7d: 5,
	preemptiveQuotaMaxDeferralMs: 2 * 60 * 60_000,
};

/**
 * Get a shallow copy of the default plugin configuration.
 *
 * This function performs no I/O and is safe to call concurrently. It does not interact with
 * the filesystem (so it has no Windows path/atomicity implications). The returned object
 * contains default settings and may include placeholder fields for secrets or tokens; callers
 * must redact sensitive values before logging or persisting.
 *
 * @returns A shallow copy of `DEFAULT_PLUGIN_CONFIG`
 */
export function getDefaultPluginConfig(): PluginConfig {
	return { ...DEFAULT_PLUGIN_CONFIG };
}

/**
 * Load the plugin configuration, applying defaults and compatibility fallbacks for legacy locations.
 *
 * Attempts to read unified settings first, falls back to legacy per-user config files (with UTF‑8 BOM handling),
 * validates and warns on schema issues, and migrates legacy file-backed configs into the unified settings when appropriate.
 * Callers should avoid concurrent writers to the config paths (this function performs filesystem reads and may perform a migration write).
 * On Windows legacy path semantics are respected; BOMs are stripped before JSON parsing.
 * Logged warnings are produced for validation or migration failures and avoid exposing sensitive tokens.
 *
 * @returns The effective PluginConfig: a shallow merge of DEFAULT_PLUGIN_CONFIG with any validated user-provided settings
 */
export function loadPluginConfig(): PluginConfig {
	try {
		const unifiedConfig = loadUnifiedPluginConfigSync();
		let userConfig: unknown = unifiedConfig;
		let sourceKind: "unified" | "file" = "unified";

		if (!isRecord(userConfig)) {
			const configPath = resolvePluginConfigPath();
			if (!configPath) {
				return { ...DEFAULT_PLUGIN_CONFIG };
			}

			const fileContent = readFileSync(configPath, "utf-8");
			const normalizedFileContent = stripUtf8Bom(fileContent);
			userConfig = JSON.parse(normalizedFileContent) as unknown;
			sourceKind = "file";
		}

		const hasFallbackEnvOverride =
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL !== undefined ||
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 !== undefined;
		if (isRecord(userConfig)) {
			const hasPolicyKey = Object.hasOwn(userConfig, "unsupportedCodexPolicy");
			const hasLegacyFallbackKey =
				Object.hasOwn(userConfig, "fallbackOnUnsupportedCodexModel") ||
				Object.hasOwn(userConfig, "fallbackToGpt52OnUnsupportedGpt53") ||
				Object.hasOwn(userConfig, "unsupportedCodexFallbackChain");
			if (!hasPolicyKey && (hasLegacyFallbackKey || hasFallbackEnvOverride)) {
				logConfigWarnOnce(
					"Legacy unsupported-model fallback settings detected without unsupportedCodexPolicy. " +
						'Using backward-compat behavior; prefer unsupportedCodexPolicy: "strict" | "fallback".',
				);
			}
		}

		const schemaErrors = getValidationErrors(PluginConfigSchema, userConfig);
		if (schemaErrors.length > 0) {
			logConfigWarnOnce(
				`Plugin config validation warnings: ${schemaErrors.slice(0, 3).join(", ")}`,
			);
		}

		if (
			sourceKind === "file" &&
			isRecord(userConfig) &&
			(process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim().length === 0
		) {
			try {
				saveUnifiedPluginConfigSync(userConfig);
			} catch (error) {
				logConfigWarnOnce(
					`Failed to migrate plugin config into ${getUnifiedSettingsPath()}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		return {
			...DEFAULT_PLUGIN_CONFIG,
			...(userConfig as Partial<PluginConfig>),
		};
	} catch (error) {
		const configPath = resolvePluginConfigPath() ?? CONFIG_PATH;
		logConfigWarnOnce(
			`Failed to load config from ${configPath}: ${(error as Error).message}`,
		);
		return { ...DEFAULT_PLUGIN_CONFIG };
	}
}

function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Determines whether a value is a non-null object that can be treated as a record.
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object and can be treated as `Record<string, unknown>`, `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Reads and parses a JSON configuration file into a plain record if present and valid.
 *
 * @param configPath - Filesystem path to the JSON config file. Concurrent writes may cause transient read/parse failures; callers should tolerate `null`. On Windows, path casing and exclusive locks can affect readability.
 * @returns The parsed object as a Record<string, unknown> when the file exists and contains a top-level JSON object, or `null` if the file is missing, malformed, or could not be read.
 */
function readConfigRecordFromPath(configPath: string): Record<string, unknown> | null {
	if (!existsSync(configPath)) return null;
	try {
		const fileContent = readFileSync(configPath, "utf-8");
		const normalizedFileContent = stripUtf8Bom(fileContent);
		const parsed = JSON.parse(normalizedFileContent) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch (error) {
		logConfigWarnOnce(
			`Failed to read config from ${configPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * Prepare a partial PluginConfig for persistence by removing undefined values,
 * omitting non-finite numbers, and shallow-copying nested object records.
 *
 * @param config - Partial plugin configuration to sanitize before saving. Note: this function does not redact or mask secrets (tokens/credentials); callers must handle redaction before writing to disk.
 * @returns A plain Record<string, unknown> suitable for JSON serialization: keys with `undefined` or non-finite numeric values are omitted and nested objects are shallow-copied.
 *
 * Concurrency: synchronous and side-effect free; callers are responsible for coordinating concurrent writes to the filesystem.
 * Filesystem: no Windows-specific path normalization or filesystem I/O is performed by this function.
 */
function sanitizePluginConfigForSave(config: Partial<PluginConfig>): Record<string, unknown> {
	const entries = Object.entries(config as Record<string, unknown>);
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (value === undefined) continue;
		if (typeof value === "number" && !Number.isFinite(value)) continue;
		if (isRecord(value)) {
			sanitized[key] = { ...value };
			continue;
		}
		sanitized[key] = value;
	}
	return sanitized;
}

/**
 * Persist a partial plugin configuration to disk, merging it with existing stored settings.
 *
 * This writes the sanitized patch either to the path specified by the CODEX_MULTI_AUTH_CONFIG_PATH
 * environment variable (if set) or into the unified settings store. The function does not take
 * internal locks; callers should avoid concurrent invocations that might overwrite each other.
 * On Windows and other platforms the write behavior follows the Node.js filesystem semantics and may
 * not be atomic across processes. Callers are responsible for redacting any sensitive values
 * (tokens, secrets) before calling if redaction is required; this function writes merged values as-is.
 *
 * @param configPatch - Partial PluginConfig containing changes to persist; undefined fields are ignored.
 * @returns void
 */
export async function savePluginConfig(configPatch: Partial<PluginConfig>): Promise<void> {
	const sanitizedPatch = sanitizePluginConfigForSave(configPatch);
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();

	if (envPath.length > 0) {
		const merged = {
			...(readConfigRecordFromPath(envPath) ?? {}),
			...sanitizedPatch,
		};
		await fs.mkdir(dirname(envPath), { recursive: true });
		await fs.writeFile(envPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
		return;
	}

	const unifiedConfig = loadUnifiedPluginConfigSync();
	const legacyPath = unifiedConfig ? null : resolvePluginConfigPath();
	const merged = {
		...(unifiedConfig ?? (legacyPath ? readConfigRecordFromPath(legacyPath) : null) ?? {}),
		...sanitizedPatch,
	};
	await saveUnifiedPluginConfig(merged);
}

/**
 * Get the effective CODEX_MODE setting
 * Priority: environment variable > config file > default (true)
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "1";
}

function parseNumberEnv(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return undefined;
	return parsed;
}

function parseStringEnv(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveBooleanSetting(
	envName: string,
	configValue: boolean | undefined,
	defaultValue: boolean,
): boolean {
	const envValue = parseBooleanEnv(process.env[envName]);
	if (envValue !== undefined) return envValue;
	return configValue ?? defaultValue;
}

/**
 * Resolve a numeric setting by preferring an environment variable, then a config value, then a default, and clamp the result within optional bounds.
 *
 * This function reads the numeric value of the environment variable named by `envName` (if present), falls back to `configValue`, then to `defaultValue`, and returns the final value constrained to `options.min`/`options.max` when provided. It has no side effects and is safe to call concurrently; it only reads process.env. Environment parsing follows platform semantics for process.env (no filesystem interactions). No secrets or tokens are produced or logged by this function.
 *
 * @param envName - The environment variable name to check for an override
 * @param configValue - The numeric value from configuration, used if the environment variable is absent
 * @param defaultValue - The fallback numeric value if neither environment nor config provide one
 * @param options - Optional bounds; `min` and `max` (inclusive) to clamp the resolved value
 * @returns The resolved number, clamped to the provided `min`/`max` if specified
 */
function resolveNumberSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number; max?: number },
): number {
	const envValue = parseNumberEnv(process.env[envName]);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min ?? Number.NEGATIVE_INFINITY;
	const max = options?.max ?? Number.POSITIVE_INFINITY;
	return Math.max(min, Math.min(max, candidate));
}

/**
 * Selects an effective string setting from the environment, the provided config value, or a fallback default while enforcing allowed values.
 *
 * @param envName - Environment variable name to consult first; its value is used if present in `allowedValues`.
 * @param configValue - Configuration-provided value used if the environment variable is absent or not allowed.
 * @param defaultValue - Value returned when neither environment nor config provide an allowed value.
 * @param allowedValues - Set of permitted values; only values contained in this set will be accepted.
 * @returns The resolved value, guaranteed to be one of the `allowedValues`.
 *
 * Concurrency: this function reads `process.env` once; concurrent mutations to environment variables may change outcome.
 * Filesystem: this function performs no filesystem operations (no platform-specific behavior).
 * Secrets: the function does not log or redact values; callers must handle any sensitive values appropriately. */
function resolveStringSetting<T extends string>(
	envName: string,
	configValue: T | undefined,
	defaultValue: T,
	allowedValues: ReadonlySet<string>,
): T {
	const envValue = parseStringEnv(process.env[envName]);
	if (envValue && allowedValues.has(envValue)) {
		return envValue as T;
	}
	if (configValue && allowedValues.has(configValue)) {
		return configValue;
	}
	return defaultValue;
}

export function getCodexMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_MODE", pluginConfig.codexMode, true);
}

export function getCodexTuiV2(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_TUI_V2", pluginConfig.codexTuiV2, true);
}

export function getCodexTuiColorProfile(
	pluginConfig: PluginConfig,
): "truecolor" | "ansi16" | "ansi256" {
	return resolveStringSetting(
		"CODEX_TUI_COLOR_PROFILE",
		pluginConfig.codexTuiColorProfile,
		"truecolor",
		TUI_COLOR_PROFILES,
	);
}

export function getCodexTuiGlyphMode(
	pluginConfig: PluginConfig,
): "ascii" | "unicode" | "auto" {
	return resolveStringSetting(
		"CODEX_TUI_GLYPHS",
		pluginConfig.codexTuiGlyphMode,
		"ascii",
		TUI_GLYPH_MODES,
	);
}

export function getFastSession(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FAST_SESSION",
		pluginConfig.fastSession,
		false,
	);
}

export function getFastSessionStrategy(pluginConfig: PluginConfig): "hybrid" | "always" {
	const env = (process.env.CODEX_AUTH_FAST_SESSION_STRATEGY ?? "").trim().toLowerCase();
	if (env === "always") return "always";
	if (env === "hybrid") return "hybrid";
	return pluginConfig.fastSessionStrategy === "always" ? "always" : "hybrid";
}

export function getFastSessionMaxInputItems(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
		pluginConfig.fastSessionMaxInputItems,
		30,
		{ min: 8 },
	);
}

export function getRetryAllAccountsRateLimited(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		pluginConfig.retryAllAccountsRateLimited,
		true,
	);
}

export function getRetryAllAccountsMaxWaitMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		0,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		pluginConfig.retryAllAccountsMaxRetries,
		Infinity,
		{ min: 0 },
	);
}

export function getUnsupportedCodexPolicy(
	pluginConfig: PluginConfig,
): UnsupportedCodexPolicy {
	const envPolicy = parseStringEnv(process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY);
	if (envPolicy && UNSUPPORTED_CODEX_POLICIES.has(envPolicy)) {
		return envPolicy as UnsupportedCodexPolicy;
	}

	const configPolicy =
		typeof pluginConfig.unsupportedCodexPolicy === "string"
			? pluginConfig.unsupportedCodexPolicy.toLowerCase()
			: undefined;
	if (configPolicy && UNSUPPORTED_CODEX_POLICIES.has(configPolicy)) {
		return configPolicy as UnsupportedCodexPolicy;
	}

	const legacyEnvFallback = parseBooleanEnv(
		process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL,
	);
	if (legacyEnvFallback !== undefined) {
		return legacyEnvFallback ? "fallback" : "strict";
	}

	if (typeof pluginConfig.fallbackOnUnsupportedCodexModel === "boolean") {
		return pluginConfig.fallbackOnUnsupportedCodexModel
			? "fallback"
			: "strict";
	}

	return "strict";
}

export function getFallbackOnUnsupportedCodexModel(pluginConfig: PluginConfig): boolean {
	return getUnsupportedCodexPolicy(pluginConfig) === "fallback";
}

export function getFallbackToGpt52OnUnsupportedGpt53(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FALLBACK_GPT53_TO_GPT52",
		pluginConfig.fallbackToGpt52OnUnsupportedGpt53,
		true,
	);
}

export function getUnsupportedCodexFallbackChain(
	pluginConfig: PluginConfig,
): Record<string, string[]> {
	const chain = pluginConfig.unsupportedCodexFallbackChain;
	if (!chain || typeof chain !== "object") {
		return {};
	}

	const normalizeModel = (value: string): string => {
		const trimmed = value.trim().toLowerCase();
		if (!trimmed) return "";
		const stripped = trimmed.includes("/")
			? (trimmed.split("/").pop() ?? trimmed)
			: trimmed;
		return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
	};

	const normalized: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(chain)) {
		if (typeof key !== "string" || !Array.isArray(value)) continue;
		const normalizedKey = normalizeModel(key);
		if (!normalizedKey) continue;

		const targets = value
			.map((target) => (typeof target === "string" ? normalizeModel(target) : ""))
			.filter((target) => target.length > 0);

		if (targets.length > 0) {
			normalized[normalizedKey] = targets;
		}
	}

	return normalized;
}

export function getTokenRefreshSkewMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		pluginConfig.rateLimitToastDebounceMs,
		60_000,
		{ min: 0 },
	);
}

export function getSessionRecovery(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_RECOVERY",
		pluginConfig.sessionRecovery,
		true,
	);
}

export function getAutoResume(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_RESUME",
		pluginConfig.autoResume,
		true,
	);
}

export function getToastDurationMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_TOAST_DURATION_MS",
		pluginConfig.toastDurationMs,
		5_000,
		{ min: 1_000 },
	);
}

export function getPerProjectAccounts(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PER_PROJECT_ACCOUNTS",
		pluginConfig.perProjectAccounts,
		true,
	);
}

export function getParallelProbing(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PARALLEL_PROBING",
		pluginConfig.parallelProbing,
		false,
	);
}

export function getParallelProbingMaxConcurrency(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
		pluginConfig.parallelProbingMaxConcurrency,
		2,
		{ min: 1 },
	);
}

export function getEmptyResponseMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
		pluginConfig.emptyResponseMaxRetries,
		2,
		{ min: 0 },
	);
}

export function getEmptyResponseRetryDelayMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS",
		pluginConfig.emptyResponseRetryDelayMs,
		1_000,
		{ min: 0 },
	);
}

export function getPidOffsetEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PID_OFFSET_ENABLED",
		pluginConfig.pidOffsetEnabled,
		false,
	);
}

export function getFetchTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

/**
 * Determine the configured stream stall timeout in milliseconds.
 *
 * This value is used to detect stalled streams across concurrent operations; the function performs no filesystem I/O (no special Windows behavior) and does not expose or redact tokens.
 *
 * @param pluginConfig - Plugin configuration that may contain a `streamStallTimeoutMs` override
 * @returns The effective stream stall timeout in milliseconds (minimum 1000 ms, default 45000 ms)
 */
export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

/**
 * Determines whether live account synchronization is enabled.
 *
 * This value respects the environment override `CODEX_AUTH_LIVE_ACCOUNT_SYNC`, falls back to
 * `pluginConfig.liveAccountSync` when present, and defaults to `true`. Callers are responsible for
 * handling concurrent use; this accessor performs no filesystem operations and does not mutate or
 * log token or credential material (tokens must be redacted by higher-level code if surfaced).
 *
 * @param pluginConfig - The plugin configuration object used as the non-environment fallback
 * @returns `true` if live account synchronization is enabled, `false` otherwise
 */
export function getLiveAccountSync(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC",
		pluginConfig.liveAccountSync,
		true,
	);
}

/**
 * Get the debounce interval, in milliseconds, used when synchronizing live accounts.
 *
 * @param pluginConfig - Plugin configuration which may contain an override for the debounce value
 * @returns The debounce interval in milliseconds; defaults to 250, and will be at least 50
 *
 * Concurrency: safe to call from multiple threads/tasks concurrently.
 * Windows filesystem: value is independent of filesystem semantics.
 * Token redaction: this value contains no secrets and is safe to log.
 */
export function getLiveAccountSyncDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS",
		pluginConfig.liveAccountSyncDebounceMs,
		250,
		{ min: 50 },
	);
}

/**
 * Determines the polling interval (in milliseconds) used by live account synchronization.
 *
 * @param pluginConfig - The plugin configuration to read the setting from.
 * @returns The effective poll interval in milliseconds; guaranteed to be at least 500.
 *
 * Notes:
 * - Concurrency: this value is used to debounce/drive polling and should be treated as a minimum per-worker interval when multiple workers run concurrently.
 * - Platform: value is independent of Windows filesystem semantics.
 * - Secrets: the returned value contains no sensitive tokens and is safe for logging (no redaction required).
 */
export function getLiveAccountSyncPollMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS",
		pluginConfig.liveAccountSyncPollMs,
		2_000,
		{ min: 500 },
	);
}

/**
 * Determines whether session affinity is enabled.
 *
 * Reads the `sessionAffinity` setting from `pluginConfig` with an environment override
 * via `CODEX_AUTH_SESSION_AFFINITY`. Defaults to `true`. This function performs no I/O,
 * is safe for concurrent reads, is unaffected by Windows filesystem semantics, and
 * does not expose or log authentication tokens.
 *
 * @param pluginConfig - The plugin configuration to consult for the setting
 * @returns `true` if session affinity is enabled, `false` otherwise
 */
export function getSessionAffinity(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_AFFINITY",
		pluginConfig.sessionAffinity,
		true,
	);
}

/**
 * Determines the session-affinity time-to-live in milliseconds.
 *
 * Reads the value from the environment variable `CODEX_AUTH_SESSION_AFFINITY_TTL_MS` if present, otherwise uses `pluginConfig.sessionAffinityTtlMs`, falling back to 20 minutes. This function performs no filesystem I/O, is safe for concurrent callers, and does not log or expose secrets (no token material is read or emitted).
 *
 * @param pluginConfig - The plugin configuration to read the setting from
 * @returns The effective session-affinity TTL in milliseconds (minimum 1000)
 */
export function getSessionAffinityTtlMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_TTL_MS",
		pluginConfig.sessionAffinityTtlMs,
		20 * 60_000,
		{ min: 1_000 },
	);
}

/**
 * Determine the configured maximum number of session-affinity entries.
 *
 * @param pluginConfig - The plugin configuration to read the `sessionAffinityMaxEntries` setting from.
 * @returns The effective maximum number of affinity entries (minimum 8, default 512).
 *
 * Concurrency: value is used for in-memory sizing and should be safe for concurrent use by runtime components.
 * Filesystem: value is runtime-only and unaffected by Windows filesystem semantics.
 * Security: this setting contains no secrets and is safe to log; it does not include tokens or credentials.
 */
export function getSessionAffinityMaxEntries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES",
		pluginConfig.sessionAffinityMaxEntries,
		512,
		{ min: 8 },
	);
}

/**
 * Controls whether the proactive refresh guardian is enabled.
 *
 * When enabled, background refreshes may run concurrently; callers should assume safe concurrent access.
 * Configuration respects cross-platform semantics (including Windows filesystem behavior) when persisting or migrating settings.
 * Any tokens or sensitive values observed during refresh operations are redacted from logs and persisted records.
 *
 * @param pluginConfig - The plugin configuration object to read the setting from
 * @returns `true` if the proactive refresh guardian is enabled, `false` otherwise.
 */
export function getProactiveRefreshGuardian(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN",
		pluginConfig.proactiveRefreshGuardian,
		true,
	);
}

/**
 * Determines the proactive refresh guardian interval in milliseconds.
 *
 * Uses the environment override `CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS` if present; otherwise uses
 * the configured `pluginConfig.proactiveRefreshIntervalMs` or the default of 60000 ms. The resulting
 * value is constrained to be at least 5000 ms.
 *
 * Concurrency assumption: callers may be invoked from multiple timers/workers concurrently.
 * Windows filesystem and token-redaction concerns do not affect this getter.
 *
 * @param pluginConfig - Plugin configuration used as the fallback source for the interval value
 * @returns The proactive refresh interval in milliseconds (>= 5000)
 */
export function getProactiveRefreshIntervalMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS",
		pluginConfig.proactiveRefreshIntervalMs,
		60_000,
		{ min: 5_000 },
	);
}

/**
 * Get the proactive refresh guardian buffer interval in milliseconds.
 *
 * The value can be overridden by the `CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS` environment variable.
 *
 * @param pluginConfig - Plugin configuration object containing `proactiveRefreshBufferMs`
 * @returns The buffer interval in milliseconds (at least 30000, default 300000)
 *
 * Concurrency: this value is applied across concurrent proactive-refresh workers and should be treated as a shared timing configuration.
 * Windows filesystem: unrelated to filesystem behavior.
 * Token redaction: environment values and config contents may be redacted in logs and diagnostics. */
export function getProactiveRefreshBufferMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS",
		pluginConfig.proactiveRefreshBufferMs,
		5 * 60_000,
		{ min: 30_000 },
	);
}

/**
 * Get the network error cooldown interval used before retrying network operations.
 *
 * @param pluginConfig - Plugin configuration to read override values from
 * @returns The cooldown interval in milliseconds (greater than or equal to 0)
 *
 * Concurrency: callers may read and cache this value; it is read-only at call time.
 * Windows filesystem: no platform-specific filesystem behavior affects this setting.
 * Token redaction: this function does not expose or log sensitive tokens.
 */
export function getNetworkErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS",
		pluginConfig.networkErrorCooldownMs,
		6_000,
		{ min: 0 },
	);
}

/**
 * Get the cooldown duration in milliseconds to apply after a server error.
 *
 * @param pluginConfig - Plugin configuration object used to resolve the setting; callers may invoke this concurrently and the returned value is read-only and safe for concurrent use. This function performs no filesystem access and is unaffected by Windows path semantics. It does not log or expose secrets—environment-derived values are treated as configuration and not token data.
 * @returns The cooldown in milliseconds to use after a server error (minimum 0, default 4000). Environment override: `CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS`.
 */
export function getServerErrorCooldownMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
		pluginConfig.serverErrorCooldownMs,
		4_000,
		{ min: 0 },
	);
}

/**
 * Determines whether periodic storage backups are enabled.
 *
 * When enabled, background backup tasks may run concurrently; backups follow platform filesystem semantics (including Windows path behavior), and persisted backup data will have sensitive tokens redacted.
 *
 * @param pluginConfig - The plugin configuration to read the setting from
 * @returns `true` if storage backup is enabled, `false` otherwise
 */
export function getStorageBackupEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_STORAGE_BACKUP_ENABLED",
		pluginConfig.storageBackupEnabled,
		true,
	);
}

/**
 * Determines whether preemptive quota checks are enabled.
 *
 * Safe to call concurrently; this function does not access the filesystem (no Windows-specific behavior)
 * and does not expose or log any authentication tokens.
 *
 * @param pluginConfig - Plugin configuration to read the preemptive quota setting from
 * @returns `true` if preemptive quota is enabled, `false` otherwise
 */
export function getPreemptiveQuotaEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
		pluginConfig.preemptiveQuotaEnabled,
		true,
	);
}

/**
 * Determines the configured preemptive quota remaining percentage for 5-hour windows.
 *
 * @param pluginConfig - Plugin configuration to read the setting from; can be overridden by the CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT environment variable. Reading this value is safe to perform concurrently; environment override semantics apply on Windows as on other platforms. Returned values are numeric and do not contain sensitive tokens.
 * @returns The percentage (0–100) used as the preemptive quota threshold for 5-hour intervals.
 */
export function getPreemptiveQuotaRemainingPercent5h(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent5h,
		5,
		{ min: 0, max: 100 },
	);
}

/**
 * Determines the percentage of quota to reserve preemptively for the 7-day window.
 *
 * Resolves the effective value from the environment variable `CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT`,
 * then from `pluginConfig.preemptiveQuotaRemainingPercent7d`, falling back to 5 if unset; the result is constrained
 * to the inclusive range 0–100. Safe for concurrent reads. Not affected by Windows filesystem semantics. Contains no
 * sensitive token data.
 *
 * @param pluginConfig - Plugin configuration object used as a fallback when the environment variable is not set
 * @returns The reserved quota percentage for the 7-day window, an integer between 0 and 100
 */
export function getPreemptiveQuotaRemainingPercent7d(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
		pluginConfig.preemptiveQuotaRemainingPercent7d,
		5,
		{ min: 0, max: 100 },
	);
}

/**
 * Get the configured maximum deferral time (in milliseconds) for preemptive quota checks.
 *
 * Reads an environment override or the plugin configuration and enforces a minimum of 1000 ms.
 *
 * @param pluginConfig - Plugin configuration object to read the setting from
 * @returns The maximum deferral interval in milliseconds
 *
 * Concurrency: concurrent config writers may not be observed immediately by readers.
 * Filesystem note: config persistence/visibility may differ on Windows vs POSIX filesystems.
 * Security: the returned value contains no sensitive tokens and is safe to log.
 */
export function getPreemptiveQuotaMaxDeferralMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS",
		pluginConfig.preemptiveQuotaMaxDeferralMs,
		2 * 60 * 60_000,
		{ min: 1_000 },
	);
}
