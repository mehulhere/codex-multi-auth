# Native Desktop Capabilities Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native Codex Desktop capabilities and ChatGPT dictation while retaining quota-aware multi-account routing for model traffic.

**Architecture:** Keep the built-in `openai` provider and point only `openai_base_url` at the loopback router. Authenticate native-provider requests with an unguessable path segment, normalize that prefix before the router's existing endpoint allowlist, and retain legacy header authentication for compatibility.

**Tech Stack:** TypeScript, Node.js HTTP server, TOML text rewriting, Vitest, Codex Desktop 0.144.4.

## Global Constraints

- Do not patch Codex Desktop application binaries or feature gates.
- Route only model discovery and Responses traffic through the local router.
- Preserve account selection, thread affinity, quota failover, status, and reversible app binding.
- Keep the router loopback-only and protect it with the existing random client secret.
- Never log or return inbound native ChatGPT credentials or the route secret.
- Follow test-first red-green cycles for every behavior change.

---

### Task 1: Native Provider App-Bind Configuration

**Files:**
- Modify: `lib/runtime/config-toml.ts`
- Modify: `lib/runtime/app-bind.ts`
- Test: `test/app-bind.test.ts`
- Test: `test/config-toml-restore.test.ts`

**Interfaces:**
- Consumes: `rewriteConfigTomlForAppBind(rawConfig, baseUrl, clientApiKey)` and the existing app-bind backup.
- Produces: a bound config with `model_provider = "openai"` and `openai_base_url = "<baseUrl>/v1/<clientApiKey>"`; restore helpers that exactly restore or remove the original top-level base URL.

- [ ] **Step 1: Write failing bind and restore tests**

Add assertions equivalent to:

```ts
const bound = rewriteConfigTomlForAppBind(
    'model_provider = "openai"\nopenai_base_url = "https://original.example/v1"\n',
    "http://127.0.0.1:32123",
    "app-secret",
);
expect(bound).toContain('model_provider = "openai"');
expect(bound).toContain(
    'openai_base_url = "http://127.0.0.1:32123/v1/app-secret"',
);
expect(bound).not.toContain("codex-multi-auth-runtime-proxy");
expect(restoreConfigTomlFromAppBind(bound, original)).toBe(original);
```

