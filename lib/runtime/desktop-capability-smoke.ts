import { maskString } from "../logger.js";

export type DesktopCapabilityLayer =
	| "discovery"
	| "contract"
	| "live"
	| "interactive";

export type DesktopCapabilityStatus =
	| "passed"
	| "failed"
	| "not_available"
	| "interactive_required"
	| "skipped";

export interface DesktopCapabilityDefinition {
	id: string;
	label: string;
	featureNames: readonly string[];
	requiresInteraction: boolean;
}

export interface DesktopCapabilityProbeOutcome {
	status: Exclude<DesktopCapabilityStatus, "interactive_required" | "skipped">;
	code?: string;
	hint?: string;
}

export interface DesktopCapabilityResult {
	id: string;
	label: string;
	status: DesktopCapabilityStatus;
	layers: DesktopCapabilityLayer[];
	durationMs: number;
	code?: string;
	hint?: string;
}

export interface DesktopCapabilitySmokeOptions {
	live: boolean;
	interactive: boolean;
	requiredIds?: readonly string[];
	enabledFeatures?: readonly string[];
	timeoutMs?: number;
}

export interface DesktopCapabilityProbeDeps {
	runProbe: (
		capability: DesktopCapabilityDefinition,
		layer: DesktopCapabilityLayer,
		signal: AbortSignal,
	) => Promise<DesktopCapabilityProbeOutcome>;
	now?: () => number;
}

export interface DesktopCapabilitySummary {
	total: number;
	passed: number;
	failed: number;
	notAvailable: number;
	interactiveRequired: number;
	skipped: number;
	requiredFailures: number;
}

export const DESKTOP_CAPABILITY_MANIFEST: readonly DesktopCapabilityDefinition[] = [
	{
		id: "responses",
		label: "Responses text streaming",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "models",
		label: "Model discovery",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "function-tools",
		label: "Function tools",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "hosted-web-search",
		label: "Hosted web search",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "image-generation",
		label: "Image generation",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "computer-use",
		label: "Computer Use",
		featureNames: [],
		requiresInteraction: true,
	},
	{
		id: "in-app-browser",
		label: "In-app browser",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "plugins",
		label: "Plugins",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "bundled-skills",
		label: "Bundled skills",
		featureNames: [],
		requiresInteraction: false,
	},
	{
		id: "dictation",
		label: "Dictation",
		featureNames: ["composer-dictation"],
		requiresInteraction: true,
	},
	{
		id: "read-aloud",
		label: "Read aloud",
		featureNames: ["read-aloud", "read-aloud-mcp"],
		requiresInteraction: true,
	},
	{
		id: "conversation-bridge",
		label: "Conversation and Farfield bridge",
		featureNames: ["conversation-mode", "farfield-bridge"],
		requiresInteraction: true,
	},
	{
		id: "thread-goals",
		label: "Thread goals and status",
		featureNames: ["multi-auth-thread-status", "persistent-status-panel"],
		requiresInteraction: false,
	},
	{
		id: "shared-history",
		label: "Shared provider history",
		featureNames: ["unified-provider-history"],
		requiresInteraction: false,
	},
] as const;

const KNOWN_INFRASTRUCTURE_FEATURES = new Set([
	"codex-wrapper-updater",
	"mcp-helper-reaper",
	"node-repl-reaper",
	"ui-tweaks",
]);

const SENSITIVE_KEYS = new Set([
	"access",
	"access_token",
	"accesstoken",
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"binary",
	"clientsecret",
	"client_secret",
	"credential",
	"imagebytes",
	"password",
	"refresh",
	"refresh_token",
	"refreshtoken",
	"secret",
	"token",
]);

const PROMPT_KEYS = new Set(["body", "input", "prompt", "raw", "responsebody"]);
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.([a-zA-Z]{2,}))/g;

function normalizeSensitiveKey(key: string): string {
	return key.replace(/[-\s]/g, "").toLowerCase();
}

function sanitizeCapabilityString(value: string): string {
	return maskString(
		value
			.replace(/Bearer\s+\S+/gi, "***MASKED***")
			.replace(LONG_SECRET_PATTERN, "***MASKED***")
			.replace(EMAIL_PATTERN, (_match, _domain, tld: string) => `***@***.${tld}`),
	);
}

export function sanitizeCapabilityValue(value: unknown, key = ""): unknown {
	const normalizedKey = normalizeSensitiveKey(key);
	if (SENSITIVE_KEYS.has(normalizedKey)) {
		return Buffer.isBuffer(value) ? "[binary redacted]" : "***MASKED***";
	}
	if (PROMPT_KEYS.has(normalizedKey)) {
		return "***REDACTED***";
	}
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return "[binary redacted]";
	}
	if (typeof value === "string") {
		return sanitizeCapabilityString(value);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeCapabilityValue(entry));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [
				entryKey,
				sanitizeCapabilityValue(entryValue, entryKey),
			]),
		);
	}
	return value;
}

