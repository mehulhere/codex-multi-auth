# Hybrid Responses WebSocket Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-sticky Responses WebSocket forwarding with bounded resources and automatic fallback to the existing HTTP rotation path.

**Architecture:** Register an authenticated HTTP upgrade handler and delegate socket pairing to `lib/runtime/responses-websocket-bridge.ts`. Reuse the proxy's account policy, token refresh, and header construction before accepting the downstream upgrade; if any setup step fails, return `426` so Codex immediately uses HTTP.

**Tech Stack:** TypeScript ESM, Node.js HTTP server, `ws` 8.x, Vitest, existing account/quota/affinity helpers.

## Global Constraints

- Preserve native `openai`, loopback-only binding, exact secret-path auth, and HTTP fallback.
- One WebSocket uses one account for its entire lifetime.
- Never rotate or replay after downstream `101` or partial output.
- Maximum 32 active connections, 64 MiB message, and 16 MiB buffered bytes per direction.
- Disable per-message compression in the router.
- Default idle timeout 300 seconds and abnormal-close cooldown 60 seconds.
- Target retained memory below 2 MiB per idle connection and cleanup within 10 MiB of baseline after 100 cycles; image payloads are reported separately.

---

### Task 1: Configuration, Types, And Dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/schemas.ts`
- Modify: `lib/config.ts`
- Modify: `lib/runtime/rotation-server-types.ts`
- Modify: `test/config.test.ts`
- Modify: `test/schemas.test.ts`
- Modify: `test/rotation-proxy-state.test.ts`

**Interfaces:**
- Produces: `getCodexRuntimeResponsesWebSockets(config): "auto" | "off"` and WebSocket status fields.

- [ ] **Step 1: Write failing config/type tests**

Assert default `auto`, config `off`, environment precedence, invalid-value fallback,
and zeroed status:

```ts
expect(getCodexRuntimeResponsesWebSockets({} as PluginConfig)).toBe("auto");
expect(getCodexRuntimeResponsesWebSockets({ codexRuntimeResponsesWebSockets: "off" } as PluginConfig)).toBe("off");
expect(state.status.activeWebSockets).toBe(0);
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/config.test.ts test/schemas.test.ts test/rotation-proxy-state.test.ts
```

- [ ] **Step 3: Add pinned dependency and minimal config**

```bash
npm install --save-exact ws@8.21.1
npm install --save-dev --save-exact @types/ws
```

Add the schema field, accessor, environment override, and status counters:

```ts
activeWebSockets: number;
webSocketUpgrades: number;
webSocketFallbacks: number;
webSocketAbnormalCloses: number;
webSocketPeakBufferedBytes: number;
webSocketLastError: string | null;
```

- [ ] **Step 4: Verify GREEN and dependency security**

```bash
npx vitest run test/config.test.ts test/schemas.test.ts test/rotation-proxy-state.test.ts
npm audit --omit=dev --audit-level=high
npm run typecheck
```

### Task 2: Bounded WebSocket Relay

**Files:**
- Create: `lib/runtime/responses-websocket-bridge.ts`
- Create: `test/responses-websocket-bridge.test.ts`

**Interfaces:**
- Produces: `createResponsesWebSocketBridge(options)` with `handleUpgrade`, `close`, and `getMetrics`.
- Consumes: an injected `prepareUpstream(request)` that either returns URL/headers/session identity or requests HTTP fallback.

- [ ] **Step 1: Write failing relay tests**

Use real loopback `ws` servers to prove text/binary relay, multiple messages,
normal/abnormal close, ping/pong, 64 MiB payload rejection, 16 MiB buffered-byte
cap, 32-connection cap, idle cleanup, and shutdown cleanup. Assert frame payloads
are byte-for-byte unchanged.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/responses-websocket-bridge.test.ts
```

- [ ] **Step 3: Implement minimal bounded relay**

Use two `WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload })`
boundaries, accept downstream only after upstream `open`, check
`bufferedAmount + payloadBytes <= maxBufferedBytes` before each send, and close
both sides on limit/error/shutdown. Track sockets and timers explicitly.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/responses-websocket-bridge.test.ts
npx eslint lib/runtime/responses-websocket-bridge.ts test/responses-websocket-bridge.test.ts --max-warnings=0
npm run typecheck
```

