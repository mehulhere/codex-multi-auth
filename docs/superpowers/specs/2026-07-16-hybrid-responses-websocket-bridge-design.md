# Hybrid Responses WebSocket Bridge

## Problem

Codex's native `openai` provider attempts Responses-over-WebSocket, while the
multi-account router currently implements Responses over HTTP streaming. The
router correctly returns `426 Upgrade Required`, so Codex falls back without a
retry loop, but it cannot use connection prewarming or reuse. A WebSocket bridge
must preserve quota-aware account selection, thread affinity, native tools,
credential isolation, bounded memory, and the proven HTTP recovery path.

## Goals

- Support authenticated native-provider Responses WebSocket upgrades without
  modifying Codex or changing the native `openai` provider identity.
- Select one managed ChatGPT account before opening the upstream socket.
- Keep that account sticky for the lifetime of the connection.
- Relay Responses WebSocket messages bidirectionally without inspecting or
  rewriting tool payloads.
- Fall back immediately to the existing HTTP router when a safe upstream socket
  cannot be established.
- Bound payloads, queued bytes, connection count, and idle lifetime.
- Expose redacted WebSocket observability and a repeatable memory benchmark.
- Keep the existing `426` behavior as the permanent safety path.

## Non-goals

- Rotate accounts after partial WebSocket response events have reached Codex.
- Hide, bypass, or aggregate OpenAI plan restrictions.
- Proxy non-Responses endpoints over WebSocket.
- Patch Codex's provider capability logic.
- Guarantee a fixed RSS delta across Node, allocator, TLS, and operating-system
  versions.

## Considered Approaches

### 1. Continue HTTP-only fallback

This is the simplest and most reliable option, but it gives up native prewarming
and connection reuse. It remains the fallback, not the selected primary path.

### 2. WebSocket-only router

Require every request to use a long-lived socket. This makes account recovery
and protocol upgrades a single point of failure. Rejected.

### 3. WebSocket-first with automatic HTTP fallback (selected)

Attempt an account-sticky upstream WebSocket before accepting the downstream
upgrade. If selection, refresh, authentication, quota readiness, TLS, or the
upstream handshake fails, return `426` and let the mature HTTP path handle the
turn. This adds latency benefits without weakening recovery.

## Connection Flow

1. Accept only loopback upgrade requests.
2. Authenticate the exact `/v1/<client-secret>/responses` path using the same
   constant-time secret check as HTTP.
3. Derive the session/thread key from current Codex headers. Treat the request
   as the Codex model family.
4. Use existing availability, quota, quarantine, forced-pin, and affinity rules
   to choose one account.
5. Refresh that account's access token before any upstream handshake.
6. Open `wss://chatgpt.com/backend-api/codex/responses` with managed account
   authorization, account ID, Codex originator, and incoming supported beta and
   metadata headers. Never forward cookies, local API keys, proxy credentials,
   or the native inbound bearer token.
7. Only after the upstream handshake succeeds, accept the downstream upgrade
   and relay text/binary, close, ping, and pong behavior.
8. Keep the selected account and session affinity fixed until both sides close.
9. On normal completion, leave the socket reusable for later turns until idle
   timeout. On abnormal upstream close, mark a short per-session WebSocket
   cooldown so the next handshake receives `426` and immediately uses HTTP.

## HTTP Fallback Rules

Return `426` before accepting the downstream socket when:

- WebSockets are disabled by configuration.
- The connection cap is reached.
- No eligible account is available.
- Token refresh fails.
- The upstream handshake returns an authentication, quota, server, protocol, or
  network error.
- The same session is in WebSocket failure cooldown.

Once a downstream `101 Switching Protocols` response has been sent, the router
must never replay or rotate a partially delivered turn. It closes both sides,
records a redacted failure, and forces the next attempt through HTTP cooldown.

## Configuration

Add a runtime setting with these semantics:

```json
{
  "codexRuntimeResponsesWebSockets": "auto"
}
```

- `auto` (default): attempt the bridge and use `426` fallback on any setup risk.
- `off`: always return `426` and retain today's HTTP-only behavior.

