#!/usr/bin/env node

import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const IDLE_LIMIT_BYTES = 2 * 1024 * 1024;
const ACTIVE_TEXT_LIMIT_BYTES = 10 * 1024 * 1024;
const CLEANUP_LIMIT_BYTES = 10 * 1024 * 1024;

export function evaluateWebSocketMemoryReport(report) {
	const failures = [];
	if (report.idleConnectionRetainedBytes > IDLE_LIMIT_BYTES) {
		failures.push("idle_connection_retained");
	}
	if (report.activeTextTransientBytes > ACTIVE_TEXT_LIMIT_BYTES) {
		failures.push("active_text_transient");
	}
	if (report.retainedAfterCyclesBytes > CLEANUP_LIMIT_BYTES) {
		failures.push("cycle_cleanup_retained");
	}
	return { passed: failures.length === 0, failures };
}

export function isDirectExecution(metaUrl, argv) {
	if (!argv[1]) return false;
	return fileURLToPath(metaUrl) === resolve(argv[1]);
}

function forceGc() {
	globalThis.gc?.();
	globalThis.gc?.();
}

function heapUsed() {
	forceGc();
	return process.memoryUsage().heapUsed;
}

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return server.address().port;
}

function openClient(url) {
	return new Promise((resolve, reject) => {
		const client = new WebSocket(url, { perMessageDeflate: false });
		client.once("open", () => resolve(client));
		client.once("error", reject);
	});
}

function nextMessage(client) {
	return new Promise((resolve) => client.once("message", resolve));
}

function closeClient(client) {
	if (client.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolve) => {
		client.once("close", resolve);
		client.close(1000, "benchmark");
	});
}

async function closeServer(server) {
	if (!server.listening) return;
	await new Promise((resolve) => server.close(resolve));
}

export async function runWebSocketMemoryBenchmark() {
	if (typeof globalThis.gc !== "function") {
		throw new Error("Run with node --expose-gc so retained memory can be measured.");
	}
	const runtime = await import(
		pathToFileURL(
			join(repoRoot, "dist", "lib", "runtime", "responses-websocket-bridge.js"),
		)
	);
	const upstreamServer = createServer();
	const upstreamWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	upstreamServer.on("upgrade", (request, socket, head) => {
		upstreamWss.handleUpgrade(request, socket, head, (ws) =>
			upstreamWss.emit("connection", ws, request),
		);
	});
	upstreamWss.on("connection", (ws) => {
		ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
	});
	const upstreamPort = await listen(upstreamServer);
	const bridge = runtime.createResponsesWebSocketBridge({
		prepareUpstream: async () => ({
			url: `ws://127.0.0.1:${upstreamPort}/responses`,
			headers: {},
		}),
	});
	const bridgeServer = createServer();
	bridgeServer.on("upgrade", (request, socket, head) => {
		void bridge.handleUpgrade(request, socket, head);
	});
	const bridgePort = await listen(bridgeServer);
	const bridgeUrl = `ws://127.0.0.1:${bridgePort}/responses`;
	const baselineBytes = heapUsed();

	const idleClient = await openClient(bridgeUrl);
	const idleConnectionRetainedBytes = Math.max(0, heapUsed() - baselineBytes);
	await closeClient(idleClient);

	const activeClient = await openClient(bridgeUrl);
	const activeBefore = heapUsed();
	const textPayload = "x".repeat(1024 * 1024);
	const activeMessage = nextMessage(activeClient);
	activeClient.send(textPayload);
	await activeMessage;
	const activeTextTransientBytes = Math.max(0, process.memoryUsage().heapUsed - activeBefore);
	await closeClient(activeClient);

	const imageClient = await openClient(bridgeUrl);
	const imageBefore = heapUsed();
	const imagePayload = Buffer.alloc(8 * 1024 * 1024, 7);
	const imageMessage = nextMessage(imageClient);
	imageClient.send(imagePayload, { binary: true });
	await imageMessage;
	const imagePayloadTransientBytes = Math.max(0, process.memoryUsage().heapUsed - imageBefore);
	await closeClient(imageClient);

	const cycleCount = 100;
	for (let index = 0; index < cycleCount; index += 1) {
		const client = await openClient(bridgeUrl);
		await closeClient(client);
	}
	await bridge.close();
	for (const client of upstreamWss.clients) client.terminate();
	upstreamWss.close();
	await closeServer(bridgeServer);
	await closeServer(upstreamServer);
	const retainedAfterCyclesBytes = Math.max(0, heapUsed() - baselineBytes);
	const measurements = {
		baselineBytes,
		idleConnectionRetainedBytes,
		activeTextTransientBytes,
		imagePayloadTransientBytes,
		cycleCount,
		retainedAfterCyclesBytes,
		limits: {
			idleConnectionRetainedBytes: IDLE_LIMIT_BYTES,
			activeTextTransientBytes: ACTIVE_TEXT_LIMIT_BYTES,
			retainedAfterCyclesBytes: CLEANUP_LIMIT_BYTES,
		},
		bridgeMetrics: bridge.getMetrics(),
	};
	return { ...measurements, ...evaluateWebSocketMemoryReport(measurements) };
}

if (isDirectExecution(import.meta.url, process.argv)) {
	runWebSocketMemoryBenchmark()
		.then((report) => {
			process.stdout.write(`${JSON.stringify(report)}\n`);
			process.exitCode = report.passed ? 0 : 1;
		})
		.catch((error) => {
			process.stderr.write(
				`Responses WebSocket memory benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