### Task 3: Account Selection, Authentication, And HTTP Fallback Integration

**Files:**
- Modify: `lib/runtime-rotation-proxy.ts`
- Modify: `lib/runtime/rotation-proxy-state.ts`
- Modify: `lib/runtime/responses-websocket-bridge.ts`
- Modify: `test/runtime-rotation-proxy.test.ts`
- Modify: `test/responses-websocket-bridge.test.ts`

**Interfaces:**
- Produces: authenticated `server.on("upgrade")` handling for secret-path Responses.
- Reuses: current quota policy, affinity, forced pin, token refresh, account ID, and outbound header helpers.

- [ ] **Step 1: Write failing proxy integration tests**

Cover wrong secret, non-loopback defense, disabled mode, selected refreshed account
headers, native/local secret stripping, account stickiness, pre-upgrade upstream
401/429/network `426`, post-upgrade abnormal-close cooldown, HTTP still working,
and no rotation after partial frames.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/runtime-rotation-proxy.test.ts test/responses-websocket-bridge.test.ts
```

- [ ] **Step 3: Extract shared account preparation and integrate upgrade handling**

Create one internal preparation path returning:

```ts
interface PreparedRuntimeAccount {
    account: ManagedAccount;
    accountId: string;
    accessToken: string;
    outboundHeaders: Headers;
    sessionKey: string | null;
}
```

Run it before upstream connection. Preserve HTTP behavior and mutex semantics.
On any bridge setup failure, write a minimal `426` response and no body. After
`101`, close rather than replay and set the bounded session cooldown.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run test/runtime-rotation-proxy.test.ts test/runtime-rotation-proxy-safe-equal.test.ts test/responses-websocket-bridge.test.ts test/app-bind.test.ts
npm run typecheck
npm run lint
```

### Task 4: Observability, Memory Benchmark, Documentation, And Live Rollout

**Files:**
- Create: `scripts/benchmark-responses-websocket-memory.mjs`
- Create: `test/benchmark-responses-websocket-memory.test.ts`
- Modify: `scripts/codex-app-router.js`
- Modify: `lib/runtime/runtime-observability.ts`
- Modify: `docs/development/TESTING.md`
- Modify: `docs/development/CONFIG_FIELDS.md`
- Modify: `docs/development/ARCHITECTURE.md`
- Modify: `package.json`

**Interfaces:**
- Produces: redacted status metrics and `npm run bench:websocket-memory`.

- [ ] **Step 1: Write failing observability and benchmark tests**

Assert status sanitization, no identity/token/frame content, zero active sockets
after close, required idle/active/large/100-cycle JSON fields, and nonzero exit
when retained heap exceeds the relaxed cleanup allowance.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run test/benchmark-responses-websocket-memory.test.ts test/app-bind.test.ts
```

- [ ] **Step 3: Implement metrics, benchmark, and docs**

Add active/upgrades/fallbacks/closes/bytes/peak/last-error metrics, redact them
through app-router status, and run the benchmark under `node --expose-gc`. Document
`auto|off`, environment override, bounds, fallback, and operator commands.

- [ ] **Step 4: Run complete verification and install**

```bash
npx vitest run test/desktop-capability-smoke.test.ts test/test-desktop-capabilities-script.test.ts test/responses-websocket-bridge.test.ts test/runtime-rotation-proxy.test.ts test/app-bind.test.ts test/config.test.ts test/schemas.test.ts
npm run bench:websocket-memory -- --json
npm run typecheck
npm run typecheck:scripts
npm run lint
npm run build
npm test
npm install -g .
codex-multi-auth rotation reset-runtime
npm run test:desktop-capabilities -- --live --json
```

Record the known unrelated full-suite failures separately; no new failure may
appear in changed or focused suites.

- [ ] **Step 5: Commit and push the WebSocket implementation**

```bash
git add package.json package-lock.json lib scripts test docs/development
git commit -m "feat: add hybrid responses websocket routing"
git push personal feature/quota-aware-thread-routing
```
