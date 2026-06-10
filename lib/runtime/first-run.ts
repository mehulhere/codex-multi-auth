// Lazy first-run setup (audit roadmap §4.5.4).
//
// The npm postinstall script used to detect the packaged Codex desktop app,
// auto-bind runtime rotation, and install OS launcher shortcuts. That work now
// runs here, on the first CLI invocation, so package installs stay
// side-effect-free. The hook is guarded by a marker file under the runtime
// root (~/.codex/multi-auth), claimed with an exclusive create so concurrent
// first invocations run the setup at most once, and every step is best-effort:
// a failure is debug-logged (messages only — never tokens or emails) and the
// command proceeds normally.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getCodexRuntimeRotationProxy, loadPluginConfig } from "../config.js";
import { withFileOperationRetry } from "../fs-retry.js";
import { createLogger } from "../logger.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { bindCodexAppRuntimeRotation, getAppBindStatus } from "./app-bind.js";

const log = createLogger("first-run");

const FIRST_RUN_MARKER_FILE = "first-run-setup.json";
export const FIRST_RUN_MARKER_VERSION = 1;

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "no"]);
const CI_ENV_KEYS = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"CIRCLECI",
	"BUILDKITE",
	"TF_BUILD",
	"TEAMCITY_VERSION",
	"JENKINS_URL",
	"TRAVIS",
	"APPVEYOR",
	"BITBUCKET_BUILD_NUMBER",
];

export type FirstRunStepStatus = "completed" | "skipped" | "failed";

export interface FirstRunSetupOutcome {
	appBind: FirstRunStepStatus;
	launcher: FirstRunStepStatus;
}

export type FirstRunSkipReason =
	| "ci"
	| "not-installed"
	| "already-done"
	| "claim-race"
	| "error";

export type FirstRunResult =
	| { ran: false; reason: FirstRunSkipReason }
	| ({ ran: true } & FirstRunSetupOutcome);

export interface FirstRunSetupDeps {
	env?: NodeJS.ProcessEnv;
	markerPath?: string;
	installedContext?: boolean;
	detectDesktopApp?: () => boolean;
	resolveRotation?: () => boolean;
	bindCodexApp?: () => Promise<FirstRunStepStatus>;
	installLauncher?: () => Promise<FirstRunStepStatus>;
	notify?: (message: string) => void;
	now?: () => number;
}

export function readOptionalBoolean(value: string | undefined): boolean | null {
	if (value === undefined || value.trim().length === 0) return null;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return null;
}

function isEnabledEnvFlag(env: NodeJS.ProcessEnv, key: string): boolean {
	const value = env[key];
	if (value === undefined || value.trim().length === 0) return false;
	return readOptionalBoolean(value) !== false;
}

export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
	if (readOptionalBoolean(env.npm_config_ignore_scripts) === true) return true;
	return CI_ENV_KEYS.some((key) => isEnabledEnvFlag(env, key));
}

function directoryContainsEntryWithPrefix(
	directory: string,
	prefix: string,
): boolean {
	try {
		return readdirSync(directory, { withFileTypes: true }).some((entry) =>
			entry.name.startsWith(prefix),
		);
	} catch {
		return false;
	}
}

export interface DesktopAppDetectionOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
}

export function hasCodexDesktopApp(
	options: DesktopAppDetectionOptions = {},
): boolean {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();

	if (platform === "win32") {
		const localAppData =
			(env.LOCALAPPDATA ?? "").trim() || join(home, "AppData", "Local");
		const programFiles =
			(env.ProgramFiles ?? env.ProgramW6432 ?? "").trim() || "C:\\Program Files";
		return (
			directoryContainsEntryWithPrefix(
				join(localAppData, "Packages"),
				"OpenAI.Codex_",
			) ||
			directoryContainsEntryWithPrefix(
				join(programFiles, "WindowsApps"),
				"OpenAI.Codex_",
			)
		);
	}

	if (platform === "darwin") {
		return (
			existsSync("/Applications/Codex.app") ||
			existsSync(join(home, "Applications", "Codex.app"))
		);
	}

	return false;
}

