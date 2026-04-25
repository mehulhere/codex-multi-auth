import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync,
}));

describe("bench codex-host resolver", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses lowercase codex command on non-windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		try {
			const mod = await import("../scripts/bench-format/codex-host.mjs");
			expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("uses lowercase codex fallback when Windows where has no path candidates", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		spawnSync.mockReturnValue({ stdout: "", stderr: "INFO: no match\n", status: 1 });
		try {
			const mod = await import("../scripts/bench-format/codex-host.mjs");
			expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("runs Codex through the current exec JSON interface", async () => {
		spawnSync.mockReturnValue({
			status: 0,
			signal: null,
			stdout: [
				JSON.stringify({
					type: "item.completed",
					item: {
						id: "item_0",
						type: "agent_message",
						text: "DONE",
					},
				}),
				JSON.stringify({
					type: "turn.completed",
					usage: {
						input_tokens: 100,
						cached_input_tokens: 25,
						output_tokens: 10,
						reasoning_output_tokens: 4,
					},
				}),
			].join("\n"),
			stderr: "",
		});
		const mod = await import("../scripts/bench-format/codex-host.mjs");

		const result = mod.runCodexJson({
			executable: { command: "node", shell: false, argsPrefix: ["C:/shim/codex.js"] },
			prompt: "Return DONE",
			model: "gpt-5.5",
			variant: "high",
			agent: "build",
			cwd: "C:/work",
			timeoutMs: 1234,
			extraEnv: { BENCH_TEST: "1" },
		});

		expect(spawnSync).toHaveBeenCalledWith(
			"node",
			[
				"C:/shim/codex.js",
				"exec",
				"--json",
				"--model",
				"gpt-5.5",
				"--skip-git-repo-check",
				"--sandbox",
				"danger-full-access",
				"-c",
				"approval_policy='never'",
				"-c",
				"model_reasoning_effort='high'",
				"Return DONE",
			],
			expect.objectContaining({
				cwd: "C:/work",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 1234,
			}),
		);
		expect(result.status).toBe(0);
		expect(result.eventError).toBeNull();
		expect(mod.getTextOutput(result.events)).toBe("DONE");
		expect(mod.getTokenTotals(result.events)).toMatchObject({
			total: 110,
			input: 100,
			output: 10,
			reasoning: 4,
			cacheRead: 25,
		});
	});

	it("parses current exec command events and ignores retry errors after a completed turn", async () => {
		const mod = await import("../scripts/bench-format/codex-host.mjs");
		const events = mod.parseNdjson(
			[
				JSON.stringify({ type: "error", message: "first model failed" }),
				JSON.stringify({ type: "turn.failed", error: { message: "first model failed" } }),
				JSON.stringify({
					type: "item.completed",
					item: {
						id: "item_0",
						type: "command_execution",
						command: "pwd",
						aggregated_output: "C:/work",
						exit_code: 0,
						status: "completed",
					},
				}),
				JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
			].join("\n"),
		);

		expect(mod.getEventError(events)).toBeNull();
		expect(mod.getToolEvents(events)).toEqual([
			expect.objectContaining({
				tool: "command_execution",
				input: { command: "pwd" },
				output: "C:/work",
				status: "completed",
			}),
		]);
	});

	it("reports final current exec errors", async () => {
		const mod = await import("../scripts/bench-format/codex-host.mjs");
		const events = mod.parseNdjson(
			[
				JSON.stringify({ type: "turn.started" }),
				JSON.stringify({ type: "error", message: "model unavailable" }),
				JSON.stringify({ type: "turn.failed", error: { message: "model unavailable" } }),
			].join("\n"),
		);

		expect(mod.getEventError(events)).toEqual({
			name: "turn.failed",
			message: "model unavailable",
		});
	});

	it("prefers plain Codex model aliases for ChatGPT-backed Codex CLI", async () => {
		const mod = await import("../scripts/bench-format/models.mjs");

		expect(mod.aliasCandidatesForCodexModel("openai/gpt-5.5")).toEqual([
			"gpt-5.5",
			"openai/gpt-5.5",
			"openai-multi/gpt-5.5",
		]);
	});
});
