import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function isJavaScriptEntryPath(candidate) {
	const extension = extname(candidate).toLowerCase();
	return extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

function createResolvedCodexBin(path) {
	return {
		path,
		launchWithNode: isJavaScriptEntryPath(path),
	};
}

function defaultResolvePackageBin(moduleUrl) {
	try {
		const require = createRequire(moduleUrl);
		return require.resolve("@openai/codex/bin/codex.js");
	} catch {
		return null;
	}
}

function resolveWindowsCmdPath(env) {
	const comSpec = (env.ComSpec ?? env.COMSPEC ?? "").trim();
	if (comSpec.length > 0) return comSpec;

	const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();
	if (systemRoot.length > 0) {
		return `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\cmd.exe`;
	}

	return "cmd.exe";
}

function splitPathEntries(pathValue) {
	if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
		return [];
	}
	return pathValue
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function resolvePathExecutableName(platform) {
	return platform === "win32" ? "codex.exe" : "codex";
}

function resolveCodexExecutableFromPath(pathEntries, platform, existsSyncImpl) {
	const executableName = resolvePathExecutableName(platform);
	for (const entry of pathEntries) {
		const candidate = join(entry, executableName);
		if (existsSyncImpl(candidate)) {
			return candidate;
		}
	}
	return null;
}

function normalizeWhereOutput(stdout) {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function resolveCodexExecutableFromSystemPath(env, platform, spawnSyncImpl, existsSyncImpl) {
	const pathEntries = splitPathEntries(env.PATH ?? env.Path ?? "");
	const fromEnvPath = resolveCodexExecutableFromPath(pathEntries, platform, existsSyncImpl);
	if (fromEnvPath) {
		return fromEnvPath;
	}

	try {
		const lookupResult =
			platform === "win32"
				? spawnSyncImpl(resolveWindowsCmdPath(env), ["/d", "/s", "/c", "where codex"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
						windowsHide: true,
					})
				: spawnSyncImpl("which", ["codex"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
					});
		if (lookupResult.status !== 0) {
			return null;
		}
		for (const candidate of normalizeWhereOutput(lookupResult.stdout)) {
			if (!existsSyncImpl(candidate)) {
				continue;
			}
			const fileName = basename(candidate).toLowerCase();
			if (fileName === "codex" || fileName === "codex.exe") {
				return candidate;
			}
		}
	} catch {
		// Ignore and fall through.
	}

	return null;
}

export function resolveRealCodexBin(options = {}) {
	const {
		env = process.env,
		argv = process.argv,
		platform = process.platform,
		moduleUrl = import.meta.url,
		existsSyncImpl = existsSync,
		spawnSyncImpl = spawnSync,
		resolvePackageBin = defaultResolvePackageBin,
	} = options;

	const override = (env.CODEX_MULTI_AUTH_REAL_CODEX_BIN ?? "").trim();
	if (override.length > 0) {
		if (existsSyncImpl(override)) return createResolvedCodexBin(override);
		return null;
	}

	const resolved = resolvePackageBin(moduleUrl);
	if (typeof resolved === "string" && resolved.length > 0 && existsSyncImpl(resolved)) {
		return createResolvedCodexBin(resolved);
	}

	const searchRoots = [];
	const scriptDir = dirname(fileURLToPath(moduleUrl));
	searchRoots.push(join(scriptDir, "..", ".."));

	const invokedScript = argv[1];
	if (typeof invokedScript === "string" && invokedScript.length > 0) {
		searchRoots.push(join(dirname(invokedScript), "..", ".."));
	}

	const npmPrefix = (env.npm_config_prefix ?? env.PREFIX ?? "").trim();
	if (npmPrefix.length > 0) {
		searchRoots.push(join(npmPrefix, "node_modules"));
		searchRoots.push(join(npmPrefix, "lib", "node_modules"));
	}

	for (const root of searchRoots) {
		const candidate = join(root, "@openai", "codex", "bin", "codex.js");
		if (existsSyncImpl(candidate)) return createResolvedCodexBin(candidate);
	}

	try {
		const rootResult =
			platform === "win32"
				? spawnSyncImpl(resolveWindowsCmdPath(env), ["/d", "/s", "/c", "npm root -g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
						windowsHide: true,
					})
				: spawnSyncImpl("npm", ["root", "-g"], {
						encoding: "utf8",
						env,
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 5000,
					});
		if (rootResult.status === 0) {
			const globalRoot = rootResult.stdout.trim();
			if (globalRoot.length > 0) {
				const globalBin = join(globalRoot, "@openai", "codex", "bin", "codex.js");
				if (existsSyncImpl(globalBin)) return createResolvedCodexBin(globalBin);
			}
		}
	} catch {
		// Ignore and fall through to null.
	}

	const nativeCodexBin = resolveCodexExecutableFromSystemPath(
		env,
		platform,
		spawnSyncImpl,
		existsSyncImpl,
	);
	if (nativeCodexBin) {
		return createResolvedCodexBin(nativeCodexBin);
	}

	return null;
}