Environment override:

```text
CODEX_MULTI_AUTH_RESPONSES_WEBSOCKETS=auto|off
```

Additional bounded defaults:

- Maximum active connections: `32`.
- Maximum WebSocket message: `64 MiB`, aligned with the existing request-body
  ceiling and required for image-bearing tool results.
- Maximum buffered outbound bytes per direction: `16 MiB`; overflow closes the
  pair with a stable overload reason.
- Idle timeout: `300000 ms`.
- Abnormal-close HTTP cooldown: `60000 ms`.
- Per-message compression disabled in the router to reduce zlib memory and
  compression-state risk. Codex and upstream may negotiate without it.

## Module Boundaries

Create `lib/runtime/responses-websocket-bridge.ts` for upgrade authentication,
upstream connection, bounded relay, lifecycle, and bridge-specific metrics.
Keep `lib/runtime-rotation-proxy.ts` responsible for server ownership and the
shared account-selection/credential preparation interface. Add WebSocket types
and metrics to `lib/runtime/rotation-server-types.ts` without exposing account
identity or tokens.

Use the maintained `ws` package rather than implementing RFC 6455 framing or
TLS manually. Pin a compatible runtime version and include its type package for
development. The bridge dependency must support Node `>=18.17.0`.

## Memory And Resource Requirements

Memory limits are operational targets, not brittle unit-test assertions:

- Target at or below `2 MiB` additional retained memory per idle connection.
- Target at or below `10 MiB` transient overhead for active text streaming.
- Image and Computer Use payload memory is reported separately because a single
  base64 image can legitimately exceed the text-stream target.
- After repeated connect/close cycles and forced garbage collection, retained
  heap must return within `10 MiB` of baseline.
- No queue may grow without a byte/count bound.
- Server shutdown must close both downstream and upstream sockets and settle all
  tracked handlers.

Add an informational benchmark that reports RSS, heap, connection count, and
buffered-byte peaks for idle, active-text, large-message, and 100-cycle cleanup
scenarios. CI enforces structural bounds and cleanup; live RSS thresholds are a
release/operator gate because allocator behavior is environment-dependent.

## Security And Account Safety

- Preserve loopback-only binding and exact secret-path authentication.
- Use existing constant-time secret comparison.
- Never include account email, access token, refresh token, native bearer,
  client secret, prompt body, or raw frames in logs/status.
- Do not change quota thresholds or increase account concurrency.
- One WebSocket equals one selected account; no multiplexing across accounts.
- WebSocket transport does not conceal account, device, IP, or usage patterns
  from OpenAI and must not be described as reducing enforcement risk.

## Observability

Add redacted counters for active connections, accepted upgrades, HTTP
fallbacks by stable reason, abnormal closes, messages/bytes in each direction,
peak buffered bytes, and last bridge error. Status output must not contain
session keys or account identities beyond the existing masked thread-status
surface.

## Testing

Test-first coverage must prove:

1. Exact secret-path and loopback checks run before endpoint disclosure.
2. Disabled/cooldown/cap states return `426` without an upstream connection.
3. The selected account's refreshed credentials reach the upstream handshake;
   native/local secrets do not.
4. Text, binary, close, ping, and pong behavior relays correctly.
5. Multiple Responses turns reuse one connection and one account.
6. Upstream handshake failures return `426` and leave HTTP operational.
7. Abnormal post-upgrade close activates per-session HTTP cooldown.
8. Message, buffer, connection, and idle limits close and clean up deterministically.
9. Server shutdown drains all socket pairs and reports zero active connections.
10. Tool-bearing Responses frames remain byte-for-byte unchanged.
11. The memory benchmark reports all required scenarios and detects retained
    connection/queue leaks.

Live verification must run the capability smoke matrix first over HTTP, then in
WebSocket `auto` mode. The reports must show the same tool outcomes, an accepted
WebSocket for Responses, zero reconnect-loop messages, and successful HTTP
fallback after a deliberately unavailable mock upstream.
