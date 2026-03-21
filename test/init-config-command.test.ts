import { afterEach, describe, expect, it, vi } from "vitest";

describe("runInitConfigCommand", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs/promises");
		vi.doUnmock("node:url");
	});

	it("resolves templates from the package root when running from dist output", async () => {
		const readFileMock = vi.fn(
			async () => '{\n  "plugin": ["codex-multi-auth"]\n}\n',
		);
		vi.doMock("node:fs/promises", () => ({
			mkdir: vi.fn(),
			readFile: readFileMock,
			writeFile: vi.fn(),
		}));
		vi.doMock("node:url", () => ({
			fileURLToPath: () =>
				"C:\\repo\\dist\\lib\\codex-manager\\commands\\init-config.js",
		}));

		const { runInitConfigCommand } = await import(
			"../lib/codex-manager/commands/init-config.js"
		);
		const logInfo = vi.fn();
		const exitCode = await runInitConfigCommand(["modern"], {
			logInfo,
			logError: vi.fn(),
			cwd: () => "C:\\repo",
		});

		expect(exitCode).toBe(0);
		expect(readFileMock).toHaveBeenCalledWith(
			"C:\\repo\\config\\codex-modern.json",
			"utf8",
		);
		expect(logInfo).toHaveBeenCalledWith(
			expect.stringContaining('"plugin": ["codex-multi-auth"]'),
		);
	});
});
