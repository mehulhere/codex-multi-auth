import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ensureFirstRunSetup,
	FIRST_RUN_MARKER_VERSION,
	hasCodexDesktopApp,
	isCiEnvironment,
	isInstalledPackageContext,
	resolveRotationEnabled,
	shouldBindCodexAppOnFirstRun,
	shouldInstallCodexAppLauncherOnFirstRun,
} from "../lib/runtime/first-run.js";

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

function createMarkerPath(): string {
	const root = mkdtempSync(path.join(tmpdir(), "codex-first-run-"));
	tempRoots.push(root);
	return path.join(root, "multi-auth", "first-run-setup.json");
}

describe("first-run detection and gates", () => {
	it("detects the packaged Windows Codex app from LOCALAPPDATA packages", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-app-detect-"));
		tempRoots.push(home);
		const localAppData = path.join(home, "AppData", "Local");
		mkdirSync(path.join(localAppData, "Packages", "OpenAI.Codex_test"), {
			recursive: true,
		});

		expect(
			hasCodexDesktopApp({
				platform: "win32",
				home,
				env: { LOCALAPPDATA: localAppData },
			}),
		).toBe(true);
		expect(
			hasCodexDesktopApp({ platform: "linux", home, env: {} }),
		).toBe(false);
	});

	it("binds the Codex app on first run only when detected with rotation enabled", () => {
		expect(
			shouldBindCodexAppOnFirstRun({
				env: {},
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(true);
		expect(
			shouldBindCodexAppOnFirstRun({
				env: {},
				rotationEnabled: true,
				appDetected: false,
			}),
		).toBe(false);
		expect(
			shouldBindCodexAppOnFirstRun({
				env: {},
				rotationEnabled: false,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldBindCodexAppOnFirstRun({
				env: { CODEX_MULTI_AUTH_APP_BIND: "0" },
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldBindCodexAppOnFirstRun({
				env: { CODEX_MULTI_AUTH_APP_BIND_INSTALL: "1" },
				rotationEnabled: false,
				appDetected: false,
			}),
		).toBe(true);
	});

	it("keeps CI and ignored-scripts guards ahead of explicit opt-ins", () => {
		expect(isCiEnvironment({ CI: "true" })).toBe(true);
		expect(isCiEnvironment({ npm_config_ignore_scripts: "true" })).toBe(true);
		expect(
			shouldBindCodexAppOnFirstRun({
				env: { CI: "true", CODEX_MULTI_AUTH_APP_BIND: "1" },
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldInstallCodexAppLauncherOnFirstRun({
				env: { GITHUB_ACTIONS: "true", CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "1" },
				rotationEnabled: true,
			}),
		).toBe(false);
	});

	it("installs launcher routing on first run when rotation is enabled", () => {
		expect(
			shouldInstallCodexAppLauncherOnFirstRun({ env: {}, rotationEnabled: true }),
		).toBe(true);
		expect(
			shouldInstallCodexAppLauncherOnFirstRun({ env: {}, rotationEnabled: false }),
		).toBe(false);
		expect(
			shouldInstallCodexAppLauncherOnFirstRun({
				env: { CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "0" },
				rotationEnabled: true,
			}),
		).toBe(false);
		expect(
			shouldInstallCodexAppLauncherOnFirstRun({
				env: { CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "1" },
				rotationEnabled: false,
			}),
		).toBe(true);
	});

	it("resolves rotation default-on with env override and config fallback", () => {
		expect(
			resolveRotationEnabled(
				{ CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0" },
				() => true,
			),
		).toBe(false);
		expect(
			resolveRotationEnabled(
				{ CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1" },
				() => false,
			),
		).toBe(true);
		expect(resolveRotationEnabled({}, () => false)).toBe(false);
		expect(resolveRotationEnabled({}, () => true)).toBe(true);
		expect(
			resolveRotationEnabled({}, () => {
				throw new Error("config unreadable");
			}),
		).toBe(true);
	});

	it("only treats node_modules installs as installed package contexts", () => {
		expect(
			isInstalledPackageContext(
				path.join("usr", "lib", "node_modules", "codex-multi-auth", "dist", "lib", "runtime", "first-run.js"),
			),
		).toBe(true);
		expect(
			isInstalledPackageContext(
				path.join("home", "dev", "codex-multi-auth", "lib", "runtime", "first-run.ts"),
			),
		).toBe(false);
	});
});

describe("ensureFirstRunSetup", () => {
	it("runs setup once and records the outcome in the marker", async () => {
		const markerPath = createMarkerPath();
		const bindCodexApp = vi.fn(async () => "completed" as const);
		const installLauncher = vi.fn(async () => "completed" as const);

		const result = await ensureFirstRunSetup({
			env: {},
			installedContext: true,
			markerPath,
			bindCodexApp,
			installLauncher,
		});

		expect(result).toEqual({ ran: true, appBind: "completed", launcher: "completed" });
		expect(bindCodexApp).toHaveBeenCalledTimes(1);
		expect(installLauncher).toHaveBeenCalledTimes(1);
		expect(existsSync(markerPath)).toBe(true);
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
		expect(marker.version).toBe(FIRST_RUN_MARKER_VERSION);
		expect(marker.appBind).toBe("completed");
		expect(marker.launcher).toBe("completed");
	});

	it("skips setup on the second run once the marker exists", async () => {
		const markerPath = createMarkerPath();
		const bindCodexApp = vi.fn(async () => "completed" as const);
		const installLauncher = vi.fn(async () => "completed" as const);
		const deps = {
			env: {},
			installedContext: true,
			markerPath,
			bindCodexApp,
			installLauncher,
		};

		await ensureFirstRunSetup(deps);
		const second = await ensureFirstRunSetup(deps);

		expect(second).toEqual({ ran: false, reason: "already-done" });
		expect(bindCodexApp).toHaveBeenCalledTimes(1);
		expect(installLauncher).toHaveBeenCalledTimes(1);
	});

	it("runs setup at most once under concurrent first invocations", async () => {
		const markerPath = createMarkerPath();
		const bindCodexApp = vi.fn(async () => "completed" as const);
		const installLauncher = vi.fn(async () => "completed" as const);
		const deps = {
			env: {},
			installedContext: true,
			markerPath,
			bindCodexApp,
			installLauncher,
		};

		const results = await Promise.all([
			ensureFirstRunSetup(deps),
			ensureFirstRunSetup(deps),
		]);

		expect(results.filter((result) => result.ran)).toHaveLength(1);
		expect(bindCodexApp).toHaveBeenCalledTimes(1);
		expect(installLauncher).toHaveBeenCalledTimes(1);
	});

	it("never fails the command when setup steps throw, and still writes the marker", async () => {
		const markerPath = createMarkerPath();

		const result = await ensureFirstRunSetup({
			env: {},
			installedContext: true,
			markerPath,
			bindCodexApp: async () => {
				throw new Error("bind exploded");
			},
			installLauncher: async () => {
				throw new Error("launcher exploded");
			},
		});

		expect(result).toEqual({ ran: true, appBind: "failed", launcher: "failed" });
		expect(existsSync(markerPath)).toBe(true);
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
		expect(marker.appBind).toBe("failed");
		expect(marker.launcher).toBe("failed");
	});

	it("resolves instead of throwing when even the marker claim fails", async () => {
		const markerPath = createMarkerPath();

		await expect(
			ensureFirstRunSetup({
				env: {},
				installedContext: true,
				markerPath,
				now: () => {
					throw new Error("clock exploded");
				},
			}),
		).resolves.toEqual({ ran: false, reason: "error" });
		expect(existsSync(markerPath)).toBe(false);
	});

	it("skips entirely in CI without creating the marker", async () => {
		const markerPath = createMarkerPath();
		const bindCodexApp = vi.fn(async () => "completed" as const);

		const result = await ensureFirstRunSetup({
			env: { CI: "1" },
			installedContext: true,
			markerPath,
			bindCodexApp,
			installLauncher: async () => "completed" as const,
		});

		expect(result).toEqual({ ran: false, reason: "ci" });
		expect(bindCodexApp).not.toHaveBeenCalled();
		expect(existsSync(markerPath)).toBe(false);
	});

	it("skips outside installed package contexts without touching the filesystem", async () => {
		const markerPath = createMarkerPath();
		const bindCodexApp = vi.fn(async () => "completed" as const);

		const result = await ensureFirstRunSetup({
			env: {},
			installedContext: false,
			markerPath,
			bindCodexApp,
			installLauncher: async () => "completed" as const,
		});

		expect(result).toEqual({ ran: false, reason: "not-installed" });
		expect(bindCodexApp).not.toHaveBeenCalled();
		expect(existsSync(markerPath)).toBe(false);
	});

	it("is wired into the CLI entrypoint as a guarded best-effort call", () => {
		const content = readFileSync("lib/codex-manager.ts", "utf8");
		expect(content).toContain('from "./runtime/first-run.js"');
		expect(content).toContain("await ensureFirstRunSetup({");
		expect(content).toContain("}).catch(() => undefined);");
	});
});
