#!/usr/bin/env node

// @ts-check

import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
	isCiEnvironment,
	resolveInstallPaths,
	removePluginFromList,
	withFileOperationRetry,
} from "./install-codex-auth-utils.js";

async function loadAppBindModule() {
	try {
		return await import("../dist/lib/runtime/app-bind.js");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_MODULE_NOT_FOUND"
		) {
			return null;
		}
		throw error;
	}
}

function defaultPreuninstallLog(message) {
	console.error(`codex-multi-auth: ${message}`);
}

/**
 * @param {{
 *   unbindCodexApp?: (dryRun: boolean) => Promise<void>,
 *   removeLauncher?: (options: { dryRun: boolean, log: (m: string) => void }) => Promise<void>,
 *   removePluginFromConfig?: (dryRun: boolean, log: (m: string) => void) => Promise<void>,
 *   clearCache?: (dryRun: boolean, log: (m: string) => void) => Promise<void>,
 *   log?: (message: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   dryRun?: boolean,
 * }} [deps]
 */
export async function runPreuninstallCleanup(deps = {}) {
	const log = deps.log ?? defaultPreuninstallLog;
	const env = deps.env ?? process.env;
	const dryRun = deps.dryRun ?? process.argv.includes("--dry-run");

	if (isCiEnvironment(env)) {
		return 0;
	}

	// Unbind Codex app runtime rotation (reverses postinstall bind)
	try {
		if (deps.unbindCodexApp) {
			await deps.unbindCodexApp(dryRun);
		} else {
			const appBindModule = await loadAppBindModule();
			if (
				appBindModule &&
				typeof appBindModule.unbindCodexAppRuntimeRotation === "function"
			) {
				if (dryRun) {
					log("[dry-run] Would unbind Codex app runtime rotation");
				} else {
					await appBindModule.unbindCodexAppRuntimeRotation();
				}
			}
		}
	} catch (error) {
		log(
			`app unbind skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Remove OS-level launcher (reverses postinstall launcher install)
	try {
		if (deps.removeLauncher) {
			await deps.removeLauncher({ dryRun, log });
		} else {
			const launcherModule = await import("./codex-app-launcher.js");
			if (typeof launcherModule.installCodexAppLauncher === "function") {
				await launcherModule.installCodexAppLauncher({ remove: true, dryRun, log });
			}
		}
	} catch (error) {
		log(
			`launcher removal skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Remove plugin entry from Codex.json
	try {
		if (deps.removePluginFromConfig) {
			await deps.removePluginFromConfig(dryRun, log);
		} else {
			const paths = resolveInstallPaths();
			if (dryRun) {
				log(`[dry-run] Would remove codex-multi-auth from ${paths.configPath}`);
			} else {
				try {
					const raw = await readFile(paths.configPath, "utf8");
					const config = JSON.parse(raw);
					if (Array.isArray(config.plugins)) {
						config.plugins = removePluginFromList(config.plugins);
						await withFileOperationRetry(() =>
							writeFile(
								paths.configPath,
								JSON.stringify(config, null, "\t") + "\n",
								"utf8",
							),
						);
					}
				} catch (fileError) {
					const code =
						fileError &&
						typeof fileError === "object" &&
						"code" in fileError
							? fileError.code
							: undefined;
					if (code !== "ENOENT") {
						log(
							`config cleanup skipped: ${fileError instanceof Error ? fileError.message : String(fileError)}`,
						);
					}
				}
			}
		}
	} catch (error) {
		log(
			`config cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Clear plugin cache dirs
	try {
		if (deps.clearCache) {
			await deps.clearCache(dryRun, log);
		} else {
			const paths = resolveInstallPaths();
			if (dryRun) {
				log(`[dry-run] Would remove ${paths.cacheNodeModules}`);
				log(`[dry-run] Would remove ${paths.cacheBunLock}`);
			} else {
				try {
					await withFileOperationRetry(() =>
						rm(paths.cacheNodeModules, { recursive: true, force: true }),
					);
					await withFileOperationRetry(() =>
						rm(paths.cacheBunLock, { force: true }),
					);
				} catch (error) {
					log(
						`cache clear skipped: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	} catch (error) {
		log(
			`cache clear skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return 0;
}

async function main() {
	return runPreuninstallCleanup();
}

function normalizeExitCode(exitCode) {
	return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
		? exitCode
		: 0;
}

const isDirectRun = (() => {
	try {
		return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isDirectRun) {
	main()
		.then((exitCode) => {
			process.exitCode = normalizeExitCode(exitCode);
		})
		.catch((error) => {
			defaultPreuninstallLog(
				`preuninstall cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 0;
		});
}
