import { describe, expect, it } from "vitest";
import {
	evaluateWebSocketMemoryReport,
	isDirectExecution,
} from "../scripts/benchmark-responses-websocket-memory.mjs";

describe("Responses WebSocket memory benchmark", () => {
	it("accepts the relaxed idle, active, and cleanup memory targets", () => {
		expect(
			evaluateWebSocketMemoryReport({
				idleConnectionRetainedBytes: 2 * 1024 * 1024,
				activeTextTransientBytes: 10 * 1024 * 1024,
				retainedAfterCyclesBytes: 10 * 1024 * 1024,
			}),
		).toMatchObject({ passed: true, failures: [] });
	});

	it("fails when any retained-memory target is exceeded", () => {
		const result = evaluateWebSocketMemoryReport({
			idleConnectionRetainedBytes: 2 * 1024 * 1024 + 1,
			activeTextTransientBytes: 10 * 1024 * 1024 + 1,
			retainedAfterCyclesBytes: 10 * 1024 * 1024 + 1,
		});
		expect(result.passed).toBe(false);
		expect(result.failures).toEqual([
			"idle_connection_retained",
			"active_text_transient",
			"cycle_cleanup_retained",
		]);
	});

	it("does not auto-run when imported", () => {
		expect(
			isDirectExecution(new URL("file:///tmp/benchmark.mjs"), ["node", "vitest"]),
		).toBe(false);
	});
});
