import type { UiRuntimeOptions } from "./runtime.js";

export type UiTextTone =
	| "primary"
	| "heading"
	| "accent"
	| "muted"
	| "success"
	| "warning"
	| "danger"
	| "normal";

const TONE_TO_COLOR: Record<UiTextTone, keyof UiRuntimeOptions["theme"]["colors"] | null> = {
	primary: "primary",
	heading: "heading",
	accent: "accent",
	muted: "muted",
	success: "success",
	warning: "warning",
	danger: "danger",
	normal: null,
};

/**
 * Compute ANSI/ANSI256/truecolor start and reset sequences for a badge based on UI options and tone.
 *
 * @param ui - Runtime UI options (palette, accent, colorProfile, and theme colors) used to choose appropriate escape sequences
 * @param tone - Badge tone; must be one of "primary", "accent", "success", "warning", "danger", or "muted"
 * @returns An object with `start` (the escape sequence to begin badge styling) and `end` (the theme reset sequence)
 *
 * Concurrency: pure and has no side effects; safe for concurrent use.
 * Windows consoles: returns ANSI sequences which may not be interpreted on older Windows terminals and may appear verbatim.
 * Token redaction: returned strings contain raw ANSI codes and should be treated like presentation data (do not leak in sensitive audit logs without redaction).
 */
function badgeStyleForTone(
	ui: UiRuntimeOptions,
	tone: Exclude<UiTextTone, "normal" | "heading">,
): { start: string; end: string } {
	const end = ui.theme.colors.reset;
	const isBlue = ui.palette === "blue";
	const accent = ui.accent;
	if (ui.colorProfile === "truecolor") {
		const accentStart = (() => {
			if (accent === "cyan") return "\x1b[48;2;8;89;106m\x1b[38;2;224;242;254m\x1b[1m";
			if (accent === "blue") return "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m";
			if (accent === "yellow") return "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m";
			return "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m";
		})();
		const successStart = isBlue
			? "\x1b[48;2;30;64;175m\x1b[38;2;219;234;254m\x1b[1m"
			: "\x1b[48;2;20;83;45m\x1b[38;2;220;252;231m\x1b[1m";
		switch (tone) {
			case "primary":
			case "accent":
				return { start: accentStart, end };
			case "success":
				return { start: successStart, end };
			case "warning":
				return { start: "\x1b[48;2;120;53;15m\x1b[38;2;255;247;237m\x1b[1m", end };
			case "danger":
				return { start: "\x1b[48;2;127;29;29m\x1b[38;2;254;226;226m\x1b[1m", end };
			case "muted":
				return { start: "\x1b[48;2;51;65;85m\x1b[38;2;226;232;240m\x1b[1m", end };
		}
	}

	if (ui.colorProfile === "ansi256") {
		const accentStart = (() => {
			if (accent === "cyan") return "\x1b[48;5;23m\x1b[38;5;159m\x1b[1m";
			if (accent === "blue") return "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m";
			if (accent === "yellow") return "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m";
			return "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m";
		})();
		const successStart = isBlue
			? "\x1b[48;5;19m\x1b[38;5;153m\x1b[1m"
			: "\x1b[48;5;22m\x1b[38;5;157m\x1b[1m";
		switch (tone) {
			case "primary":
			case "accent":
				return { start: accentStart, end };
			case "success":
				return { start: successStart, end };
			case "warning":
				return { start: "\x1b[48;5;94m\x1b[38;5;230m\x1b[1m", end };
			case "danger":
				return { start: "\x1b[48;5;88m\x1b[38;5;224m\x1b[1m", end };
			case "muted":
				return { start: "\x1b[48;5;240m\x1b[38;5;255m\x1b[1m", end };
		}
	}

	const accentStart = (() => {
		if (accent === "cyan") return "\x1b[46m\x1b[30m\x1b[1m";
		if (accent === "blue") return "\x1b[44m\x1b[97m\x1b[1m";
		if (accent === "yellow") return "\x1b[43m\x1b[30m\x1b[1m";
		return "\x1b[42m\x1b[30m\x1b[1m";
	})();
	const successStart = isBlue ? "\x1b[44m\x1b[97m\x1b[1m" : "\x1b[42m\x1b[30m\x1b[1m";
	switch (tone) {
		case "primary":
		case "accent":
			return { start: accentStart, end };
		case "success":
			return { start: successStart, end };
		case "warning":
			return { start: "\x1b[43m\x1b[30m\x1b[1m", end };
		case "danger":
			return { start: "\x1b[41m\x1b[97m\x1b[1m", end };
		case "muted":
			return { start: "\x1b[100m\x1b[97m\x1b[1m", end };
	}
}

