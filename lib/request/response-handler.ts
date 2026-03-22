import { createLogger, logRequest, LOGGING_ENABLED } from "../logger.js";
import { PLUGIN_NAME } from "../constants.js";

import type { SSEEventData } from "../types.js";

const log = createLogger("response-handler");

const MAX_SSE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 45_000;

function extractResponseId(response: unknown): string | null {
	if (!response || typeof response !== "object") return null;
	const candidate = (response as { id?: unknown }).id;
	return typeof candidate === "string" && candidate.trim().length > 0
		? candidate.trim()
		: null;
}

function notifyResponseId(
	onResponseId: ((responseId: string) => void) | undefined,
	response: unknown,
): void {
	const responseId = extractResponseId(response);
	if (!responseId || !onResponseId) return;
	try {
		onResponseId(responseId);
	} catch (error) {
		log.warn("Failed to persist response id from upstream event", {
			error: String(error),
			responseId,
		});
	}
}

function maybeCaptureResponseEvent(
	data: SSEEventData,
	onResponseId?: (responseId: string) => void,
): unknown | null {
	if (data.type === "error") {
		log.error("SSE error event received", { error: data });
		return null;
	}

	if (data.type === "response.done" || data.type === "response.completed") {
		notifyResponseId(onResponseId, data.response);
		return data.response ?? null;
	}

	return null;
}

/**

 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(
	sseText: string,
	onResponseId?: (responseId: string) => void,
): unknown | null {
	const lines = sseText.split(/\r?\n/);

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine.startsWith('data: ')) {
			const payload = trimmedLine.substring(6).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				const data = JSON.parse(payload) as SSEEventData;
				const finalResponse = maybeCaptureResponseEvent(data, onResponseId);
				if (finalResponse) return finalResponse;
			} catch {
				// Skip malformed JSON
			}
		}
	}

	return null;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export async function convertSseToJson(
	response: Response,
	headers: Headers,
	options?: {
		onResponseId?: (responseId: string) => void;
		streamStallTimeoutMs?: number;
	},
): Promise<Response> {
	if (!response.body) {
		throw new Error(`[${PLUGIN_NAME}] Response has no body`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';
	const streamStallTimeoutMs = Math.max(
		1_000,
		Math.floor(options?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS),
	);

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await readWithTimeout(reader, streamStallTimeoutMs);
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
			if (fullText.length > MAX_SSE_SIZE) {
				throw new Error(`SSE response exceeds ${MAX_SSE_SIZE} bytes limit`);
			}
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response
		const finalResponse = parseSseStream(fullText, options?.onResponseId);

		if (!finalResponse) {
			log.warn("Could not find final response in SSE stream");

			logRequest("stream-error", { error: "No response.done event found" });

			// Return original stream if we can't parse
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers: headers,
			});
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		log.error("Error converting stream", { error: String(error) });
		logRequest("stream-error", { error: String(error) });
		if (typeof reader.cancel === "function") {
			await reader.cancel(String(error)).catch(() => {});
		}
		throw error;
	} finally {
		// Release the reader lock to prevent resource leaks
		reader.releaseLock();
	}

}

function createResponseIdCapturingStream(
	body: ReadableStream<Uint8Array>,
	onResponseId: (responseId: string) => void,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let bufferedText = "";

	const processBufferedLines = (flush = false): void => {
		const lines = bufferedText.split(/\r?\n/);
		if (!flush) {
			bufferedText = lines.pop() ?? "";
		} else {
			bufferedText = "";
		}

		for (const rawLine of lines) {
			const trimmedLine = rawLine.trim();
			if (!trimmedLine.startsWith("data: ")) continue;
			const payload = trimmedLine.slice(6).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				const data = JSON.parse(payload) as SSEEventData;
				maybeCaptureResponseEvent(data, onResponseId);
			} catch {
				// Ignore malformed SSE lines and keep forwarding the raw stream.
			}
		}
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bufferedText += decoder.decode(chunk, { stream: true });
				processBufferedLines();
				controller.enqueue(chunk);
			},
			flush() {
				bufferedText += decoder.decode();
				processBufferedLines(true);
			},
		}),
	);
}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(
						new Error(
							`SSE stream stalled for ${timeoutMs}ms while waiting for response.done`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Check if a non-streaming response is empty or malformed.
 * Returns true if the response body is empty, null, or lacks meaningful content.
 * @param body - Parsed JSON body from the response
 * @returns True if response should be considered empty/malformed
 */
export function isEmptyResponse(body: unknown): boolean {
	if (body === null || body === undefined) return true;
	if (typeof body === 'string' && body.trim() === '') return true;
	if (typeof body !== 'object') return false;

	const obj = body as Record<string, unknown>;

	if (Object.keys(obj).length === 0) return true;

	const hasOutput = 'output' in obj && obj.output !== null && obj.output !== undefined;
	const hasChoices = 'choices' in obj && Array.isArray(obj.choices) && 
		obj.choices.some(c => c !== null && c !== undefined && typeof c === 'object' && Object.keys(c as object).length > 0);
	const hasContent = 'content' in obj && obj.content !== null && obj.content !== undefined &&
		(typeof obj.content !== 'string' || obj.content.trim() !== '');

	if ('id' in obj || 'object' in obj || 'model' in obj) {
		return !hasOutput && !hasChoices && !hasContent;
	}

	return false;
}

export function attachResponseIdCapture(
	response: Response,
	headers: Headers,
	onResponseId?: (responseId: string) => void,
): Response {
	if (!response.body || !onResponseId) {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	return new Response(createResponseIdCapturingStream(response.body, onResponseId), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
