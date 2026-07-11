import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ManagedAccount } from "../accounts.js";
import type { CodexQuotaWindow } from "../quota-probe.js";
import { getAccountIdentityKey } from "../storage/identity.js";
import type { ParsedCodexQuotaSnapshot } from "./quota-headers.js";

export const DEFAULT_THREAD_STATUS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 512;
const MAX_SESSION_KEY_LENGTH = 256;
const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;

interface StoredThreadStatus {
	accountKey: string;
	primary: CodexQuotaWindow;
	secondary: CodexQuotaWindow;
	updatedAt: number;
	expiresAt: number;
}

export interface RuntimeThreadStatus {
	accountNumber: number;
	accountDisplay: string;
	maskedEmail: string | null;
	primary: CodexQuotaWindow;
	secondary: CodexQuotaWindow;
	updatedAt: number;
}

export interface ThreadStatusStoreOptions {
	ttlMs?: number;
	maxEntries?: number;
	storagePath?: string;
}

function normalizeSessionKey(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_SESSION_KEY_LENGTH) return null;
	return trimmed;
}

function threadAccountKey(account: ManagedAccount): string | null {
	const identity = getAccountIdentityKey(account);
	if (!identity) return null;
	return createHash("sha256").update(identity).digest("hex");
}

function cloneWindow(window: CodexQuotaWindow): CodexQuotaWindow {
	const result: CodexQuotaWindow = {};
	if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
		result.usedPercent = window.usedPercent;
	}
	if (typeof window.windowMinutes === "number" && Number.isFinite(window.windowMinutes)) {
		result.windowMinutes = window.windowMinutes;
	}
	if (typeof window.resetAtMs === "number" && Number.isFinite(window.resetAtMs)) {
		result.resetAtMs = window.resetAtMs;
	}
	return result;
}

export function maskThreadStatusEmail(email: string | undefined): string | null {
	if (!email) return null;
	const trimmed = email.trim();
	const at = trimmed.indexOf("@");
	if (at <= 0 || at === trimmed.length - 1 || trimmed.indexOf("@", at + 1) !== -1) {
		return null;
	}
	const localPrefix = trimmed.slice(0, Math.min(2, at));
	const domain = trimmed.slice(at + 1);
	if (!domain.includes(".")) return null;
	return `${localPrefix}***@${domain}`;
}

export class ThreadStatusStore {
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly storagePath: string | null;
	private readonly entries = new Map<string, StoredThreadStatus>();

	constructor(options: ThreadStatusStoreOptions = {}) {
		this.ttlMs = Math.max(
			1,
			Math.floor(options.ttlMs ?? DEFAULT_THREAD_STATUS_TTL_MS),
		);
		this.maxEntries = Math.max(
			1,
			Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
		);
		this.storagePath = options.storagePath?.trim() || null;
		this.loadFromDisk();
	}

	remember(
		sessionKey: string | null | undefined,
		account: ManagedAccount | undefined,
		quota: ParsedCodexQuotaSnapshot | null,
		now = Date.now(),
	): void {
		const key = normalizeSessionKey(sessionKey);
		if (!key || !account) return;
		const accountKey = threadAccountKey(account);
		if (!accountKey) return;
		const existing = this.entries.get(key);
		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
			this.evictOldest();
		}
		this.entries.set(key, {
			accountKey,
			primary: quota
				? cloneWindow(quota.primary)
				: existing?.accountKey === accountKey
					? cloneWindow(existing.primary)
					: {},
			secondary: quota
				? cloneWindow(quota.secondary)
				: existing?.accountKey === accountKey
					? cloneWindow(existing.secondary)
					: {},
			updatedAt: now,
			expiresAt: now + this.ttlMs,
		});
		this.persistToDisk();
	}

	get(
		sessionKey: string | null | undefined,
		accounts: readonly ManagedAccount[],
		now = Date.now(),
	): RuntimeThreadStatus | null {
		const key = normalizeSessionKey(sessionKey);
		if (!key) return null;
		const entry = this.entries.get(key);
		if (!entry) return null;
		if (entry.expiresAt <= now) {
			this.entries.delete(key);
			this.persistToDisk();
			return null;
		}
		const account = accounts.find(
			(candidate) => threadAccountKey(candidate) === entry.accountKey,
		);
		if (!account) return null;
		const accountNumber = account.index + 1;
		const maskedEmail = maskThreadStatusEmail(account.email);
		return {
			accountNumber,
			accountDisplay: maskedEmail
				? `Account ${accountNumber} (${maskedEmail})`
				: `Account ${accountNumber}`,
			maskedEmail,
			primary: cloneWindow(entry.primary),
			secondary: cloneWindow(entry.secondary),
			updatedAt: entry.updatedAt,
		};
	}

	snapshot(
		accounts: readonly ManagedAccount[],
		now = Date.now(),
	): Record<string, RuntimeThreadStatus> {
		const result: Record<string, RuntimeThreadStatus> = {};
		for (const key of this.entries.keys()) {
			const status = this.get(key, accounts, now);
			if (status) result[key] = status;
		}
		return result;
	}

	private evictOldest(): void {
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.entries.entries()) {
			if (entry.updatedAt < oldestAt) {
				oldestAt = entry.updatedAt;
				oldestKey = key;
			}
		}
		if (oldestKey) this.entries.delete(oldestKey);
	}

	private loadFromDisk(): void {
		if (!this.storagePath) return;
		try {
			const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as {
				version?: unknown;
				entries?: unknown;
			};
			if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
				return;
			}
			for (const [sessionKey, candidate] of Object.entries(parsed.entries).slice(
				0,
				this.maxEntries,
			)) {
				const key = normalizeSessionKey(sessionKey);
				if (!key || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
					continue;
				}
				const value = candidate as Partial<StoredThreadStatus>;
				if (
					typeof value.accountKey !== "string" ||
					!ACCOUNT_KEY_PATTERN.test(value.accountKey) ||
					typeof value.updatedAt !== "number" ||
					!Number.isFinite(value.updatedAt) ||
					typeof value.expiresAt !== "number" ||
					!Number.isFinite(value.expiresAt)
				) {
					continue;
				}
				this.entries.set(key, {
					accountKey: value.accountKey,
					primary: cloneWindow(value.primary ?? {}),
					secondary: cloneWindow(value.secondary ?? {}),
					updatedAt: value.updatedAt,
					expiresAt: value.expiresAt,
				});
			}
		} catch {
			// Assignment persistence is best-effort; routing must remain available.
		}
	}

	private persistToDisk(): void {
		if (!this.storagePath) return;
		const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			mkdirSync(dirname(this.storagePath), { recursive: true });
			writeFileSync(
				tempPath,
				`${JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }, null, 2)}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, this.storagePath);
			chmodSync(this.storagePath, 0o600);
		} catch {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Preserve the original best-effort write failure.
			}
		}
	}
}