/**
 * Colorize a text string according to the UI theme and tone.
 *
 * If `ui.v2Enabled` is false or the tone maps to no color, the original `text` is returned unchanged.
 *
 * Concurrency: pure and side-effect-free; safe to call concurrently.
 * Filesystem: performs no I/O and behaves identically on Windows and other platforms.
 * Token redaction: this function only wraps `text` with theme color tokens and does not redact or alter token contents.
 *
 * @param ui - Runtime UI options (used to determine theme colors and whether v2 styling is enabled)
 * @param text - The text to colorize
 * @param tone - The text tone to apply; when the tone maps to no color (e.g., "normal") the text is returned as-is
 * @returns The input `text` wrapped with the theme color start token for `tone` and the theme reset token, or the original `text` if no color is applied
 */
export function paintUiText(ui: UiRuntimeOptions, text: string, tone: UiTextTone = "normal"): string {
	if (!ui.v2Enabled) return text;
	const colorKey = TONE_TO_COLOR[tone];
	if (!colorKey) return text;
	return `${ui.theme.colors[colorKey]}${text}${ui.theme.colors.reset}`;
}

export function formatUiHeader(ui: UiRuntimeOptions, title: string): string[] {
	if (!ui.v2Enabled) return [title];
	const divider = "-".repeat(Math.max(8, title.length));
	return [
		paintUiText(ui, title, "heading"),
		paintUiText(ui, divider, "muted"),
	];
}

export function formatUiSection(ui: UiRuntimeOptions, title: string): string[] {
	if (!ui.v2Enabled) return [title];
	return [paintUiText(ui, title, "accent")];
}

export function formatUiItem(
	ui: UiRuntimeOptions,
	text: string,
	tone: UiTextTone = "normal",
): string {
	if (!ui.v2Enabled) return `- ${text}`;
	const bullet = paintUiText(ui, ui.theme.glyphs.bullet, "muted");
	return `${bullet} ${paintUiText(ui, text, tone)}`;
}

export function formatUiKeyValue(
	ui: UiRuntimeOptions,
	key: string,
	value: string,
	valueTone: UiTextTone = "normal",
): string {
	if (!ui.v2Enabled) return `${key}: ${value}`;
	const keyText = paintUiText(ui, `${key}:`, "muted");
	const valueText = paintUiText(ui, value, valueTone);
	return `${keyText} ${valueText}`;
}

/**
 * Format a badge label for the UI, applying tone-specific styling when v2 UI is enabled.
 *
 * @param ui - Runtime UI options that control styling, color profile, and v2 enablement
 * @param label - Text to display inside the badge (will be wrapped in square brackets)
 * @param tone - Visual tone for the badge; must not be `"normal"` or `"heading"`
 * @returns The badge string; when v2 is disabled this is `"[label]"`, otherwise the label wrapped with start/end styling sequences
 *
 * @remarks
 * Concurrency: safe to call concurrently; function is pure with respect to provided inputs.  
 * Windows filesystem: output contains ANSI/ANSI256/truecolor escape sequences when v2 is enabled—terminal support may vary on Windows consoles.  
 * Token redaction: this function does not perform any secret/token redaction; callers should redact sensitive values in `label` before calling if needed.
 */
export function formatUiBadge(
	ui: UiRuntimeOptions,
	label: string,
	tone: Exclude<UiTextTone, "normal" | "heading"> = "accent",
): string {
	const text = `[${label}]`;
	if (!ui.v2Enabled) return text;
	const style = badgeStyleForTone(ui, tone);
	return `${style.start}${text}${style.end}`;
}

/**
 * Selects a UI tone representing quota health based on remaining percentage.
 *
 * @param leftPercent - Percentage of quota remaining (typically 0–100)
 * @returns `'success'` if `leftPercent` > 35, `'warning'` if `leftPercent` ≤ 35 and > 15, `'danger'` if `leftPercent` ≤ 15
 *
 * @remarks
 * Concurrency: pure and side-effect-free; safe to call from concurrent contexts.
 * Windows filesystem: no filesystem interaction.
 * Token redaction: does not handle or emit sensitive tokens.
 */
export function quotaToneFromLeftPercent(
	leftPercent: number,
): Extract<UiTextTone, "success" | "warning" | "danger"> {
	if (leftPercent <= 15) return "danger";
	if (leftPercent <= 35) return "warning";
	return "success";
}
