import { createInterface } from "node:readline/promises";
import type { PluginConfig } from "../types.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";

export async function promptExperimentalSettingsMenu<
	TAction,
	TTargetState,
	TPlan,
	TApplied,
>(params: {
	initialConfig: PluginConfig;
	isInteractive: () => boolean;
	ui: UiRuntimeOptions;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	select: <T>(
		items: Array<Record<string, unknown>>,
		options: Record<string, unknown>,
	) => Promise<T | null>;
	getExperimentalSelectOptions: (
		ui: UiRuntimeOptions,
		help: string,
		hotkeyMapper: (raw: string) => TAction | undefined,
	) => Record<string, unknown>;
	mapExperimentalMenuHotkey: (raw: string) => TAction | undefined;
	mapExperimentalStatusHotkey: (raw: string) => TAction | undefined;
	formatDashboardSettingState: (enabled: boolean) => string;
	copy: {
		experimentalSync: string;
		experimentalBackup: string;
		experimentalRefreshGuard: string;
		experimentalRefreshInterval: string;
		experimentalDecreaseInterval: string;
		experimentalIncreaseInterval: string;
		saveAndBack: string;
		backNoSave: string;
		experimentalHelpMenu: string;
		experimentalBackupPrompt: string;
		back: string;
		experimentalHelpStatus: string;
		experimentalApplySync: string;
		experimentalHelpPreview: string;
	};
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	runNamedBackupExport: (args: {
		name: string;
	}) => Promise<{ kind: string; path?: string; error?: unknown }>;
	loadAccounts: () => Promise<unknown>;
	loadExperimentalSyncTarget: () => Promise<TTargetState>;
	planOcChatgptSync: (args: Record<string, unknown>) => Promise<TPlan>;
	applyOcChatgptSync: (args: Record<string, unknown>) => Promise<TApplied>;
	getTargetKind: (targetState: TTargetState) => string;
	getTargetDestination: (targetState: TTargetState) => unknown;
	getTargetDetection: (targetState: TTargetState) => unknown;
	getTargetErrorMessage: (targetState: TTargetState) => string | null;
	getPlanKind: (plan: TPlan) => string;
	getPlanBlockedReason: (plan: TPlan) => string;
	getPlanPreview: (plan: TPlan) => {
		toAdd: unknown[];
		toUpdate: unknown[];
		toSkip: unknown[];
		unchangedDestinationOnly: unknown[];
		activeSelectionBehavior: string;
	};
	getAppliedLabel: (applied: TApplied) => { label: string; color: string };
}): Promise<PluginConfig | null> {
	if (!params.isInteractive()) return null;
	let draft = params.cloneBackendPluginConfig(params.initialConfig);
	const copy = params.copy;

	while (true) {
		const action = await params.select<TAction>(
			[
				{
					label: copy.experimentalSync,
					value: { type: "sync" },
					color: "yellow",
				},
				{
					label: copy.experimentalBackup,
					value: { type: "backup" },
					color: "green",
				},
				{
					label: `${params.formatDashboardSettingState(draft.proactiveRefreshGuardian ?? false)} ${copy.experimentalRefreshGuard}`,
					value: { type: "toggle-refresh-guardian" },
					color: "yellow",
				},
				{
					label: `${copy.experimentalRefreshInterval}: ${Math.round((draft.proactiveRefreshIntervalMs ?? 60000) / 60000)} min`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: copy.experimentalDecreaseInterval,
					value: { type: "decrease-refresh-interval" },
					color: "yellow",
				},
				{
					label: copy.experimentalIncreaseInterval,
					value: { type: "increase-refresh-interval" },
					color: "green",
				},
				{ label: copy.saveAndBack, value: { type: "save" }, color: "green" },
				{ label: copy.backNoSave, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
				copy.experimentalHelpMenu,
				params.mapExperimentalMenuHotkey,
			),
		);
		const actionType = (action as { type?: string } | null)?.type;
		if (!action || actionType === "back") return null;
		if (actionType === "save") return draft;
		if (actionType === "toggle-refresh-guardian") {
			draft = {
				...draft,
				proactiveRefreshGuardian: !(draft.proactiveRefreshGuardian ?? false),
			};
			continue;
		}
		if (actionType === "decrease-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.max(
					60_000,
					(draft.proactiveRefreshIntervalMs ?? 60000) - 60000,
				),
			};
			continue;
		}
		if (actionType === "increase-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.min(
					600000,
					(draft.proactiveRefreshIntervalMs ?? 60000) + 60000,
				),
			};
			continue;
		}
		if (actionType === "backup") {
			const prompt = createInterface({
				input: params.input,
				output: params.output,
			});
			try {
				const backupName = (
					await prompt.question(copy.experimentalBackupPrompt)
				).trim();
				if (!backupName || backupName.toLowerCase() === "q") continue;
				try {
					const backupResult = await params.runNamedBackupExport({
						name: backupName,
					});
					const backupLabel =
						backupResult.kind === "exported"
							? `Saved backup to ${backupResult.path}`
							: backupResult.kind === "collision"
								? `Backup already exists: ${backupResult.path}`
								: backupResult.error instanceof Error
									? backupResult.error.message
									: String(backupResult.error);
					await params.select<TAction>(
						[
							{
								label: backupLabel,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: backupResult.kind === "exported" ? "green" : "yellow",
							},
							{ label: copy.back, value: { type: "back" }, color: "red" },
						],
						params.getExperimentalSelectOptions(
							params.ui,
							copy.experimentalHelpStatus,
							params.mapExperimentalStatusHotkey,
						),
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await params.select<TAction>(
						[
							{
								label: message,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: "yellow",
							},
							{ label: copy.back, value: { type: "back" }, color: "red" },
						],
						params.getExperimentalSelectOptions(
							params.ui,
							copy.experimentalHelpStatus,
							params.mapExperimentalStatusHotkey,
						),
					);
				}
			} finally {
				prompt.close();
			}
			continue;
		}

		const source = await params.loadAccounts();
		const targetState = await params.loadExperimentalSyncTarget();
		const targetError = params.getTargetErrorMessage(targetState);
		if (targetError) {
			await params.select<TAction>(
				[
					{
						label: targetError,
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{ label: copy.back, value: { type: "back" }, color: "red" },
				],
				params.getExperimentalSelectOptions(
					params.ui,
					copy.experimentalHelpStatus,
					params.mapExperimentalStatusHotkey,
				),
			);
			continue;
		}

		const targetKind = params.getTargetKind(targetState);
		const targetDetection = params.getTargetDetection(targetState);
		const plan = await params.planOcChatgptSync({
			source,
			destination:
				targetKind === "target"
					? params.getTargetDestination(targetState)
					: null,
			dependencies:
				targetKind === "target"
					? { detectTarget: () => targetDetection }
					: undefined,
		});
		if (params.getPlanKind(plan) !== "ready") {
			await params.select<TAction>(
				[
					{
						label: params.getPlanBlockedReason(plan),
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{ label: copy.back, value: { type: "back" }, color: "red" },
				],
				params.getExperimentalSelectOptions(
					params.ui,
					copy.experimentalHelpStatus,
					params.mapExperimentalStatusHotkey,
				),
			);
			continue;
		}

		const preview = params.getPlanPreview(plan);
		const review = await params.select<TAction>(
			[
				{
					label: `Preview: add ${preview.toAdd.length} | update ${preview.toUpdate.length} | skip ${preview.toSkip.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Preserve destination-only: ${preview.unchangedDestinationOnly.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Active selection: ${preview.activeSelectionBehavior}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: copy.experimentalApplySync,
					value: { type: "apply" },
					color: "green",
				},
				{ label: copy.backNoSave, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
				copy.experimentalHelpPreview,
				(raw) => {
					const lower = raw.toLowerCase();
					if (lower === "q") return { type: "back" } as TAction;
					if (lower === "a") return { type: "apply" } as TAction;
					return undefined;
				},
			),
		);
		if (!review || (review as { type?: string }).type === "back") continue;

		const applied = await params.applyOcChatgptSync({
			source,
			destination:
				targetKind === "target"
					? params.getTargetDestination(targetState)
					: undefined,
			dependencies:
				targetKind === "target"
					? { detectTarget: () => targetDetection }
					: undefined,
		});
		const appliedLabel = params.getAppliedLabel(applied);
		await params.select<TAction>(
			[
				{
					label: appliedLabel.label,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: appliedLabel.color,
				},
				{ label: copy.back, value: { type: "back" }, color: "red" },
			],
			params.getExperimentalSelectOptions(
				params.ui,
				copy.experimentalHelpStatus,
				params.mapExperimentalStatusHotkey,
			),
		);
	}
}
