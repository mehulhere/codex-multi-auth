#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const DEFAULT_TIMEOUT_MS = 60_000;

function parsePositiveInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

export function parseDesktopCapabilityArgs(argv) {
	const options = {
		live: false,
		interactive: false,
		json: false,
		requiredIds: [],
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	for (const arg of argv) {
		if (arg === "--live") {
			options.live = true;
			continue;
		}
		if (arg === "--interactive") {
			options.interactive = true;
			options.live = true;
			continue;
		}
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg.startsWith("--require=")) {
			const id = arg.slice("--require=".length).trim();
			if (!id) throw new Error("--require needs a capability id");
			options.requiredIds.push(id);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			options.timeoutMs = parsePositiveInteger(
				arg.slice("--timeout-ms=".length),
				"--timeout-ms",
			);
			continue;
		}
		throw new Error(`Unknown desktop capability option: ${arg}`);
	}
	return options;
}

const STATUS_LABELS = {
	passed: "PASS ",
	failed: "FAIL ",
	not_available: "N/A  ",
	interactive_required: "USER ",
	skipped: "SKIP ",
};

export function renderDesktopCapabilityReport(report) {
	const lines = [
		`Desktop capability smoke · ${report.mode} · ${report.generatedAt}`,
		"",
	];
	for (const result of report.results) {
		const status = STATUS_LABELS[result.status] ?? "???? ";
		const suffix = result.code ? ` · ${result.code}` : "";
		lines.push(`${status} ${result.id} · ${result.durationMs}ms${suffix}`);
		if (result.hint) lines.push(`      ${result.hint}`);
	}
	lines.push(
		"",
		`${report.summary.passed} passed, ${report.summary.failed} failed, ` +
			`${report.summary.interactiveRequired} interactive, ${report.summary.notAvailable} unavailable`,
	);
	return `${lines.join("\n")}\n`;
}

function parseFeatureList(output) {
	return new Map(
		output
			.split(/\r?\n/)
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length >= 3)
			.map((parts) => [parts[0], parts.at(-1) === "true"]),
	);
}

function resolveDesktopRepo() {
	return (
		process.env.CODEX_DESKTOP_REPO?.trim() ||
		join(homedir(), ".gemini", "antigravity", "scratch", "codex-desktop-linux")
	);
}

async function readOptional(path, readFileImpl = readFile) {
	try {
		return await readFileImpl(path, "utf8");
	} catch {
		return null;
	}
}

function parseLoopbackBaseUrl(config) {
	const match = /^openai_base_url\s*=\s*["']([^"']+)["']/m.exec(config ?? "");
	if (!match) return null;
	try {
		const url = new URL(match[1]);
		if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
			return null;
		}
		return url.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}

function parseCodexVersion(output) {
	return /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/.exec(output)?.[1] ?? "unknown";
}

