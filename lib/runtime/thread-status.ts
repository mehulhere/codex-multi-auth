import { createHash } from "node:crypto";
import type { ManagedAccount } from "../accounts.js";
import type { CodexQuotaWindow } from "../quota-probe.js";
import { getAccountIdentityKey } from "../storage/identity.js";
import type { ParsedCodexQuotaSnapshot } from "./quota-headers.js";

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 512;
const MAX_SESSION_KEY_LENGTH = 256;

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
	private readonly entries = new Map<string, StoredThreadStatus>();

	constructor(options: ThreadStatusStoreOptions = {}) {
		this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_TTL_MS));
		this.maxEntries = Math.max(
			1,
			Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
		);
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
}