export function resolveRotationEnabled(
	env: NodeJS.ProcessEnv = process.env,
	readConfigRotation: () => boolean = () =>
		getCodexRuntimeRotationProxy(loadPluginConfig()) === true,
): boolean {
	const envOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY,
	);
	if (envOverride !== null) return envOverride;
	try {
		return readConfigRotation();
	} catch {
		// Rotation defaults on; a malformed config must not block first-run setup.
		return true;
	}
}

export interface FirstRunBindGateOptions {
	env?: NodeJS.ProcessEnv;
	rotationEnabled: boolean;
	appDetected: boolean;
}

export function shouldBindCodexAppOnFirstRun(
	options: FirstRunBindGateOptions,
): boolean {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const bindOverride = readOptionalBoolean(env.CODEX_MULTI_AUTH_APP_BIND);
	if (bindOverride !== null) return bindOverride;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_BIND_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	if (!options.rotationEnabled) return false;
	return options.appDetected;
}

export interface FirstRunLauncherGateOptions {
	env?: NodeJS.ProcessEnv;
	rotationEnabled: boolean;
}

export function shouldInstallCodexAppLauncherOnFirstRun(
	options: FirstRunLauncherGateOptions,
): boolean {
	const env = options.env ?? process.env;
	if (isCiEnvironment(env)) return false;

	const installOverride = readOptionalBoolean(
		env.CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL,
	);
	if (installOverride !== null) return installOverride;

	return options.rotationEnabled;
}

/**
 * First-run setup only fires when the module runs from an installed package
 * (a path containing a `node_modules` segment, as with global and npx
 * installs). Development checkouts and the test suite run straight from the
 * repository tree and stay side-effect-free.
 */
export function isInstalledPackageContext(
	modulePath: string = fileURLToPath(import.meta.url),
): boolean {
	return modulePath.split(sep).includes("node_modules");
}

export function getFirstRunMarkerPath(): string {
	return join(getCodexMultiAuthDir(), FIRST_RUN_MARKER_FILE);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === code
	);
}

/**
 * Claims the marker with an exclusive create so that, across processes, at
 * most one first invocation runs the setup. Returns false when another
 * process already holds (or completed) the claim.
 */
function claimFirstRunMarker(markerPath: string, startedAt: number): boolean {
	mkdirSync(dirname(markerPath), { recursive: true });
	const payload = `${JSON.stringify(
		{ version: FIRST_RUN_MARKER_VERSION, startedAt },
		null,
		"\t",
	)}\n`;
	try {
		writeFileSync(markerPath, payload, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (isErrnoCode(error, "EEXIST")) return false;
		throw error;
	}
}

async function atomicWriteMarker(target: string, content: string): Promise<void> {
	await withFileOperationRetry(async () => {
		const tempPath = join(
			dirname(target),
			[
				`.${basename(target)}`,
				String(process.pid),
				String(Date.now()),
				randomBytes(4).toString("hex"),
				"tmp",
			].join("."),
		);
		let moved = false;
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(tempPath, "w", 0o600);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = null;
			await rename(tempPath, target);
			moved = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!moved) {
				await unlink(tempPath).catch(() => undefined);
			}
		}
	});
}

async function finalizeFirstRunMarker(
	markerPath: string,
	startedAt: number,
	outcome: FirstRunSetupOutcome,
	now: () => number,
): Promise<void> {
	const payload = `${JSON.stringify(
		{
			version: FIRST_RUN_MARKER_VERSION,
			startedAt,
			completedAt: now(),
			appBind: outcome.appBind,
			launcher: outcome.launcher,
		},
		null,
		"\t",
	)}\n`;
	try {
		await atomicWriteMarker(markerPath, payload);
	} catch (error) {
		// The claim file already guarantees once-only behavior; losing the
		// completion details is acceptable.
		log.debug("first-run marker finalize failed", {
			error: errorMessage(error),
		});
	}
}

type LauncherInstallFn = (options: {
	log: (message: string) => void;
}) => Promise<unknown>;

