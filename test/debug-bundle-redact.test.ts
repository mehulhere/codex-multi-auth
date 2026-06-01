import { afterEach, beforeEach, vi } from "vitest";

const homedirMock = vi.fn<() => string>();

vi.mock("node:os", async (importActual) => {
	const actual = await importActual<typeof import("node:os")>();
	return {
		...actual,
		homedir: () => homedirMock(),
	};
});

import { redactHome, runDebugBundleCommand } from "../lib/codex-manager/commands/debug-bundle.js";

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("debug-bundle redactHome (errors-logging-04)", () => {
	beforeEach(() => {
		homedirMock.mockReset();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: realPlatform,
			configurable: true,
		});
	});

	describe("posix path rules", () => {
		beforeEach(() => {
			setPlatform("linux");
			homedirMock.mockReturnValue("/home/alice");
		});

		it("redacts the home prefix with ~ at a path boundary", () => {
			expect(redactHome("/home/alice/.codex/config.json")).toBe(
				"~/.codex/config.json",
			);
		});

		it("redacts an exact home match", () => {
			expect(redactHome("/home/alice")).toBe("~");
		});

		it("does NOT redact a sibling that merely shares the prefix", () => {
			// prefix-collision: /home/alice2 must not be treated as under /home/alice.
			expect(redactHome("/home/alice2/.codex/config.json")).toBe(
				"/home/alice2/.codex/config.json",
			);
		});

		it("is case-sensitive on posix", () => {
			expect(redactHome("/HOME/Alice/.codex")).toBe("/HOME/Alice/.codex");
		});
	});

	describe("windows path rules", () => {
		beforeEach(() => {
			setPlatform("win32");
			homedirMock.mockReturnValue("C:\\Users\\Alice");
		});

		it("redacts despite case-only differences", () => {
			expect(redactHome("c:\\users\\alice\\.codex\\config.json")).toBe(
				"~\\.codex\\config.json",
			);
		});

		it("redacts the exact home regardless of case", () => {
			expect(redactHome("C:\\USERS\\ALICE")).toBe("~");
		});

		it("does NOT redact a case-insensitive sibling prefix", () => {
			expect(redactHome("c:\\users\\alice2\\.codex")).toBe(
				"c:\\users\\alice2\\.codex",
			);
		});
	});

	it("returns the value unchanged when homedir is empty", () => {
		setPlatform("linux");
		homedirMock.mockReturnValue("");
		expect(redactHome("/home/alice/.codex")).toBe("/home/alice/.codex");
	});

	describe("--json bundle redaction", () => {
		beforeEach(() => {
			setPlatform("linux");
			homedirMock.mockReturnValue("/home/alice");
		});

		it("redacts configPath, masks accountId, and strips proxy creds from config entries", async () => {
			const lines: string[] = [];
			const code = await runDebugBundleCommand(["--json"], {
				getConfigReport: () => ({
					configPath: "/home/alice/.codex/config.json",
					storageKind: "unified" as never,
					entries: [
						{
							key: "runtimeRotationProxy" as never,
							value: "http://user:s3cr3t-pass@proxy.internal:8080",
							defaultValue: null,
							source: "config" as never,
							envNames: [],
						},
					],
				}),
				getStoragePath: () => "/home/alice/.codex/accounts.json",
				loadAccounts: async () => ({ accounts: [], activeIndex: undefined }),
				loadFlaggedAccounts: async () => ({ accounts: [] }),
				loadCodexCliState: async () => ({
					path: "/home/alice/.codex",
					accounts: [],
					activeEmail: "alice@example.com",
					activeAccountId: "org-1234567890abcdef",
				}),
				getLastAccountsSaveTimestamp: () => 0,
				logInfo: (m) => lines.push(m),
				logError: (m) => lines.push(m),
			});
			expect(code).toBe(0);
			const out = lines.join("\n");
			// configPath home prefix redacted.
			expect(out).toContain("~/.codex/config.json");
			expect(out).not.toContain("/home/alice/.codex/config.json");
			// account id masked, not cleartext.
			expect(out).not.toContain("org-1234567890abcdef");
			// email masked.
			expect(out).not.toContain("alice@example.com");
			// proxy password must not appear anywhere in the bundle.
			expect(out).not.toContain("s3cr3t-pass");
		});
	});
});
