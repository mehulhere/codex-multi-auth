import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface PreparedResponsesWebSocketUpstream {
	url: string;
	headers: Record<string, string>;
	onOpen?: () => void;
	onConnectionFailure?: (error: unknown) => void;
	onAbnormalClose?: (code: number, reason: string) => void;
}

export interface ResponsesWebSocketBridgeMetrics {
	activeConnections: number;
	upgrades: number;
	fallbacks: number;
	abnormalCloses: number;
	peakBufferedBytes: number;
	lastError: string | null;
}

export interface ResponsesWebSocketBridgeOptions {
	prepareUpstream: (
		request: IncomingMessage,
	) => Promise<PreparedResponsesWebSocketUpstream | null>;
	maxConnections?: number;
	maxPayloadBytes?: number;
	maxBufferedBytes?: number;
	idleTimeoutMs?: number;
	onMetrics?: (metrics: ResponsesWebSocketBridgeMetrics) => void;
}

export interface ResponsesWebSocketBridge {
	handleUpgrade: (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => Promise<boolean>;
	close: () => Promise<void>;
	getMetrics: () => ResponsesWebSocketBridgeMetrics;
}

interface SocketPair {
	downstream: WebSocket;
	upstream: WebSocket;
	idleTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
	terminalEventSeen: boolean;
}

function rawDataBytes(data: RawData): number {
	if (Buffer.isBuffer(data)) return data.byteLength;
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (Array.isArray(data)) {
		return data.reduce((total, entry) => total + entry.byteLength, 0);
	}
	return 0;
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
	if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
		return;
	}
	if (code === 1005 || code === 1006 || code === 1015) {
		socket.terminate();
		return;
	}
	socket.close(code, reason.slice(0, 123));
}

function writeHttpFallback(socket: Duplex): void {
	if (socket.destroyed) return;
	socket.write(
		"HTTP/1.1 426 Upgrade Required\r\n" +
			"Connection: close\r\n" +
			"Content-Length: 0\r\n\r\n",
	);
	socket.end();
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/Bearer\s+\S+/gi, "Bearer ***MASKED***")
		.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "***MASKED***")
		.slice(0, 500);
}