function parseEnabledDesktopFeatures(value) {
	try {
		const parsed = JSON.parse(value ?? "");
		return Array.isArray(parsed?.enabled)
			? parsed.enabled.filter((entry) => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

async function readResponseText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

function spawnCodexExec(args, signal) {
	return new Promise((resolve) => {
		const child = spawn("codex", args, {
			cwd: tmpdir(),
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});
		let stdout = "";
		let stderr = "";
		const maxBytes = 4 * 1024 * 1024;
		const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-maxBytes);
		child.stdout.on("data", (chunk) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", (error) => {
			stderr = `${stderr}\n${error.message}`;
		});
		child.once("close", (exitCode) => {
			resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
		});
		child.stdin.end();
	});
}

export function createSystemProbeDeps(overrides = {}) {
	const execFileImpl = overrides.execFileImpl ?? ((command, args, options) => execFileAsync(command, args, options));
	const readFileImpl = overrides.readFileImpl ?? readFile;
	const fetchImpl = overrides.fetchImpl ?? fetch;
	const home = overrides.home ?? homedir();
	const desktopRepo = overrides.desktopRepo ?? resolveDesktopRepo();
	const runCodexExecImpl =
		overrides.runCodexExecImpl ??
		(overrides.execFileImpl
			? (args, signal) =>
				execFileImpl("codex", args, {
					cwd: tmpdir(),
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
					signal,
				})
			: spawnCodexExec);
	let featureListPromise;
	let configPromise;
	let desktopFeaturesPromise;
	let codexVersionPromise;
	let routerModelsPromise;
	let pluginListPromise;
	let mcpListPromise;
	const loadFeatureList = () =>
		(featureListPromise ??= execFileImpl("codex", ["features", "list"], {
			encoding: "utf8",
		}).then(({ stdout }) => parseFeatureList(stdout)));
	const loadConfig = () =>
		(configPromise ??= readOptional(join(home, ".codex", "config.toml"), readFileImpl));
	const loadDesktopFeatures = () =>
		(desktopFeaturesPromise ??= readOptional(
			join(desktopRepo, "linux-features", "features.json"),
			readFileImpl,
		));
	const loadCodexVersion = () =>
		(codexVersionPromise ??= execFileImpl("codex", ["--version"], {
			encoding: "utf8",
		}).then(({ stdout }) => parseCodexVersion(stdout)));
	const loadRouterModels = async (baseUrl, signal) => {
		routerModelsPromise ??= (async () => {
			const clientVersion = await loadCodexVersion();
			const response = await fetchImpl(
				`${baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`,
				{ signal },
			);
			const payload = response.ok ? await response.json().catch(() => null) : null;
			const entries = Array.isArray(payload?.models)
				? payload.models
				: Array.isArray(payload?.data)
					? payload.data
					: [];
			return { response, entries };
		})();
		return routerModelsPromise;
	};
	const loadPluginList = () =>
		(pluginListPromise ??= execFileImpl("codex", ["plugin", "list"], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		}).then(({ stdout }) => stdout));
	const loadMcpList = () =>
		(mcpListPromise ??= execFileImpl("codex", ["mcp", "list"], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		}).then(({ stdout }) => stdout));
	const runCodexExec = async (args, signal) => {
		try {
			return await runCodexExecImpl(args, signal);
		} catch (error) {
			return {
				stdout: typeof error?.stdout === "string" ? error.stdout : "",
				stderr: typeof error?.stderr === "string" ? error.stderr : "",
				exitCode: typeof error?.code === "number" ? error.code : 1,
			};
		}
	};
	const readEventTypes = (stdout) =>
		stdout
			.split(/\r?\n/)
			.flatMap((line) => {
				try {
					const event = JSON.parse(line);
					return [{ type: event.type, itemType: event.item?.type, status: event.item?.status }];
				} catch {
					return [];
				}
			});
	const runFunctionToolProbe = async (model, signal) => {
		const result = await runCodexExec(
			[
				"exec",
				"--ephemeral",
				"--json",
				"--skip-git-repo-check",
				"--ignore-rules",
				"-s",
				"read-only",
				"-m",
				model,
				"Run the shell command printf capability-ok, then reply with only OK.",
			],
			signal,
		);
		const events = readEventTypes(result.stdout);
		return events.some(
			(event) =>
				event.type === "item.completed" &&
				event.itemType === "command_execution" &&
				event.status === "completed",
		)
			? { status: "passed", code: "function_tool_completed" }
			: { status: "failed", code: "function_tool_missing" };
	};
	const runHostedWebSearchProbe = async (model, signal) => {
		const result = await runCodexExec(
			[
				"--search",
				"exec",
				"--ephemeral",
				"--json",
				"--skip-git-repo-check",
				"--ignore-rules",
				"-s",
				"read-only",
				"-m",
				model,
				"Use web search once to read the title of https://openai.com, then reply with only OK.",
			],
			signal,
		);
		if (/runtime_rotation_proxy_not_found/.test(result.stderr)) {
			return {
				status: "failed",
				code: "unsupported_route",
				hint: "The hosted web-search flow reached a router endpoint that is not supported.",
			};
		}
		const events = readEventTypes(result.stdout);
		return events.some((event) => event.itemType === "web_search")
			? { status: "passed", code: "web_search_started" }
			: { status: "failed", code: "web_search_missing" };
	};
	const runImageGenerationProbe = async (baseUrl, signal) => {
		const authText = await readOptional(join(home, ".codex", "auth.json"), readFileImpl);
		let auth;
		try {
			auth = JSON.parse(authText ?? "");
		} catch {
			return { status: "not_available", code: "native_auth_missing" };
		}
		const accessToken = auth?.tokens?.access_token;
		const accountId = auth?.tokens?.account_id;
		if (typeof accessToken !== "string" || typeof accountId !== "string") {
			return { status: "not_available", code: "native_auth_missing" };
		}
		const response = await fetchImpl(`${baseUrl}/images/generations`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"chatgpt-account-id": accountId,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "gpt-image-1",
				prompt: "A single solid blue square.",
				size: "1024x1024",
				n: 1,
			}),
			signal,
		});
		const bytes = Buffer.from(await response.arrayBuffer());
		let payload;
		try {
			payload = JSON.parse(bytes.toString("utf8"));
		} catch {
			payload = null;
		}
		if (!response.ok) return { status: "failed", code: `http_${response.status}` };
		return Array.isArray(payload?.data) && payload.data.length > 0
			? { status: "passed", code: "image_generated" }
			: { status: "failed", code: "invalid_image_payload" };
	};
	const runThreadGoalProbe = async (baseUrl, signal) => {
		const threadId = `capability-smoke-${randomUUID()}`;
		const setResponse = await fetchImpl(`${baseUrl}/thread/goal/set`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadId, goal: "capability smoke" }),
			signal,
		});
		if (!setResponse.ok) {
			return setResponse.status === 404
				? {
						status: "failed",
						code: "unsupported_route",
						hint: "The live thread-goal endpoint is not exposed by the current upstream.",
					}
				: { status: "failed", code: `set_http_${setResponse.status}` };
		}
		const getResponse = await fetchImpl(
			`${baseUrl}/thread/goal/get?thread_id=${encodeURIComponent(threadId)}`,
			{ signal },
		);
		if (!getResponse.ok) return { status: "failed", code: `get_http_${getResponse.status}` };
		const payload = await getResponse.json().catch(() => null);
		return payload?.goal === "capability smoke"
			? { status: "passed", code: "goal_round_trip" }
			: { status: "failed", code: "goal_mismatch" };
	};
	const runLiveProbe = async (capability, signal) => {
		const config = await loadConfig();
		const baseUrl = parseLoopbackBaseUrl(config);
		if (!baseUrl) {
			return {
				status: "failed",
				code: "native_router_config_missing",
				hint: "Expected a loopback openai_base_url before live probing.",
			};
		}
		if (capability.id === "models") {
			const { response, entries } = await loadRouterModels(baseUrl, signal);
			if (!response.ok) {
				return { status: "failed", code: `http_${response.status}` };
			}
			return entries.length > 0
				? { status: "passed", code: "http_200" }
				: { status: "failed", code: "invalid_models_payload" };
		}
		if (["responses", "function-tools", "hosted-web-search"].includes(capability.id)) {
			const { entries } = await loadRouterModels(baseUrl, signal);
			const model = entries
				.map((entry) => entry?.slug ?? entry?.id)
				.find((entry) => typeof entry === "string" && entry.length > 0);
			if (!model) return { status: "failed", code: "no_live_model" };
			if (capability.id === "function-tools") {
				return runFunctionToolProbe(model, signal);
			}
			if (capability.id === "hosted-web-search") {
				return runHostedWebSearchProbe(model, signal);
			}
			const response = await fetchImpl(`${baseUrl}/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model,
					instructions: "Return the single word OK.",
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "Capability smoke check." }],
						},
					],
					stream: true,
					store: false,
				}),
				signal,
			});
			const text = await readResponseText(response);
			if (!response.ok) return { status: "failed", code: `http_${response.status}` };
			return /response\.(completed|done)/.test(text)
				? { status: "passed", code: "response_completed" }
				: { status: "failed", code: "missing_terminal_event" };
		}
		if (capability.id === "image-generation") {
			return runImageGenerationProbe(baseUrl, signal);
		}
		if (capability.id === "thread-goals") {
			return runThreadGoalProbe(baseUrl, signal);
		}
		if (capability.id === "shared-history") {
			const { stdout } = await execFileImpl("codex-multi-auth", ["history", "list", "--json"], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				signal,
			});
			const payload = JSON.parse(stdout);
			return Array.isArray(payload?.sessions)
				? { status: "passed", code: "history_readable" }
				: { status: "failed", code: "invalid_history_payload" };
		}
		const [features, desktopFeatureText] = await Promise.all([
			loadFeatureList(),
			loadDesktopFeatures(),
		]);
		const desktopFeatures = new Set(parseEnabledDesktopFeatures(desktopFeatureText));
		if (capability.id === "computer-use") {
			return features.get("computer_use") === true
				? { status: "passed", code: "computer_use_ready" }
				: { status: "not_available", code: "feature_disabled" };
		}
		if (capability.id === "dictation") {
			return desktopFeatures.has("composer-dictation")
				? { status: "passed", code: "dictation_bridge_ready" }
				: { status: "not_available", code: "feature_disabled" };
		}
		if (capability.id === "conversation-bridge") {
			return desktopFeatures.has("conversation-mode") && desktopFeatures.has("farfield-bridge")
				? { status: "passed", code: "conversation_bridge_ready" }
				: { status: "not_available", code: "feature_disabled" };
		}
		if (["plugins", "bundled-skills", "in-app-browser", "read-aloud"].includes(capability.id)) {
			const [plugins, mcp] = await Promise.all([loadPluginList(), loadMcpList()]);
			if (capability.id === "plugins") {
				return /installed, enabled/.test(plugins)
					? { status: "passed", code: "plugin_registry_ready" }
					: { status: "not_available", code: "no_enabled_plugins" };
			}
			if (capability.id === "bundled-skills") {
				return /@openai-bundled\s+installed, enabled/.test(plugins)
					? { status: "passed", code: "bundled_skills_ready" }
					: { status: "not_available", code: "bundled_skills_missing" };
			}
			if (capability.id === "in-app-browser") {
				return /browser@openai-bundled\s+installed, enabled/.test(plugins) && /node_repl[\s\S]*enabled/.test(mcp)
					? { status: "passed", code: "browser_bridge_ready" }
					: { status: "not_available", code: "browser_bridge_missing" };
			}
			return /read-aloud@openai-bundled\s+installed, enabled/.test(plugins) && /read-aloud[\s\S]*enabled/.test(mcp)
				? { status: "passed", code: "read_aloud_ready" }
				: { status: "not_available", code: "read_aloud_missing" };
		}
		return {
			status: "not_available",
			code: "live_probe_not_implemented",
			hint: "This capability currently has deterministic readiness evidence only.",
		};
	};

	return {
		async getEnabledFeatures() {
			return parseEnabledDesktopFeatures(await loadDesktopFeatures());
		},
		async runProbe(capability, layer, signal) {
			if (layer === "interactive") {
				return { status: "passed" };
			}
			if (layer === "live") {
				return runLiveProbe(capability, signal);
			}
			const [features, config, desktopFeatures] = await Promise.all([
				loadFeatureList(),
				loadConfig(),
				loadDesktopFeatures(),
			]);
			if (!config) {
				return {
					status: "not_available",
					code: "codex_config_missing",
					hint: "Codex config.toml is not readable.",
				};
			}
			if (
				!/^model_provider\s*=\s*["']openai["']/m.test(config) ||
				!/^openai_base_url\s*=\s*["']http:\/\/(127\.0\.0\.1|localhost|\[::1\])/m.test(
					config,
				)
			) {
				return {
					status: "failed",
					code: "native_router_config_missing",
					hint: "Expected native openai provider with a loopback openai_base_url.",
				};
			}
			if (
				capability.id === "image-generation" &&
				features.get("image_generation") !== true
			) {
				return { status: "not_available", code: "feature_disabled" };
			}
			if (capability.id === "computer-use" && features.get("computer_use") !== true) {
				return { status: "not_available", code: "feature_disabled" };
			}
			if (capability.id === "in-app-browser" && features.get("in_app_browser") !== true) {
				return { status: "not_available", code: "feature_disabled" };
			}
			if (capability.id === "plugins" && features.get("plugins") !== true) {
				return { status: "not_available", code: "feature_disabled" };
			}
			if (capability.featureNames.length > 0 && !desktopFeatures) {
				return {
					status: "not_available",
					code: "desktop_feature_profile_missing",
				};
			}
			return { status: "passed" };
		},
	};
}

export function resolveCompiledSmokeModulePath() {
	return join(repoRoot, "dist", "lib", "runtime", "desktop-capability-smoke.js");
}

export async function runDesktopCapabilitiesCli(argv, injected = {}) {
	const options = parseDesktopCapabilityArgs(argv);
	const runtime = injected.runtime ??
		(injected.runSmoke && injected.summarize
			? null
			: await import(pathToFileURL(resolveCompiledSmokeModulePath())));
	const runSmoke = injected.runSmoke ?? runtime.runDesktopCapabilitySmoke;
	const summarize = injected.summarize ?? runtime.summarizeDesktopCapabilityResults;
	const createProbeDeps = injected.createProbeDeps ?? createSystemProbeDeps;
	const write = injected.write ?? ((value) => process.stdout.write(value));
	const now = injected.now ?? (() => new Date());
	const probeDeps = createProbeDeps();
	const enabledFeatures = await probeDeps.getEnabledFeatures?.();
	const results = await runSmoke(
		{
			live: options.live,
			interactive: options.interactive,
			requiredIds: options.requiredIds,
			timeoutMs: options.timeoutMs,
			enabledFeatures,
		},
		probeDeps,
	);
	const summary = summarize(results, options.requiredIds);
	const report = {
		generatedAt: now().toISOString(),
		mode: options.interactive ? "interactive" : options.live ? "live" : "deterministic",
		results,
		summary,
	};
	write(options.json ? `${JSON.stringify(report)}\n` : renderDesktopCapabilityReport(report));
	return summary.requiredFailures > 0 ? 1 : 0;
}

export function isDirectExecution(metaUrl, argv) {
	if (!argv[1]) return false;
	return fileURLToPath(metaUrl) === resolve(argv[1]);
}

if (isDirectExecution(import.meta.url, process.argv)) {
	runDesktopCapabilitiesCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`Desktop capability smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
