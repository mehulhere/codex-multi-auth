/**
 * Pins the wiring between the OAuth callback server and the failure guidance
 * (issue #630). `describeCallbackFailure` and `startLocalOAuthServer` are each
 * covered on their own; this asserts the seam in `runOAuthFlow` that picks the
 * failure reason and forwards the bind error, which is what actually makes the
 * Windows/WSL conflict legible to the user.
 *
 * Under vitest neither stdin nor stdout is a TTY, so the manual-paste prompt
 * short-circuits to `cancelled` in browser mode and the flow returns without
 * blocking on input.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hooks } = vi.hoisted(() => ({
	hooks: {
		serverInfo: null as unknown,
		guidanceLines: [] as string[],
	},
}));

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		createAuthorizationFlow: vi.fn(async () => ({
			pkce: { challenge: "challenge", verifier: "verifier" },
			state: "test-state",
			url: "https://auth.openai.com/oauth/authorize?state=test-state",
		})),
	};
});

vi.mock("../lib/auth/server.js", () => ({
	startLocalOAuthServer: vi.fn(async () => hooks.serverInfo),
}));

vi.mock("../lib/auth/browser.js", () => ({
	openBrowserUrl: vi.fn(() => true),
	copyTextToClipboard: vi.fn(() => true),
	isBrowserLaunchSuppressed: vi.fn(() => false),
	getBrowserOpener: vi.fn(() => "xdg-open"),
}));

vi.mock("../lib/auth/callback-guidance.js", () => ({
	describeCallbackFailure: vi.fn(() => hooks.guidanceLines),
}));

const { describeCallbackFailure } = await import(
	"../lib/auth/callback-guidance.js"
);
const { runOAuthFlow } = await import("../lib/codex-manager/login-oauth.js");

const mockedGuidance = vi.mocked(describeCallbackFailure);

/** A callback server that bound cleanly but never received a redirect. */
function serverThatTimesOut() {
	return {
		port: 1455,
		ready: true,
		close: vi.fn(),
		waitForCode: vi.fn(async () => null),
	};
}

/** A callback server that could not take the port at all. */
function serverThatFailedToBind(bindErrorCode?: string) {
	return {
		port: 1455,
		ready: false,
		bindErrorCode,
		close: vi.fn(),
		waitForCode: vi.fn(async () => null),
	};
}

describe("runOAuthFlow callback-failure guidance", () => {
	let logged: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		logged = [];
		hooks.guidanceLines = ["GUIDANCE LINE ONE", "", "GUIDANCE LINE TWO"];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
	});

	it("reports bind-failed with the bind error when the port could not be taken", async () => {
		hooks.serverInfo = serverThatFailedToBind("EADDRINUSE");

		await runOAuthFlow(false, "browser");

		expect(mockedGuidance).toHaveBeenCalledWith("bind-failed", {
			bindErrorCode: "EADDRINUSE",
		});
	});

	it("reports callback-timeout when the server bound but no redirect arrived", async () => {
		// The Windows/WSL hijack: a clean bind, and nothing ever comes back.
		hooks.serverInfo = serverThatTimesOut();

		await runOAuthFlow(false, "browser");

		expect(mockedGuidance).toHaveBeenCalledWith("callback-timeout", {
			bindErrorCode: undefined,
		});
	});

	it("prints every guidance line, preserving blank separators", async () => {
		hooks.serverInfo = serverThatTimesOut();

		await runOAuthFlow(false, "browser");

		expect(logged).toEqual(
			expect.arrayContaining([
				expect.stringContaining("GUIDANCE LINE ONE"),
				expect.stringContaining("GUIDANCE LINE TWO"),
			]),
		);
		// Blank separators are emitted unstyled rather than dropped.
		expect(logged).toContain("");
	});

	// Manual mode is not exercised here: it sets `allowNonTty`, so the prompt
	// blocks reading stdin rather than short-circuiting, and faking that stream
	// would test the harness more than the code. The guidance is gated on
	// `signInMode === "browser"` in one place, and the three cases above pin the
	// branch that actually selects the reason.
});
