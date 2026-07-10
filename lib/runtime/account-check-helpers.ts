import type { ModelFamily } from "../prompts/codex.js";
import type { AccountStorageV3 } from "../storage.js";
import type { TokenResult } from "../types.js";
import { isPermanentAuthFailure } from "../auth/permanent-failure.js";

export function clampActiveIndices(
	storage: AccountStorageV3,
	families: readonly ModelFamily[],
): void {
	const count = storage.accounts.length;
	if (count === 0) {
		storage.activeIndex = 0;
		storage.activeIndexByFamily = {};
		return;
	}
	storage.activeIndex = Math.max(0, Math.min(storage.activeIndex, count - 1));
	storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
	for (const family of families) {
		const raw = storage.activeIndexByFamily[family];
		const candidate =
			typeof raw === "number" && Number.isFinite(raw)
				? raw
				: storage.activeIndex;
		storage.activeIndexByFamily[family] = Math.max(
			0,
			Math.min(candidate, count - 1),
		);
	}
}

export function isFlaggableFailure(
	failure: Extract<TokenResult, { type: "failed" }>,
): boolean {
	return isPermanentAuthFailure(failure);
}
