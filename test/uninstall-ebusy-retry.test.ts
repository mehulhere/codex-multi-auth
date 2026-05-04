import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveUninstallPaths } from "../lib/codex-manager/commands/uninstall.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

// Wrap node:fs/promises so we can inject a one-shot EBUSY into a single
// operation, which forces the uninstall command's withFileOperationRetry
// loop down its retry branch deterministically.
let injectEbusyOnNextRm = false;
let injectEbusyOnNextRead = false;

vi.mock("node:fs/promises", async () => {
	const actual: typeof import("node:fs/promises") = await vi.importActual(
		"node:fs/promises",
	);
	return {
		...actual,
		rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
			if (injectEbusyOnNextRm) {
				injectEbusyOnNextRm = false;
				const err = Object.assign(new Error("EBUSY: resource busy"), {
					code: "EBUSY",
				});
				throw err;
			}
			return actual.rm(...args);
		}),
		readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
			if (injectEbusyOnNextRead) {
				injectEbusyOnNextRead = false;
				const err = Object.assign(new Error("EBUSY: read busy"), {
					code: "EBUSY",
				});
				throw err;
			}
			return actual.readFile(
				...(args as Parameters<typeof actual.readFile>),
			) as ReturnType<typeof actual.readFile>;
		}),
	};
});

const tempRoots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	injectEbusyOnNextRm = false;
	injectEbusyOnNextRead = false;
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await removeWithRetry(root, { recursive: true, force: true });
	}
});

function makeTempHome(): string {
	const root = mkdtempSync(path.join(tmpdir(), "uninstall-ebusy-"));
	tempRoots.push(root);
	return root;
}

// Defer to production resolveUninstallPaths so the test fixtures cannot
// drift from real uninstall behavior; derive the missing dir entries via
// path.dirname.
function pathsForTempHome(home: string) {
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		APPDATA:
			process.platform === "win32" ? path.join(home, "AppData", "Roaming") : "",
		LOCALAPPDATA:
			process.platform === "win32" ? path.join(home, "AppData", "Local") : "",
	};
	const resolved = resolveUninstallPaths(process.platform, env, home);
	return {
		...resolved,
		configDir: path.dirname(resolved.configPath),
		cacheDir: path.dirname(resolved.cacheBunLock),
	};
}

describe("runUninstallCommand fs retry", () => {
	it("retries Codex.json read after a single EBUSY", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		injectEbusyOnNextRead = true;
		const messages: string[] = [];
		const { runUninstallCommand } = await import(
			"../lib/codex-manager/commands/uninstall.js"
		);

		const code = await runUninstallCommand([], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		// The retry loop swallowed the EBUSY and the second readFile attempt
		// succeeded; the plugin entry was removed and exit code is clean.
		expect(code).toBe(0);
		expect(injectEbusyOnNextRead).toBe(false);
		expect(messages.some((m) => m.includes("config cleanup skipped"))).toBe(false);
	});

	it("retries cache rm after a single EBUSY", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.cacheNodeModules, { recursive: true });
		writeFileSync(
			path.join(paths.cacheNodeModules, "marker"),
			"x",
			"utf8",
		);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		injectEbusyOnNextRm = true;
		const messages: string[] = [];
		const { runUninstallCommand } = await import(
			"../lib/codex-manager/commands/uninstall.js"
		);

		const code = await runUninstallCommand([], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(injectEbusyOnNextRm).toBe(false);
		expect(messages.some((m) => m.includes("cache clear skipped"))).toBe(false);
	});
});
