import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBridgeCommand } from "../lib/codex-manager/commands/bridge.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

describe("bridge command", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-bridge-command-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("creates and lists token metadata while showing plaintext only on create", async () => {
		const logInfo = vi.fn();
		const exitCode = await runBridgeCommand(
			["token", "create", "--label", "OpenCode"],
			{ logInfo, logError: vi.fn() },
		);
		expect(exitCode).toBe(0);
		const createOutput = logInfo.mock.calls.map((call) => String(call[0])).join("\n");
		expect(createOutput).toContain("Token:");
		const token = createOutput.match(/Token: (cma_local_[^\s]+)/)?.[1];
		expect(token).toBeTruthy();

		logInfo.mockClear();
		expect(
			await runBridgeCommand(["token", "list"], {
				logInfo,
				logError: vi.fn(),
			}),
		).toBe(0);
		const listOutput = logInfo.mock.calls.map((call) => String(call[0])).join("\n");
		expect(listOutput).toContain("OpenCode active");
		expect(listOutput).not.toContain(token);
	});

	it("prints valid json for an empty token list", async () => {
		const logInfo = vi.fn();
		expect(
			await runBridgeCommand(["token", "list", "--json"], {
				logInfo,
				logError: vi.fn(),
			}),
		).toBe(0);

		const output = logInfo.mock.calls.map((call) => String(call[0])).join("\n");
		expect(JSON.parse(output)).toEqual({
			command: "bridge token list",
			tokens: [],
		});
	});

	it("omits token hashes from bridge token json output", async () => {
		const logInfo = vi.fn();
		expect(
			await runBridgeCommand(["token", "create", "--label", "Env", "--json"], {
				logInfo,
				logError: vi.fn(),
			}),
		).toBe(0);

		const created = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			plainToken?: string;
			token?: Record<string, unknown>;
		};
		expect(created.plainToken).toMatch(/^cma_local_/);
		expect(created.token?.tokenHash).toBeUndefined();

		logInfo.mockClear();
		expect(
			await runBridgeCommand(["token", "list", "--json"], {
				logInfo,
				logError: vi.fn(),
			}),
		).toBe(0);
		const listed = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			tokens?: Array<Record<string, unknown>>;
		};
		expect(listed.tokens).toHaveLength(1);
		expect(listed.tokens?.[0]?.tokenHash).toBeUndefined();
		expect(JSON.stringify(listed)).not.toContain(created.plainToken);
	});
});
