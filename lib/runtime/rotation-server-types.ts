import type { AccountManager } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";
import type { QuotaCacheData } from "../quota-cache.js";
import type { QuotaPoolAggregate } from "../quota-pool-aggregate.js";
import type {
	RuntimeThreadStatus,
	ThreadStatusPersistenceState,
} from "./thread-status.js";

export interface RuntimeRotationProxyServer {
	host: string;
	port: number;
	baseUrl: string;
	close: () => Promise<void>;
	getStatus: () => RuntimeRotationProxyStatus;
}

export interface RuntimeRotationProxyStatus {
	startedAt: number;
	totalRequests: number;
	upstreamRequests: number;
	retries: number;
	rotations: number;
	streamsStarted: number;
	lastError: string | null;
	lastAccountIndex: number | null;
	lastAccountLabel: string | null;
	lastAccountId: string | null;
	lastAccountUpdatedAt: number | null;
	threadStatuses: Record<string, RuntimeThreadStatus>;
	threadStatusPersistence: ThreadStatusPersistenceState;
	poolQuota: QuotaPoolAggregate & { updatedAt: number };
}

export interface RuntimeRotationProxyOptions {
	host?: string;
	port?: number;
	upstreamBaseUrl?: string;
	clientApiKey: string;
	accountManager?: AccountManager;
	fetchImpl?: typeof fetch;
	now?: () => number;
	quotaRemainingPercentThreshold?: number;
	/** Optional initial cache for isolated callers/tests; disk is loaded when omitted. */
	quotaCache?: QuotaCacheData;
	maxRequestBodyBytes?: number;
	fetchTimeoutMs?: number;
	streamStallTimeoutMs?: number;
	/** Owner-only durable per-thread account assignment sidecar used by Desktop. */
	threadStatusPath?: string;
	threadStatusTtlMs?: number;
	initialThreadStatuses?: Record<string, RuntimeThreadStatus>;
	/**
	 * Whether this proxy honors the persisted manual pin written by `switch`.
	 * Defaults to true. Desktop app-bind disables it because that surface uses
	 * automatic per-thread best-account routing; explicit forced pins remain
	 * strict regardless of this setting.
	 */
	honorStoredPin?: boolean;
	/**
	 * Ephemeral, per-instance account pin (0-based) for a single invocation
	 * (issue #623: `codex-multi-auth-codex --account`). When set, this proxy
	 * routes every request to exactly this account and never rotates, without
	 * touching the persisted `switch` pin on disk. Falls back to
	 * `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` in the environment when omitted so
	 * the value survives the launcher -> detached app-helper process boundary.
	 */
	forcedAccountIndex?: number | null;
}

export interface RequestContext {
	body: Buffer;
	headers: Headers;
	method: "GET" | "POST";
	upstreamPath: string;
	model: string | null;
	family: ModelFamily;
	stream: boolean;
	sessionKey: string | null;
	previousResponseId: string | null;
}

export type ExhaustionReason =
	| "rate-limit"
	| "server-error"
	| "network-error"
	| "auth-failure"
	| "budget"
	| "deactivated"
	| "no-account";
export type RuntimeProxyHttpError = Error & {
	statusCode: number;
	code: string;
};

export interface RuntimeRotationAccountIdentity {
	index: number;
	label: string;
	accountId: string | null;
	updatedAt: number;
}
