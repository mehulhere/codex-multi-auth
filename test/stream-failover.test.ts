import { afterEach, describe, expect, it, vi } from "vitest";
import { withStreamingFailover } from "../lib/request/stream-failover.js";

const encoder = new TextEncoder();

function makeStallingResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: first\n\n"));
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

function makeIdleResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start() {
				// Intentionally idle until timeout.
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

function makeSseResponse(payload: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(payload));
				controller.close();
			},
		}),
		{
			headers: {
				"content-type": "text/event-stream",
			},
		},
	);
}

describe("stream failover", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns original response when max failovers disabled", async () => {
		const response = withStreamingFailover(
			makeSseResponse("data: ok\n\n"),
			async () => makeSseResponse("data: fallback\n\n"),
			{ maxFailovers: 0, stallTimeoutMs: 10 },
		);

		await expect(response.text()).resolves.toContain("data: ok");
	});

	it("switches to fallback stream when primary stalls", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn(async () => makeSseResponse("data: second\n\n"));
		const response = withStreamingFailover(makeIdleResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const textPromise = response.text();
		await vi.advanceTimersByTimeAsync(1_200);
		const text = await textPromise;
		expect(text).toContain("codex-multi-auth failover 1");
		expect(text).toContain("data: second");
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it("includes request id marker when provided", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => makeSseResponse("data: fallback\n\n"),
			{
				maxFailovers: 1,
				stallTimeoutMs: 10,
				requestInstanceId: "req-123",
			},
		);

		const textPromise = response.text();
		await vi.advanceTimersByTimeAsync(1_200);
		const text = await textPromise;
		expect(text).toContain("codex-multi-auth failover 1 req:req-123");
	});

	it("errors when fallback is unavailable", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
	});

	it("propagates fallback provider exceptions deterministically", async () => {
		vi.useFakeTimers();
		const response = withStreamingFailover(
			makeIdleResponse(),
			async () => {
				throw new Error("fallback exploded");
			},
			{ maxFailovers: 1, stallTimeoutMs: 10 },
		);

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("fallback exploded");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;
	});

	it("does not trigger fallback when read-error and timeout race after bytes emitted", async () => {
		vi.useFakeTimers();
		const raceResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("data: first\n\n"));
					setTimeout(() => {
						controller.error(new Error("primary read failure"));
					}, 20);
				},
			}),
			{
				headers: {
					"content-type": "text/event-stream",
				},
			},
		);
		const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
		const response = withStreamingFailover(raceResponse, fallback, {
			maxFailovers: 1,
			softTimeoutMs: 10,
			hardTimeoutMs: 20,
		});

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("primary read failure");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;

		expect(fallback).not.toHaveBeenCalled();
	});

	it("does not replay after bytes have already been emitted", async () => {
		vi.useFakeTimers();
		const fallback = vi.fn(async () => makeSseResponse("data: fallback\n\n"));
		const response = withStreamingFailover(makeStallingResponse(), fallback, {
			maxFailovers: 1,
			stallTimeoutMs: 10,
		});

		const textPromise = response.text();
		const assertion = expect(textPromise).rejects.toThrow("SSE stream stalled");
		await vi.advanceTimersByTimeAsync(1_200);
		await assertion;

		expect(fallback).not.toHaveBeenCalled();
	});

	it("releases underlying reader when wrapped stream is cancelled", async () => {
		let sourceCancelled = 0;
		const response = withStreamingFailover(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data: first\n\n"));
					},
					cancel() {
						sourceCancelled += 1;
					},
				}),
				{
					headers: {
						"content-type": "text/event-stream",
					},
				},
			),
			async () => null,
			{ maxFailovers: 1, stallTimeoutMs: 10_000 },
		);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		await reader?.cancel();

		expect(sourceCancelled).toBeGreaterThan(0);
	});

	it("does not emit an unhandled rejection if releasing the upstream reader throws", async () => {
		// Regression for the `pump().catch((err) => controller.error(err))`
		// safety net at lib/request/stream-failover.ts:230. If the inner
		// cleanup (`releaseCurrentReader()`, `controller.error()`) itself
		// throws — e.g. the upstream reader's releaseLock fails because the
		// stream is in an unusual state — the outer .catch must still
		// forward the error to the consumer rather than leaking an unhandled
		// promise rejection.
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const upstream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("primary boom"));
				},
			});
			// Patch getReader so the returned reader.releaseLock throws when
			// pump's catch path calls it during cleanup. This is the same
			// kind of secondary failure the outer .catch is meant to absorb.
			const realGetReader = upstream.getReader.bind(upstream);
			(upstream as unknown as {
				getReader: () => ReadableStreamDefaultReader<Uint8Array>;
			}).getReader = () => {
				const reader = realGetReader();
				const realReleaseLock = reader.releaseLock.bind(reader);
				reader.releaseLock = () => {
					realReleaseLock();
					throw new Error("releaseLock blew up");
				};
				return reader;
			};

			const response = withStreamingFailover(
				new Response(upstream, {
					headers: { "content-type": "text/event-stream" },
				}),
				async () => null,
				{ maxFailovers: 0 },
			);

			// Consumer should observe an error rather than hanging.
			await expect(response.text()).rejects.toThrow();

			// Yield once so the .catch microtask drains.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