Cover an absent original `openai_base_url`, a config whose first content is an array table, CRLF input, and rebind idempotency.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/app-bind.test.ts test/config-toml-restore.test.ts
```

Expected: failures show the bind still writes `codex-multi-auth-runtime-proxy` and no top-level `openai_base_url`.

- [ ] **Step 3: Implement minimal native-provider TOML rewriting**

Add focused top-level helpers that replace or insert one root key before the first table and restore it from the original config. Build the routed URL with a normalized base and encoded secret:

```ts
function createNativeOpenAIBaseUrl(baseUrl: string, clientApiKey: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/v1/${encodeURIComponent(clientApiKey)}`;
}

export function rewriteConfigTomlForRuntimeRotationProvider(
    rawConfig: string,
    baseUrl: string,
    clientApiKey = "",
): string {
    const withoutLegacyProvider = removeRuntimeRotationProviderBlock(rawConfig);
    const withNativeProvider = rewriteTopLevelKey(
        withoutLegacyProvider,
        "model_provider",
        tomlStringLiteral("openai"),
    );
    return rewriteTopLevelKey(
        enableTopLevelResponseStorage(withNativeProvider),
        "openai_base_url",
        tomlStringLiteral(createNativeOpenAIBaseUrl(baseUrl, clientApiKey)),
    );
}
```

Extend restore and orphan detection so both the legacy custom-provider bind and the new secret loopback `openai_base_url` bind are reversible.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run test/app-bind.test.ts test/config-toml-restore.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the configuration change**

```bash
git add lib/runtime/config-toml.ts lib/runtime/app-bind.ts test/app-bind.test.ts test/config-toml-restore.test.ts
git commit -m "fix: preserve native provider in desktop bind"
```

### Task 2: Secret Path Authentication And Endpoint Normalization

**Files:**
- Modify: `lib/runtime-rotation-proxy.ts`
- Test: `test/runtime-rotation-proxy.test.ts`

**Interfaces:**
- Consumes: `RuntimeRotationProxyOptions.clientApiKey` and native-provider paths shaped as `/v1/<clientApiKey>/models` or `/v1/<clientApiKey>/responses`.
- Produces: `resolveAuthorizedRequestPath(pathname, headers, clientApiKey): string | null`, returning a normalized allowlist path for valid secret-path or legacy-header requests.

- [ ] **Step 1: Write failing path-authentication tests**

Add integration cases equivalent to:

```ts
const accepted = await postResponses(
    proxy,
    { model: "gpt-5-codex" },
    `/v1/${DEFAULT_CLIENT_API_KEY}/responses`,
    { authorization: "Bearer native-chatgpt-token" },
);
expect(accepted.status).toBe(HTTP_STATUS.OK);

const rejected = await postResponses(
    proxy,
    { model: "gpt-5-codex" },
    "/v1/wrong-secret/responses",
    { authorization: "Bearer native-chatgpt-token" },
);
expect(rejected.status).toBe(HTTP_STATUS.UNAUTHORIZED);
```

Also cover models, percent-encoded mismatch, unknown endpoint after a valid secret, and legacy bearer/`x-api-key` authentication.

- [ ] **Step 2: Run the focused proxy tests and verify RED**

Run:

```bash
npx vitest run test/runtime-rotation-proxy.test.ts
```

Expected: secret-prefixed requests return unauthorized because only header authentication exists.

- [ ] **Step 3: Implement minimal constant-time route authorization**

Normalize only an exact route prefix and reuse the existing constant-time comparison:

```ts
function resolveAuthorizedRequestPath(
    pathname: string,
    headers: Headers,
    clientApiKey: string,
): string | null {
    const prefix = "/v1/";
    if (pathname.startsWith(prefix)) {
        const remainder = pathname.slice(prefix.length);
        const separator = remainder.indexOf("/");
        if (separator > 0) {
            const candidate = decodeURIComponent(remainder.slice(0, separator));
            if (safeEqual(candidate, clientApiKey)) {
                return `/v1${remainder.slice(separator)}`;
            }
        }
    }
    return isAuthorizedClient(headers, clientApiKey) ? pathname : null;
}
```

Use the normalized path for endpoint classification and request-context construction while preserving the original query string for upstream forwarding.

- [ ] **Step 4: Run the focused proxy tests and verify GREEN**

Run:

```bash
npx vitest run test/runtime-rotation-proxy.test.ts
```

Expected: all proxy tests pass, including legacy auth and endpoint-enumeration behavior.

- [ ] **Step 5: Commit the router change**

```bash
git add lib/runtime-rotation-proxy.ts test/runtime-rotation-proxy.test.ts
git commit -m "fix: authenticate native model routes by secret path"
```

### Task 3: Install And Verify Desktop Behavior

**Files:**
- Modify if required by existing project convention: `Done.md`
- Generated only by build: `dist/`
- Live config/state: `~/.codex/config.toml`, `~/.codex/multi-auth/app-bind/`

**Interfaces:**
- Consumes: the two committed implementation tasks and existing rotation CLI commands.
- Produces: a globally installed package, rebound Desktop config, and fresh evidence for native tools, dictation visibility, and rotation.

- [ ] **Step 1: Run static and automated verification**

```bash
npm run typecheck
npm run lint
npx vitest run test/app-bind.test.ts test/config-toml-restore.test.ts test/runtime-rotation-proxy.test.ts
npm test
npm run build
```

Expected: every command exits zero with no test failures.

- [ ] **Step 2: Install the current checkout and rebind**

```bash
npm install -g .
codex-multi-auth --version
codex-multi-auth rotation restart-app
codex-multi-auth rotation status
```

Expected: installed version matches the checkout, router is running, and `~/.codex/config.toml` uses native `openai` plus the loopback `openai_base_url`.

- [ ] **Step 3: Restart Desktop and run native capability probes**

Close and reopen Codex Desktop, create a fresh task, and capture its tool inventory. Verify:

```text
model_provider: openai
image_gen__imagegen: present
web__run: present
```

Run one image-generation request and one web request. Confirm both succeed and that router logs contain only model/models traffic.

- [ ] **Step 4: Verify dictation and account rotation**

Confirm the composer mic button is visible. Click it, grant microphone access if prompted, speak a short phrase, and verify transcription appears. Then run a normal model turn and inspect:

```bash
codex-multi-auth rotation status
codex-multi-auth history list --json
```

Expected: the fresh task remains native `openai`, the router reports a managed account, and per-thread routing/status remains populated.

- [ ] **Step 5: Record any unavoidable manual verification and commit**

If the GUI mic interaction cannot be automated, add exactly one crisp line to `Done.md` describing that remaining manual check, then commit it:

```bash
git add Done.md
git commit -m "docs: record desktop capability verification"
```