async function loadLauncherInstall(): Promise<LauncherInstallFn | null> {
	const candidates = [
		fileURLToPath(new URL("../../../scripts/codex-app-launcher.js", import.meta.url)),
		fileURLToPath(new URL("../../scripts/codex-app-launcher.js", import.meta.url)),
	];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const launcherModule = (await import(
			pathToFileURL(candidate).href
		)) as Record<string, unknown>;
		return typeof launcherModule.installCodexAppLauncher === "function"
			? (launcherModule.installCodexAppLauncher as LauncherInstallFn)
			: null;
	}
	return null;
}

async function defaultBindCodexApp(
	env: NodeJS.ProcessEnv,
	rotationEnabled: boolean,
	detectDesktopApp: () => boolean,
	notify: (message: string) => void,
): Promise<FirstRunStepStatus> {
	const currentStatus = await getAppBindStatus().catch(() => null);
	const appDetected = detectDesktopApp() || currentStatus?.bound === true;
	if (!shouldBindCodexAppOnFirstRun({ env, rotationEnabled, appDetected })) {
		return "skipped";
	}
	const result = await bindCodexAppRuntimeRotation();
	if (result?.message) {
		notify(result.message);
	}
	return "completed";
}

async function defaultInstallLauncher(
	env: NodeJS.ProcessEnv,
	rotationEnabled: boolean,
	notify: (message: string) => void,
): Promise<FirstRunStepStatus> {
	if (!shouldInstallCodexAppLauncherOnFirstRun({ env, rotationEnabled })) {
		return "skipped";
	}
	const installLauncher = await loadLauncherInstall();
	if (!installLauncher) return "skipped";
	await installLauncher({ log: notify });
	return "completed";
}

/**
 * Runs the lazily deferred install setup (Codex app bind + launcher routing)
 * exactly once per runtime root. Never throws and never blocks a command on
 * failure: every error path resolves with a skip/failed status and only
 * debug-logs sanitized messages.
 */
export async function ensureFirstRunSetup(
	deps: FirstRunSetupDeps = {},
): Promise<FirstRunResult> {
	try {
		const env = deps.env ?? process.env;
		if (isCiEnvironment(env)) return { ran: false, reason: "ci" };
		const installed = deps.installedContext ?? isInstalledPackageContext();
		if (!installed) return { ran: false, reason: "not-installed" };
		const markerPath = deps.markerPath ?? getFirstRunMarkerPath();
		if (existsSync(markerPath)) return { ran: false, reason: "already-done" };
		const now = deps.now ?? Date.now;
		const startedAt = now();
		if (!claimFirstRunMarker(markerPath, startedAt)) {
			return { ran: false, reason: "claim-race" };
		}

		// Library default goes through the structured logger; the CLI entrypoint
		// passes a stderr notify so interactive users still see bind messages.
		const notify = deps.notify ?? ((message: string) => log.info(message));
		const detectDesktopApp =
			deps.detectDesktopApp ?? (() => hasCodexDesktopApp({ env }));
		const rotationEnabled = deps.resolveRotation
			? deps.resolveRotation()
			: resolveRotationEnabled(env);

		const outcome: FirstRunSetupOutcome = {
			appBind: "skipped",
			launcher: "skipped",
		};
		try {
			outcome.appBind = await (deps.bindCodexApp
				? deps.bindCodexApp()
				: defaultBindCodexApp(env, rotationEnabled, detectDesktopApp, notify));
		} catch (error) {
			outcome.appBind = "failed";
			log.debug("first-run app bind skipped", { error: errorMessage(error) });
		}
		try {
			outcome.launcher = await (deps.installLauncher
				? deps.installLauncher()
				: defaultInstallLauncher(env, rotationEnabled, notify));
		} catch (error) {
			outcome.launcher = "failed";
			log.debug("first-run launcher install skipped", {
				error: errorMessage(error),
			});
		}

		await finalizeFirstRunMarker(markerPath, startedAt, outcome, now);
		return { ran: true, ...outcome };
	} catch (error) {
		log.debug("first-run setup skipped", { error: errorMessage(error) });
		return { ran: false, reason: "error" };
	}
}
