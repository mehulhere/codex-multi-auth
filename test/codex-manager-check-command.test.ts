import { describe, expect, it, vi } from "vitest";
import {
	type CheckCommandDeps,
	runCheckCommand,
} from "../lib/codex-manager/commands/check.js";

describe("runCheckCommand", () => {
	it("checks Tailscale before running health check with live probing enabled", async () => {
		const callOrder: string[] = [];
		const deps: CheckCommandDeps = {
			ensureTailscaleRunning: vi.fn(async () => {
				callOrder.push("tailscale");
				return { status: "running", detail: "Tailscale is running" };
			}),
			runHealthCheck: vi.fn(async () => {
				callOrder.push("accounts");
			}),
		};

		const result = await runCheckCommand(deps);

		expect(result).toBe(0);
		expect(deps.ensureTailscaleRunning).toHaveBeenCalledTimes(1);
		expect(deps.runHealthCheck).toHaveBeenCalledTimes(1);
		expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true });
		expect(callOrder).toEqual(["tailscale", "accounts"]);
	});

	it("continues account checks when Tailscale recovery fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const deps: CheckCommandDeps = {
			ensureTailscaleRunning: vi.fn(async () => ({
				status: "failed",
				detail: "could not turn on Tailscale",
			})),
			runHealthCheck: vi.fn(async () => undefined),
		};

		await expect(runCheckCommand(deps)).resolves.toBe(0);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("could not turn on Tailscale"),
		);
		expect(deps.runHealthCheck).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("propagates rejection from runHealthCheck", async () => {
		const error = new Error("probe failed");
		const deps: CheckCommandDeps = {
			ensureTailscaleRunning: vi.fn(async () => ({
				status: "running",
				detail: "Tailscale is running",
			})),
			runHealthCheck: vi.fn(async () => {
				throw error;
			}),
		};

		await expect(runCheckCommand(deps)).rejects.toThrow("probe failed");
		expect(deps.runHealthCheck).toHaveBeenCalledTimes(1);
		expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true });
	});
});
