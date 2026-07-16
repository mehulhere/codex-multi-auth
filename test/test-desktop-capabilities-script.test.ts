import { describe, expect, it, vi } from "vitest";

describe("desktop capability smoke script", () => {
	it("parses deterministic, live, interactive, JSON, and required options", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");

		expect(
			mod.parseDesktopCapabilityArgs([
				"--live",
				"--interactive",
				"--json",
				"--require=models",
				"--require=image-generation",
				"--timeout-ms=45000",
			]),
		).toEqual({
			live: true,
			interactive: true,
			json: true,
			requiredIds: ["models", "image-generation"],
			timeoutMs: 45_000,
		});
	});

	it("rejects unknown arguments and invalid timeouts", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");

		expect(() => mod.parseDesktopCapabilityArgs(["--unknown"])).toThrow(
			"Unknown desktop capability option: --unknown",
		);
		expect(() => mod.parseDesktopCapabilityArgs(["--timeout-ms=0"])).toThrow(
			"--timeout-ms must be a positive integer",
		);
	});

	it("renders one concise human row per result", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		const output = mod.renderDesktopCapabilityReport({
			generatedAt: "2026-07-16T00:00:00.000Z",
			mode: "live",
			results: [
				{
					id: "models",
					label: "Model discovery",
					status: "passed",
					layers: ["discovery", "contract", "live"],
					durationMs: 12,
					code: "http_200",
				},
			],
			summary: {
				total: 1,
				passed: 1,
				failed: 0,
				notAvailable: 0,
				interactiveRequired: 0,
				skipped: 0,
				requiredFailures: 0,
			},
		});

		expect(output).toContain("PASS  models");
		expect(output).toContain("1 passed, 0 failed");
	});

	it("runs with injected orchestration and sets failure exit code", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		const write = vi.fn();
		const runSmoke = vi.fn(async () => [
			{
				id: "models",
				label: "Model discovery",
				status: "failed",
				layers: ["discovery"],
				durationMs: 1,
				code: "router_unavailable",
			},
		]);
		const summarize = vi.fn(() => ({
			total: 1,
			passed: 0,
			failed: 1,
			notAvailable: 0,
			interactiveRequired: 0,
			skipped: 0,
			requiredFailures: 1,
		}));

		const code = await mod.runDesktopCapabilitiesCli(["--json", "--require=models"], {
			runSmoke,
			summarize,
			createProbeDeps: () => ({ runProbe: vi.fn() }),
			write,
			now: () => new Date("2026-07-16T00:00:00.000Z"),
		});

		expect(code).toBe(1);
		expect(runSmoke).toHaveBeenCalledWith(
			expect.objectContaining({ live: false, interactive: false }),
			expect.anything(),
		);
		expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
			mode: "deterministic",
			summary: { requiredFailures: 1 },
		});
	});

	it("does not auto-run when imported by tests", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		expect(mod.resolveCompiledSmokeModulePath()).toMatch(
			/dist[/\\]lib[/\\]runtime[/\\]desktop-capability-smoke\.js$/,
		);
		expect(mod.isDirectExecution(new URL("file:///tmp/test-runner.js"), ["node", "vitest"])).toBe(
			false,
		);
	});

	it("uses authenticated loopback probes without exposing the client secret", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/models?client_version=0.144.4")) {
				return new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.endsWith("/responses")) {
				expect(init?.method).toBe("POST");
				return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		const readFileImpl = vi.fn(async (path: string) => {
			if (path.endsWith("config.toml")) {
				return 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:3210/v1/test-secret"\n';
			}
			if (path.endsWith("features.json")) {
				return JSON.stringify({ enabled: ["composer-dictation"] });
			}
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const execFileImpl = vi.fn(async (command: string, args: string[]) => {
			if (command === "codex" && args.join(" ") === "features list") {
				return {
					stdout: "image_generation stable true\ncomputer_use stable true\nin_app_browser stable true\nplugins stable true\n",
				};
			}
			if (command === "codex" && args[0] === "--version") {
				return { stdout: "codex-cli 0.144.4\n" };
			}
			throw new Error(`unexpected command ${command} ${args.join(" ")}`);
		});
		const deps = mod.createSystemProbeDeps({
			fetchImpl,
			readFileImpl,
			execFileImpl,
			home: "/tmp/home",
			desktopRepo: "/tmp/desktop",
		});
		const models = { id: "models", featureNames: [], requiresInteraction: false };
		const responses = { id: "responses", featureNames: [], requiresInteraction: false };

		expect(await deps.runProbe(models, "live", new AbortController().signal)).toEqual({
			status: "passed",
			code: "http_200",
		});
		expect(await deps.runProbe(responses, "live", new AbortController().signal)).toEqual({
			status: "passed",
			code: "response_completed",
		});
		expect(fetchImpl.mock.calls.flat().join(" ")).toContain("test-secret");
	});

	it("loads enabled Desktop features into manifest completeness checks", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		const write = vi.fn();
		const runSmoke = vi.fn(async () => []);
		await mod.runDesktopCapabilitiesCli([], {
			runSmoke,
			summarize: () => ({
				total: 0,
				passed: 0,
				failed: 0,
				notAvailable: 0,
				interactiveRequired: 0,
				skipped: 0,
				requiredFailures: 0,
			}),
			createProbeDeps: () => ({
				runProbe: vi.fn(),
				getEnabledFeatures: async () => ["composer-dictation", "future-feature"],
			}),
			write,
		});

		expect(runSmoke).toHaveBeenCalledWith(
			expect.objectContaining({
				enabledFeatures: ["composer-dictation", "future-feature"],
			}),
			expect.anything(),
		);
	});

	it("classifies live function-tool success and hosted-tool route failures", async () => {
		const mod = await import("../scripts/test-desktop-capabilities.js");
		const readFileImpl = vi.fn(async (path: string) => {
			if (path.endsWith("config.toml")) {
				return 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:3210/v1/test-secret"\n';
			}
			if (path.endsWith("features.json")) return JSON.stringify({ enabled: [] });
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		const execFileImpl = vi.fn(async (command: string, args: string[]) => {
			if (command === "codex" && args.join(" ") === "features list") {
				return { stdout: "plugins stable true\n" };
			}
			if (command === "codex" && args[0] === "--version") {
				return { stdout: "codex-cli 0.144.4\n" };
			}
			if (command === "codex" && args.includes("--search")) {
				return {
					stdout: '{"type":"item.started","item":{"type":"web_search"}}\n',
					stderr: "runtime_rotation_proxy_not_found",
				};
			}
			if (command === "codex" && args.includes("exec")) {
				return {
					stdout: '{"type":"item.completed","item":{"type":"command_execution","status":"completed"}}\n',
					stderr: "",
				};
			}
			throw new Error(`unexpected command ${command}`);
		});
		const deps = mod.createSystemProbeDeps({
			readFileImpl,
			execFileImpl,
			fetchImpl: async (url: string) =>
				new Response(JSON.stringify({ models: [{ slug: "gpt-test" }] }), {
					status: url.includes("/models") ? 200 : 404,
				}),
			home: "/tmp/home",
			desktopRepo: "/tmp/desktop",
		});
		const signal = new AbortController().signal;

		expect(
			await deps.runProbe(
				{ id: "function-tools", featureNames: [], requiresInteraction: false },
				"live",
				signal,
			),
		).toEqual({ status: "passed", code: "function_tool_completed" });
		expect(
			await deps.runProbe(
				{ id: "hosted-web-search", featureNames: [], requiresInteraction: false },
				"live",
				signal,
			),
		).toEqual({
			status: "failed",
			code: "unsupported_route",
			hint: "The hosted web-search flow reached a router endpoint that is not supported.",
		});
	});
});