export function createResponsesWebSocketBridge(
	options: ResponsesWebSocketBridgeOptions,
): ResponsesWebSocketBridge {
	const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
	const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const downstreamServer = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
		maxPayload: maxPayloadBytes,
	});
	const pairs = new Set<SocketPair>();
	const pendingUpstreams = new Set<WebSocket>();
	let closed = false;
	const metrics: ResponsesWebSocketBridgeMetrics = {
		activeConnections: 0,
		upgrades: 0,
		fallbacks: 0,
		abnormalCloses: 0,
		peakBufferedBytes: 0,
		lastError: null,
	};

	const snapshot = (): ResponsesWebSocketBridgeMetrics => ({ ...metrics });
	const notifyMetrics = (): void => options.onMetrics?.(snapshot());
	const fallback = (socket: Duplex, error?: unknown): false => {
		metrics.fallbacks += 1;
		if (error !== undefined) metrics.lastError = sanitizeError(error);
		notifyMetrics();
		writeHttpFallback(socket);
		return false;
	};

	const attachPair = (
		downstream: WebSocket,
		upstream: WebSocket,
		prepared: PreparedResponsesWebSocketUpstream,
	): void => {
		const pair: SocketPair = {
			downstream,
			upstream,
			idleTimer: null,
			closed: false,
			terminalEventSeen: false,
		};
		pairs.add(pair);
		metrics.activeConnections += 1;
		metrics.upgrades += 1;
		notifyMetrics();

		const finish = (code: number, reason: Buffer, source: WebSocket): void => {
			if (pair.closed) return;
			pair.closed = true;
			if (pair.idleTimer) clearTimeout(pair.idleTimer);
			pairs.delete(pair);
			metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
			if (code !== 1000 && code !== 1001 && !pair.terminalEventSeen) {
				metrics.abnormalCloses += 1;
				prepared.onAbnormalClose?.(code, reason.toString("utf8"));
			}
			const destination = source === downstream ? upstream : downstream;
			safeClose(destination, code, reason.toString("utf8"));
			notifyMetrics();
		};

		const closeForLimit = (): void => {
			safeClose(downstream, 1009, "bridge resource limit");
			finish(1009, Buffer.from("bridge resource limit"), downstream);
		};

		const touch = (): void => {
			if (pair.closed) return;
			if (pair.idleTimer) clearTimeout(pair.idleTimer);
			pair.idleTimer = setTimeout(() => {
				safeClose(downstream, 1001, "bridge idle timeout");
				safeClose(upstream, 1001, "bridge idle timeout");
			}, idleTimeoutMs);
			pair.idleTimer.unref?.();
		};

		const relay = (source: WebSocket, destination: WebSocket) =>
			(data: RawData, isBinary: boolean): void => {
				touch();
				const payloadBytes = rawDataBytes(data);
				if (source === upstream && !isBinary && payloadBytes <= 1024 * 1024) {
					const text = Buffer.isBuffer(data)
						? data.toString("utf8")
						: Buffer.from(data as ArrayBuffer).toString("utf8");
					if (
						/"type"\s*:\s*"response\.(completed|done|failed|incomplete)"/.test(
							text,
						)
					) {
						pair.terminalEventSeen = true;
					}
				}
				const bufferedBytes = destination.bufferedAmount + payloadBytes;
				metrics.peakBufferedBytes = Math.max(
					metrics.peakBufferedBytes,
					bufferedBytes,
				);
				if (bufferedBytes > maxBufferedBytes || destination.readyState !== WebSocket.OPEN) {
					closeForLimit();
					return;
				}
				destination.send(data, { binary: isBinary }, (error) => {
					if (!error) return;
					metrics.lastError = sanitizeError(error);
					safeClose(source, 1011, "bridge relay error");
					safeClose(destination, 1011, "bridge relay error");
				});
			};

		downstream.on("message", relay(downstream, upstream));
		upstream.on("message", relay(upstream, downstream));
		downstream.on("close", (code, reason) => finish(code, reason, downstream));
		upstream.on("close", (code, reason) => finish(code, reason, upstream));
		downstream.on("error", (error) => {
			metrics.lastError = sanitizeError(error);
		});
		upstream.on("error", (error) => {
			metrics.lastError = sanitizeError(error);
		});
		for (const socket of [downstream, upstream]) {
			socket.on("ping", touch);
			socket.on("pong", touch);
		}
		touch();
	};

	const handleUpgrade = async (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	): Promise<boolean> => {
		if (closed || pairs.size + pendingUpstreams.size >= maxConnections) {
			return fallback(socket, new Error("Responses WebSocket connection limit reached."));
		}
		let prepared: PreparedResponsesWebSocketUpstream | null;
		try {
			prepared = await options.prepareUpstream(request);
		} catch (error) {
			return fallback(socket, error);
		}
		if (!prepared) return fallback(socket);

		const upstream = new WebSocket(prepared.url, {
			headers: prepared.headers,
			perMessageDeflate: false,
			maxPayload: maxPayloadBytes,
		});
		pendingUpstreams.add(upstream);
		try {
			await new Promise<void>((resolve, reject) => {
				const cleanup = (): void => {
					upstream.off("open", onOpen);
					upstream.off("error", onError);
					upstream.off("unexpected-response", onUnexpectedResponse);
				};
				const onOpen = (): void => {
					cleanup();
					resolve();
				};
				const onError = (error: Error): void => {
					cleanup();
					reject(error);
				};
				const onUnexpectedResponse = (
					_request: IncomingMessage,
					response: IncomingMessage,
				): void => {
					response.resume();
					cleanup();
					reject(new Error(`Upstream WebSocket returned HTTP ${response.statusCode ?? 0}.`));
				};
				upstream.once("open", onOpen);
				upstream.once("error", onError);
				upstream.once("unexpected-response", onUnexpectedResponse);
			});
		} catch (error) {
			pendingUpstreams.delete(upstream);
			prepared.onConnectionFailure?.(error);
			upstream.on("error", () => undefined);
			upstream.terminate();
			return fallback(socket, error);
		}
		pendingUpstreams.delete(upstream);
		prepared.onOpen?.();
		if (closed || socket.destroyed) {
			upstream.close(1001, "bridge unavailable");
			return fallback(socket);
		}

		return await new Promise<boolean>((resolve) => {
			downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
				attachPair(downstream, upstream, prepared);
				resolve(true);
			});
		});
	};

	return {
		handleUpgrade,
		getMetrics: snapshot,
		close: async () => {
			if (closed) return;
			closed = true;
			for (const upstream of pendingUpstreams) upstream.terminate();
			pendingUpstreams.clear();
			for (const pair of pairs) {
				safeClose(pair.downstream, 1001, "bridge shutdown");
				safeClose(pair.upstream, 1001, "bridge shutdown");
			}
			const deadline = Date.now() + 250;
			while (pairs.size > 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			for (const pair of pairs) {
				pair.downstream.terminate();
				pair.upstream.terminate();
			}
			pairs.clear();
			metrics.activeConnections = 0;
			notifyMetrics();
			downstreamServer.close();
		},
	};
}
