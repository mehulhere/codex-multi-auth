# Native Desktop Capabilities With Multi-Account Routing

## Problem

The Desktop app bind currently selects the custom
`codex-multi-auth-runtime-proxy` model provider. Codex classifies that provider
as non-native and as not requiring OpenAI authentication. This has three
confirmed user-visible effects:

- `image_gen__imagegen` is omitted from the callable tool set.
- `web__run` is omitted from the callable tool set.
- Desktop dictation is hidden because its eligibility check requires
  `authMethod === "chatgpt"` in addition to the voice-input feature gate and
  browser media APIs.

The multi-account router itself is healthy. The defect is the provider and
authentication identity used to reach it.

## Goals

- Keep the native `openai` provider identity and ChatGPT authentication state.
- Route only model discovery and Responses traffic through the local account
  rotation router.
- Restore image generation, web browsing/search, and the dictation button.
- Preserve account selection, thread affinity, quota failover, status, and
  reversible app binding.
- Keep the local router protected by an unguessable client secret.

## Non-goals

- Proxy ChatGPT application endpoints such as plugins, Apps, analytics, or
  dictation transcription.
- Patch the Codex Desktop application or its feature gates.
- Change account selection or quota policy.

## Considered Approaches

### 1. Native provider with model-only `openai_base_url` routing (selected)

Keep `model_provider = "openai"` and write `openai_base_url` to a loopback URL
whose path includes the existing random client secret. Codex continues to use
native ChatGPT authentication and first-party capability gates, while model
discovery and Responses requests reach the router.

This is the smallest boundary and matches Codex's supported endpoint override.
The router must recognize the secret path prefix, strip it before endpoint
classification, and continue replacing inbound credentials with the selected
managed account token upstream.

### 2. Selective ChatGPT reverse proxy

Keep the native provider but redirect `chatgpt_base_url`, rotate model requests,
and forward every other ChatGPT endpoint to OpenAI unchanged. This preserves
capabilities but expands the router into a general authenticated reverse proxy,
including plugin, Apps, analytics, and future endpoints. The larger security and
compatibility surface is unnecessary.

### 3. Treat the custom provider as first-party

Patch or fork Codex so the custom provider receives native tools and ChatGPT
dictation eligibility. This couples the fix to private Desktop implementation
details and would need repeated maintenance after app updates.

## Configuration Design

The bound configuration will contain top-level values equivalent to:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:<port>/v1/<client-secret>"
disable_response_storage = false
```

No custom `[model_providers.*]` block is added. Existing user values are stored
in the current app-bind backup and restored exactly during unbind. Rebinding
replaces only values owned by the bind and remains idempotent.

The random secret stays in the protected app-bind state and user configuration,
as the current bearer-token design already does. Startup entries continue to
reference the protected state file instead of embedding the secret.

## Router Design

The router accepts only loopback connections. A native-provider request is
authorized when its URL starts with the exact secret route prefix. After
constant-time secret comparison, the prefix is removed and the remaining path
must be one of the existing allowlisted endpoints:

- `GET /models`
- `POST /responses`
- the existing equivalent `/v1` and `/codex` forms where applicable

Legacy bearer or `x-api-key` authentication remains accepted temporarily for
wrapper and upgrade compatibility. Unsupported or unauthenticated requests keep
the current non-enumerating error behavior.

The router ignores the caller's native ChatGPT bearer token and continues to
replace it with the selected managed account token before forwarding upstream.
Secrets and inbound tokens are never logged or returned.

If Codex attempts a Responses WebSocket prewarm, the HTTP-only router may reject
the upgrade and Codex falls back to its normal HTTP Responses path. Supporting
WebSocket forwarding is outside this change unless runtime verification shows
that the installed Codex version cannot fall back.

## Failure Handling And Compatibility

- Missing or invalid secret route: return the existing unauthorized response.
- Valid secret but unsupported endpoint: return the existing not-found response.
- Router unavailable: preserve the existing explicit local connection error;
  do not silently bypass account routing.
- Old app-bind state: rebinding migrates the config to native identity while
  retaining the same state format and client secret.
- Unbind: remove the bind-owned `openai_base_url` and restore the original
  provider, response-storage, and base-URL settings exactly.

## Testing

Automated tests will prove:

1. Binding retains `model_provider = "openai"` and writes a secret-bearing
   loopback `openai_base_url` without a custom provider block.
2. Unbinding restores existing, absent, and unusual top-level values without
   duplicate TOML keys or section-placement errors.
3. The router accepts the exact path secret, rejects incorrect secrets, strips
   the prefix, and preserves the endpoint allowlist.
4. Legacy header authentication remains functional.
5. Managed upstream credentials replace native inbound credentials.

Live verification will use a fresh Desktop task to confirm:

- the recorded provider is `openai`;
- `image_gen__imagegen` and `web__run` are present;
- the mic button is visible and dictation can request microphone access;
- account rotation/status and a normal model turn still work;
- plugins, Apps, and analytics are no longer sent to the local router.
