import { describe, expect, it, vi } from "vitest";
import {
	ensureTailscaleRunning,
	type TailscaleCommandRunner,
} from "../lib/codex-manager/tailscale-check.js";

function result(stdout = "", stderr = "") {
	return { stdout, stderr };
}

const runningStatus = JSON.stringify({ BackendState: "Running" });
const stoppedStatus = JSON.stringify({ BackendState: "Stopped" });

describe("ensureTailscaleRunning", () => {
	it("accepts a running direct Tailscale CLI", async () => {
		const runCommand: TailscaleCommandRunner = vi.fn(async () =>
			result(runningStatus),
		);

		await expect(ensureTailscaleRunning({ runCommand, platform: "linux" })).resolves.toEqual({
			status: "running",
			detail: "Tailscale is running",
		});
		expect(runCommand).toHaveBeenCalledWith("tailscale", ["status", "--json"]);
	});

	it("falls back to the host CLI in a Linux sandbox", async () => {
		const runCommand: TailscaleCommandRunner = vi.fn(async (command) => {
			if (command === "tailscale") {
				throw Object.assign(new Error("not found"), { code: "ENOENT" });
			}
			return result(runningStatus);
		});

		await expect(ensureTailscaleRunning({ runCommand, platform: "linux" })).resolves.toMatchObject({
			status: "running",
		});
		expect(runCommand).toHaveBeenNthCalledWith(2, "flatpak-spawn", [
			"--host",
			"tailscale",
			"status",
			"--json",
		]);
	});

	it("turns on a stopped Tailscale backend and verifies it", async () => {
		const runCommand: TailscaleCommandRunner = vi
			.fn()
			.mockResolvedValueOnce(result(stoppedStatus))
			.mockResolvedValueOnce(result())
			.mockResolvedValueOnce(result(runningStatus));

		await expect(ensureTailscaleRunning({ runCommand, platform: "linux" })).resolves.toEqual({
			status: "started",
			detail: "Tailscale was turned on",
		});
		expect(runCommand).toHaveBeenNthCalledWith(2, "tailscale", ["up"]);
		expect(runCommand).toHaveBeenNthCalledWith(3, "tailscale", ["status", "--json"]);
	});

	it("returns a non-fatal unavailable result when no CLI can be found", async () => {
		const runCommand: TailscaleCommandRunner = vi.fn(async () => {
			throw Object.assign(new Error("not found"), { code: "ENOENT" });
		});

		await expect(ensureTailscaleRunning({ runCommand, platform: "linux" })).resolves.toEqual({
			status: "unavailable",
			detail: "Tailscale CLI is unavailable",
		});
	});
});
