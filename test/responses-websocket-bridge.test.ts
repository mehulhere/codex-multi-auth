import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
	createResponsesWebSocketBridge,
	type ResponsesWebSocketBridge,
} from "../lib/runtime/responses-websocket-bridge.js";

interface Fixture {
	server: Server;
	bridge: ResponsesWebSocketBridge;
	url: string;
}

const fixtures: Fixture[] = [];
const upstreamServers: Array<{ server: Server; wss: WebSocketServer }> = [];

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	return (server.address() as AddressInfo).port;
}

async function startEchoUpstream(): Promise<string> {
	const server = createServer();
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	server.on("upgrade", (request, socket, head) => {
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit("connection", ws, request);
		});
	});
	wss.on("connection", (ws) => {
		ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
	});
	const port = await listen(server);
	upstreamServers.push({ server, wss });
	return `ws://127.0.0.1:${port}/responses`;
}

async function startBridge(
	upstreamUrl: string,
	overrides: Parameters<typeof createResponsesWebSocketBridge>[0] = {
		prepareUpstream: async () => ({ url: upstreamUrl, headers: {} }),
	},
): Promise<Fixture> {
	const bridge = createResponsesWebSocketBridge({
		prepareUpstream: async () => ({ url: upstreamUrl, headers: {} }),
		...overrides,
	});
	const server = createServer((_request, response) => {
		response.writeHead(426).end();
	});
	server.on("upgrade", (request, socket, head) => {
		void bridge.handleUpgrade(request, socket, head);
	});
	const port = await listen(server);
	const fixture = { server, bridge, url: `ws://127.0.0.1:${port}/responses` };
	fixtures.push(fixture);
	return fixture;
}

function openClient(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { perMessageDeflate: false });
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

function nextMessage(ws: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
	return new Promise((resolve) => {
		ws.once("message", (data, isBinary) => resolve({ data, isBinary }));
	});
}

function nextClose(ws: WebSocket): Promise<number> {
	return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map(async ({ bridge, server }) => {
			await bridge.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}),
	);
	await Promise.all(
		upstreamServers.splice(0).map(async ({ server, wss }) => {
			for (const client of wss.clients) client.terminate();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}),
	);
});

describe("Responses WebSocket bridge", () => {
	it("relays text and binary frames byte-for-byte with compression disabled", async () => {
		const upstreamUrl = await startEchoUpstream();
		const fixture = await startBridge(upstreamUrl);
		const client = await openClient(fixture.url);

		const textMessage = nextMessage(client);
		client.send("hello");
		expect((await textMessage).data.toString()).toBe("hello");

		const binaryMessage = nextMessage(client);
		client.send(Buffer.from([0, 1, 2, 255]), { binary: true });
		const binary = await binaryMessage;
		expect(binary.isBinary).toBe(true);
		expect(Buffer.from(binary.data)).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(client.extensions).toBe("");

		client.close(1000, "done");
		await nextClose(client);
		expect(fixture.bridge.getMetrics()).toMatchObject({
			activeConnections: 0,
			upgrades: 1,
			fallbacks: 0,
		});
	});

	it("returns HTTP 426 when upstream preparation or connection fails", async () => {
		const fixture = await startBridge("ws://127.0.0.1:1/responses");
		const status = await new Promise<number>((resolve) => {
			const client = new WebSocket(fixture.url);
			client.once("unexpected-response", (_request, response) => {
				resolve(response.statusCode ?? 0);
			});
			client.once("error", () => undefined);
		});

		expect(status).toBe(426);
		expect(fixture.bridge.getMetrics()).toMatchObject({
			activeConnections: 0,
			upgrades: 0,
			fallbacks: 1,
		});
	});

	it("enforces connection, payload, buffered-byte, and idle limits", async () => {
		const upstreamUrl = await startEchoUpstream();
		const fixture = await startBridge(upstreamUrl, {
			prepareUpstream: async () => ({ url: upstreamUrl, headers: {} }),
			maxConnections: 1,
			maxPayloadBytes: 8,
			maxBufferedBytes: 4,
			idleTimeoutMs: 50,
		});
		const first = await openClient(fixture.url);
		const secondStatus = await new Promise<number>((resolve) => {
			const second = new WebSocket(fixture.url);
			second.once("unexpected-response", (_request, response) => {
				resolve(response.statusCode ?? 0);
			});
			second.once("error", () => undefined);
		});
		expect(secondStatus).toBe(426);

		const close = nextClose(first);
		first.send("12345");
		expect(await close).toBe(1009);
		expect(fixture.bridge.getMetrics().activeConnections).toBe(0);
	});

	it("closes idle connections and every active socket during shutdown", async () => {
		const upstreamUrl = await startEchoUpstream();
		const idleFixture = await startBridge(upstreamUrl, {
			prepareUpstream: async () => ({ url: upstreamUrl, headers: {} }),
			idleTimeoutMs: 25,
		});
		const idleClient = await openClient(idleFixture.url);
		expect(await nextClose(idleClient)).toBe(1001);

		const activeFixture = await startBridge(upstreamUrl);
		const activeClient = await openClient(activeFixture.url);
		const close = nextClose(activeClient);
		await activeFixture.bridge.close();
		expect(await close).toBe(1001);
		expect(activeFixture.bridge.getMetrics().activeConnections).toBe(0);
	});

	it("does not cool a completed response when the client exits without a close handshake", async () => {
		const upstreamUrl = await startEchoUpstream();
		const fixture = await startBridge(upstreamUrl);
		const client = await openClient(fixture.url);
		const terminal = nextMessage(client);
		const upstream = [...(upstreamServers.at(-1)?.wss.clients ?? [])][0];
		if (!upstream) throw new Error("expected upstream WebSocket client");
		upstream.send('{"type":"response.completed"}');
		expect((await terminal).data.toString()).toContain("response.completed");
		const close = nextClose(client);
		upstream.terminate();
		expect(await close).toBe(1006);
		expect(fixture.bridge.getMetrics().abnormalCloses).toBe(0);
	});
});
