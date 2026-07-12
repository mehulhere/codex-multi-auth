import type { TailscaleCheckResult } from "../tailscale-check.js";

export interface CheckCommandDeps {
	ensureTailscaleRunning: () => Promise<TailscaleCheckResult>;
	runHealthCheck: (options: { liveProbe: boolean }) => Promise<void>;
}

export async function runCheckCommand(deps: CheckCommandDeps): Promise<number> {
	const tailscale = await deps.ensureTailscaleRunning();
	if (tailscale.status === "running" || tailscale.status === "started") {
		console.log(`  ✓ ${tailscale.detail}`);
	} else {
		console.warn(`  ! ${tailscale.detail}; continuing account checks`);
	}
	await deps.runHealthCheck({ liveProbe: true });
	return 0;
}
