import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface TailscaleCommandResult {
	stdout: string;
	stderr: string;
}

export type TailscaleCommandRunner = (
	command: string,
	args: string[],
) => Promise<TailscaleCommandResult>;

export interface TailscaleCheckResult {
	status: "running" | "started" | "unavailable" | "failed";
	detail: string;
}

interface TailscaleCheckOptions {
	runCommand?: TailscaleCommandRunner;
	platform?: NodeJS.Platform;
}

interface TailscaleCommand {
	command: string;
	prefixArgs: string[];
}

const execFileAsync = promisify(execFile);

const defaultRunCommand: TailscaleCommandRunner = async (command, args) => {
	const { stdout, stderr } = await execFileAsync(command, args, {
		encoding: "utf8",
	});
	return { stdout, stderr };
};

function isCommandUnavailable(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function isRunningStatus(stdout: string): boolean {
	try {
		const parsed = JSON.parse(stdout) as { BackendState?: unknown };
		return parsed.BackendState === "Running";
	} catch {
		return false;
	}
}

function commandArgs(target: TailscaleCommand, args: string[]): string[] {
	return [...target.prefixArgs, "tailscale", ...args];
}

async function runTailscaleCommand(
	runCommand: TailscaleCommandRunner,
	target: TailscaleCommand,
	args: string[],
): Promise<TailscaleCommandResult> {
	if (target.command === "tailscale") {
		return runCommand(target.command, args);
	}
	return runCommand(target.command, commandArgs(target, args));
}

export async function ensureTailscaleRunning(
	options: TailscaleCheckOptions = {},
): Promise<TailscaleCheckResult> {
	const runCommand = options.runCommand ?? defaultRunCommand;
	const platform = options.platform ?? process.platform;
	const targets: TailscaleCommand[] = [
		{ command: "tailscale", prefixArgs: [] },
	];
	if (platform === "linux") {
		targets.push({ command: "flatpak-spawn", prefixArgs: ["--host"] });
	}

	for (const target of targets) {
		try {
			const status = await runTailscaleCommand(runCommand, target, [
				"status",
				"--json",
			]);
			if (isRunningStatus(status.stdout)) {
				return { status: "running", detail: "Tailscale is running" };
			}
		} catch (error) {
			if (isCommandUnavailable(error)) continue;
		}

		try {
			await runTailscaleCommand(runCommand, target, ["up"]);
			const status = await runTailscaleCommand(runCommand, target, [
				"status",
				"--json",
			]);
			if (isRunningStatus(status.stdout)) {
				return { status: "started", detail: "Tailscale was turned on" };
			}
			return {
				status: "failed",
				detail: "Tailscale did not report a running connection after recovery",
			};
		} catch (error) {
			if (isCommandUnavailable(error)) continue;
			return {
				status: "failed",
				detail: "could not turn on Tailscale",
			};
		}
	}

	return {
		status: "unavailable",
		detail: "Tailscale CLI is unavailable",
	};
}