function sanitizeOutcome(
	outcome: DesktopCapabilityProbeOutcome,
): DesktopCapabilityProbeOutcome {
	return {
		status: outcome.status,
		...(outcome.code
			? { code: String(sanitizeCapabilityValue(outcome.code)) }
			: {}),
		...(outcome.hint
			? { hint: String(sanitizeCapabilityValue(outcome.hint)) }
			: {}),
	};
}

async function runProbeWithTimeout(
	capability: DesktopCapabilityDefinition,
	layer: DesktopCapabilityLayer,
	deps: DesktopCapabilityProbeDeps,
	timeoutMs: number,
): Promise<DesktopCapabilityProbeOutcome> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		const timeout = new Promise<DesktopCapabilityProbeOutcome>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve({
					status: "failed",
					code: "probe_timeout",
					hint: `Capability probe exceeded ${timeoutMs} ms.`,
				});
			}, timeoutMs);
		});
		const result = await Promise.race([
			deps.runProbe(capability, layer, controller.signal),
			timeout,
		]);
		return sanitizeOutcome(result);
	} catch (error) {
		return {
			status: "failed",
			code: "probe_error",
			hint: sanitizeCapabilityString(
				error instanceof Error ? error.message : String(error),
			),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function runCapability(
	capability: DesktopCapabilityDefinition,
	options: DesktopCapabilitySmokeOptions,
	deps: DesktopCapabilityProbeDeps,
): Promise<DesktopCapabilityResult> {
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const layers: DesktopCapabilityLayer[] = ["discovery", "contract"];
	if (options.live) layers.push("live");
	if (options.interactive && capability.requiresInteraction) {
		layers.push("interactive");
	}

	let outcome: DesktopCapabilityProbeOutcome = { status: "passed" };
	for (const layer of layers) {
		outcome = await runProbeWithTimeout(
			capability,
			layer,
			deps,
			options.timeoutMs ?? 30_000,
		);
		if (outcome.status !== "passed") break;
	}

	const status: DesktopCapabilityStatus =
		outcome.status === "passed" && capability.requiresInteraction && !options.interactive
			? "interactive_required"
			: outcome.status;
	return {
		id: capability.id,
		label: capability.label,
		status,
		layers,
		durationMs: Math.max(0, now() - startedAt),
		...(outcome.code ? { code: outcome.code } : {}),
		...(outcome.hint ? { hint: outcome.hint } : {}),
	};
}

function unknownFeatureResults(
	enabledFeatures: readonly string[] | undefined,
): DesktopCapabilityResult[] {
	if (!enabledFeatures) return [];
	const known = new Set(KNOWN_INFRASTRUCTURE_FEATURES);
	for (const capability of DESKTOP_CAPABILITY_MANIFEST) {
		for (const featureName of capability.featureNames) known.add(featureName);
	}
	return [...new Set(enabledFeatures)]
		.filter((featureName) => !known.has(featureName))
		.map((featureName) => ({
			id: `feature:${featureName}`,
			label: `Unknown enabled feature: ${featureName}`,
			status: "failed" as const,
			layers: ["discovery" as const],
			durationMs: 0,
			code: "unknown_enabled_feature",
			hint: "Add this enabled feature to the capability manifest before release.",
		}));
}

export async function runDesktopCapabilitySmoke(
	options: DesktopCapabilitySmokeOptions,
	deps: DesktopCapabilityProbeDeps,
): Promise<DesktopCapabilityResult[]> {
	const results: DesktopCapabilityResult[] = [];
	for (const capability of DESKTOP_CAPABILITY_MANIFEST) {
		results.push(await runCapability(capability, options, deps));
	}
	results.push(...unknownFeatureResults(options.enabledFeatures));
	return results;
}

export function summarizeDesktopCapabilityResults(
	results: readonly DesktopCapabilityResult[],
	requiredIds: readonly string[] = [],
): DesktopCapabilitySummary {
	const required = new Set(requiredIds);
	return {
		total: results.length,
		passed: results.filter((entry) => entry.status === "passed").length,
		failed: results.filter((entry) => entry.status === "failed").length,
		notAvailable: results.filter((entry) => entry.status === "not_available").length,
		interactiveRequired: results.filter(
			(entry) => entry.status === "interactive_required",
		).length,
		skipped: results.filter((entry) => entry.status === "skipped").length,
		requiredFailures: results.filter(
			(entry) =>
				(required.size === 0 || required.has(entry.id)) && entry.status === "failed",
		).length,
	};
}
