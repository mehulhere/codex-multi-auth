import { describe, expect, it, vi } from "vitest";
import {
	DESKTOP_CAPABILITY_MANIFEST,
	runDesktopCapabilitySmoke,
	sanitizeCapabilityValue,
	summarizeDesktopCapabilityResults,
	type DesktopCapabilityProbeDeps,
} from "../lib/runtime/desktop-capability-smoke.js";

const EXPECTED_IDS = [
	"responses",
	"models",
	"function-tools",
	"hosted-web-search",
	"image-generation",
	"computer-use",
	"in-app-browser",
	"plugins",
	"bundled-skills",
	"dictation",
	"read-aloud",
	"conversation-bridge",
	"thread-goals",
	"shared-history",
];

function passingDeps(): DesktopCapabilityProbeDeps {
	return {
		runProbe: vi.fn(async () => ({ status: "passed" as const })),
	};
}

describe("desktop capability smoke matrix", () => {
	it("defines every expected Desktop capability exactly once", () => {
		expect(DESKTOP_CAPABILITY_MANIFEST.map((entry) => entry.id)).toEqual(EXPECTED_IDS);
		expect(new Set(EXPECTED_IDS).size).toBe(EXPECTED_IDS.length);
	});

	it("runs deterministic layers without claiming live or interactive success", async () => {
		const deps = passingDeps();
		const results = await runDesktopCapabilitySmoke(
			{ live: false, interactive: false },
			deps,
		);

		expect(results).toHaveLength(EXPECTED_IDS.length);
		expect(results.find((entry) => entry.id === "responses")).toMatchObject({
			status: "passed",
			layers: ["discovery", "contract"],
		});
		expect(results.find((entry) => entry.id === "dictation")).toMatchObject({
			status: "interactive_required",
			layers: ["discovery", "contract"],
		});
		expect(deps.runProbe).not.toHaveBeenCalledWith(
			expect.anything(),
			"live",
			expect.anything(),
		);
	});

	it("runs live layers while preserving the physical interaction boundary", async () => {
		const deps = passingDeps();
		const results = await runDesktopCapabilitySmoke(
			{ live: true, interactive: false },
			deps,
		);

		expect(results.find((entry) => entry.id === "models")).toMatchObject({
			status: "passed",
			layers: ["discovery", "contract", "live"],
		});
		expect(results.find((entry) => entry.id === "dictation")).toMatchObject({
			status: "interactive_required",
			layers: ["discovery", "contract", "live"],
		});
	});

	it("reports an unknown enabled feature as a required failure", async () => {
		const results = await runDesktopCapabilitySmoke(
			{
				live: false,
				interactive: false,
				enabledFeatures: ["composer-dictation", "future-teleporter"],
			},
			passingDeps(),
		);

		expect(results).toContainEqual(
			expect.objectContaining({
				id: "feature:future-teleporter",
				status: "failed",
				code: "unknown_enabled_feature",
			}),
		);
	});

	it("keeps the first failed layer and summarizes required failures", async () => {
		const deps: DesktopCapabilityProbeDeps = {
			runProbe: vi.fn(async (capability, layer) =>
				capability.id === "hosted-web-search" && layer === "live"
					? {
							status: "failed" as const,
							code: "unsupported_route",
							hint: "Router rejected Bearer secret@example.com",
						}
					: { status: "passed" as const },
			),
		};
		const results = await runDesktopCapabilitySmoke(
			{
				live: true,
				interactive: false,
				requiredIds: ["hosted-web-search"],
			},
			deps,
		);

		expect(results.find((entry) => entry.id === "hosted-web-search")).toMatchObject({
			status: "failed",
			code: "unsupported_route",
			hint: "Router rejected ***MASKED***",
		});
		expect(summarizeDesktopCapabilityResults(results, ["hosted-web-search"])).toMatchObject({
			requiredFailures: 1,
			failed: 1,
		});
	});

	it("classifies probe timeouts without leaking the thrown message", async () => {
		vi.useFakeTimers();
		try {
			const deps: DesktopCapabilityProbeDeps = {
				runProbe: vi.fn(async (capability) =>
					capability.id === "responses"
						? new Promise(() => {
								// Intentionally unresolved.
							})
						: { status: "passed" as const },
				),
			};
			const pending = runDesktopCapabilitySmoke(
				{ live: false, interactive: false, timeoutMs: 10 },
				deps,
			);
			await vi.advanceTimersByTimeAsync(20);
			const results = await pending;

			expect(results[0]).toMatchObject({
				status: "failed",
				code: "probe_timeout",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("recursively redacts credentials, emails, prompts, and binary output", () => {
		const secret = "a".repeat(64);
		expect(
			sanitizeCapabilityValue({
				authorization: "Bearer token-value",
				email: "person@example.com",
				clientSecret: secret,
				prompt: "private prompt",
				imageBytes: Buffer.from("image"),
				nested: ["safe", secret],
			}),
		).toEqual({
			authorization: "***MASKED***",
			email: "***@***.com",
			clientSecret: "***MASKED***",
			prompt: "***REDACTED***",
			imageBytes: "[binary redacted]",
			nested: ["safe", "***MASKED***"],
		});
	});
});
